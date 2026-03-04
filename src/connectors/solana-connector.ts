// SolanaConnector — handles Solana-native operations: balance queries, tx signing, confirmation
// Parallel to LiFiConnector, not replacing it. For cross-chain bridges involving Solana,
// both connectors collaborate: LI.FI provides the route, SolanaConnector signs Solana-side transactions.

import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  Transaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { createLogger } from '../utils/logger.js';
import { CyrusError } from '../utils/errors.js';
import type {
  SolanaBalance,
  SolanaTransaction,
  SolanaCommitment,
  SolanaConnectorConfig,
} from './solana-types.js';
import { SOLANA_DEFAULTS } from './solana-types.js';

// SPL Token Program ID — constant to avoid @solana/spl-token dependency
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

const logger = createLogger('solana-connector');

// --- Error classes ---

export class SolanaConnectorError extends CyrusError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, context);
  }
}

export class SolanaConfirmationTimeoutError extends CyrusError {
  constructor(context: { signature: string; elapsed: number; commitment: SolanaCommitment }) {
    super(
      `Solana confirmation timeout after ${context.elapsed}ms for ${context.signature} at ${context.commitment} level`,
      context,
    );
  }
}

// --- SolanaConnector ---

export class SolanaConnector {
  private readonly connection: Connection;
  private readonly keypair: Keypair | null;
  private readonly commitment: SolanaCommitment;
  private initialized: boolean;

  constructor(config: Partial<SolanaConnectorConfig> = {}) {
    const rpcUrl = config.rpcUrl ?? SOLANA_DEFAULTS.RPC_URL;
    this.commitment = config.commitment ?? SOLANA_DEFAULTS.COMMITMENT;

    this.connection = new Connection(rpcUrl, this.commitment);
    this.keypair = null;
    this.initialized = false;

    const keypairSecret = config.keypairSecret ?? process.env.SOLANA_PRIVATE_KEY;
    if (keypairSecret) {
      try {
        this.keypair = this.loadKeypair(keypairSecret);
        this.initialized = true;
        logger.info(
          { publicKey: this.keypair.publicKey.toBase58() },
          'Solana wallet initialized',
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new SolanaConnectorError('Failed to load Solana keypair', {
          reason: message,
        });
      }
    } else {
      logger.info('No SOLANA_PRIVATE_KEY provided — Solana features disabled');
    }
  }

  // --- Keypair loading ---

  private loadKeypair(secret: string): Keypair {
    const trimmed = secret.trim();

    // Try JSON byte array format: [1,2,3,...]
    if (trimmed.startsWith('[')) {
      try {
        const bytes = JSON.parse(trimmed) as number[];
        return Keypair.fromSecretKey(Uint8Array.from(bytes));
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new SolanaConnectorError('Invalid JSON byte array format for SOLANA_PRIVATE_KEY', {
          format: 'json-byte-array',
          reason,
        });
      }
    }

    // Try base58 format
    try {
      const decoded = bs58.decode(trimmed);
      return Keypair.fromSecretKey(decoded);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new SolanaConnectorError(
        'Invalid SOLANA_PRIVATE_KEY: must be base58-encoded secret key or JSON byte array',
        { format: 'base58', reason },
      );
    }
  }

  // --- Accessors ---

  getPublicKey(): PublicKey {
    if (!this.keypair) {
      throw new SolanaConnectorError('Solana keypair not loaded', {
        method: 'getPublicKey',
      });
    }
    return this.keypair.publicKey;
  }

  getKeypair(): Keypair {
    if (!this.keypair) {
      throw new SolanaConnectorError('Solana keypair not loaded', {
        method: 'getKeypair',
      });
    }
    return this.keypair;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  getConnection(): Connection {
    return this.connection;
  }

  // --- Balance queries ---

  async getSolBalance(): Promise<bigint> {
    const publicKey = this.getPublicKey();
    try {
      const lamports = await this.connection.getBalance(publicKey);
      return BigInt(lamports);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SolanaConnectorError('Failed to get SOL balance', {
        method: 'getSolBalance',
        publicKey: publicKey.toBase58(),
        reason: message,
      });
    }
  }

  async getSplTokenBalances(): Promise<SolanaBalance[]> {
    const publicKey = this.getPublicKey();
    try {
      const response = await this.connection.getTokenAccountsByOwner(publicKey, {
        programId: TOKEN_PROGRAM_ID,
      });

      const balances: SolanaBalance[] = [];

      for (const { account } of response.value) {
        const data = account.data;
        // SPL Token account data layout: mint (32 bytes) + owner (32 bytes) + amount (8 bytes LE)
        const mintBytes = data.slice(0, 32);
        const mint = new PublicKey(mintBytes).toBase58();
        const amountBytes = data.slice(64, 72);
        const amount = BigInt(
          new DataView(amountBytes.buffer, amountBytes.byteOffset, 8).getBigUint64(0, true),
        );

        // Default to 0 decimals — actual decimals resolved via mint metadata
        const decimals = 0;
        const uiAmount = Number(amount);

        balances.push({ mint, amount, decimals, uiAmount });
      }

      return balances;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SolanaConnectorError('Failed to get SPL token balances', {
        method: 'getSplTokenBalances',
        publicKey: publicKey.toBase58(),
        reason: message,
      });
    }
  }

  async getTokenBalance(mint: string): Promise<SolanaBalance | null> {
    const balances = await this.getSplTokenBalances();
    return balances.find((b) => b.mint === mint) ?? null;
  }

  async getRecentTransactions(limit: number = 10): Promise<SolanaTransaction[]> {
    const publicKey = this.getPublicKey();
    try {
      const signatures = await this.connection.getSignaturesForAddress(publicKey, { limit });
      return signatures.map((sig) => ({
        signature: sig.signature,
        slot: sig.slot,
        blockTime: sig.blockTime ?? null,
        err: sig.err ?? null,
        memo: sig.memo ?? null,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SolanaConnectorError('Failed to get recent transactions', {
        method: 'getRecentTransactions',
        publicKey: publicKey.toBase58(),
        reason: message,
      });
    }
  }

  // --- Transaction confirmation ---

  async waitForConfirmation(
    signature: string,
    commitment?: SolanaCommitment,
  ): Promise<boolean> {
    const level = commitment ?? this.commitment;
    const timeout =
      level === 'finalized'
        ? SOLANA_DEFAULTS.FINALIZED_TIMEOUT_MS
        : SOLANA_DEFAULTS.CONFIRMATION_TIMEOUT_MS;

    const startTime = Date.now();

    try {
      const latestBlockhash = await this.connection.getLatestBlockhash(level);
      const result = await this.connection.confirmTransaction(
        {
          signature,
          blockhash: latestBlockhash.blockhash,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        },
        level,
      );

      if (result.value.err) {
        logger.warn({ signature, error: result.value.err }, 'Transaction confirmed with error');
        return false;
      }

      const elapsed = Date.now() - startTime;
      logger.debug({ signature, commitment: level, elapsed }, 'Transaction confirmed');
      return true;
    } catch (error) {
      const elapsed = Date.now() - startTime;
      if (elapsed >= timeout) {
        throw new SolanaConfirmationTimeoutError({
          signature,
          elapsed,
          commitment: level,
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new SolanaConnectorError('Transaction confirmation failed', {
        method: 'waitForConfirmation',
        signature,
        commitment: level,
        elapsed,
        reason: message,
      });
    }
  }

  // --- Transaction signing & sending ---

  async signAndSendTransaction(
    serializedTx: Buffer | Uint8Array,
    isVersioned: boolean = true,
  ): Promise<string> {
    const keypair = this.getKeypair();

    let signature: string;

    if (isVersioned) {
      const tx = VersionedTransaction.deserialize(serializedTx);
      tx.sign([keypair]);
      signature = await this.connection.sendTransaction(tx);
    } else {
      const tx = Transaction.from(serializedTx);
      tx.sign(keypair);
      signature = await this.connection.sendRawTransaction(tx.serialize());
    }

    logger.info({ signature }, 'Solana transaction sent');
    return signature;
  }

  // --- Refresh balances into store ---

  async getAllBalances(): Promise<{ sol: bigint; splTokens: SolanaBalance[] }> {
    const sol = await this.getSolBalance();
    const splTokens = await this.getSplTokenBalances();
    return { sol, splTokens };
  }
}
