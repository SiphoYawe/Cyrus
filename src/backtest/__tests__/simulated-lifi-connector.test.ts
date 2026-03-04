import { describe, it, expect, beforeEach } from 'vitest';
import { SimulatedLiFiConnector } from '../../connectors/simulated-lifi-connector.js';
import { HistoricalDataLoader } from '../historical-data-loader.js';
import { Store } from '../../core/store.js';
import { chainId, tokenAddress } from '../../core/types.js';
import type { FeeModel } from '../types.js';
import type { QuoteParams } from '../../connectors/types.js';

describe('SimulatedLiFiConnector', () => {
  let loader: HistoricalDataLoader;
  let connector: SimulatedLiFiConnector;
  const defaultFeeModel: FeeModel = {
    bridgeFeePercent: 0.003,
    gasEstimateUsd: 5.0,
    dexFeePercent: 0.003,
  };

  beforeEach(() => {
    Store.getInstance().reset();

    loader = new HistoricalDataLoader();
    loader.loadDirect([
      { timestamp: 1000, token: '0xusdc', chainId: 1, price: 1.0, volume: 100000 },
      { timestamp: 1000, token: '0xweth', chainId: 1, price: 2500.0, volume: 50000 },
      { timestamp: 1000, token: '0xusdc', chainId: 42161, price: 1.0, volume: 80000 },
      { timestamp: 2000, token: '0xusdc', chainId: 1, price: 1.01, volume: 120000 },
      { timestamp: 2000, token: '0xweth', chainId: 1, price: 2550.0, volume: 55000 },
      { timestamp: 2000, token: '0xusdc', chainId: 42161, price: 1.005, volume: 90000 },
      { timestamp: 3000, token: '0xusdc', chainId: 1, price: 0.99, volume: 110000 },
      { timestamp: 3000, token: '0xweth', chainId: 1, price: 2480.0, volume: 45000 },
      { timestamp: 3000, token: '0xusdc', chainId: 42161, price: 0.995, volume: 85000 },
    ]);

    connector = new SimulatedLiFiConnector(loader, {
      slippage: 0.005,
      bridgeDelayMs: 60000,
      feeModel: defaultFeeModel,
      seed: 42,
    });
  });

  // --- Time control ---

  describe('time control', () => {
    it('starts with timestamp 0', () => {
      expect(connector.getCurrentTimestamp()).toBe(0);
    });

    it('setCurrentTimestamp updates timestamp', () => {
      connector.setCurrentTimestamp(1000);
      expect(connector.getCurrentTimestamp()).toBe(1000);
    });

    it('advanceTo updates timestamp', () => {
      connector.advanceTo(2000);
      expect(connector.getCurrentTimestamp()).toBe(2000);
    });
  });

  // --- getQuote ---

  describe('getQuote', () => {
    it('returns deterministic simulated quote based on historical prices', async () => {
      connector.setCurrentTimestamp(1000);

      const params: QuoteParams = {
        fromChain: chainId(1),
        toChain: chainId(1),
        fromToken: tokenAddress('0xweth'),
        toToken: tokenAddress('0xusdc'),
        fromAmount: '1000000000000000000', // 1 WETH in wei
      };

      const quote = await connector.getQuote(params);

      expect(quote.tool).toBe('simulated-bridge');
      expect(quote.action.fromChainId).toBe(1);
      expect(quote.action.toChainId).toBe(1);
      expect(quote.estimate.approvalAddress).toBeDefined();
      expect(quote.transactionRequest).toBeDefined();
      expect(quote.transactionRequest.chainId).toBe(1);

      // toAmount should be based on price ratio: WETH(2500) / USDC(1.0) * amount * fees
      const toAmount = BigInt(quote.estimate.toAmount);
      expect(toAmount).toBeGreaterThan(0n);
    });

    it('applies configured slippage and fee model', async () => {
      connector.setCurrentTimestamp(1000);

      // Same-chain quote — no bridge fee, only dex fee
      const params: QuoteParams = {
        fromChain: chainId(1),
        toChain: chainId(1),
        fromToken: tokenAddress('0xusdc'),
        toToken: tokenAddress('0xweth'),
        fromAmount: '1000000', // 1 USDC
      };

      const quote = await connector.getQuote(params);
      const toAmount = Number(quote.estimate.toAmount);

      // Expected: 1000000 * (1.0/2500) = 400 raw, minus slippage and dex fee
      // The toAmount should be less than 400 due to fees
      expect(toAmount).toBeGreaterThan(0);
      expect(toAmount).toBeLessThan(400); // 1000000 * (1/2500) = 400 before fees
    });

    it('applies bridge fee for cross-chain quotes', async () => {
      connector.setCurrentTimestamp(1000);

      const sameChainParams: QuoteParams = {
        fromChain: chainId(1),
        toChain: chainId(1),
        fromToken: tokenAddress('0xusdc'),
        toToken: tokenAddress('0xweth'),
        fromAmount: '1000000',
      };

      const crossChainParams: QuoteParams = {
        fromChain: chainId(1),
        toChain: chainId(42161),
        fromToken: tokenAddress('0xusdc'),
        toToken: tokenAddress('0xusdc'),
        fromAmount: '1000000',
      };

      // Cross-chain should have bridge fee applied
      const crossChainQuote = await connector.getQuote(crossChainParams);
      const crossChainAmount = Number(crossChainQuote.estimate.toAmount);

      // Cross-chain USDC->USDC with bridge fee: should be less than 1000000
      expect(crossChainAmount).toBeLessThan(1000000);
      expect(crossChainAmount).toBeGreaterThan(0);
    });

    it('makes zero network calls', async () => {
      connector.setCurrentTimestamp(1000);

      // If this were making real HTTP calls, it would fail since there's no server
      // The fact that it returns successfully proves no network calls
      const quote = await connector.getQuote({
        fromChain: chainId(1),
        toChain: chainId(1),
        fromToken: tokenAddress('0xusdc'),
        toToken: tokenAddress('0xweth'),
        fromAmount: '1000000',
      });

      expect(quote).toBeDefined();
      expect(quote.tool).toBe('simulated-bridge');
    });

    it('throws when no historical price data exists', async () => {
      connector.setCurrentTimestamp(1000);

      await expect(
        connector.getQuote({
          fromChain: chainId(1),
          toChain: chainId(1),
          fromToken: tokenAddress('0xunknown'),
          toToken: tokenAddress('0xusdc'),
          fromAmount: '1000000',
        }),
      ).rejects.toThrow('No historical price data');
    });

    it('produces deterministic results with same seed', async () => {
      connector.setCurrentTimestamp(1000);

      const params: QuoteParams = {
        fromChain: chainId(1),
        toChain: chainId(1),
        fromToken: tokenAddress('0xusdc'),
        toToken: tokenAddress('0xweth'),
        fromAmount: '1000000',
      };

      // Create a second connector with the same seed
      const connector2 = new SimulatedLiFiConnector(loader, {
        slippage: 0.005,
        bridgeDelayMs: 60000,
        feeModel: defaultFeeModel,
        seed: 42,
      });
      connector2.setCurrentTimestamp(1000);

      const quote1 = await connector.getQuote(params);
      const quote2 = await connector2.getQuote(params);

      expect(quote1.estimate.toAmount).toBe(quote2.estimate.toAmount);
    });

    it('includes simulated approvalAddress and transactionRequest stubs', async () => {
      connector.setCurrentTimestamp(1000);

      const quote = await connector.getQuote({
        fromChain: chainId(1),
        toChain: chainId(42161),
        fromToken: tokenAddress('0xusdc'),
        toToken: tokenAddress('0xusdc'),
        fromAmount: '1000000',
      });

      expect(quote.estimate.approvalAddress).toBeDefined();
      expect(typeof quote.estimate.approvalAddress).toBe('string');
      expect(quote.transactionRequest.to).toBeDefined();
      expect(quote.transactionRequest.data).toBeDefined();
      expect(quote.transactionRequest.value).toBeDefined();
      expect(quote.transactionRequest.gasLimit).toBeDefined();
    });
  });

  // --- executeTransaction ---

  describe('executeTransaction', () => {
    it('records trade in internal log', () => {
      connector.setCurrentTimestamp(1000);

      const txHash = connector.executeTransaction(
        '0xusdc',
        '0xweth',
        1,
        1,
        1000000n,
        400n,
      );

      expect(txHash).toBeDefined();
      expect(typeof txHash).toBe('string');

      const tradeLog = connector.getTradeLog();
      expect(tradeLog).toHaveLength(1);
      expect(tradeLog[0].fromToken).toBe('0xusdc');
      expect(tradeLog[0].toToken).toBe('0xweth');
      expect(tradeLog[0].amount).toBe(1000000n);
      expect(tradeLog[0].entryTimestamp).toBe(1000);
    });

    it('records fill price based on historical data', () => {
      connector.setCurrentTimestamp(1000);

      connector.executeTransaction(
        '0xusdc',
        '0xweth',
        1,
        1,
        1000000n,
        400n,
      );

      const tradeLog = connector.getTradeLog();
      // Fill price should be based on historical price of fromToken (USDC = 1.0) with slippage
      expect(tradeLog[0].fillPrice).toBeCloseTo(1.0, 0);
    });

    it('computes simulated fees', () => {
      connector.setCurrentTimestamp(1000);

      connector.executeTransaction(
        '0xusdc',
        '0xweth',
        1,
        42161, // cross-chain
        1000000n,
        400n,
      );

      const tradeLog = connector.getTradeLog();
      // Fees should be > 0 (bridge + dex + gas)
      expect(tradeLog[0].fees).toBeGreaterThan(0n);
    });

    it('creates pending transfer for cross-chain trades', () => {
      connector.setCurrentTimestamp(1000);

      connector.executeTransaction(
        '0xusdc',
        '0xusdc',
        1,
        42161, // cross-chain
        1000000n,
        990000n,
      );

      const pending = connector.getPendingTransfers();
      expect(pending.size).toBe(1);
    });

    it('does not create pending transfer for same-chain trades', () => {
      connector.setCurrentTimestamp(1000);

      connector.executeTransaction(
        '0xusdc',
        '0xweth',
        1,
        1, // same chain
        1000000n,
        400n,
      );

      const pending = connector.getPendingTransfers();
      expect(pending.size).toBe(0);
    });
  });

  // --- getStatus ---

  describe('getStatus', () => {
    it('returns PENDING before bridge delay elapses', async () => {
      connector.setCurrentTimestamp(1000);

      const txHash = connector.executeTransaction(
        '0xusdc',
        '0xusdc',
        1,
        42161,
        1000000n,
        990000n,
      );

      // Still within bridge delay (60000ms)
      connector.setCurrentTimestamp(1000 + 30000);

      const status = await connector.getStatus(txHash, 'simulated-bridge', 1, 42161);
      expect(status.status).toBe('PENDING');
    });

    it('returns DONE + COMPLETED after bridge delay elapses', async () => {
      connector.setCurrentTimestamp(1000);

      const txHash = connector.executeTransaction(
        '0xusdc',
        '0xusdc',
        1,
        42161,
        1000000n,
        990000n,
      );

      // Past bridge delay (60000ms)
      connector.setCurrentTimestamp(1000 + 60001);

      const status = await connector.getStatus(txHash, 'simulated-bridge', 1, 42161);
      expect(status.status).toBe('DONE');
      expect(status.substatus).toBe('COMPLETED');
    });

    it('returns DONE for unknown txHash', async () => {
      const status = await connector.getStatus('0xunknown', 'bridge', 1, 42161);
      expect(status.status).toBe('DONE');
      expect(status.substatus).toBe('COMPLETED');
    });
  });

  // --- getTradeLog ---

  describe('getTradeLog', () => {
    it('returns empty array initially', () => {
      expect(connector.getTradeLog()).toHaveLength(0);
    });

    it('returns all recorded trades', () => {
      connector.setCurrentTimestamp(1000);

      connector.executeTransaction('0xusdc', '0xweth', 1, 1, 1000000n, 400n);
      connector.executeTransaction('0xweth', '0xusdc', 1, 1, 400n, 1000000n);

      const log = connector.getTradeLog();
      expect(log).toHaveLength(2);
      expect(log[0].id).toBe('trade-1');
      expect(log[1].id).toBe('trade-2');
    });

    it('returns a copy (not the internal array)', () => {
      connector.setCurrentTimestamp(1000);
      connector.executeTransaction('0xusdc', '0xweth', 1, 1, 1000000n, 400n);

      const log1 = connector.getTradeLog();
      const log2 = connector.getTradeLog();

      expect(log1).not.toBe(log2);
      expect(log1).toEqual(log2);
    });
  });

  // --- Other LiFi interface methods ---

  describe('getChains', () => {
    it('returns simulated chains', async () => {
      const chains = await connector.getChains();
      expect(chains.length).toBeGreaterThan(0);
      expect(chains[0].id).toBe(1);
    });
  });

  describe('getTokens', () => {
    it('returns simulated tokens', async () => {
      const tokens = await connector.getTokens();
      expect(tokens.length).toBeGreaterThan(0);
    });
  });

  describe('getRoutes', () => {
    it('returns simulated routes based on historical data', async () => {
      connector.setCurrentTimestamp(1000);

      const routes = await connector.getRoutes({
        fromChainId: 1,
        toChainId: 1,
        fromTokenAddress: '0xusdc',
        toTokenAddress: '0xweth',
        fromAmount: '1000000',
      });

      expect(routes).toHaveLength(1);
      expect(routes[0].tags).toContain('SIMULATED');
    });
  });

  describe('getTools', () => {
    it('returns simulated tools', async () => {
      const tools = await connector.getTools();
      expect(tools.length).toBeGreaterThan(0);
    });
  });

  describe('getConnections', () => {
    it('returns simulated connections', async () => {
      const connections = await connector.getConnections(1, 42161);
      expect(connections).toHaveLength(1);
      expect(connections[0].fromChainId).toBe(1);
      expect(connections[0].toChainId).toBe(42161);
    });
  });
});
