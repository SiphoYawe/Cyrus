import type { CyrusAgent } from './cyrus-agent.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('signal-handler');
const FORCE_EXIT_TIMEOUT_MS = 30_000;

export function setupSignalHandlers(
  agent: CyrusAgent,
  onShutdown?: () => Promise<void>
): void {
  let shuttingDown = false;

  const handleSignal = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      logger.warn({ signal }, 'Signal received during shutdown, ignoring');
      return;
    }

    shuttingDown = true;
    logger.info({ signal }, 'Shutdown signal received');

    // Force exit after timeout
    const forceExitTimer = setTimeout(() => {
      logger.fatal('Force exit after timeout');
      process.exit(1);
    }, FORCE_EXIT_TIMEOUT_MS);

    // Allow the timer to not prevent process exit if everything finishes
    if (typeof forceExitTimer === 'object' && 'unref' in forceExitTimer) {
      forceExitTimer.unref();
    }

    try {
      agent.stop();

      if (onShutdown) {
        await onShutdown();
      }

      logger.info('Graceful shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error({ error }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => {
    void handleSignal('SIGTERM');
  });

  process.on('SIGINT', () => {
    void handleSignal('SIGINT');
  });
}
