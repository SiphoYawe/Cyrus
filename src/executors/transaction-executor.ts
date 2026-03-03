// Transaction execution — submits the main swap/bridge transaction and waits for receipt
// CRITICAL: Always verify wallet chain matches transactionRequest.chainId before signing

import type { QuoteResult } from '../connectors/types.js';
import { TransactionExecutionError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('transaction-executor');

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface TransactionReceipt {
  readonly status: 'success' | 'reverted';
  readonly transactionHash: `0x${string}`;
  readonly blockNumber: bigint;
  readonly gasUsed: bigint;
}

// Minimal interfaces for viem client operations — used for testability
export interface TxPublicClient {
  waitForTransactionReceipt(args: {
    hash: `0x${string}`;
  }): Promise<TransactionReceipt>;
}

export interface TxWalletClient {
  chain: { id: number } | undefined;
  sendTransaction(args: {
    to: `0x${string}`;
    data: `0x${string}`;
    value: bigint;
    gas?: bigint;
    gasPrice?: bigint;
  }): Promise<`0x${string}`>;
  switchChain?(args: { id: number }): Promise<void>;
}

export interface TransactionResult {
  readonly txHash: string;
  readonly chainId: number;
  readonly blockNumber: bigint;
  readonly gasUsed: bigint;
  readonly status: string;
}

export class TransactionExecutor {
  private readonly publicClient: TxPublicClient;
  private readonly walletClient: TxWalletClient;

  constructor(publicClient: TxPublicClient, walletClient: TxWalletClient) {
    this.publicClient = publicClient;
    this.walletClient = walletClient;
  }

  /**
   * Execute the main transaction from a LI.FI quote.
   * Verifies chain, submits tx, waits for receipt, returns result.
   */
  async execute(quote: QuoteResult): Promise<TransactionResult> {
    const { transactionRequest } = quote;
    const targetChainId = transactionRequest.chainId;

    try {
      // Verify wallet chain matches target chain
      const currentChainId = this.walletClient.chain?.id;
      if (currentChainId !== targetChainId) {
        logger.info(
          { currentChainId, targetChainId },
          'Chain mismatch, switching chain',
        );

        if (this.walletClient.switchChain) {
          await this.walletClient.switchChain({ id: targetChainId });
          logger.info({ targetChainId }, 'Chain switched successfully');
        } else {
          throw new TransactionExecutionError(
            `Wallet chain ${currentChainId} does not match target chain ${targetChainId} and switchChain not available`,
            { chainId: targetChainId },
          );
        }
      }

      // Validate to address is non-zero
      const toAddress = transactionRequest.to as `0x${string}`;
      if (!toAddress || toAddress.toLowerCase() === ZERO_ADDRESS) {
        throw new TransactionExecutionError(
          'Transaction target address is zero address',
          { chainId: targetChainId, to: toAddress },
        );
      }

      // Parse transaction fields
      const value = BigInt(transactionRequest.value || '0');
      const gas = transactionRequest.gasLimit
        ? BigInt(transactionRequest.gasLimit)
        : undefined;
      const gasPrice = transactionRequest.gasPrice
        ? BigInt(transactionRequest.gasPrice)
        : undefined;

      logger.info(
        {
          to: toAddress,
          chainId: targetChainId,
          value: value.toString(),
          gas: gas?.toString(),
          tool: quote.tool,
        },
        'Submitting transaction',
      );

      // Submit transaction
      const txHash = await this.walletClient.sendTransaction({
        to: toAddress,
        data: transactionRequest.data as `0x${string}`,
        value,
        gas,
        gasPrice,
      });

      logger.info({ txHash, chainId: targetChainId }, 'Transaction submitted, waiting for receipt');

      // Wait for receipt
      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash: txHash,
      });

      const result: TransactionResult = {
        txHash: receipt.transactionHash,
        chainId: targetChainId,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
        status: receipt.status,
      };

      logger.info(
        {
          txHash: result.txHash,
          chainId: result.chainId,
          blockNumber: result.blockNumber.toString(),
          gasUsed: result.gasUsed.toString(),
          status: result.status,
        },
        'Transaction confirmed',
      );

      if (receipt.status !== 'success') {
        throw new TransactionExecutionError(
          `Transaction reverted on chain ${targetChainId}`,
          { chainId: targetChainId, txHash: receipt.transactionHash },
        );
      }

      return result;
    } catch (error) {
      if (error instanceof TransactionExecutionError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : 'Unknown transaction error';
      throw new TransactionExecutionError(message, {
        chainId: targetChainId,
        to: transactionRequest.to,
      });
    }
  }
}
