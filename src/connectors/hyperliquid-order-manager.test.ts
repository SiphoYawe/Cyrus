import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Store } from '../core/store.js';
import { PerpOrderRejectedError } from '../utils/errors.js';
import { formatUnits, parseUnits } from '../utils/bigint.js';
import {
  HyperliquidOrderManager,
  type PerpOrderParams,
} from './hyperliquid-order-manager.js';
import type { HyperliquidConnectorInterface } from './hyperliquid-connector.js';
import type { HyperliquidOrderResult } from './hyperliquid-types.js';

function mockConnector(overrides?: Partial<HyperliquidConnectorInterface>): HyperliquidConnectorInterface {
  return {
    queryBalance: vi.fn(),
    queryPositions: vi.fn(),
    queryFundingRates: vi.fn(),
    queryOpenInterest: vi.fn(),
    queryOrderBook: vi.fn(),
    placeMarketOrder: vi.fn().mockResolvedValue({
      status: 'ok',
      orderId: 12345,
      filledSize: '1.5',
      avgPrice: '2000.50',
    } satisfies HyperliquidOrderResult),
    placeLimitOrder: vi.fn().mockResolvedValue({
      status: 'ok',
      orderId: 12346,
      filledSize: '0',
    } satisfies HyperliquidOrderResult),
    cancelOrder: vi.fn().mockResolvedValue(true),
    closePosition: vi.fn(),
    queryOpenOrders: vi.fn().mockResolvedValue([]),
    queryFills: vi.fn().mockResolvedValue([]),
    depositToMargin: vi.fn(),
    withdrawFromMargin: vi.fn(),
    ...overrides,
  } as unknown as HyperliquidConnectorInterface;
}

function makeParams(overrides?: Partial<PerpOrderParams>): PerpOrderParams {
  return {
    symbol: 'ETH',
    side: 'buy',
    size: 1500000000000000000n, // 1.5 ETH in 18 decimals
    leverage: 18,
    type: 'market',
    decimals: 18,
    ...overrides,
  };
}

describe('HyperliquidOrderManager', () => {
  let connector: HyperliquidConnectorInterface;
  let manager: HyperliquidOrderManager;

  beforeEach(() => {
    Store.getInstance().reset();
    vi.clearAllMocks();
    connector = mockConnector();
    manager = new HyperliquidOrderManager(connector);
  });

  // --- Market orders (AC1, AC5) ---

  it('market order fills at current price and returns complete PerpOrderResult', async () => {
    const result = await manager.placeOrder(makeParams());
    expect(result.orderId).toBe('12345');
    expect(result.status).toBe('filled');
    expect(result.fillPrice).toBe('2000.50');
    expect(result.fillSize).toBe('1.5');
    expect(result.averageFillPrice).toBe('2000.50');
    expect(result.timestamp).toBeGreaterThan(0);
    expect(result.fees).toBeDefined();
  });

  it('market order converts bigint size to decimal string correctly', async () => {
    await manager.placeOrder(makeParams({ size: 1500000000000000000n, decimals: 18 }));
    expect(connector.placeMarketOrder).toHaveBeenCalledWith('ETH', 'long', '1.5', 18);
  });

  it('converts bigint size with 6 decimals (USDC-like)', async () => {
    await manager.placeOrder(makeParams({
      symbol: 'BTC',
      size: 10000000n, // 10 USDC
      decimals: 6,
    }));
    expect(connector.placeMarketOrder).toHaveBeenCalledWith('BTC', 'long', '10', 18);
  });

  // --- Limit orders (AC2, AC3, AC5) ---

  it('limit order with GTC default time-in-force', async () => {
    await manager.placeOrder(makeParams({
      type: 'limit',
      price: 2000000000000000000000n, // 2000 in 18 decimals
      decimals: 18,
    }));
    expect(connector.placeLimitOrder).toHaveBeenCalledWith('ETH', 'long', '1.5', '2000', 18, 'GTC');
  });

  it('limit order with IOC fills immediately or cancels', async () => {
    // IOC with no fill → cancelled
    const result = await manager.placeOrder(makeParams({
      type: 'limit',
      price: 2000000000000000000000n,
      timeInForce: 'IOC',
      decimals: 18,
    }));
    expect(result.status).toBe('cancelled');
  });

  it('limit order with IOC partial fill returns filled portion', async () => {
    connector = mockConnector({
      placeLimitOrder: vi.fn().mockResolvedValue({
        status: 'ok',
        orderId: 12347,
        filledSize: '0.5',
        avgPrice: '2000',
      }),
    });
    manager = new HyperliquidOrderManager(connector);

    const result = await manager.placeOrder(makeParams({
      type: 'limit',
      price: 2000000000000000000000n,
      timeInForce: 'IOC',
      decimals: 18,
    }));
    expect(result.status).toBe('partial');
    expect(result.fillSize).toBe('0.5');
  });

  it('limit order with FOK fills completely or cancels entirely (no partial)', async () => {
    // FOK with no fill → cancelled
    const result = await manager.placeOrder(makeParams({
      type: 'limit',
      price: 2000000000000000000000n,
      timeInForce: 'FOK',
      decimals: 18,
    }));
    expect(result.status).toBe('cancelled');
  });

  // --- Order rejection (AC4) ---

  it('order rejection wraps in PerpOrderRejectedError with correct context', async () => {
    connector = mockConnector({
      placeMarketOrder: vi.fn().mockResolvedValue({
        status: 'error',
        error: 'insufficient margin',
      }),
    });
    manager = new HyperliquidOrderManager(connector);

    await expect(manager.placeOrder(makeParams())).rejects.toThrow(PerpOrderRejectedError);
  });

  it('insufficient margin rejection mapped to INSUFFICIENT_MARGIN reason', async () => {
    connector = mockConnector({
      placeMarketOrder: vi.fn().mockResolvedValue({
        status: 'error',
        error: 'Not enough margin for trade',
      }),
    });
    manager = new HyperliquidOrderManager(connector);

    try {
      await manager.placeOrder(makeParams());
      expect.fail('Should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PerpOrderRejectedError);
      expect((e as PerpOrderRejectedError).context.rejectionReason).toBe('INSUFFICIENT_MARGIN');
    }
  });

  it('invalid symbol rejection mapped to INVALID_SYMBOL reason', async () => {
    connector = mockConnector({
      placeMarketOrder: vi.fn().mockResolvedValue({
        status: 'error',
        error: 'Unknown asset FOO',
      }),
    });
    manager = new HyperliquidOrderManager(connector);

    try {
      await manager.placeOrder(makeParams({ symbol: 'FOO' }));
      expect.fail('Should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PerpOrderRejectedError);
      expect((e as PerpOrderRejectedError).context.rejectionReason).toBe('INVALID_SYMBOL');
    }
  });

  it('connector throw wraps in PerpOrderRejectedError', async () => {
    connector = mockConnector({
      placeMarketOrder: vi.fn().mockRejectedValue(new Error('insufficient margin')),
    });
    manager = new HyperliquidOrderManager(connector);

    await expect(manager.placeOrder(makeParams())).rejects.toThrow(PerpOrderRejectedError);
  });

  // --- formatDecimal / parseDecimal (AC5) ---

  it('formatUnits converts bigint to correct decimal string (6 decimals USDC)', () => {
    expect(formatUnits(10000000n, 6)).toBe('10');
    expect(formatUnits(1500000n, 6)).toBe('1.5');
  });

  it('formatUnits handles zero, large amounts, trailing zeros', () => {
    expect(formatUnits(0n, 18)).toBe('0');
    expect(formatUnits(1000000000000000000n, 18)).toBe('1');
    expect(formatUnits(123456789012345678901234567890n, 18)).toBe('123456789012.34567890123456789');
  });

  it('parseUnits converts decimal string back to bigint correctly', () => {
    expect(parseUnits('10', 6)).toBe(10000000n);
    expect(parseUnits('1.5', 18)).toBe(1500000000000000000n);
    expect(parseUnits('0', 18)).toBe(0n);
  });

  // --- Order cancellation (AC6) ---

  it('cancelOrder successfully cancels pending limit order', async () => {
    // First place a limit order
    await manager.placeOrder(makeParams({
      type: 'limit',
      price: 2000000000000000000000n,
      decimals: 18,
    }));

    const result = await manager.cancelOrder('ETH', '12346');
    expect(result.status).toBe('cancelled');
    expect(result.orderId).toBe('12346');
  });

  it('cancelOrder returns fill details when order already filled', async () => {
    // Place a market order (fills immediately)
    await manager.placeOrder(makeParams());

    const result = await manager.cancelOrder('ETH', '12345');
    // Order was already filled, so cancelOrder reflects that
    expect(result.filledSize).toBe('1.5');
  });

  // --- Order status (AC7) ---

  it('getOrderStatus returns correct status for filled order', async () => {
    await manager.placeOrder(makeParams());
    const status = await manager.getOrderStatus('12345');
    expect(status.status).toBe('filled');
    expect(status.averageFillPrice).toBe('2000.50');
  });

  it('getOrderStatus returns pending for unknown orderId', async () => {
    const status = await manager.getOrderStatus('99999');
    expect(status.status).toBe('pending');
  });

  // --- Partial fills (AC8) ---

  it('partial fill updates average fill price correctly (volume-weighted)', async () => {
    // Place a limit order that's pending
    await manager.placeOrder(makeParams({
      type: 'limit',
      price: 2000000000000000000000n,
      decimals: 18,
    }));

    // Simulate first partial fill
    manager.updatePartialFill('12346', '2000', '0.5');
    let status = await manager.getOrderStatus('12346');
    expect(status.status).toBe('partial');

    // Second partial fill at different price
    manager.updatePartialFill('12346', '2010', '1.0');
    status = await manager.getOrderStatus('12346');

    // Volume-weighted avg: (2000*0.5 + 2010*1.0) / 1.5 = 3010/1.5 ≈ 2006.67
    expect(parseFloat(status.averageFillPrice)).toBeCloseTo(2006.67, 1);
    expect(status.status).toBe('filled');
  });

  it('partial fill tracks remaining unfilled size', async () => {
    await manager.placeOrder(makeParams({
      type: 'limit',
      price: 2000000000000000000000n,
      decimals: 18,
    }));

    manager.updatePartialFill('12346', '2000', '0.3');
    const status = await manager.getOrderStatus('12346');
    expect(parseFloat(status.remainingSize)).toBeCloseTo(1.2, 1);
    expect(status.status).toBe('partial');
  });

  // --- Logging ---

  it('sell side maps to short on connector', async () => {
    await manager.placeOrder(makeParams({ side: 'sell' }));
    expect(connector.placeMarketOrder).toHaveBeenCalledWith('ETH', 'short', '1.5', 18);
  });
});
