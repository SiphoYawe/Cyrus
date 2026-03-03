'use client';

import { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';

/**
 * GlobalChatShortcut — registers Cmd+K (Mac) / Ctrl+K (Win/Linux) globally.
 * - If on /chat: focuses the chat textarea (dispatches a custom event that ChatPage listens to).
 * - If on any other page: navigates to /chat.
 */
export function GlobalChatShortcut() {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const isMac =
        typeof navigator !== 'undefined' &&
        navigator.platform.toUpperCase().includes('MAC');
      const modifierKey = isMac ? e.metaKey : e.ctrlKey;

      if (!modifierKey || e.key !== 'k') return;

      e.preventDefault();

      if (pathname === '/chat') {
        // Dispatch custom event — ChatPage listens and focuses the input
        window.dispatchEvent(new CustomEvent('cyrus:focus-chat-input'));
      } else {
        router.push('/chat');
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [pathname, router]);

  return null;
}
