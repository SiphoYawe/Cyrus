'use client';

import { WebSocketProvider } from '@/providers/ws-provider';
import { AppSidebar } from '@/components/layout/sidebar';
import { Header } from '@/components/layout/header';
import { ConnectionBanner } from '@/components/layout/connection-banner';
import { GlobalChatShortcut } from '@/components/chat/global-chat-shortcut';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <WebSocketProvider>
      <GlobalChatShortcut />
      <div className="flex h-screen overflow-hidden bg-background">
        <AppSidebar />
        <div className="flex flex-1 flex-col overflow-hidden">
          <ConnectionBanner />
          <Header />
          <main className="flex-1 overflow-y-auto p-6">{children}</main>
        </div>
      </div>
    </WebSocketProvider>
  );
}
