'use client';

import { useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAccount, useSignMessage } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { SiweMessage } from 'siwe';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export default function AuthPage() {
  const router = useRouter();
  const { address, chainId, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();

  const handleSignIn = useCallback(async () => {
    if (!address || !chainId) return;

    try {
      // Get nonce
      const nonceRes = await fetch('/api/auth/nonce');
      const { nonce } = await nonceRes.json();

      // Create SIWE message
      const message = new SiweMessage({
        domain: window.location.host,
        address,
        statement: 'Sign in to CYRUS Agent Dashboard',
        uri: window.location.origin,
        version: '1',
        chainId,
        nonce,
      });

      const messageStr = message.prepareMessage();
      const signature = await signMessageAsync({ message: messageStr });

      // Verify with backend
      const verifyRes = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: messageStr, signature }),
      });

      if (verifyRes.ok) {
        router.push('/');
      }
    } catch {
      // User rejected or error — stay on page
    }
  }, [address, chainId, signMessageAsync, router]);

  // Check if already authenticated
  useEffect(() => {
    fetch('/api/auth/session')
      .then((r) => r.json())
      .then((data) => {
        if (data.authenticated) router.push('/');
      })
      .catch(() => {});
  }, [router]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-bold tracking-tight">
            CYRUS
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            Autonomous Cross-Chain Agent
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex justify-center">
            <ConnectButton />
          </div>

          {isConnected && (
            <div className="space-y-4">
              <p className="text-center text-sm text-muted-foreground">
                Sign a message to verify your wallet and access the dashboard.
              </p>
              <Button
                onClick={handleSignIn}
                className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
              >
                Sign In with Ethereum
              </Button>
            </div>
          )}

          {!isConnected && (
            <p className="text-center text-sm text-muted-foreground">
              Connect your wallet to get started.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
