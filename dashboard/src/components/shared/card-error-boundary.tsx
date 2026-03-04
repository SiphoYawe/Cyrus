'use client';

import { Component, type ReactNode, type ErrorInfo } from 'react';
import * as Sentry from '@sentry/nextjs';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

interface CardErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  cachedContent?: ReactNode;
  className?: string;
  onRetry?: () => void;
}

interface CardErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class CardErrorBoundary extends Component<
  CardErrorBoundaryProps,
  CardErrorBoundaryState
> {
  constructor(props: CardErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): CardErrorBoundaryState {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[CardErrorBoundary] caught error:', error, info.componentStack);
    Sentry.captureException(error, {
      contexts: { react: { componentStack: info.componentStack ?? undefined } },
    });
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
    this.props.onRetry?.();
  };

  override render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    if (this.props.fallback) {
      return this.props.fallback;
    }

    return (
      <div className={cn('relative overflow-hidden rounded-xl border bg-card', this.props.className)}>
        {/* Cached content with overlay */}
        {this.props.cachedContent && (
          <div className="opacity-40 pointer-events-none select-none">
            {this.props.cachedContent}
          </div>
        )}
        <div
          className={cn(
            'flex flex-col items-center justify-center gap-3 p-6 text-center',
            this.props.cachedContent && 'absolute inset-0 bg-card/80 backdrop-blur-sm'
          )}
        >
          <p className="text-xs text-muted-foreground">
            {this.state.error?.message ?? 'Failed to load data'}
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={this.handleRetry}
            className="h-7 text-xs"
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }
}
