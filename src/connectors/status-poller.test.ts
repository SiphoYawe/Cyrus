import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StatusPoller } from './status-poller.js';
import type { LiFiConnectorInterface, LiFiStatusResponse } from './types.js';

function createMockConnector(): LiFiConnectorInterface {
  return {
    getQuote: vi.fn(),
    getRoutes: vi.fn(),
    getChains: vi.fn(),
    getTokens: vi.fn(),
    getStatus: vi.fn(),
    getConnections: vi.fn(),
    getTools: vi.fn(),
  };
}

const noopSleep = () => Promise.resolve();

describe('StatusPoller', () => {
  let mockConnector: ReturnType<typeof createMockConnector>;

  beforeEach(() => {
    mockConnector = createMockConnector();
  });

  describe('getPollingDelay', () => {
    it('returns 10s for attempts 1-6 (Tier 1)', () => {
      expect(StatusPoller.getPollingDelay(1)).toBe(10_000);
      expect(StatusPoller.getPollingDelay(3)).toBe(10_000);
      expect(StatusPoller.getPollingDelay(6)).toBe(10_000);
    });

    it('returns 30s for attempts 7-12 (Tier 2)', () => {
      expect(StatusPoller.getPollingDelay(7)).toBe(30_000);
      expect(StatusPoller.getPollingDelay(10)).toBe(30_000);
      expect(StatusPoller.getPollingDelay(12)).toBe(30_000);
    });

    it('returns 60s for attempts 13-24 (Tier 3)', () => {
      expect(StatusPoller.getPollingDelay(13)).toBe(60_000);
      expect(StatusPoller.getPollingDelay(18)).toBe(60_000);
      expect(StatusPoller.getPollingDelay(24)).toBe(60_000);
    });

    it('returns 120s for attempts 25+ (Tier 4)', () => {
      expect(StatusPoller.getPollingDelay(25)).toBe(120_000);
      expect(StatusPoller.getPollingDelay(50)).toBe(120_000);
      expect(StatusPoller.getPollingDelay(100)).toBe(120_000);
    });
  });

  describe('pollUntilTerminal', () => {
    it('returns immediately when status is DONE on first poll', async () => {
      const response: LiFiStatusResponse = {
        status: 'DONE',
        substatus: 'COMPLETED',
        receiving: {
          amount: '995000',
          token: {
            address: '0xabc',
            symbol: 'USDC',
            decimals: 6,
            chainId: 42161,
            name: 'USD Coin',
          },
          chainId: 42161,
        },
        tool: 'stargate',
      };

      (mockConnector.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue(response);

      const poller = new StatusPoller(mockConnector, { sleep: noopSleep });

      const result = await poller.pollUntilTerminal({
        txHash: '0xhash',
        bridge: 'stargate',
        fromChain: 1,
        toChain: 42161,
      });

      expect(result.status).toBe('DONE');
      expect(result.substatus).toBe('COMPLETED');
      expect(result.receiving?.amount).toBe('995000');
      expect(mockConnector.getStatus).toHaveBeenCalledTimes(1);
    });

    it('returns immediately when status is FAILED on first poll', async () => {
      const response: LiFiStatusResponse = {
        status: 'FAILED',
      };

      (mockConnector.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue(response);

      const poller = new StatusPoller(mockConnector, { sleep: noopSleep });

      const result = await poller.pollUntilTerminal({
        txHash: '0xhash',
        bridge: 'stargate',
        fromChain: 1,
        toChain: 42161,
      });

      expect(result.status).toBe('FAILED');
      expect(mockConnector.getStatus).toHaveBeenCalledTimes(1);
    });

    it('polls through NOT_FOUND and PENDING until DONE', async () => {
      const getStatusMock = mockConnector.getStatus as ReturnType<typeof vi.fn>;

      getStatusMock
        .mockResolvedValueOnce({ status: 'NOT_FOUND' })
        .mockResolvedValueOnce({ status: 'NOT_FOUND' })
        .mockResolvedValueOnce({ status: 'PENDING' })
        .mockResolvedValueOnce({
          status: 'DONE',
          substatus: 'COMPLETED',
          receiving: {
            amount: '1000',
            token: { address: '0x1', symbol: 'TKN', decimals: 18, chainId: 1, name: 'Token' },
            chainId: 1,
          },
        });

      const poller = new StatusPoller(mockConnector, { sleep: noopSleep });

      const result = await poller.pollUntilTerminal({
        txHash: '0xhash',
        bridge: 'stargate',
        fromChain: 1,
        toChain: 42161,
      });

      expect(result.status).toBe('DONE');
      expect(result.substatus).toBe('COMPLETED');
      expect(getStatusMock).toHaveBeenCalledTimes(4);
    });

    it('times out after max duration', async () => {
      (mockConnector.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: 'PENDING',
      });

      // Use a very short max duration
      const poller = new StatusPoller(mockConnector, {
        maxDurationMs: 1,
        sleep: noopSleep,
      });

      // Need to add a small delay so Date.now() advances
      const sleepWithTick = async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
      };

      const poller2 = new StatusPoller(mockConnector, {
        maxDurationMs: 5,
        sleep: sleepWithTick,
      });

      const result = await poller2.pollUntilTerminal({
        txHash: '0xhash',
        bridge: 'stargate',
        fromChain: 1,
        toChain: 42161,
      });

      expect(result.status).toBe('FAILED');
    });

    it('continues polling when getStatus throws an error', async () => {
      const getStatusMock = mockConnector.getStatus as ReturnType<typeof vi.fn>;

      getStatusMock
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({
          status: 'DONE',
          substatus: 'COMPLETED',
          receiving: {
            amount: '500',
            token: { address: '0x1', symbol: 'X', decimals: 18, chainId: 1, name: 'X' },
            chainId: 1,
          },
        });

      const poller = new StatusPoller(mockConnector, { sleep: noopSleep });

      const result = await poller.pollUntilTerminal({
        txHash: '0xhash',
        bridge: 'hop',
        fromChain: 1,
        toChain: 10,
      });

      expect(result.status).toBe('DONE');
      expect(getStatusMock).toHaveBeenCalledTimes(2);
    });

    it('respects abort signal', async () => {
      (mockConnector.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: 'PENDING',
      });

      const controller = new AbortController();
      // Abort immediately
      controller.abort();

      const poller = new StatusPoller(mockConnector, { sleep: noopSleep });

      const result = await poller.pollUntilTerminal(
        {
          txHash: '0xhash',
          bridge: 'stargate',
          fromChain: 1,
          toChain: 42161,
        },
        controller.signal,
      );

      expect(result.status).toBe('FAILED');
      expect(mockConnector.getStatus).not.toHaveBeenCalled();
    });

    it('passes correct parameters to connector.getStatus', async () => {
      (mockConnector.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: 'DONE',
        substatus: 'COMPLETED',
      });

      const poller = new StatusPoller(mockConnector, { sleep: noopSleep });

      await poller.pollUntilTerminal({
        txHash: '0xtxhash123',
        bridge: 'across',
        fromChain: 1,
        toChain: 42161,
      });

      expect(mockConnector.getStatus).toHaveBeenCalledWith(
        '0xtxhash123',
        'across',
        1,
        42161,
      );
    });

    it('calls sleep with correct backoff delay', async () => {
      const sleepFn = vi.fn().mockResolvedValue(undefined);
      const getStatusMock = mockConnector.getStatus as ReturnType<typeof vi.fn>;

      getStatusMock
        .mockResolvedValueOnce({ status: 'PENDING' })
        .mockResolvedValueOnce({ status: 'DONE', substatus: 'COMPLETED' });

      const poller = new StatusPoller(mockConnector, { sleep: sleepFn });

      await poller.pollUntilTerminal({
        txHash: '0xhash',
        bridge: 'stargate',
        fromChain: 1,
        toChain: 42161,
      });

      // After first attempt (PENDING), sleep should be called with Tier 1 delay
      expect(sleepFn).toHaveBeenCalledTimes(1);
      expect(sleepFn).toHaveBeenCalledWith(10_000);
    });
  });
});
