import { describe, it, expect, vi } from 'vitest';
import { RunnableBase } from './runnable-base.js';

// Concrete implementation for testing
class TestRunnable extends RunnableBase {
  public controlTaskFn: () => Promise<void> = async () => {};
  public onStopFn: () => Promise<void> = async () => {};

  constructor(tickIntervalMs: number = 10) {
    super(tickIntervalMs, 'test-runnable');
  }

  async controlTask(): Promise<void> {
    return this.controlTaskFn();
  }

  async onStop(): Promise<void> {
    return this.onStopFn();
  }
}

describe('RunnableBase', () => {
  it('starts and stops the loop', async () => {
    const runnable = new TestRunnable(5);
    let ticks = 0;

    runnable.controlTaskFn = async () => {
      ticks++;
      if (ticks >= 3) {
        runnable.stop();
      }
    };

    expect(runnable.isRunning()).toBe(false);
    await runnable.start();
    expect(runnable.isRunning()).toBe(false);
    expect(ticks).toBe(3);
  });

  it('increments tick count on each successful iteration', async () => {
    const runnable = new TestRunnable(5);
    let ticks = 0;

    runnable.controlTaskFn = async () => {
      ticks++;
      if (ticks >= 5) {
        runnable.stop();
      }
    };

    await runnable.start();
    expect(runnable.getTickCount()).toBe(5);
  });

  it('isolates errors and continues the loop', async () => {
    const runnable = new TestRunnable(5);
    let callCount = 0;

    runnable.controlTaskFn = async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('transient error');
      }
      if (callCount >= 3) {
        runnable.stop();
      }
    };

    await runnable.start();
    // Call 1: error (no tick increment), Call 2: success (tick=1), Call 3: success + stop (tick=2)
    expect(callCount).toBe(3);
    expect(runnable.getTickCount()).toBe(2);
  });

  it('stops after 10 consecutive errors', async () => {
    const runnable = new TestRunnable(1);
    let callCount = 0;

    runnable.controlTaskFn = async () => {
      callCount++;
      throw new Error(`error #${callCount}`);
    };

    await runnable.start();
    expect(callCount).toBe(10);
    expect(runnable.isRunning()).toBe(false);
    expect(runnable.getTickCount()).toBe(0);
  });

  it('resets consecutive error count on success', async () => {
    const runnable = new TestRunnable(1);
    let callCount = 0;

    runnable.controlTaskFn = async () => {
      callCount++;
      // Fail calls 1-3, succeed call 4, fail calls 5-7, stop on call 8
      if (callCount <= 3) throw new Error('fail');
      if (callCount === 4) return; // success - resets counter
      if (callCount <= 7) throw new Error('fail again');
      runnable.stop();
    };

    await runnable.start();
    // Should not have stopped due to 10 consecutive errors
    expect(callCount).toBe(8);
  });

  it('calls onStop when the loop ends', async () => {
    const runnable = new TestRunnable(5);
    let onStopCalled = false;

    runnable.controlTaskFn = async () => {
      runnable.stop();
    };

    runnable.onStopFn = async () => {
      onStopCalled = true;
    };

    await runnable.start();
    expect(onStopCalled).toBe(true);
  });

  it('setTickInterval updates the tick interval for the next sleep cycle', async () => {
    const runnable = new TestRunnable(100);
    expect(runnable.getTickIntervalMs()).toBe(100);

    let ticks = 0;
    runnable.controlTaskFn = async () => {
      ticks++;
      if (ticks === 1) {
        // Update interval via protected method (accessible in subclass)
        (runnable as unknown as { setTickInterval: (ms: number) => void }).setTickInterval(5);
      }
      if (ticks >= 3) {
        runnable.stop();
      }
    };

    await runnable.start();
    expect(ticks).toBe(3);
    expect(runnable.getTickIntervalMs()).toBe(5);
  });

  it('returns correct isRunning state', async () => {
    const runnable = new TestRunnable(5);
    expect(runnable.isRunning()).toBe(false);

    let wasRunningDuringTick = false;
    runnable.controlTaskFn = async () => {
      wasRunningDuringTick = runnable.isRunning();
      runnable.stop();
    };

    await runnable.start();
    expect(wasRunningDuringTick).toBe(true);
    expect(runnable.isRunning()).toBe(false);
  });
});
