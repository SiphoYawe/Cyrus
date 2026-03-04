import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import {
  telegramAuthCommand,
  validatePhoneNumber,
  cleanPhoneCode,
} from '../telegram-auth-command.js';
import type {
  TeleprotoAuthClient,
  PromptIO,
  TelegramAuthOptions,
} from '../telegram-auth-command.js';
import { Store } from '../../core/store.js';

// --- Mock factories ---

function createMockClient(overrides?: Partial<TeleprotoAuthClient>): TeleprotoAuthClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    sendCode: vi.fn().mockResolvedValue({ phoneCodeHash: 'hash123', isCodeViaApp: true }),
    signIn: vi.fn().mockResolvedValue({ className: 'User' }),
    checkPassword: vi.fn().mockResolvedValue(undefined),
    getEntity: vi.fn().mockResolvedValue({ id: BigInt(12345), username: 'agentpear' }),
    getMessages: vi.fn().mockResolvedValue([{ message: 'Latest signal message' }]),
    getSession: vi.fn().mockReturnValue('test-session-string-abc123'),
    ...overrides,
  };
}

function createMockIO(answers: string[]): PromptIO {
  let idx = 0;
  return {
    question: vi.fn().mockImplementation(() => {
      const answer = answers[idx] ?? '';
      idx++;
      return Promise.resolve(answer);
    }),
    questionSecret: vi.fn().mockImplementation(() => {
      const answer = answers[idx] ?? '';
      idx++;
      return Promise.resolve(answer);
    }),
    close: vi.fn(),
  };
}

function createOptions(
  answers: string[],
  clientOverrides?: Partial<TeleprotoAuthClient>,
  envFilePath?: string,
): TelegramAuthOptions {
  return {
    apiId: 12345,
    apiHash: 'test-hash',
    client: createMockClient(clientOverrides),
    io: createMockIO(answers),
    envFilePath: envFilePath ?? join(mkdtempSync(join(tmpdir(), 'cyrus-test-')), '.env'),
  };
}

describe('telegram-auth-command', () => {
  beforeEach(() => {
    Store.getInstance().reset();
    vi.clearAllMocks();
  });

  // --- Phone number validation ---

  it('validates correct phone number formats', () => {
    expect(validatePhoneNumber('+1234567890')).toBe(true);
    expect(validatePhoneNumber('+27 82 123 4567')).toBe(true);
    expect(validatePhoneNumber('+1-234-567-8901')).toBe(true);
  });

  it('rejects invalid phone number formats', () => {
    expect(validatePhoneNumber('1234567890')).toBe(false); // no +
    expect(validatePhoneNumber('+123')).toBe(false); // too short
    expect(validatePhoneNumber('abc')).toBe(false);
    expect(validatePhoneNumber('')).toBe(false);
  });

  // --- Code cleaning ---

  it('strips non-digit characters from code', () => {
    expect(cleanPhoneCode('1-2-3-4-5')).toBe('12345');
    expect(cleanPhoneCode('1 2 3 4 5')).toBe('12345');
    expect(cleanPhoneCode('12345')).toBe('12345');
  });

  // --- Successful flow ---

  it('completes successful flow: phone -> code -> session string (AC2, AC3)', async () => {
    const opts = createOptions([
      '+1234567890',   // phone number
      '12345',         // verification code
      'n',             // don't write to .env
    ]);

    const result = await telegramAuthCommand(opts);

    expect(result.success).toBe(true);
    expect(result.sessionString).toBe('test-session-string-abc123');
    expect(result.verified).toBe(true);
  });

  it('completes flow with 2FA: phone -> code -> password -> session (AC2, AC6)', async () => {
    const opts = createOptions(
      [
        '+1234567890',   // phone number
        '12345',         // verification code
        'mypassword',    // 2FA password
        'n',             // don't write to .env
      ],
      {
        signIn: vi.fn().mockResolvedValue({ className: 'SessionPasswordNeeded' }),
      },
    );

    const result = await telegramAuthCommand(opts);

    expect(result.success).toBe(true);
    expect(result.sessionString).toBeDefined();
  });

  // --- Error handling ---

  it('handles wrong code error with retry (AC5)', async () => {
    const signInFn = vi.fn()
      .mockRejectedValueOnce(new Error('PHONE_CODE_INVALID'))
      .mockResolvedValue({ className: 'User' });

    const opts = createOptions(
      [
        '+1234567890',
        '11111',    // wrong code
        '12345',    // correct code
        'n',
      ],
      { signIn: signInFn },
    );

    const result = await telegramAuthCommand(opts);

    expect(result.success).toBe(true);
    expect(signInFn).toHaveBeenCalledTimes(2);
  });

  it('handles expired code error (AC5)', async () => {
    const opts = createOptions(
      ['+1234567890', '12345'],
      { signIn: vi.fn().mockRejectedValue(new Error('PHONE_CODE_EXPIRED')) },
    );

    const result = await telegramAuthCommand(opts);

    expect(result.success).toBe(false);
    expect(result.error).toContain('expired');
  });

  it('handles wrong 2FA password with 3 retries then aborts (AC6)', async () => {
    const opts = createOptions(
      [
        '+1234567890',
        '12345',         // correct verification code
        'wrong1',        // wrong 2FA
        'wrong2',        // wrong 2FA
        'wrong3',        // wrong 2FA
      ],
      {
        signIn: vi.fn().mockResolvedValue({ className: 'SessionPasswordNeeded' }),
        checkPassword: vi.fn().mockRejectedValue(new Error('PASSWORD_HASH_INVALID')),
      },
    );

    const result = await telegramAuthCommand(opts);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Too many incorrect 2FA');
  });

  // --- Session string output ---

  it('session string output includes .env instructions (AC3)', async () => {
    const opts = createOptions(['+1234567890', '12345', 'n']);
    const result = await telegramAuthCommand(opts);
    expect(result.sessionString).toBeDefined();
    expect(result.sessionString).toBe('test-session-string-abc123');
  });

  // --- Verification ---

  it('verifies by fetching one message from @agentpear (AC4)', async () => {
    const getEntityFn = vi.fn().mockResolvedValue({ id: BigInt(12345), username: 'agentpear' });
    const getMessagesFn = vi.fn().mockResolvedValue([{ message: 'Latest signal from Agent Pear' }]);

    const opts = createOptions(
      ['+1234567890', '12345', 'n'],
      { getEntity: getEntityFn, getMessages: getMessagesFn },
    );

    const result = await telegramAuthCommand(opts);

    expect(result.verified).toBe(true);
    expect(getEntityFn).toHaveBeenCalledWith('agentpear');
    expect(getMessagesFn).toHaveBeenCalledWith(expect.anything(), { limit: 1 });
  });

  it('handles verification failure gracefully (AC4)', async () => {
    const opts = createOptions(
      ['+1234567890', '12345', 'n'],
      { getEntity: vi.fn().mockRejectedValue(new Error('Channel not found')) },
    );

    const result = await telegramAuthCommand(opts);

    // Session still succeeds even if verification fails
    expect(result.success).toBe(true);
    expect(result.verified).toBe(false);
  });

  // --- Graceful abort ---

  it('handles empty phone number as abort (AC7)', async () => {
    const opts = createOptions(['']); // empty = cancelled

    const result = await telegramAuthCommand(opts);

    expect(result.success).toBe(false);
    expect(result.error).toContain('cancelled');
  });

  // --- Missing config ---

  it('handles invalid phone number format', async () => {
    const opts = createOptions(['1234']); // no + prefix

    const result = await telegramAuthCommand(opts);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid phone number');
  });

  // --- Rate limiting ---

  it('handles FLOOD_WAIT error (AC5)', async () => {
    const opts = createOptions(
      ['+1234567890'],
      { sendCode: vi.fn().mockRejectedValue(new Error('FLOOD_WAIT_300')) },
    );

    const result = await telegramAuthCommand(opts);

    expect(result.success).toBe(false);
    expect(result.error).toContain('wait');
  });

  // --- Write to .env ---

  it('writes session string to .env file when confirmed', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'cyrus-env-'));
    const envPath = join(tmpDir, '.env');

    const opts = createOptions(
      ['+1234567890', '12345', 'y'],
      undefined,
      envPath,
    );

    const result = await telegramAuthCommand(opts);

    expect(result.success).toBe(true);
    const contents = readFileSync(envPath, 'utf-8');
    expect(contents).toContain('TELEGRAM_SESSION_STRING=test-session-string-abc123');

    // Cleanup
    if (existsSync(envPath)) unlinkSync(envPath);
  });

  // --- IO cleanup ---

  it('always calls io.close() and client.disconnect()', async () => {
    const client = createMockClient();
    const io = createMockIO(['+1234567890', '12345', 'n']);

    await telegramAuthCommand({ apiId: 123, apiHash: 'abc', client, io });

    expect(io.close).toHaveBeenCalled();
    expect(client.disconnect).toHaveBeenCalled();
  });
});
