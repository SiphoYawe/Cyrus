import { describe, it, expect, beforeEach } from 'vitest';
import { useTransfersStore, type Transfer } from '../transfers-store';
import { WS_EVENT_TYPES } from '@/types/ws';

const makeTransfer = (overrides: Partial<Transfer> = {}): Transfer => ({
  id: 'tx-1',
  fromChainId: 1,
  toChainId: 42161,
  fromToken: { symbol: 'USDC', address: '0xA0b8', decimals: 6 },
  toToken: { symbol: 'USDC', address: '0xFF97', decimals: 6 },
  fromAmount: '1000000000',
  status: 'PENDING',
  startedAt: Date.now(),
  ...overrides,
});

describe('transfers-store', () => {
  beforeEach(() => {
    useTransfersStore.setState({
      active: new Map(),
      completed: [],
    });
  });

  it('starts with empty maps', () => {
    const state = useTransfersStore.getState();
    expect(state.active.size).toBe(0);
    expect(state.completed).toHaveLength(0);
  });

  it('addTransfer adds to active map', () => {
    const t = makeTransfer();
    useTransfersStore.getState().addTransfer(t);
    expect(useTransfersStore.getState().active.get('tx-1')).toBeDefined();
  });

  it('updateTransfer modifies active transfer', () => {
    useTransfersStore.getState().addTransfer(makeTransfer());
    useTransfersStore.getState().updateTransfer('tx-1', { status: 'IN_PROGRESS' });
    expect(useTransfersStore.getState().active.get('tx-1')?.status).toBe('IN_PROGRESS');
  });

  it('completeTransfer moves from active to completed', () => {
    useTransfersStore.getState().addTransfer(makeTransfer());
    useTransfersStore.getState().completeTransfer('tx-1', { status: 'COMPLETED', toAmount: '999000000' });

    const state = useTransfersStore.getState();
    expect(state.active.size).toBe(0);
    expect(state.completed).toHaveLength(1);
    expect(state.completed[0].status).toBe('COMPLETED');
  });

  it('handles STATE_TRANSFER_CREATED event', () => {
    useTransfersStore.getState().handleWsEvent({
      event: WS_EVENT_TYPES.STATE_TRANSFER_CREATED,
      data: makeTransfer({ id: 'tx-ws-1' }),
      timestamp: Date.now(),
    });
    expect(useTransfersStore.getState().active.has('tx-ws-1')).toBe(true);
  });

  it('handles STATE_TRANSFER_COMPLETED event', () => {
    useTransfersStore.getState().addTransfer(makeTransfer({ id: 'tx-c1' }));
    useTransfersStore.getState().handleWsEvent({
      event: WS_EVENT_TYPES.STATE_TRANSFER_COMPLETED,
      data: makeTransfer({ id: 'tx-c1', status: 'COMPLETED' }),
      timestamp: Date.now(),
    });

    const state = useTransfersStore.getState();
    expect(state.active.size).toBe(0);
    expect(state.completed).toHaveLength(1);
  });
});
