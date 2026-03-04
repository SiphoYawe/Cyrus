// WalletManager — dual EVM + Solana wallet management
// Manages both viem (EVM) and @solana/web3.js (Solana) wallets from env vars.
// Solana support is optional — agent can run EVM-only if SOLANA_PRIVATE_KEY is not set.

import { privateKeyToAccount } from 'viem/accounts';
import type { PrivateKeyAccount } from 'viem/accounts';
import type { PublicKey } from '@solana/web3.js';
import { createLogger } from '../utils/logger.js';
import { CyrusError } from '../utils/errors.js';
import { SolanaConnector } from './solana-connector.js';
import type { SolanaConnectorConfig } from './solana-types.js';

const logger = createLogger('wallet-manager');

// --- Error class ---

export class WalletManagerError extends CyrusError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, context);
  }
}

// --- Config ---

export interface WalletManagerConfig {
  readonly evmPrivateKey?: string;
  readonly solanaConfig?: Partial<SolanaConnectorConfig>;
}

// --- WalletManager ---

export class WalletManager {
  private readonly evmAccount: PrivateKeyAccount | null;
  private readonly solanaConnector: SolanaConnector | null;

  constructor(config: WalletManagerConfig = {}) {
    // Load EVM wallet
    const evmKey = config.evmPrivateKey ?? process.env.PRIVATE_KEY;
    if (evmKey) {
      try {
        this.evmAccount = privateKeyToAccount(evmKey as `0x${string}`);
        logger.info({ evmAddress: this.evmAccount.address }, 'EVM wallet loaded');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new WalletManagerError('Failed to load EVM private key', {
          reason: message,
        });
      }
    } else {
      this.evmAccount = null;
      logger.warn('No PRIVATE_KEY provided — EVM features disabled');
    }

    // Load Solana wallet (optional)
    const solanaSecret = config.solanaConfig?.keypairSecret ?? process.env.SOLANA_PRIVATE_KEY;
    if (solanaSecret) {
      try {
        this.solanaConnector = new SolanaConnector({
          ...config.solanaConfig,
          keypairSecret: solanaSecret,
        });
        logger.info(
          { solanaPublicKey: this.solanaConnector.getPublicKey().toBase58() },
          'Solana wallet loaded',
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new WalletManagerError('Failed to load Solana keypair', {
          reason: message,
        });
      }
    } else {
      this.solanaConnector = null;
      logger.info('No SOLANA_PRIVATE_KEY provided — Solana features disabled');
    }

    // Validate at least one wallet is available
    if (!this.evmAccount && !this.solanaConnector) {
      throw new WalletManagerError(
        'No wallets configured — provide at least PRIVATE_KEY or SOLANA_PRIVATE_KEY',
      );
    }
  }

  // --- EVM accessors ---

  getEvmAddress(): string {
    if (!this.evmAccount) {
      throw new WalletManagerError('EVM wallet not loaded', { method: 'getEvmAddress' });
    }
    return this.evmAccount.address;
  }

  getEvmAccount(): PrivateKeyAccount {
    if (!this.evmAccount) {
      throw new WalletManagerError('EVM wallet not loaded', { method: 'getEvmAccount' });
    }
    return this.evmAccount;
  }

  hasEvmWallet(): boolean {
    return this.evmAccount !== null;
  }

  // --- Solana accessors ---

  getSolanaPublicKey(): PublicKey {
    if (!this.solanaConnector) {
      throw new WalletManagerError('Solana wallet not loaded', {
        method: 'getSolanaPublicKey',
      });
    }
    return this.solanaConnector.getPublicKey();
  }

  getSolanaConnector(): SolanaConnector {
    if (!this.solanaConnector) {
      throw new WalletManagerError('Solana wallet not loaded', {
        method: 'getSolanaConnector',
      });
    }
    return this.solanaConnector;
  }

  hasSolanaWallet(): boolean {
    return this.solanaConnector !== null && this.solanaConnector.isInitialized();
  }
}
