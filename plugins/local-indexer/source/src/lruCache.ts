/**
 * LRU Cache — §4.4 Query Cache
 *
 * 반복 쿼리 최적화를 위한 경량 in-memory LRU 캐시.
 * 외부 의존성 없이 Map의 삽입 순서 특성을 활용.
 */
export class LruCache<V> {
  private readonly maxSize: number;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, { value: V; expiresAt: number }>();

  constructor(options: { maxSize?: number; ttlMs?: number } = {}) {
    this.maxSize = options.maxSize ?? 64;
    this.ttlMs = options.ttlMs ?? 5 * 60 * 1000; // 기본 5분
  }

  get(key: string): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    // LRU: 접근 시 맨 뒤로 이동 (Map은 삽입 순서 유지)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    this.cache.delete(key); // 기존 항목 제거 (순서 갱신)
    if (this.cache.size >= this.maxSize) {
      // 가장 오래된 항목(맨 앞) 제거
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /** 특정 키 패턴 무효화 (문서 재인덱싱 시) */
  invalidate(prefix: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}
