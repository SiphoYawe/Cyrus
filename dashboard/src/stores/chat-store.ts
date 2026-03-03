import { create } from 'zustand';
import type { WsEventEnvelope } from '@/types/ws';
import { WS_EVENT_TYPES } from '@/types/ws';

export type MessageRole = 'user' | 'assistant';
export type MessageType = 'text' | 'plan_preview' | 'clarification' | 'status_update' | 'error';

export interface PlanPreview {
  summary: string;
  estimatedCost?: string;
  affectedPositions?: string[];
  steps?: string[];
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  type: MessageType;
  content: string;
  timestamp: number;
  planPreview?: PlanPreview;
  options?: string[];
  confirmed?: boolean;
}

export interface ChatState {
  messages: ChatMessage[];
  pending: boolean;
  welcomeShown: boolean;

  addMessage: (message: ChatMessage) => void;
  setPending: (pending: boolean) => void;
  setWelcomeShown: () => void;
  confirmPlan: (messageId: string) => void;
  cancelPlan: (messageId: string) => void;
  handleWsEvent: (event: WsEventEnvelope) => void;
}

let messageCounter = 0;
function nextId(): string {
  return `msg-${Date.now()}-${++messageCounter}`;
}

export const useChatStore = create<ChatState>()((set) => ({
  messages: [],
  pending: false,
  welcomeShown: false,

  addMessage: (message) =>
    set((state) => ({
      messages: [...state.messages, { ...message, id: message.id || nextId() }],
    })),

  setPending: (pending) => set({ pending }),

  setWelcomeShown: () => set({ welcomeShown: true }),

  confirmPlan: (messageId) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId ? { ...m, confirmed: true } : m
      ),
    })),

  cancelPlan: (messageId) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId ? { ...m, confirmed: false } : m
      ),
    })),

  handleWsEvent: (event) => {
    if (event.event !== WS_EVENT_TYPES.COMMAND_RESPONSE) return;

    const data = event.data as {
      type?: MessageType;
      content?: string;
      planPreview?: PlanPreview;
      options?: string[];
    };

    set((state) => ({
      pending: false,
      messages: [
        ...state.messages,
        {
          id: nextId(),
          role: 'assistant' as const,
          type: data.type ?? 'text',
          content: data.content ?? '',
          timestamp: event.timestamp,
          planPreview: data.planPreview,
          options: data.options,
        },
      ],
    }));
  },
}));
