import { createLogger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import type pino from 'pino';

export abstract class RunnableBase {
  protected running = false;
  protected tickCount = 0;
  protected consecutiveErrors = 0;
  protected readonly logger: pino.Logger;
  private readonly tickIntervalMs: number;

  constructor(tickIntervalMs: number = 30_000, loggerName: string = 'runnable') {
    this.tickIntervalMs = tickIntervalMs;
    this.logger = createLogger(loggerName);
  }

  async start(): Promise<void> {
    this.running = true;
    this.logger.info({ tickIntervalMs: this.tickIntervalMs }, 'Runnable started');

    while (this.running) {
      try {
        await this.controlTask();
        this.consecutiveErrors = 0;
        this.tickCount++;
      } catch (error) {
        this.consecutiveErrors++;
        this.logger.error(
          { error, consecutiveErrors: this.consecutiveErrors, tickCount: this.tickCount },
          'Error in control task'
        );

        if (this.consecutiveErrors >= 10) {
          this.logger.fatal(
            { consecutiveErrors: this.consecutiveErrors },
            'Too many consecutive errors, pausing runnable'
          );
          this.running = false;
        }
      }

      if (this.running) {
        await sleep(this.tickIntervalMs);
      }
    }

    await this.onStop();
  }

  stop(): void {
    this.logger.info({ tickCount: this.tickCount }, 'Stop requested');
    this.running = false;
  }

  abstract controlTask(): Promise<void>;
  abstract onStop(): Promise<void>;

  getTickCount(): number {
    return this.tickCount;
  }

  isRunning(): boolean {
    return this.running;
  }
}
