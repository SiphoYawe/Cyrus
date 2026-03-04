// CLI command: cyrus telegram-auth
// Interactive Telegram authentication flow to generate a session string.

import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('telegram-auth');

// --- Teleproto auth abstraction for testability ---

export interface TeleprotoAuthClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendCode(apiCredentials: { apiId: number; apiHash: string }, phoneNumber: string): Promise<{ phoneCodeHash: string; isCodeViaApp: boolean }>;
  signIn(params: { phoneNumber: string; phoneCodeHash: string; phoneCode: string }): Promise<{ className?: string }>;
  checkPassword(password: string): Promise<void>;
  getEntity(username: string): Promise<{ id: bigint | number; username?: string }>;
  getMessages(entity: { id: bigint | number }, options: { limit: number }): Promise<Array<{ message: string }>>;
  getSession(): string;
}

export interface PromptIO {
  question(prompt: string): Promise<string>;
  questionSecret(prompt: string): Promise<string>;
  close(): void;
}

// --- Default prompt implementation using readline ---

export function createPromptIO(): PromptIO {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return {
    question(prompt: string): Promise<string> {
      return new Promise((resolve) => {
        rl.question(prompt, resolve);
      });
    },
    questionSecret(prompt: string): Promise<string> {
      return new Promise((resolve) => {
        process.stdout.write(prompt);
        const stdin = process.stdin;
        const oldRaw = stdin.isRaw;
        if (stdin.setRawMode) {
          stdin.setRawMode(true);
        }
        let input = '';
        const onData = (ch: Buffer) => {
          const c = ch.toString('utf8');
          if (c === '\n' || c === '\r') {
            if (stdin.setRawMode) {
              stdin.setRawMode(oldRaw ?? false);
            }
            stdin.removeListener('data', onData);
            process.stdout.write('\n');
            resolve(input);
          } else if (c === '\u0003') {
            // Ctrl+C
            if (stdin.setRawMode) {
              stdin.setRawMode(oldRaw ?? false);
            }
            stdin.removeListener('data', onData);
            resolve('');
          } else if (c === '\u007F' || c === '\b') {
            // Backspace
            if (input.length > 0) {
              input = input.slice(0, -1);
              process.stdout.write('\b \b');
            }
          } else {
            input += c;
            process.stdout.write('*');
          }
        };
        stdin.on('data', onData);
      });
    },
    close() {
      rl.close();
    },
  };
}

// --- Phone number validation ---

export function validatePhoneNumber(phone: string): boolean {
  const cleaned = phone.replace(/[\s\-()]/g, '');
  return /^\+\d{7,15}$/.test(cleaned);
}

export function cleanPhoneCode(code: string): string {
  return code.replace(/\D/g, '');
}

// --- Auth flow ---

export interface TelegramAuthOptions {
  apiId: number;
  apiHash: string;
  client: TeleprotoAuthClient;
  io: PromptIO;
  envFilePath?: string;
}

export interface TelegramAuthResult {
  readonly success: boolean;
  readonly sessionString?: string;
  readonly error?: string;
  readonly verified?: boolean;
}

export async function telegramAuthCommand(
  options: TelegramAuthOptions,
): Promise<TelegramAuthResult> {
  const { apiId, apiHash, client, io } = options;
  const envFilePath = options.envFilePath ?? '.env';

  try {
    // Connect
    await client.connect();

    // Step 1: Phone number
    const rawPhone = await io.question('Enter your phone number (with country code, e.g., +1234567890): ');
    if (!rawPhone) {
      return { success: false, error: 'Authentication cancelled.' };
    }

    const phoneNumber = rawPhone.replace(/[\s\-()]/g, '');
    if (!validatePhoneNumber(phoneNumber)) {
      return { success: false, error: 'Invalid phone number format. Must start with + followed by 7-15 digits.' };
    }

    // Step 2: Send code
    logger.info({ phoneNumber: phoneNumber.slice(0, 4) + '****' }, 'Sending verification code');
    let phoneCodeHash: string;

    try {
      const result = await client.sendCode({ apiId, apiHash }, phoneNumber);
      phoneCodeHash = result.phoneCodeHash;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (errorMsg.includes('FLOOD_WAIT')) {
        const waitMatch = errorMsg.match(/(\d+)/);
        const waitSec = waitMatch ? parseInt(waitMatch[1], 10) : 60;
        return { success: false, error: `Too many attempts. Please wait ${waitSec} seconds before trying again.` };
      }
      if (errorMsg.includes('PHONE_NUMBER_INVALID') || errorMsg.includes('not registered')) {
        return { success: false, error: 'This phone number is not registered with Telegram. Please use a registered number.' };
      }
      return { success: false, error: `Failed to send code: ${errorMsg}` };
    }

    // Step 3: Verification code
    let signedIn = false;
    let needs2FA = false;

    for (let attempt = 0; attempt < 3; attempt++) {
      const rawCode = await io.question('Enter the verification code you received: ');
      if (!rawCode) {
        return { success: false, error: 'Authentication cancelled.' };
      }

      const phoneCode = cleanPhoneCode(rawCode);
      if (phoneCode.length < 4) {
        logger.warn('Code too short, please try again');
        continue;
      }

      try {
        const result = await client.signIn({ phoneNumber, phoneCodeHash, phoneCode });
        if (result?.className === 'SessionPasswordNeeded') {
          needs2FA = true;
        } else {
          signedIn = true;
        }
        break;
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        if (errorMsg.includes('PHONE_CODE_INVALID')) {
          logger.warn('Invalid code. Please check the code sent to your Telegram app and try again.');
          continue;
        }
        if (errorMsg.includes('PHONE_CODE_EXPIRED')) {
          return { success: false, error: 'Code expired. Please restart the auth process to receive a new code.' };
        }
        if (errorMsg.includes('SESSION_PASSWORD_NEEDED')) {
          needs2FA = true;
          break;
        }
        return { success: false, error: `Sign-in failed: ${errorMsg}` };
      }
    }

    if (!signedIn && !needs2FA) {
      return { success: false, error: 'Too many incorrect code attempts. Please try again later.' };
    }

    // Step 4: 2FA if needed
    if (needs2FA) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const password = await io.questionSecret('Enter your 2FA password: ');
        if (!password) {
          return { success: false, error: 'Authentication cancelled.' };
        }

        try {
          await client.checkPassword(password);
          signedIn = true;
          break;
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          if (errorMsg.includes('PASSWORD_HASH_INVALID') || errorMsg.includes('incorrect')) {
            logger.warn(`Incorrect 2FA password. ${2 - attempt} attempt(s) remaining.`);
            continue;
          }
          return { success: false, error: `2FA failed: ${errorMsg}` };
        }
      }

      if (!signedIn) {
        return { success: false, error: 'Too many incorrect 2FA attempts. Please try again later.' };
      }
    }

    // Step 5: Get session string
    const sessionString = client.getSession();

    // Step 6: Verify by fetching a message
    let verified = false;
    try {
      const entity = await client.getEntity('agentpear');
      const messages = await client.getMessages(entity, { limit: 1 });
      if (messages.length > 0) {
        const preview = messages[0].message.length > 100
          ? messages[0].message.slice(0, 100) + '...'
          : messages[0].message;
        logger.info({ preview }, 'Verification successful! Connected to @agentpear channel.');
        verified = true;
      }
    } catch {
      logger.warn('Could not verify connection to @agentpear. The session string was generated but channel access could not be confirmed.');
    }

    // Step 7: Offer to write to .env
    const writeAnswer = await io.question(`Would you like to append the session string to your ${envFilePath} file? (y/n): `);
    if (writeAnswer.toLowerCase() === 'y') {
      try {
        const line = `\n# Telegram session - generated by cyrus telegram-auth\nTELEGRAM_SESSION_STRING=${sessionString}\n`;
        if (existsSync(envFilePath)) {
          appendFileSync(envFilePath, line);
        } else {
          writeFileSync(envFilePath, line);
        }
        logger.info({ path: envFilePath }, 'Session string written to .env file');
      } catch (err) {
        logger.warn({ error: err }, 'Failed to write to .env file');
      }
    }

    return { success: true, sessionString, verified };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Authentication failed: ${errorMsg}` };
  } finally {
    try {
      await client.disconnect();
    } catch { /* ignore */ }
    io.close();
  }
}
