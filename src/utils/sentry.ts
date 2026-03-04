import * as Sentry from '@sentry/node';

const SECRET_PATTERNS = [
  /0x[a-fA-F0-9]{64}/g,
  /sk-[a-zA-Z0-9-_]{20,}/g,
];

function scrubSecrets(value: string): string {
  let result = value;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

function scrubEventStrings(obj: unknown): unknown {
  if (typeof obj === 'string') return scrubSecrets(obj);
  if (Array.isArray(obj)) return obj.map(scrubEventStrings);
  if (obj && typeof obj === 'object') {
    const scrubbed: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      scrubbed[key] = scrubEventStrings(val);
    }
    return scrubbed;
  }
  return obj;
}

let initialized = false;

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'production',
    tracesSampleRate: 0,
    beforeSend(event) {
      // Scrub secrets from exception messages
      if (event.exception?.values) {
        for (const ex of event.exception.values) {
          if (ex.value) ex.value = scrubSecrets(ex.value);
        }
      }
      // Scrub secrets from breadcrumbs
      if (event.breadcrumbs) {
        event.breadcrumbs = scrubEventStrings(event.breadcrumbs) as typeof event.breadcrumbs;
      }
      // Scrub extras
      if (event.extra) {
        event.extra = scrubEventStrings(event.extra) as typeof event.extra;
      }
      return event;
    },
  });

  initialized = true;
}

export function captureError(
  error: unknown,
  context?: Record<string, unknown>,
): void {
  if (!initialized) return;

  Sentry.withScope((scope) => {
    if (context) {
      for (const [key, value] of Object.entries(context)) {
        scope.setExtra(key, value);
      }
    }

    // Extract context from domain errors that carry extra info
    if (error instanceof Error && 'context' in error) {
      const ctx = (error as Error & { context?: Record<string, unknown> }).context;
      if (ctx && typeof ctx === 'object') {
        for (const [key, value] of Object.entries(ctx)) {
          scope.setExtra(key, value);
        }
      }
    }

    Sentry.captureException(error);
  });
}

export { Sentry };
