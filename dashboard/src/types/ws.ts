/** Mirror of backend WsEventEnvelope */
export interface WsEventEnvelope<T = unknown> {
  event: string;
  data: T;
  timestamp: number;
}

export const WS_EVENT_TYPES = {
  STATE_BALANCE_UPDATED: 'state.balance.updated',
  STATE_TRANSFER_CREATED: 'state.transfer.created',
  STATE_TRANSFER_UPDATED: 'state.transfer.updated',
  STATE_TRANSFER_COMPLETED: 'state.transfer.completed',
  STATE_POSITION_UPDATED: 'state.position.updated',
  STATE_PRICE_UPDATED: 'state.price.updated',
  AGENT_TICK: 'agent.tick',
  AGENT_ERROR: 'agent.error',
  AGENT_STARTED: 'agent.started',
  AGENT_STOPPED: 'agent.stopped',
  COMMAND_RESPONSE: 'command.response',
  COMMAND_ERROR: 'command.error',
  AI_REGIME_CHANGED: 'ai.regime.changed',
  AI_STRATEGY_SELECTION_CHANGED: 'ai.strategy.selection_changed',
  CONFIRMATION_REQUEST: 'confirmation.request',
  RECOVERY_OPTIONS: 'recovery.options',
  STRATEGY_STATUS_UPDATED: 'strategy.status.updated',
  CONFIG_UPDATED: 'config.updated',
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
  RISK_DIAL_CHANGE: 'risk.dial.change',
  CONFIG_UPDATE: 'config.update',
  STRATEGY_TOGGLE: 'strategy.toggle',
  CHAT_MESSAGE: 'chat.message',
  CHAT_CONFIRM: 'chat.confirm',
  CHAT_CANCEL: 'chat.cancel',
  TRANSFER_RETRY: 'transfer.retry',
  TRANSFER_HOLD: 'transfer.hold',
  TRANSFER_REVERSE: 'transfer.reverse',
} as const;

export type WsCommandType = (typeof WS_COMMANDS)[keyof typeof WS_COMMANDS];
