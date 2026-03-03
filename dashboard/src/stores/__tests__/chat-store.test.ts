import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../chat-store';
import { WS_EVENT_TYPES } from '@/types/ws';

describe('chat-store', () => {
  beforeEach(() => {
    useChatStore.setState({
      messages: [],
      pending: false,
      welcomeShown: false,
    });
  });

  it('starts with empty messages', () => {
    const state = useChatStore.getState();
    expect(state.messages).toHaveLength(0);
    expect(state.pending).toBe(false);
  });

  it('addMessage appends message', () => {
    useChatStore.getState().addMessage({
      id: 'test-1',
      role: 'user',
      type: 'text',
      content: 'Move 20% to Aave',
      timestamp: Date.now(),
    });
    expect(useChatStore.getState().messages).toHaveLength(1);
    expect(useChatStore.getState().messages[0].content).toBe('Move 20% to Aave');
  });

  it('setPending toggles pending state', () => {
    useChatStore.getState().setPending(true);
    expect(useChatStore.getState().pending).toBe(true);
  });

  it('handles COMMAND_RESPONSE event', () => {
    useChatStore.getState().setPending(true);
    useChatStore.getState().handleWsEvent({
      event: WS_EVENT_TYPES.COMMAND_RESPONSE,
      data: {
        type: 'text',
        content: 'I will move 20% of your portfolio to Aave on Optimism.',
      },
      timestamp: Date.now(),
    });

    const state = useChatStore.getState();
    expect(state.pending).toBe(false);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].role).toBe('assistant');
  });

  it('confirmPlan marks message as confirmed', () => {
    useChatStore.getState().addMessage({
      id: 'plan-1',
      role: 'assistant',
      type: 'plan_preview',
      content: 'Plan preview',
      timestamp: Date.now(),
      planPreview: { summary: 'Move to Aave' },
    });

    useChatStore.getState().confirmPlan('plan-1');
    expect(useChatStore.getState().messages[0].confirmed).toBe(true);
  });
});
