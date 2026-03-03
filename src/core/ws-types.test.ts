import { describe, it, expect, vi } from 'vitest';
import { createEventEnvelope, WS_EVENT_TYPES, WS_COMMANDS } from './ws-types.js';
import type { WsEventEnvelope, WsEventType, WsCommandType } from './ws-types.js';

describe('ws-types', () => {
  describe('createEventEnvelope', () => {
    it('creates an envelope with event, data, and timestamp', () => {
      const before = Date.now();
      const envelope = createEventEnvelope('test.event', { key: 'value' });
      const after = Date.now();

      expect(envelope.event).toBe('test.event');
      expect(envelope.data).toEqual({ key: 'value' });
      expect(envelope.timestamp).toBeGreaterThanOrEqual(before);
      expect(envelope.timestamp).toBeLessThanOrEqual(after);
    });

    it('preserves generic type for data', () => {
      const envelope: WsEventEnvelope<number> = createEventEnvelope('test', 42);
      expect(envelope.data).toBe(42);
    });

    it('works with null data', () => {
      const envelope = createEventEnvelope('test', null);
      expect(envelope.data).toBeNull();
    });

    it('works with complex nested data', () => {
      const data = { nested: { array: [1, 2, 3], obj: { a: 'b' } } };
      const envelope = createEventEnvelope('test', data);
      expect(envelope.data).toEqual(data);
    });
  });

  describe('WS_EVENT_TYPES', () => {
    it('has all state event types', () => {
      expect(WS_EVENT_TYPES.STATE_BALANCE_UPDATED).toBe('state.balance.updated');
      expect(WS_EVENT_TYPES.STATE_TRANSFER_CREATED).toBe('state.transfer.created');
      expect(WS_EVENT_TYPES.STATE_TRANSFER_UPDATED).toBe('state.transfer.updated');
      expect(WS_EVENT_TYPES.STATE_TRANSFER_COMPLETED).toBe('state.transfer.completed');
      expect(WS_EVENT_TYPES.STATE_POSITION_UPDATED).toBe('state.position.updated');
      expect(WS_EVENT_TYPES.STATE_PRICE_UPDATED).toBe('state.price.updated');
    });

    it('has all agent lifecycle event types', () => {
      expect(WS_EVENT_TYPES.AGENT_TICK).toBe('agent.tick');
      expect(WS_EVENT_TYPES.AGENT_ERROR).toBe('agent.error');
      expect(WS_EVENT_TYPES.AGENT_STARTED).toBe('agent.started');
      expect(WS_EVENT_TYPES.AGENT_STOPPED).toBe('agent.stopped');
    });

    it('has command response event types', () => {
      expect(WS_EVENT_TYPES.COMMAND_RESPONSE).toBe('command.response');
      expect(WS_EVENT_TYPES.COMMAND_ERROR).toBe('command.error');
    });

    it('has 12 total event types', () => {
      expect(Object.keys(WS_EVENT_TYPES)).toHaveLength(12);
    });

    it('values are assignable to WsEventType', () => {
      // Type-level check: this compiles only if values satisfy WsEventType
      const _check: WsEventType = WS_EVENT_TYPES.STATE_BALANCE_UPDATED;
      expect(_check).toBeDefined();
    });
  });

  describe('WS_COMMANDS', () => {
    it('has all command types', () => {
      expect(WS_COMMANDS.AGENT_START).toBe('agent.start');
      expect(WS_COMMANDS.AGENT_STOP).toBe('agent.stop');
      expect(WS_COMMANDS.AGENT_STATUS).toBe('agent.status');
      expect(WS_COMMANDS.STRATEGY_ENABLE).toBe('strategy.enable');
      expect(WS_COMMANDS.STRATEGY_DISABLE).toBe('strategy.disable');
      expect(WS_COMMANDS.CONFIG_GET).toBe('config.get');
    });

    it('has 6 total commands', () => {
      expect(Object.keys(WS_COMMANDS)).toHaveLength(6);
    });

    it('values are assignable to WsCommandType', () => {
      const _check: WsCommandType = WS_COMMANDS.AGENT_START;
      expect(_check).toBeDefined();
    });
  });
});
