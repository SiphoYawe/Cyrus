import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TransactionExecutor } from './transaction-executor.js';
import type { TxPublicClient, TxWalletClient, TransactionReceipt } from './transaction-executor.js';
import type { QuoteResult } from '../connectors/types.js';
import { TransactionExecutionError } from '../utils/errors.js';
import { SOLANA_CHAIN_ID } from '../connectors/solana-types.js';
import type { SolanaConnector } from '../connectors/solana-connector.js';

// --- Mock factories ---

function createMockReceipt(overrides: Partial<TransactionReceipt> = {}): TransactionReceipt {
  return {
    status: 'success',
    transactionHash: '0xresulthash0000000000000000000000000000000000000000000000000000ab' as `0x${string}`,
    blockNumber: 18000000n,
    gasUsed: 150000n,
    ...overrides,
  };
}

function createMockPublicClient(
  overrides: Partial<TxPublicClient> = {},
): TxPublicClient {
  return {
    waitForTransactionReceipt: vi.fn().mockResolvedValue(createMockReceipt()),
    ...overrides,
  };
}

function createMockWalletClient(
  overrides: Partial<TxWalletClient> = {},
): TxWalletClient {
  return {
    chain: { id: 1 },
    sendTransaction: vi.fn().mockResolvedValue(
      '0xresulthash0000000000000000000000000000000000000000000000000000ab' as `0x${string}`,
    ),
    switchChain: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createMockQuote(overrides: Partial<QuoteResult> = {}): QuoteResult {
  return {
    transactionRequest: {
      to: '0xdeadbeef00000000000000000000000000000001',
      data: '0xabcdef1234567890',
      value: '1000000000000000',
      gasLimit: '200000',
      chainId: 1,
    },
    estimate: {
      approvalAddress: '0xspender0000000000000000000000000000000001',
      toAmount: '990000',
      toAmountMin: '985000',
      executionDuration: 30,
      gasCosts: [],
    },
    tool: 'stargate',
    toolDetails: { key: 'stargate', name: 'Stargate', logoURI: '' },
    action: { fromChainId: 1, toChainId: 42161, fromToken: {}, toToken: {} },
    ...overrides,
  };
}

describe('TransactionExecutor', () => {
  let publicClient: TxPublicClient;
  let walletClient: TxWalletClient;
  let executor: TransactionExecutor;

  beforeEach(() => {
    publicClient = createMockPublicClient();
    walletClient = createMockWalletClient();
    executor = new TransactionExecutor(publicClient, walletClient);
  });

  // --- Chain verification ---

  describe('chain verification', () => {
    it('does not switch chain when wallet already on target chain', async () => {
      const quote = createMockQuote();
      walletClient = createMockWalletClient({ chain: { id: 1 } });
      executor = new TransactionExecutor(publicClient, walletClient);

      await executor.execute(quote);

      expect(walletClient.switchChain).not.toHaveBeenCalled();
    });

    it('switches chain when wallet is on wrong chain', async () => {
      const mockSwitchChain = vi.fn().mockResolvedValue(undefined);
      walletClient = createMockWalletClient({
        chain: { id: 42161 }, // Arbitrum, but target is Ethereum (1)
        switchChain: mockSwitchChain,
      });
      executor = new TransactionExecutor(publicClient, walletClient);

      const quote = createMockQuote(); // chainId: 1

      await executor.execute(quote);

      expect(mockSwitchChain).toHaveBeenCalledWith({ id: 1 });
    });

    it('throws TransactionExecutionError when switchChain is not available', async () => {
      walletClient = createMockWalletClient({
        chain: { id: 42161 },
        switchChain: undefined,
      });
      executor = new TransactionExecutor(publicClient, walletClient);

      const quote = createMockQuote(); // chainId: 1

      await expect(executor.execute(quote)).rejects.toBeInstanceOf(TransactionExecutionError);
    });
  });

  // --- Transaction submission ---

  describe('transaction submission', () => {
    it('submits transaction with correct parameters', async () => {
      const mockSendTransaction = vi.fn().mockResolvedValue('0xtxhash' as `0x${string}`);
      walletClient = createMockWalletClient({ sendTransaction: mockSendTransaction });
      publicClient = createMockPublicClient({
        waitForTransactionReceipt: vi.fn().mockResolvedValue(
          createMockReceipt({ transactionHash: '0xtxhash' as `0x${string}` }),
        ),
      });
      executor = new TransactionExecutor(publicClient, walletClient);

      const quote = createMockQuote();
      await executor.execute(quote);

      expect(mockSendTransaction).toHaveBeenCalledTimes(1);
      const sentArgs = mockSendTransaction.mock.calls[0][0];
      expect(sentArgs.to).toBe('0xdeadbeef00000000000000000000000000000001');
      expect(sentArgs.data).toBe('0xabcdef1234567890');
      expect(sentArgs.value).toBe(1000000000000000n);
      expect(sentArgs.gas).toBe(200000n);
    });

    it('validates to address is non-zero', async () => {
      const quote = createMockQuote({
        transactionRequest: {
          to: '0x0000000000000000000000000000000000000000',
          data: '0x1234',
          value: '0',
          gasLimit: '200000',
          chainId: 1,
        },
      });

      await expect(executor.execute(quote)).rejects.toBeInstanceOf(TransactionExecutionError);
    });
  });

  // --- Receipt awaiting ---

  describe('receipt awaiting', () => {
    it('waits for transaction receipt and returns result', async () => {
      const receipt = createMockReceipt({
        transactionHash: '0xfinalhash' as `0x${string}`,
        blockNumber: 19000000n,
        gasUsed: 180000n,
      });

      publicClient = createMockPublicClient({
        waitForTransactionReceipt: vi.fn().mockResolvedValue(receipt),
      });
      walletClient = createMockWalletClient({
        sendTransaction: vi.fn().mockResolvedValue('0xfinalhash' as `0x${string}`),
      });
      executor = new TransactionExecutor(publicClient, walletClient);

      const quote = createMockQuote();
      const result = await executor.execute(quote);

      expect(result.txHash).toBe('0xfinalhash');
      expect(result.chainId).toBe(1);
      expect(result.blockNumber).toBe(19000000n);
      expect(result.gasUsed).toBe(180000n);
      expect(result.status).toBe('success');
    });

    it('throws TransactionExecutionError when receipt status is reverted', async () => {
      const receipt = createMockReceipt({ status: 'reverted' });
      publicClient = createMockPublicClient({
        waitForTransactionReceipt: vi.fn().mockResolvedValue(receipt),
      });
      executor = new TransactionExecutor(publicClient, walletClient);

      const quote = createMockQuote();

      await expect(executor.execute(quote)).rejects.toBeInstanceOf(TransactionExecutionError);
    });

    it('throws TransactionExecutionError when sendTransaction fails', async () => {
      walletClient = createMockWalletClient({
        sendTransaction: vi.fn().mockRejectedValue(new Error('user rejected')),
      });
      executor = new TransactionExecutor(publicClient, walletClient);

      const quote = createMockQuote();

      await expect(executor.execute(quote)).rejects.toBeInstanceOf(TransactionExecutionError);
    });
  });

  // --- Gas price handling ---

  describe('gas fields', () => {
    it('passes gasPrice when present in transactionRequest', async () => {
      const mockSendTransaction = vi.fn().mockResolvedValue('0xtx' as `0x${string}`);
      walletClient = createMockWalletClient({ sendTransaction: mockSendTransaction });
      executor = new TransactionExecutor(publicClient, walletClient);

      const quote = createMockQuote({
        transactionRequest: {
          to: '0xdeadbeef00000000000000000000000000000001',
          data: '0x1234',
          value: '0',
          gasLimit: '200000',
          gasPrice: '30000000000',
          chainId: 1,
        },
      });

      await executor.execute(quote);

      const sentArgs = mockSendTransaction.mock.calls[0][0];
      expect(sentArgs.gasPrice).toBe(30000000000n);
    });

    it('omits gasPrice when not present in transactionRequest', async () => {
      const mockSendTransaction = vi.fn().mockResolvedValue('0xtx' as `0x${string}`);
      walletClient = createMockWalletClient({ sendTransaction: mockSendTransaction });
      executor = new TransactionExecutor(publicClient, walletClient);

      const quote = createMockQuote({
        transactionRequest: {
          to: '0xdeadbeef00000000000000000000000000000001',
          data: '0x1234',
          value: '0',
          gasLimit: '200000',
          chainId: 1,
        },
      });

      await executor.execute(quote);

      const sentArgs = mockSendTransaction.mock.calls[0][0];
      expect(sentArgs.gasPrice).toBeUndefined();
    });
  });

  // --- Solana routing ---

  describe('Solana transaction routing', () => {
    function createMockSolanaConnector(overrides: Partial<SolanaConnector> = {}): SolanaConnector {
      return {
        signAndSendTransaction: vi.fn().mockResolvedValue('solana-tx-sig-abc123'),
        waitForConfirmation: vi.fn().mockResolvedValue(true),
        isInitialized: vi.fn().mockReturnValue(true),
        ...overrides,
      } as unknown as SolanaConnector;
    }

    function createSolanaQuote(): QuoteResult {
      // Solana transaction data is base64-encoded
      const txData = Buffer.from('fake-solana-tx-bytes').toString('base64');
      return createMockQuote({
        transactionRequest: {
          to: 'SomeProgram111111111111111111111111111111111',
          data: txData,
          value: '0',
          gasLimit: '0',
          chainId: SOLANA_CHAIN_ID,
        },
        tool: 'allbridge',
      });
    }

    it('routes Solana-chain transactions to SolanaConnector', async () => {
      const mockSolana = createMockSolanaConnector();
      executor.setSolanaConnector(mockSolana);

      const quote = createSolanaQuote();
      const result = await executor.execute(quote);

      expect(result.txHash).toBe('solana-tx-sig-abc123');
      expect(result.chainId).toBe(SOLANA_CHAIN_ID);
      expect(result.status).toBe('success');
      expect(mockSolana.signAndSendTransaction).toHaveBeenCalledTimes(1);
      expect(mockSolana.waitForConfirmation).toHaveBeenCalledWith('solana-tx-sig-abc123');

      // EVM wallet should NOT have been called
      expect(walletClient.sendTransaction).not.toHaveBeenCalled();
    });

    it('throws TransactionExecutionError when no SolanaConnector attached', async () => {
      // Do NOT call setSolanaConnector
      const quote = createSolanaQuote();

      await expect(executor.execute(quote)).rejects.toThrow(TransactionExecutionError);
      await expect(executor.execute(quote)).rejects.toThrow('no SolanaConnector attached');
    });

    it('throws TransactionExecutionError when Solana confirmation fails', async () => {
      const mockSolana = createMockSolanaConnector({
        waitForConfirmation: vi.fn().mockResolvedValue(false),
      });
      executor.setSolanaConnector(mockSolana);

      const quote = createSolanaQuote();

      await expect(executor.execute(quote)).rejects.toThrow(TransactionExecutionError);
      await expect(executor.execute(quote)).rejects.toThrow('confirmed with error');
    });

    it('throws TransactionExecutionError when signAndSendTransaction rejects', async () => {
      const mockSolana = createMockSolanaConnector({
        signAndSendTransaction: vi.fn().mockRejectedValue(new Error('Solana RPC unavailable')),
      });
      executor.setSolanaConnector(mockSolana);

      const quote = createSolanaQuote();

      await expect(executor.execute(quote)).rejects.toThrow(TransactionExecutionError);
    });

    it('does not route EVM transactions to SolanaConnector even when attached', async () => {
      const mockSolana = createMockSolanaConnector();
      executor.setSolanaConnector(mockSolana);

      const evmQuote = createMockQuote(); // chainId: 1 (Ethereum)
      await executor.execute(evmQuote);

      // Solana connector should NOT be called for EVM transactions
      expect(mockSolana.signAndSendTransaction).not.toHaveBeenCalled();
      // EVM wallet SHOULD be called
      expect(walletClient.sendTransaction).toHaveBeenCalledTimes(1);
    });
  });
});
