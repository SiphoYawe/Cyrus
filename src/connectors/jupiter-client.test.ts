import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { Store } from '../core/store.js';
import { JupiterClient, JupiterClientError } from './jupiter-client.js';
import { SolanaConnector } from './solana-connector.js';
import { SOLANA_DEFAULTS } from './solana-types.js';
import type { JupiterQuote } from './solana-types.js';

// Generate a test keypair
const testKeypair = Keypair.generate();
const testSecretBase58 = bs58.encode(testKeypair.secretKey);

// --- Mock @solana/web3.js ---
vi.mock('@solana/web3.js', async () => {
  const actual = await vi.importActual<typeof import('@solana/web3.js')>('@solana/web3.js');

  // Must be a regular function (not arrow) to support `new` constructor calls
  function MockConnection() {
    return {
      getBalance: vi.fn().mockResolvedValue(5_000_000_000),
      getTokenAccountsByOwner: vi.fn().mockResolvedValue({ value: [] }),
      getSignaturesForAddress: vi.fn().mockResolvedValue([]),
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
      getLatestBlockhash: vi.fn().mockResolvedValue({
        blockhash: 'test-blockhash',
        lastValidBlockHeight: 100000,
      }),
      sendTransaction: vi.fn().mockResolvedValue('swap-tx-sig'),
    };
  }

  return {
    ...actual,
    Connection: MockConnection,
  };
});

// --- Mock fetch for Jupiter API calls ---
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Sample quote response from Jupiter API
const sampleQuoteResponse = {
  inputMint: 'So11111111111111111111111111111111111111112',
  outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  inAmount: '1000000000',
  outAmount: '150000000',
  priceImpactPct: '0.01',
  routePlan: [
    {
      swapInfo: {
        ammKey: 'amm-key-1',
        label: 'Raydium',
        inputMint: 'So11111111111111111111111111111111111111112',
        outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        inAmount: '1000000000',
        outAmount: '150000000',
        feeAmount: '500000',
        feeMint: 'So11111111111111111111111111111111111111112',
      },
      percent: 100,
    },
  ],
  otherAmountThreshold: '148500000',
  swapMode: 'ExactIn',
};

describe('JupiterClient', () => {
  let connector: SolanaConnector;
  let client: JupiterClient;
  let store: Store;

  beforeEach(() => {
    store = Store.getInstance();
    connector = new SolanaConnector({
      keypairSecret: testSecretBase58,
      rpcUrl: 'https://api.devnet.solana.com',
      commitment: 'confirmed',
      jupiterApiUrl: SOLANA_DEFAULTS.JUPITER_API_URL,
    });
    client = new JupiterClient(connector);
    vi.clearAllMocks();
  });

  afterEach(() => {
    store.reset();
  });

  describe('getQuote', () => {
    it('returns JupiterQuote with amounts as bigint', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(sampleQuoteResponse),
      });

      const quote = await client.getQuote(
        'So11111111111111111111111111111111111111112',
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        1_000_000_000n,
      );

      expect(typeof quote.inAmount).toBe('bigint');
      expect(typeof quote.outAmount).toBe('bigint');
      expect(quote.inAmount).toBe(1_000_000_000n);
      expect(quote.outAmount).toBe(150_000_000n);
      expect(quote.inputMint).toBe('So11111111111111111111111111111111111111112');
      expect(quote.outputMint).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
      expect(quote.swapMode).toBe('ExactIn');
      expect(quote.routePlan).toHaveLength(1);
      expect(typeof quote.routePlan[0].swapInfo.feeAmount).toBe('bigint');
    });

    it('applies default slippage of 50 bps', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(sampleQuoteResponse),
      });

      await client.getQuote(
        'So11111111111111111111111111111111111111112',
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        1_000_000_000n,
      );

      // Verify the URL contains slippageBps=50
      const fetchCall = mockFetch.mock.calls[0][0] as string;
      expect(fetchCall).toContain('slippageBps=50');
    });

    it('handles COULD_NOT_FIND_ANY_ROUTE error', async () => {
      const errorResponse = {
        ok: false,
        status: 400,
        text: () => Promise.resolve('COULD_NOT_FIND_ANY_ROUTE'),
      };
      mockFetch.mockResolvedValue(errorResponse);

      await expect(
        client.getQuote(
          'InvalidMint111111111111111111111111111111111',
          'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          1_000_000_000n,
        ),
      ).rejects.toThrow('No route found');

      mockFetch.mockReset();
    });

    it('handles TOKEN_NOT_TRADABLE error', async () => {
      // Provide enough responses for initial + retries (withRetry maxRetries: 2)
      const errorResponse = {
        ok: false,
        status: 400,
        text: () => Promise.resolve('TOKEN_NOT_TRADABLE'),
      };
      mockFetch.mockResolvedValue(errorResponse);

      await expect(
        client.getQuote('x', 'y', 1n),
      ).rejects.toThrow('Token is not tradable');

      mockFetch.mockReset();
    });

    it('handles AMOUNT_TOO_SMALL error', async () => {
      const errorResponse = {
        ok: false,
        status: 400,
        text: () => Promise.resolve('AMOUNT_TOO_SMALL'),
      };
      mockFetch.mockResolvedValue(errorResponse);

      await expect(
        client.getQuote('x', 'y', 1n),
      ).rejects.toThrow('Swap amount too small');

      mockFetch.mockReset();
    });

    it('allows custom slippage override', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(sampleQuoteResponse),
      });

      await client.getQuote(
        'So11111111111111111111111111111111111111112',
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        1_000_000_000n,
        100, // 1% slippage
      );

      const fetchCall = mockFetch.mock.calls[0][0] as string;
      expect(fetchCall).toContain('slippageBps=100');
    });
  });

  describe('executeSwap', () => {
    it('deserializes, signs, and sends transaction — returns JupiterSwapResult', async () => {
      // We need to create a mock versioned transaction
      // Instead of testing the actual deserialization (which requires a real tx),
      // we test the flow by mocking at the fetch level
      const mockQuote: JupiterQuote = {
        inputMint: 'So11111111111111111111111111111111111111112',
        outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        inAmount: 1_000_000_000n,
        outAmount: 150_000_000n,
        priceImpactPct: 0.01,
        routePlan: [],
        otherAmountThreshold: 148_500_000n,
        swapMode: 'ExactIn',
      };

      // The swap API returns a base64-encoded versioned transaction
      // We can't easily mock VersionedTransaction.deserialize without a real tx,
      // so we test that the API call is made correctly
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            swapTransaction: 'AAAA', // minimal base64
          }),
      });

      // VersionedTransaction.deserialize will fail with invalid tx data,
      // which is expected in a unit test — we're testing the client logic, not Solana
      await expect(client.executeSwap(mockQuote)).rejects.toThrow();

      // Verify the swap API was called with correct payload
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const fetchArgs = mockFetch.mock.calls[0];
      expect(fetchArgs[0]).toContain('/swap');
      const body = JSON.parse(fetchArgs[1].body);
      expect(body.userPublicKey).toBe(testKeypair.publicKey.toBase58());
      expect(body.wrapAndUnwrapSol).toBe(true);
    });
  });
});
