// Parse LI.FI status API responses into a normalized StatusUpdate

import type { LiFiStatus, LiFiSubstatus } from '../core/types.js';

export interface StatusTokenInfo {
  readonly address: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly chainId: number;
}

export interface StatusTransferInfo {
  readonly amount: string;
  readonly token: StatusTokenInfo;
  readonly chainId: number;
}

export interface StatusUpdate {
  readonly status: LiFiStatus;
  readonly substatus?: LiFiSubstatus;
  readonly receiving?: StatusTransferInfo;
  readonly sending?: StatusTransferInfo;
  readonly tool?: string;
  readonly substatusMessage?: string;
  readonly lifiExplorerLink?: string;
}

const VALID_STATUSES = new Set<string>(['NOT_FOUND', 'PENDING', 'DONE', 'FAILED']);
const VALID_SUBSTATUSES = new Set<string>(['COMPLETED', 'PARTIAL', 'REFUNDED']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTokenInfo(raw: unknown): StatusTokenInfo | undefined {
  if (!isRecord(raw)) return undefined;

  const address = typeof raw.address === 'string' ? raw.address : '';
  const symbol = typeof raw.symbol === 'string' ? raw.symbol : '';
  const decimals = typeof raw.decimals === 'number' ? raw.decimals : 0;
  const chainId = typeof raw.chainId === 'number' ? raw.chainId : 0;

  if (!address && !symbol) return undefined;

  return { address, symbol, decimals, chainId };
}

function parseTransferInfo(raw: unknown): StatusTransferInfo | undefined {
  if (!isRecord(raw)) return undefined;

  const amount = typeof raw.amount === 'string' ? raw.amount : undefined;
  if (!amount) return undefined;

  const token = parseTokenInfo(raw.token);
  if (!token) return undefined;

  const chainId = typeof raw.chainId === 'number' ? raw.chainId : token.chainId;

  return { amount, token, chainId };
}

export function parseStatusResponse(response: unknown): StatusUpdate {
  if (!isRecord(response)) {
    return { status: 'NOT_FOUND' as LiFiStatus };
  }

  // Parse status — default to NOT_FOUND for unknown values
  const rawStatus = typeof response.status === 'string' ? response.status : '';
  const status: LiFiStatus = VALID_STATUSES.has(rawStatus)
    ? (rawStatus as LiFiStatus)
    : 'NOT_FOUND';

  // Parse substatus
  const rawSubstatus = typeof response.substatus === 'string' ? response.substatus : undefined;
  const substatus: LiFiSubstatus | undefined =
    rawSubstatus && VALID_SUBSTATUSES.has(rawSubstatus)
      ? (rawSubstatus as LiFiSubstatus)
      : undefined;

  // Parse receiving/sending info
  const receiving = parseTransferInfo(response.receiving);
  const sending = parseTransferInfo(response.sending);

  // Parse tool — could be response.tool or response.bridge
  const tool =
    typeof response.tool === 'string'
      ? response.tool
      : typeof response.bridge === 'string'
        ? response.bridge
        : undefined;

  // Parse optional message and link
  const substatusMessage =
    typeof response.substatusMessage === 'string' ? response.substatusMessage : undefined;
  const lifiExplorerLink =
    typeof response.lifiExplorerLink === 'string' ? response.lifiExplorerLink : undefined;

  return {
    status,
    ...(substatus !== undefined && { substatus }),
    ...(receiving !== undefined && { receiving }),
    ...(sending !== undefined && { sending }),
    ...(tool !== undefined && { tool }),
    ...(substatusMessage !== undefined && { substatusMessage }),
    ...(lifiExplorerLink !== undefined && { lifiExplorerLink }),
  };
}
