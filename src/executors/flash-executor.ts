// FlashExecutor — handles Aave V3 flash loan borrow and repay transactions
// Used by FlashOrchestrator for cross-chain arbitrage loops.
// Borrow and repay happen as separate transactions (non-atomic cross-chain).

import { createLogger } from '../utils/logger.js';
import { CyrusError } from '../utils/errors.js';
import type { TokenAddress } from '../core/types.js';
import type { FlashLoanConfig, FlashLoanProvider } from '../strategies/builtin/flash-types.js';

const logger = createLogger('flash-executor');

// Aave V3 Pool ABI subset — only the functions we need
export const AAVE_V3_POOL_ABI = [
  {
    name: 'flashLoanSimple',
    type: 'function',
    inputs: [
      { name: 'receiverAddress', type: 'address' },
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'params', type: 'bytes' },
      { name: 'referralCode', type: 'uint16' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'supply',
    type: 'function',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'onBehalfOf', type: 'address' },
      { name: 'referralCode', type: 'uint16' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'borrow',
    type: 'function',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'interestRateMode', type: 'uint256' },
      { name: 'referralCode', type: 'uint16' },
      { name: 'onBehalfOf', type: 'address' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'repay',
    type: 'function',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'interestRateMode', type: 'uint256' },
      { name: 'onBehalfOf', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
] as const;

// --- Error classes ---

export class FlashExecutorError extends CyrusError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, context);
  }
}

// --- Wallet client interface (matches viem pattern) ---

export interface FlashWalletClient {
  writeContract(params: {
    address: string;
    abi: readonly Record<string, unknown>[];
    functionName: string;
    args: readonly unknown[];
    chain?: unknown;
  }): Promise<string>;
  account: { address: string };
}

// Flash loan fee rates by provider
const FEE_RATES: Record<FlashLoanProvider, number> = {
  'aave-v3': 0.0005, // 0.05%
  'dydx': 0, // 0%
};

// --- FlashExecutor ---

export class FlashExecutor {
  private readonly walletClient: FlashWalletClient;

  constructor(walletClient: FlashWalletClient) {
    this.walletClient = walletClient;
  }

  /**
   * Borrow tokens via Aave V3 variable-rate borrow.
   * Since cross-chain arbitrage is non-atomic, we use Aave's standard borrow
   * (creates a variable debt position) rather than flashLoanSimple.
   * The debt is repaid after the cross-chain loop completes.
   */
  async borrow(
    config: FlashLoanConfig,
    token: TokenAddress,
    amount: bigint,
  ): Promise<string> {
    logger.info(
      {
        provider: config.provider,
        token: token as string,
        amount: amount.toString(),
        chainId: config.chainId as number,
      },
      'Initiating flash loan borrow',
    );

    try {
      const txHash = await this.walletClient.writeContract({
        address: config.poolAddress,
        abi: AAVE_V3_POOL_ABI as unknown as readonly Record<string, unknown>[],
        functionName: 'borrow',
        args: [
          token as string,
          amount,
          2n, // interestRateMode: 2 = variable rate
          0, // referralCode
          this.walletClient.account.address,
        ],
      });

      logger.info(
        { txHash, provider: config.provider, amount: amount.toString() },
        'Flash loan borrow transaction sent',
      );

      return txHash;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new FlashExecutorError('Flash loan borrow failed', {
        provider: config.provider,
        token: token as string,
        amount: amount.toString(),
        chainId: config.chainId as number,
        reason,
      });
    }
  }

  /**
   * Repay flash loan — returns principal + fee to Aave V3 Pool.
   * Caller must ensure token approval for the Pool contract before calling.
   */
  async repay(
    config: FlashLoanConfig,
    token: TokenAddress,
    amount: bigint,
    fee: bigint,
  ): Promise<string> {
    const totalRepayment = amount + fee;

    logger.info(
      {
        provider: config.provider,
        token: token as string,
        principal: amount.toString(),
        fee: fee.toString(),
        total: totalRepayment.toString(),
      },
      'Initiating flash loan repayment',
    );

    try {
      const txHash = await this.walletClient.writeContract({
        address: config.poolAddress,
        abi: AAVE_V3_POOL_ABI as unknown as readonly Record<string, unknown>[],
        functionName: 'repay',
        args: [
          token as string,
          totalRepayment,
          2n, // interestRateMode: 2 = variable rate
          this.walletClient.account.address,
        ],
      });

      logger.info(
        { txHash, provider: config.provider, total: totalRepayment.toString() },
        'Flash loan repayment transaction sent',
      );

      return txHash;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new FlashExecutorError('Flash loan repayment failed', {
        provider: config.provider,
        token: token as string,
        amount: amount.toString(),
        fee: fee.toString(),
        chainId: config.chainId as number,
        reason,
      });
    }
  }

  /**
   * Calculate flash loan fee for a given provider and amount.
   */
  static calculateFee(provider: FlashLoanProvider, amount: bigint): bigint {
    const rate = FEE_RATES[provider];
    if (rate === 0) return 0n;
    // Fee = amount * rate, using integer math (multiply first, then divide)
    return (amount * BigInt(Math.round(rate * 1_000_000))) / 1_000_000n;
  }

  /**
   * Get fee rate for a provider.
   */
  static getFeeRate(provider: FlashLoanProvider): number {
    return FEE_RATES[provider];
  }
}
