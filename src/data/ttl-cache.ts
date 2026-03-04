// Generic TTL cache for market data

interface CacheEntry<T> {
  readonly value: T;
  readonly timestamp: number;
}

export class TtlCache<T> {
  private readonly ttlMs: number;
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  get(key: string): T | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.entries.set(key, { value, timestamp: Date.now() });
  }

  invalidate(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
