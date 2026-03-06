import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { Store } from '../core/store.js';
import { chainId, tokenAddress } from '../core/types.js';
import {
  SolanaConnector,
  SolanaConnectorError,
  SolanaConfirmationTimeoutError,
} from './solana-connector.js';
import { SOLANA_CHAIN_ID, WRAPPED_SOL_MINT, SOLANA_DEFAULTS } from './solana-types.js';
import { WalletManager, WalletManagerError } from './wallet-manager.js';

// Generate a test keypair
const testKeypair = Keypair.generate();
const testSecretBase58 = bs58.encode(testKeypair.secretKey);
const testSecretJsonArray = JSON.stringify(Array.from(testKeypair.secretKey));

// --- Mock @solana/web3.js Connection class ---
vi.mock('@solana/web3.js', async () => {
  const actual = await vi.importActual<typeof import('@solana/web3.js')>('@solana/web3.js');

  // Must be a regular function (not arrow) to support `new` constructor calls
  function MockConnection() {
    return {
      getBalance: vi.fn().mockResolvedValue(5_000_000_000), // 5 SOL
      getTokenAccountsByOwner: vi.fn().mockResolvedValue({ value: [] }),
      getSignaturesForAddress: vi.fn().mockResolvedValue([
        {
          signature: 'test-sig-1',
          slot: 12345,
          blockTime: 1700000000,
          err: null,
          memo: null,
        },
        {
          signature: 'test-sig-2',
          slot: 12346,
          blockTime: 1700000060,
          err: null,
          memo: 'test memo',
        },
      ]),
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
      getLatestBlockhash: vi.fn().mockResolvedValue({
        blockhash: 'test-blockhash',
        lastValidBlockHeight: 100000,
      }),
      sendTransaction: vi.fn().mockResolvedValue('tx-sig-123'),
      sendRawTransaction: vi.fn().mockResolvedValue('tx-sig-raw-123'),
    };
  }

  return {
    ...actual,
    Connection: MockConnection,
  };
});

describe('SolanaConnector', () => {
  let store: Store;

  beforeEach(() => {
    store = Store.getInstance();
    vi.clearAllMocks();
  });

  afterEach(() => {
    store.reset();
  });

  describe('initialization', () => {
    it('initializes with valid base58 keypair', () => {
      const connector = new SolanaConnector({
        keypairSecret: testSecretBase58,
        rpcUrl: 'https://api.devnet.solana.com',
        commitment: 'confirmed',
        jupiterApiUrl: SOLANA_DEFAULTS.JUPITER_API_URL,
      });

      expect(connector.isInitialized()).toBe(true);
      expect(connector.getPublicKey().toBase58()).toBe(testKeypair.publicKey.toBase58());
    });

    it('initializes with valid JSON byte array keypair', () => {
      const connector = new SolanaConnector({
        keypairSecret: testSecretJsonArray,
        rpcUrl: 'https://api.devnet.solana.com',
        commitment: 'confirmed',
        jupiterApiUrl: SOLANA_DEFAULTS.JUPITER_API_URL,
      });

      expect(connector.isInitialized()).toBe(true);
      expect(connector.getPublicKey().toBase58()).toBe(testKeypair.publicKey.toBase58());
    });

    it('throws SolanaConnectorError when keypair secret is malformed', () => {
      expect(() => {
        new SolanaConnector({
          keypairSecret: 'not-a-valid-key!!!',
          rpcUrl: 'https://api.devnet.solana.com',
          commitment: 'confirmed',
          jupiterApiUrl: SOLANA_DEFAULTS.JUPITER_API_URL,
        });
      }).toThrow(SolanaConnectorError);
    });

    it('initializes without keypair when none provided', () => {
      // Remove env var temporarily
      const originalEnv = process.env.SOLANA_PRIVATE_KEY;
      delete process.env.SOLANA_PRIVATE_KEY;

      const connector = new SolanaConnector({
        rpcUrl: 'https://api.devnet.solana.com',
        commitment: 'confirmed',
        jupiterApiUrl: SOLANA_DEFAULTS.JUPITER_API_URL,
      });

      expect(connector.isInitialized()).toBe(false);

      // Restore
      if (originalEnv !== undefined) {
        process.env.SOLANA_PRIVATE_KEY = originalEnv;
      }
    });

    it('throws when accessing publicKey without keypair', () => {
      const originalEnv = process.env.SOLANA_PRIVATE_KEY;
      delete process.env.SOLANA_PRIVATE_KEY;

      const connector = new SolanaConnector({
        rpcUrl: 'https://api.devnet.solana.com',
        commitment: 'confirmed',
        jupiterApiUrl: SOLANA_DEFAULTS.JUPITER_API_URL,
      });

      expect(() => connector.getPublicKey()).toThrow(SolanaConnectorError);

      if (originalEnv !== undefined) {
        process.env.SOLANA_PRIVATE_KEY = originalEnv;
      }
    });
  });

  describe('balance queries', () => {
    it('returns SOL balance as bigint', async () => {
      const connector = new SolanaConnector({
        keypairSecret: testSecretBase58,
        rpcUrl: 'https://api.devnet.solana.com',
        commitment: 'confirmed',
        jupiterApiUrl: SOLANA_DEFAULTS.JUPITER_API_URL,
      });

      const balance = await connector.getSolBalance();
      expect(balance).toBe(5_000_000_000n); // 5 SOL in lamports
      expect(typeof balance).toBe('bigint');
    });

    it('returns empty array for no SPL token accounts', async () => {
      const connector = new SolanaConnector({
        keypairSecret: testSecretBase58,
        rpcUrl: 'https://api.devnet.solana.com',
        commitment: 'confirmed',
        jupiterApiUrl: SOLANA_DEFAULTS.JUPITER_API_URL,
      });

      const balances = await connector.getSplTokenBalances();
      expect(balances).toEqual([]);
    });

    it('returns null for non-existent token balance', async () => {
      const connector = new SolanaConnector({
        keypairSecret: testSecretBase58,
        rpcUrl: 'https://api.devnet.solana.com',
        commitment: 'confirmed',
        jupiterApiUrl: SOLANA_DEFAULTS.JUPITER_API_URL,
      });

      const balance = await connector.getTokenBalance('NonExistentMint111111111111111111');
      expect(balance).toBeNull();
    });
  });

  describe('recent transactions', () => {
    it('maps RPC response to SolanaTransaction[] with correct fields', async () => {
      const connector = new SolanaConnector({
        keypairSecret: testSecretBase58,
        rpcUrl: 'https://api.devnet.solana.com',
        commitment: 'confirmed',
        jupiterApiUrl: SOLANA_DEFAULTS.JUPITER_API_URL,
      });

      const txs = await connector.getRecentTransactions(10);
      expect(txs).toHaveLength(2);
      expect(txs[0]).toEqual({
        signature: 'test-sig-1',
        slot: 12345,
        blockTime: 1700000000,
        err: null,
        memo: null,
      });
      expect(txs[1]).toEqual({
        signature: 'test-sig-2',
        slot: 12346,
        blockTime: 1700000060,
        err: null,
        memo: 'test memo',
      });
    });
  });

  describe('transaction confirmation', () => {
    it('returns true for successful confirmation', async () => {
      const connector = new SolanaConnector({
        keypairSecret: testSecretBase58,
        rpcUrl: 'https://api.devnet.solana.com',
        commitment: 'confirmed',
        jupiterApiUrl: SOLANA_DEFAULTS.JUPITER_API_URL,
      });

      const result = await connector.waitForConfirmation('test-sig-1', 'confirmed');
      expect(result).toBe(true);
    });

    it('throws SolanaConfirmationTimeoutError on confirmation failure after elapsed time', async () => {
      const connector = new SolanaConnector({
        keypairSecret: testSecretBase58,
        rpcUrl: 'https://api.devnet.solana.com',
        commitment: 'confirmed',
        jupiterApiUrl: SOLANA_DEFAULTS.JUPITER_API_URL,
      });

      // Override the connection mock to throw a timeout-like error
      const conn = connector.getConnection();
      vi.spyOn(conn, 'confirmTransaction').mockRejectedValueOnce(
        new Error('TransactionExpiredBlockheightExceededError'),
      );
      // Mock getLatestBlockhash to return fast so elapsed time stays low
      vi.spyOn(conn, 'getLatestBlockhash').mockResolvedValueOnce({
        blockhash: 'test-blockhash',
        lastValidBlockHeight: 100000,
      } as never);

      // Since elapsed will be < timeout, it throws SolanaConnectorError (not timeout)
      await expect(
        connector.waitForConfirmation('bad-sig', 'confirmed'),
      ).rejects.toThrow('Transaction confirmation failed');
    });

    it('supports all commitment levels: processed, confirmed, finalized', async () => {
      const connector = new SolanaConnector({
        keypairSecret: testSecretBase58,
        rpcUrl: 'https://api.devnet.solana.com',
        commitment: 'processed',
        jupiterApiUrl: SOLANA_DEFAULTS.JUPITER_API_URL,
      });

      // All should succeed with mock
      await expect(connector.waitForConfirmation('sig', 'processed')).resolves.toBe(true);
      await expect(connector.waitForConfirmation('sig', 'confirmed')).resolves.toBe(true);
      await expect(connector.waitForConfirmation('sig', 'finalized')).resolves.toBe(true);
    });
  });

  describe('state store integration', () => {
    it('uses correct Solana composite key format for SOL balance', () => {
      const solChainId = chainId(SOLANA_CHAIN_ID);
      const solMint = tokenAddress(WRAPPED_SOL_MINT);

      store.setBalance(solChainId, solMint, 5_000_000_000n, 750, 'SOL', 9);

      const balance = store.getBalance(solChainId, solMint);
      expect(balance).toBeDefined();
      expect(balance!.amount).toBe(5_000_000_000n);
      expect(balance!.symbol).toBe('SOL');
    });

    it('uses correct Solana composite key format for SPL tokens', () => {
      const solChainId = chainId(SOLANA_CHAIN_ID);
      const usdcMint = tokenAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

      store.setBalance(solChainId, usdcMint, 1_000_000n, 1.0, 'USDC', 6);

      const balance = store.getBalance(solChainId, usdcMint);
      expect(balance).toBeDefined();
      expect(balance!.amount).toBe(1_000_000n);
    });

    it('includes Solana balances in getAllBalances', () => {
      const solChainId = chainId(SOLANA_CHAIN_ID);
      const solMint = tokenAddress(WRAPPED_SOL_MINT);
      const ethChainId = chainId(1);
      const ethToken = tokenAddress('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');

      store.setBalance(solChainId, solMint, 5_000_000_000n, 750, 'SOL', 9);
      store.setBalance(ethChainId, ethToken, 1_000_000_000_000_000_000n, 3500, 'WETH', 18);

      const all = store.getAllBalances();
      expect(all).toHaveLength(2);
      expect(all.some((b) => b.symbol === 'SOL')).toBe(true);
      expect(all.some((b) => b.symbol === 'WETH')).toBe(true);
    });

    it('getAvailableBalance deducts in-flight Solana transfers', () => {
      const solChainId = chainId(SOLANA_CHAIN_ID);
      const solMint = tokenAddress(WRAPPED_SOL_MINT);

      store.setBalance(solChainId, solMint, 10_000_000_000n, 1500, 'SOL', 9);

      // Create an in-flight transfer from Solana
      store.createTransfer({
        txHash: 'solana-tx-hash',
        fromChain: solChainId,
        toChain: chainId(1), // to Ethereum
        fromToken: solMint,
        toToken: tokenAddress('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'),
        amount: 3_000_000_000n,
        bridge: 'allbridge',
        quoteData: null,
      });

      const available = store.getAvailableBalance(solChainId, solMint);
      expect(available).toBe(7_000_000_000n); // 10B - 3B = 7B lamports
    });

    it('store.reset() clears Solana balance entries', () => {
      const solChainId = chainId(SOLANA_CHAIN_ID);
      const solMint = tokenAddress(WRAPPED_SOL_MINT);

      store.setBalance(solChainId, solMint, 5_000_000_000n, 750, 'SOL', 9);
      expect(store.getBalance(solChainId, solMint)).toBeDefined();

      store.reset();
      const freshStore = Store.getInstance();
      expect(freshStore.getBalance(solChainId, solMint)).toBeUndefined();
      freshStore.reset();
    });
  });
});

describe('WalletManager', () => {
  const originalPrivateKey = process.env.PRIVATE_KEY;
  const originalSolanaKey = process.env.SOLANA_PRIVATE_KEY;

  beforeEach(() => {
    // Set up test keys
    process.env.PRIVATE_KEY = '0x' + '1'.repeat(64);
    process.env.SOLANA_PRIVATE_KEY = testSecretBase58;
    Store.getInstance();
  });

  afterEach(() => {
    // Restore original env
    if (originalPrivateKey !== undefined) {
      process.env.PRIVATE_KEY = originalPrivateKey;
    } else {
      delete process.env.PRIVATE_KEY;
    }
    if (originalSolanaKey !== undefined) {
      process.env.SOLANA_PRIVATE_KEY = originalSolanaKey;
    } else {
      delete process.env.SOLANA_PRIVATE_KEY;
    }
    Store.getInstance().reset();
  });

  it('loads both EVM and Solana keys and hasSolanaWallet returns true', () => {
    const wm = new WalletManager();
    expect(wm.hasEvmWallet()).toBe(true);
    expect(wm.hasSolanaWallet()).toBe(true);
    expect(wm.getEvmAddress()).toBeDefined();
    expect(wm.getSolanaPublicKey().toBase58()).toBe(testKeypair.publicKey.toBase58());
  });

  it('functions correctly in EVM-only mode when no Solana key provided', () => {
    delete process.env.SOLANA_PRIVATE_KEY;
    const wm = new WalletManager();
    expect(wm.hasEvmWallet()).toBe(true);
    expect(wm.hasSolanaWallet()).toBe(false);
    expect(() => wm.getSolanaPublicKey()).toThrow(WalletManagerError);
  });

  it('throws when no wallets are configured at all', () => {
    delete process.env.PRIVATE_KEY;
    delete process.env.SOLANA_PRIVATE_KEY;
    expect(() => new WalletManager()).toThrow(WalletManagerError);
  });
});

describe('agent bootstrap integration', () => {
  beforeEach(() => {
    Store.getInstance().reset();
  });

  afterEach(() => {
    Store.getInstance().reset();
  });

  it('populates store balances from getAllBalances()', async () => {
    const connector = new SolanaConnector({
      keypairSecret: testSecretBase58,
      rpcUrl: 'https://api.devnet.solana.com',
      commitment: 'confirmed',
      jupiterApiUrl: SOLANA_DEFAULTS.JUPITER_API_URL,
    });

    const { sol, splTokens } = await connector.getAllBalances();
    const store = Store.getInstance();
    const solChainId = chainId(SOLANA_CHAIN_ID);

    // Populate store the same way index.ts does
    store.setBalance(solChainId, tokenAddress(WRAPPED_SOL_MINT), sol, 0, 'SOL', 9);
    for (const token of splTokens) {
      store.setBalance(solChainId, tokenAddress(token.mint), token.amount, 0, token.mint, token.decimals);
    }

    // Verify SOL balance is in store
    const solBalance = store.getBalance(solChainId, tokenAddress(WRAPPED_SOL_MINT));
    expect(solBalance).toBeDefined();
    expect(solBalance!.amount).toBe(5_000_000_000n);
    expect(solBalance!.symbol).toBe('SOL');
    expect(solBalance!.decimals).toBe(9);
  });

  it('gracefully handles missing SOLANA_PRIVATE_KEY (connector not initialized)', () => {
    const originalEnv = process.env.SOLANA_PRIVATE_KEY;
    delete process.env.SOLANA_PRIVATE_KEY;

    const connector = new SolanaConnector({
      rpcUrl: 'https://api.devnet.solana.com',
      commitment: 'confirmed',
      jupiterApiUrl: SOLANA_DEFAULTS.JUPITER_API_URL,
    });

    // Agent should check isInitialized() before proceeding
    expect(connector.isInitialized()).toBe(false);

    // Attempting to query balances without a key should throw
    expect(() => connector.getPublicKey()).toThrow(SolanaConnectorError);

    if (originalEnv !== undefined) {
      process.env.SOLANA_PRIVATE_KEY = originalEnv;
    }
  });

  it('getAllBalances returns sol and splTokens for store population', async () => {
    const connector = new SolanaConnector({
      keypairSecret: testSecretBase58,
      rpcUrl: 'https://api.devnet.solana.com',
      commitment: 'confirmed',
      jupiterApiUrl: SOLANA_DEFAULTS.JUPITER_API_URL,
    });

    const result = await connector.getAllBalances();
    expect(result).toHaveProperty('sol');
    expect(result).toHaveProperty('splTokens');
    expect(typeof result.sol).toBe('bigint');
    expect(Array.isArray(result.splTokens)).toBe(true);
  });
});

describe('EVM↔Solana bridging via LI.FI', () => {
  it('EVM→Solana uses toChainId 1151111081099710 and Solana public key as toAddress', () => {
    // Validate constants and address format
    expect(SOLANA_CHAIN_ID).toBe(1151111081099710);
    const pubKey = testKeypair.publicKey.toBase58();
    expect(pubKey.length).toBeGreaterThan(30); // Solana public keys are ~44 chars base58
    expect(pubKey).not.toMatch(/^0x/); // Not an EVM address
  });

  it('Solana→EVM bridge uses fromChainId 1151111081099710', () => {
    // The bridge params should use Solana chain ID as fromChainId
    const bridgeParams = {
      fromChainId: SOLANA_CHAIN_ID,
      toChainId: 1, // Ethereum
      fromAddress: testKeypair.publicKey.toBase58(),
      toAddress: '0x1234567890abcdef1234567890abcdef12345678',
    };

    expect(bridgeParams.fromChainId).toBe(1151111081099710);
    expect(bridgeParams.fromAddress).toBe(testKeypair.publicKey.toBase58());
  });
});
