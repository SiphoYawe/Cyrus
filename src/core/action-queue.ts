import type { ExecutorAction } from './action-types.js';

export class ActionQueue {
  private queue: ExecutorAction[] = [];

  enqueue(action: ExecutorAction): void {
    this.queue.push(action);
    // Sort descending by priority (higher priority = first)
    this.queue.sort((a, b) => b.priority - a.priority);
  }

  dequeue(): ExecutorAction | undefined {
    return this.queue.shift();
  }

  peek(): ExecutorAction | undefined {
    return this.queue[0];
  }

  size(): number {
    return this.queue.length;
  }

  isEmpty(): boolean {
    return this.queue.length === 0;
  }

  drain(): ExecutorAction[] {
    const all = this.queue.splice(0);
    return all;
  }

  clear(): void {
    this.queue.length = 0;
  }
}
