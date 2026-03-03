import { describe, it, expect } from 'vitest';
import { createLogger } from './logger.js';

describe('createLogger', () => {
  it('creates a logger with component name', () => {
    const logger = createLogger('test-component');
    expect(logger).toBeDefined();
    // The logger should have the component binding
    expect(logger.bindings().component).toBe('test-component');
  });

  it('creates different child loggers', () => {
    const logger1 = createLogger('component-a');
    const logger2 = createLogger('component-b');

    expect(logger1.bindings().component).toBe('component-a');
    expect(logger2.bindings().component).toBe('component-b');
  });
});
