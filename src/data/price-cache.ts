const DEFAULT_TTL_MS = 30_000; // 30 seconds

interface CacheEntry {
  readonly price: number;
  readonly timestamp: number;
}

export class PriceCache {
  private readonly ttlMs: number;
  private readonly entries = new Map<string, CacheEntry>();

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  get(key: string): number | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    return entry.price;
  }

  set(key: string, price: number): void {
    this.entries.set(key, { price, timestamp: Date.now() });
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
