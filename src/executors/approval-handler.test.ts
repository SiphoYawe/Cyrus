import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApprovalHandler } from './approval-handler.js';
import type { ApprovalPublicClient, ApprovalWalletClient } from './approval-handler.js';
import type { QuoteResult } from '../connectors/types.js';
import { tokenAddress } from '../core/types.js';
import { NATIVE_ADDRESS, USDT_ADDRESSES, CHAINS } from '../core/constants.js';
import { ApprovalError } from '../utils/errors.js';

// --- Mock factories ---

function createMockPublicClient(
  overrides: Partial<ApprovalPublicClient> = {},
): ApprovalPublicClient {
  return {
    readContract: vi.fn().mockResolvedValue(0n),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({
      status: 'success' as const,
      transactionHash: '0xreceipt' as `0x${string}`,
    }),
    ...overrides,
  };
}

function createMockWalletClient(
  overrides: Partial<ApprovalWalletClient> = {},
): ApprovalWalletClient {
  return {
    account: { address: '0x1234567890abcdef1234567890abcdef12345678' as `0x${string}` },
    writeContract: vi.fn().mockResolvedValue('0xapprovalhash' as `0x${string}`),
    ...overrides,
  };
}

function createMockQuote(overrides: Partial<QuoteResult> = {}): QuoteResult {
  return {
    transactionRequest: {
      to: '0xdeadbeef00000000000000000000000000000001',
      data: '0x1234',
      value: '0',
      gasLimit: '200000',
      chainId: 1,
    },
    estimate: {
      approvalAddress: '0xspender0000000000000000000000000000000001',
      toAmount: '990000',
      toAmountMin: '985000',
      executionDuration: 30,
      gasCosts: [{ amount: '1000000000000000', amountUSD: '2.50', token: { symbol: 'ETH' } }],
    },
    tool: 'uniswap',
    toolDetails: { key: 'uniswap', name: 'Uniswap', logoURI: '' },
    action: {
      fromChainId: 1,
      toChainId: 1,
      fromToken: { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
      toToken: { address: '0xdac17f958d2ee523a2206206994597c13d831ec7' },
      fromAmount: '1000000',
    },
    ...overrides,
  };
}

describe('ApprovalHandler', () => {
  let publicClient: ApprovalPublicClient;
  let walletClient: ApprovalWalletClient;
  let handler: ApprovalHandler;

  beforeEach(() => {
    publicClient = createMockPublicClient();
    walletClient = createMockWalletClient();
    handler = new ApprovalHandler(publicClient, walletClient);
  });

  // --- Native token skip ---

  describe('native token', () => {
    it('skips approval for native token (address 0x0)', async () => {
      const quote = createMockQuote();

      const result = await handler.handleApproval(quote, NATIVE_ADDRESS);

      expect(result).toBeNull();
      expect(publicClient.readContract).not.toHaveBeenCalled();
      expect(walletClient.writeContract).not.toHaveBeenCalled();
    });
  });

  // --- Sufficient allowance skip ---

  describe('sufficient allowance', () => {
    it('skips approval when current allowance >= fromAmount', async () => {
      const mockReadContract = vi.fn().mockResolvedValue(2000000n);
      publicClient = createMockPublicClient({ readContract: mockReadContract });
      handler = new ApprovalHandler(publicClient, walletClient);

      const fromToken = tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
      const quote = createMockQuote();

      const result = await handler.handleApproval(quote, fromToken);

      expect(result).toBeNull();
      expect(mockReadContract).toHaveBeenCalledTimes(1);
      expect(walletClient.writeContract).not.toHaveBeenCalled();
    });

    it('skips when allowance exactly equals fromAmount', async () => {
      const mockReadContract = vi.fn().mockResolvedValue(1000000n);
      publicClient = createMockPublicClient({ readContract: mockReadContract });
      handler = new ApprovalHandler(publicClient, walletClient);

      const fromToken = tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
      const quote = createMockQuote();

      const result = await handler.handleApproval(quote, fromToken);

      expect(result).toBeNull();
    });
  });

  // --- Exact amount approval ---

  describe('exact amount approval', () => {
    it('approves exact fromAmount when allowance is insufficient', async () => {
      const mockReadContract = vi.fn().mockResolvedValue(0n);
      const mockWriteContract = vi.fn().mockResolvedValue('0xapprove123' as `0x${string}`);
      publicClient = createMockPublicClient({ readContract: mockReadContract });
      walletClient = createMockWalletClient({ writeContract: mockWriteContract });
      handler = new ApprovalHandler(publicClient, walletClient);

      const fromToken = tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
      const quote = createMockQuote();

      const result = await handler.handleApproval(quote, fromToken);

      expect(result).toBe('0xapprove123');
      expect(mockWriteContract).toHaveBeenCalledTimes(1);

      // Verify it approved the exact amount (1000000n from action.fromAmount)
      const approveCall = mockWriteContract.mock.calls[0][0];
      expect(approveCall.functionName).toBe('approve');
      expect(approveCall.args[1]).toBe(1000000n); // exact amount, not maxUint256
    });

    it('returns the approval tx hash', async () => {
      const expectedHash = '0xmytxhash000000000000000000000000000000000000000000000000000000ab';
      const mockWriteContract = vi.fn().mockResolvedValue(expectedHash as `0x${string}`);
      publicClient = createMockPublicClient();
      walletClient = createMockWalletClient({ writeContract: mockWriteContract });
      handler = new ApprovalHandler(publicClient, walletClient);

      const fromToken = tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
      const quote = createMockQuote();

      const result = await handler.handleApproval(quote, fromToken);

      expect(result).toBe(expectedHash);
    });
  });

  // --- Approval address from quote ---

  describe('approval address from quote', () => {
    it('uses estimate.approvalAddress as the spender, never hardcoded', async () => {
      const customApprovalAddr = '0xcustom0000000000000000000000000000000099';
      const mockWriteContract = vi.fn().mockResolvedValue('0xtx' as `0x${string}`);
      publicClient = createMockPublicClient();
      walletClient = createMockWalletClient({ writeContract: mockWriteContract });
      handler = new ApprovalHandler(publicClient, walletClient);

      const fromToken = tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
      const quote = createMockQuote({
        estimate: {
          approvalAddress: customApprovalAddr,
          toAmount: '990000',
          toAmountMin: '985000',
          executionDuration: 30,
          gasCosts: [],
        },
      });

      await handler.handleApproval(quote, fromToken);

      // Check that readContract used the custom approval address
      const readCall = (publicClient.readContract as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(readCall.args[1]).toBe(customApprovalAddr);

      // Check that writeContract used the custom approval address
      const writeCall = mockWriteContract.mock.calls[0][0];
      expect(writeCall.args[0]).toBe(customApprovalAddr);
    });
  });

  // --- USDT zero-reset pattern ---

  describe('USDT zero-reset pattern', () => {
    it('resets allowance to 0 before approving new amount for USDT', async () => {
      const usdtAddress = USDT_ADDRESSES[CHAINS.ETHEREUM];
      const callOrder: string[] = [];

      const mockReadContract = vi.fn().mockResolvedValue(500000n); // existing non-zero allowance
      const mockWriteContract = vi.fn().mockImplementation(async (args: { args: readonly [string, bigint] }) => {
        const amount = args.args[1];
        callOrder.push(amount === 0n ? 'reset-to-zero' : 'approve-amount');
        return '0xtx' as `0x${string}`;
      });

      publicClient = createMockPublicClient({ readContract: mockReadContract });
      walletClient = createMockWalletClient({ writeContract: mockWriteContract });
      handler = new ApprovalHandler(publicClient, walletClient);

      const quote = createMockQuote();

      await handler.handleApproval(quote, usdtAddress);

      // Should have called writeContract twice: reset to 0, then approve amount
      expect(mockWriteContract).toHaveBeenCalledTimes(2);
      expect(callOrder).toEqual(['reset-to-zero', 'approve-amount']);

      // First call: approve to 0
      const resetCall = mockWriteContract.mock.calls[0][0];
      expect(resetCall.args[1]).toBe(0n);

      // Second call: approve exact amount
      const approveCall = mockWriteContract.mock.calls[1][0];
      expect(approveCall.args[1]).toBe(1000000n);
    });

    it('skips zero-reset for USDT when current allowance is 0', async () => {
      const usdtAddress = USDT_ADDRESSES[CHAINS.ETHEREUM];

      const mockReadContract = vi.fn().mockResolvedValue(0n);
      const mockWriteContract = vi.fn().mockResolvedValue('0xtx' as `0x${string}`);

      publicClient = createMockPublicClient({ readContract: mockReadContract });
      walletClient = createMockWalletClient({ writeContract: mockWriteContract });
      handler = new ApprovalHandler(publicClient, walletClient);

      const quote = createMockQuote();

      await handler.handleApproval(quote, usdtAddress);

      // Should only approve once (no reset needed)
      expect(mockWriteContract).toHaveBeenCalledTimes(1);
      expect(mockWriteContract.mock.calls[0][0].args[1]).toBe(1000000n);
    });

    it('does NOT do zero-reset for non-USDT tokens', async () => {
      const usdcAddress = tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'); // USDC, not USDT

      const mockReadContract = vi.fn().mockResolvedValue(500000n); // existing allowance
      const mockWriteContract = vi.fn().mockResolvedValue('0xtx' as `0x${string}`);

      publicClient = createMockPublicClient({ readContract: mockReadContract });
      walletClient = createMockWalletClient({ writeContract: mockWriteContract });
      handler = new ApprovalHandler(publicClient, walletClient);

      const quote = createMockQuote();

      await handler.handleApproval(quote, usdcAddress);

      // Should only approve once (no reset needed for non-USDT)
      expect(mockWriteContract).toHaveBeenCalledTimes(1);
      expect(mockWriteContract.mock.calls[0][0].args[1]).toBe(1000000n);
    });
  });

  // --- Error handling ---

  describe('error handling', () => {
    it('throws ApprovalError when writeContract fails', async () => {
      const mockWriteContract = vi.fn().mockRejectedValue(new Error('gas estimation failed'));
      publicClient = createMockPublicClient();
      walletClient = createMockWalletClient({ writeContract: mockWriteContract });
      handler = new ApprovalHandler(publicClient, walletClient);

      const fromToken = tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
      const quote = createMockQuote();

      await expect(handler.handleApproval(quote, fromToken)).rejects.toBeInstanceOf(ApprovalError);
    });

    it('throws ApprovalError when receipt status is reverted', async () => {
      publicClient = createMockPublicClient({
        waitForTransactionReceipt: vi.fn().mockResolvedValue({
          status: 'reverted',
          transactionHash: '0xfailed',
        }),
      });
      walletClient = createMockWalletClient();
      handler = new ApprovalHandler(publicClient, walletClient);

      const fromToken = tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
      const quote = createMockQuote();

      await expect(handler.handleApproval(quote, fromToken)).rejects.toBeInstanceOf(ApprovalError);
    });
  });
});
