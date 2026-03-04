// JupiterClient — Solana DEX aggregator integration
// Jupiter is to Solana what LI.FI's DEX aggregation is to EVM.
// Use Jupiter for same-chain Solana swaps; use LI.FI for cross-chain moves involving Solana.

import { VersionedTransaction } from '@solana/web3.js';
import { createLogger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { CyrusError } from '../utils/errors.js';
import type { SolanaConnector } from './solana-connector.js';
import type {
  JupiterQuote,
  JupiterRoutePlan,
  JupiterSwapResult,
  SolanaCommitment,
} from './solana-types.js';
import { SOLANA_DEFAULTS } from './solana-types.js';

const logger = createLogger('jupiter-client');

// --- Error class ---

export class JupiterClientError extends CyrusError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, context);
  }
}

// --- Raw API response types ---

interface JupiterQuoteApiResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan: {
    swapInfo: {
      ammKey: string;
      label: string;
      inputMint: string;
      outputMint: string;
      inAmount: string;
      outAmount: string;
      feeAmount: string;
      feeMint: string;
    };
    percent: number;
  }[];
  otherAmountThreshold: string;
  swapMode: 'ExactIn' | 'ExactOut';
}

interface JupiterSwapApiResponse {
  swapTransaction: string; // base64-encoded versioned transaction
}

// --- JupiterClient ---

export class JupiterClient {
  private readonly apiUrl: string;
  private readonly connector: SolanaConnector;
  private readonly defaultSlippageBps: number;

  constructor(
    connector: SolanaConnector,
    apiUrl: string = SOLANA_DEFAULTS.JUPITER_API_URL,
    defaultSlippageBps: number = SOLANA_DEFAULTS.SLIPPAGE_BPS,
  ) {
    this.connector = connector;
    this.apiUrl = apiUrl;
    this.defaultSlippageBps = defaultSlippageBps;
  }

  // --- Quote ---

  async getQuote(
    inputMint: string,
    outputMint: string,
    amount: bigint,
    slippageBps?: number,
  ): Promise<JupiterQuote> {
    const bps = slippageBps ?? this.defaultSlippageBps;
    const url = `${this.apiUrl}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount.toString()}&slippageBps=${bps}`;

    logger.debug({ inputMint, outputMint, amount: amount.toString(), slippageBps: bps }, 'Fetching Jupiter quote');

    const response = await withRetry(
      async () => {
        const res = await fetch(url);
        if (res.status === 429) {
          throw new JupiterClientError('Jupiter rate limited', {
            statusCode: 429,
            method: 'getQuote',
          });
        }
        if (!res.ok) {
          const body = await res.text();
          this.handleJupiterError(body, res.status);
        }
        return res.json() as Promise<JupiterQuoteApiResponse>;
      },
      { maxRetries: 2, baseDelayMs: 1000, maxDelayMs: 5000 },
    );

    return this.parseQuoteResponse(response);
  }

  // --- Swap execution ---

  async executeSwap(
    quote: JupiterQuote,
    commitment?: SolanaCommitment,
  ): Promise<JupiterSwapResult> {
    const publicKey = this.connector.getPublicKey();
    const url = `${this.apiUrl}/swap`;

    logger.info(
      {
        inputMint: quote.inputMint,
        outputMint: quote.outputMint,
        inAmount: quote.inAmount.toString(),
      },
      'Executing Jupiter swap',
    );

    // Reconstruct the quote for the swap API (amounts as strings)
    const quoteForApi = this.quoteToApiFormat(quote);

    const swapResponse = await withRetry(
      async () => {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            quoteResponse: quoteForApi,
            userPublicKey: publicKey.toBase58(),
            wrapAndUnwrapSol: true,
          }),
        });

        if (res.status === 429) {
          throw new JupiterClientError('Jupiter rate limited', {
            statusCode: 429,
            method: 'executeSwap',
          });
        }
        if (!res.ok) {
          const body = await res.text();
          throw new JupiterClientError(`Jupiter swap API error: ${body}`, {
            statusCode: res.status,
            method: 'executeSwap',
          });
        }

        return res.json() as Promise<JupiterSwapApiResponse>;
      },
      { maxRetries: 1, baseDelayMs: 1000, maxDelayMs: 3000 },
    );

    // Deserialize, sign, and send the versioned transaction
    const txBuffer = Buffer.from(swapResponse.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuffer);

    const keypair = this.connector.getKeypair();
    tx.sign([keypair]);

    const connection = this.connector.getConnection();
    const signature = await connection.sendTransaction(tx);

    logger.info({ signature }, 'Jupiter swap transaction sent');

    // Wait for confirmation
    const level = commitment ?? 'confirmed';
    const confirmed = await this.connector.waitForConfirmation(signature, level);

    return {
      signature,
      confirmed,
      inputAmount: quote.inAmount,
      outputAmount: quote.outAmount,
    };
  }

  // --- Private helpers ---

  private parseQuoteResponse(raw: JupiterQuoteApiResponse): JupiterQuote {
    const routePlan: JupiterRoutePlan[] = (raw.routePlan ?? []).map((rp) => ({
      swapInfo: {
        ammKey: rp.swapInfo.ammKey,
        label: rp.swapInfo.label,
        inputMint: rp.swapInfo.inputMint,
        outputMint: rp.swapInfo.outputMint,
        inAmount: BigInt(rp.swapInfo.inAmount),
        outAmount: BigInt(rp.swapInfo.outAmount),
        feeAmount: BigInt(rp.swapInfo.feeAmount),
        feeMint: rp.swapInfo.feeMint,
      },
      percent: rp.percent,
    }));

    return {
      inputMint: raw.inputMint,
      outputMint: raw.outputMint,
      inAmount: BigInt(raw.inAmount),
      outAmount: BigInt(raw.outAmount),
      priceImpactPct: parseFloat(raw.priceImpactPct),
      routePlan,
      otherAmountThreshold: BigInt(raw.otherAmountThreshold),
      swapMode: raw.swapMode,
    };
  }

  private quoteToApiFormat(quote: JupiterQuote): JupiterQuoteApiResponse {
    return {
      inputMint: quote.inputMint,
      outputMint: quote.outputMint,
      inAmount: quote.inAmount.toString(),
      outAmount: quote.outAmount.toString(),
      priceImpactPct: quote.priceImpactPct.toString(),
      routePlan: quote.routePlan.map((rp) => ({
        swapInfo: {
          ammKey: rp.swapInfo.ammKey,
          label: rp.swapInfo.label,
          inputMint: rp.swapInfo.inputMint,
          outputMint: rp.swapInfo.outputMint,
          inAmount: rp.swapInfo.inAmount.toString(),
          outAmount: rp.swapInfo.outAmount.toString(),
          feeAmount: rp.swapInfo.feeAmount.toString(),
          feeMint: rp.swapInfo.feeMint,
        },
        percent: rp.percent,
      })),
      otherAmountThreshold: quote.otherAmountThreshold.toString(),
      swapMode: quote.swapMode,
    };
  }

  private handleJupiterError(body: string, statusCode: number): never {
    // Known Jupiter error codes
    if (body.includes('COULD_NOT_FIND_ANY_ROUTE')) {
      throw new JupiterClientError('No route found for swap', {
        errorCode: 'COULD_NOT_FIND_ANY_ROUTE',
        statusCode,
        method: 'getQuote',
      });
    }
    if (body.includes('TOKEN_NOT_TRADABLE')) {
      throw new JupiterClientError('Token is not tradable on Jupiter', {
        errorCode: 'TOKEN_NOT_TRADABLE',
        statusCode,
        method: 'getQuote',
      });
    }
    if (body.includes('AMOUNT_TOO_SMALL')) {
      throw new JupiterClientError('Swap amount too small', {
        errorCode: 'AMOUNT_TOO_SMALL',
        statusCode,
        method: 'getQuote',
      });
    }
    throw new JupiterClientError(`Jupiter API error: ${body}`, {
      statusCode,
      method: 'getQuote',
    });
  }
}
