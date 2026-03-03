// Token approval handling for ERC20 tokens before swap/bridge execution
// CRITICAL: Never hardcode LI.FI contract addresses — always use estimate.approvalAddress from quote
// CRITICAL: Always approve exact amounts — NEVER approve maxUint256
// CRITICAL: USDT requires reset to 0 before new non-zero approval

import type { QuoteResult } from '../connectors/types.js';
import type { TokenAddress } from '../core/types.js';
import { NATIVE_ADDRESS, USDT_ADDRESSES } from '../core/constants.js';
import { ApprovalError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('approval-handler');

const ERC20_ABI = [
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

// Minimal interfaces for viem client operations — used for testability
export interface ApprovalPublicClient {
  readContract(args: {
    address: `0x${string}`;
    abi: typeof ERC20_ABI;
    functionName: 'allowance';
    args: readonly [`0x${string}`, `0x${string}`];
  }): Promise<bigint>;
  waitForTransactionReceipt(args: {
    hash: `0x${string}`;
  }): Promise<{ status: 'success' | 'reverted'; transactionHash: `0x${string}` }>;
}

export interface ApprovalWalletClient {
  account: { address: `0x${string}` } | undefined;
  writeContract(args: {
    address: `0x${string}`;
    abi: typeof ERC20_ABI;
    functionName: 'approve';
    args: readonly [`0x${string}`, bigint];
  }): Promise<`0x${string}`>;
}

function isUsdtToken(tokenAddress: TokenAddress): boolean {
  const lowerAddr = tokenAddress.toLowerCase();
  for (const addr of Object.values(USDT_ADDRESSES)) {
    if (addr.toLowerCase() === lowerAddr) {
      return true;
    }
  }
  return false;
}

export class ApprovalHandler {
  private readonly publicClient: ApprovalPublicClient;
  private readonly walletClient: ApprovalWalletClient;

  constructor(publicClient: ApprovalPublicClient, walletClient: ApprovalWalletClient) {
    this.publicClient = publicClient;
    this.walletClient = walletClient;
  }

  /**
   * Handle token approval for a quote. Returns the approval tx hash or null if skipped.
   * Skips if:
   *   - fromToken is native (ETH)
   *   - current allowance is already >= fromAmount
   * Handles USDT zero-reset pattern.
   */
  async handleApproval(
    quote: QuoteResult,
    fromToken: TokenAddress,
  ): Promise<string | null> {
    const approvalAddress = quote.estimate.approvalAddress;

    // Skip native tokens — no approval needed
    if (fromToken.toLowerCase() === NATIVE_ADDRESS.toLowerCase()) {
      logger.info({ fromToken }, 'Skipping approval for native token');
      return null;
    }

    const account = this.walletClient.account;
    if (!account) {
      throw new ApprovalError({
        token: fromToken,
        spender: approvalAddress,
        amount: '0',
      });
    }

    const owner = account.address;
    const spender = approvalAddress as `0x${string}`;
    const tokenAddr = fromToken as `0x${string}`;

    // Extract fromAmount from the LI.FI quote action (it includes fromAmount in the response)
    const actionAny = quote.action as unknown as Record<string, unknown>;
    const fromAmountStr = (actionAny['fromAmount'] as string) ?? '0';
    const fromAmount = BigInt(fromAmountStr);

    if (fromAmount === 0n) {
      logger.warn({ fromToken, approvalAddress }, 'fromAmount is 0, skipping approval');
      return null;
    }

    try {
      // Check current allowance
      const currentAllowance = await this.publicClient.readContract({
        address: tokenAddr,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [owner, spender],
      });

      logger.debug(
        {
          token: fromToken,
          spender: approvalAddress,
          currentAllowance: currentAllowance.toString(),
          requiredAmount: fromAmount.toString(),
        },
        'Checked current allowance',
      );

      // If allowance is already sufficient, skip
      if (currentAllowance >= fromAmount) {
        logger.info(
          {
            token: fromToken,
            spender: approvalAddress,
            currentAllowance: currentAllowance.toString(),
          },
          'Sufficient allowance, skipping approval',
        );
        return null;
      }

      // USDT zero-reset pattern: if token is USDT and current allowance > 0, reset to 0 first
      if (isUsdtToken(fromToken) && currentAllowance > 0n) {
        logger.info(
          { token: fromToken, currentAllowance: currentAllowance.toString() },
          'USDT detected with non-zero allowance, resetting to 0 first',
        );

        const resetTxHash = await this.walletClient.writeContract({
          address: tokenAddr,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [spender, 0n],
        });

        logger.info({ txHash: resetTxHash }, 'USDT zero-reset tx submitted, waiting for receipt');

        const resetReceipt = await this.publicClient.waitForTransactionReceipt({
          hash: resetTxHash,
        });

        if (resetReceipt.status !== 'success') {
          throw new ApprovalError({
            token: fromToken,
            spender: approvalAddress,
            amount: '0 (reset)',
          });
        }

        logger.info({ txHash: resetTxHash }, 'USDT zero-reset confirmed');
      }

      // Approve exact amount
      logger.info(
        {
          token: fromToken,
          spender: approvalAddress,
          amount: fromAmount.toString(),
        },
        'Submitting approval transaction',
      );

      const approveTxHash = await this.walletClient.writeContract({
        address: tokenAddr,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [spender, fromAmount],
      });

      logger.info({ txHash: approveTxHash }, 'Approval tx submitted, waiting for receipt');

      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash: approveTxHash,
      });

      if (receipt.status !== 'success') {
        throw new ApprovalError({
          token: fromToken,
          spender: approvalAddress,
          amount: fromAmount.toString(),
        });
      }

      logger.info(
        { txHash: approveTxHash, amount: fromAmount.toString() },
        'Approval confirmed',
      );

      return approveTxHash;
    } catch (error) {
      if (error instanceof ApprovalError) {
        throw error;
      }

      throw new ApprovalError({
        token: fromToken,
        spender: approvalAddress,
        amount: fromAmount.toString(),
      });
    }
  }
}
