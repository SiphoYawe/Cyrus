import { loadConfig } from './core/config.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('main');

async function main(): Promise<void> {
  const { config } = loadConfig();

  logger.info(
    {
      mode: config.mode,
      tickIntervalMs: config.tickIntervalMs,
      integrator: config.integrator,
    },
    'Cyrus agent starting'
  );

  // Agent initialization will be added in Story 1.3
  logger.info('Cyrus agent initialized — awaiting runtime loop implementation');
}

main().catch((error) => {
  logger.fatal({ error }, 'Cyrus agent failed to start');
  process.exit(1);
});
