export interface WsEventEnvelope<T = unknown> {
  event: string;
  data: T;
  timestamp: number;
}

export const WS_EVENT_TYPES = {
  // State events
  STATE_BALANCE_UPDATED: 'state.balance.updated',
  STATE_TRANSFER_CREATED: 'state.transfer.created',
  STATE_TRANSFER_UPDATED: 'state.transfer.updated',
  STATE_TRANSFER_COMPLETED: 'state.transfer.completed',
  STATE_POSITION_UPDATED: 'state.position.updated',
  STATE_PRICE_UPDATED: 'state.price.updated',
  // Agent lifecycle
  AGENT_TICK: 'agent.tick',
  AGENT_ERROR: 'agent.error',
  AGENT_STARTED: 'agent.started',
  AGENT_STOPPED: 'agent.stopped',
  // Command responses
  COMMAND_RESPONSE: 'command.response',
  COMMAND_ERROR: 'command.error',
} as const;

export type WsEventType = (typeof WS_EVENT_TYPES)[keyof typeof WS_EVENT_TYPES];

export interface WsCommand {
  command: string;
  payload?: unknown;
  requestId?: string;
}

export const WS_COMMANDS = {
  AGENT_START: 'agent.start',
  AGENT_STOP: 'agent.stop',
  AGENT_STATUS: 'agent.status',
  STRATEGY_ENABLE: 'strategy.enable',
  STRATEGY_DISABLE: 'strategy.disable',
  CONFIG_GET: 'config.get',
} as const;

export type WsCommandType = (typeof WS_COMMANDS)[keyof typeof WS_COMMANDS];

export function createEventEnvelope<T>(event: string, data: T): WsEventEnvelope<T> {
  return { event, data, timestamp: Date.now() };
}
