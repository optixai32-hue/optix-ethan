/**
 * Owned by Task 2-d. Generic read-through cache.
 *
 * Python sources consulted:
 *   - /home/z/onyx/backend/onyx/cache/interface.py (CacheBackend: get/set with TTL,
 *     fail-open on CACHE_TRANSIENT_ERRORS)
 *   - /home/z/onyx/backend/onyx/cache/redis_backend.py (RedisCacheBackend: JSON-ish
 *     string payloads in Redis with EX TTL, namespaced keys)
 *   - /home/z/onyx/backend/onyx/key_value_store/store.py (PgRedisKVStore: JSON
 *     serialization + 1-day KV_REDIS_KEY_EXPIRATION; here the default TTL is 300s
 *     per the porting spec)
 *
 * Implementation: Redis is the source of truth for entries; a process-local
 * Map acts as an in-memory read-through layer in front of it. Cache misses
 * populate both layers. invalidateNamespace deletes every namespaced key in
 * Redis and clears the local layer. Redis failures are logged, never thrown.
 */
import { kvDelete, kvGet, kvKeys, kvSet } from "../key_value_store/redis_compat";
import { getLogger } from "../utils/logger";

const logger = getLogger("cache.generic_cache");

export const DEFAULT_CACHE_TTL_SECONDS = 300;

interface MemoryEntry<T> {
  value: T;
  expiresAtMs: number;
}

export class GenericCache<T> {
  private readonly namespace: string;
  private readonly ttlSeconds: number;
  private readonly memory = new Map<string, MemoryEntry<T>>();

  constructor(namespace: string, ttlSeconds: number = DEFAULT_CACHE_TTL_SECONDS) {
    this.namespace = namespace;
    this.ttlSeconds = ttlSeconds;
  }

  /** Physical Redis key for a logical cache key: `<namespace>:<key>`. */
  private key(key: string): string {
    return `${this.namespace}:${key}`;
  }

  private memGet(key: string): T | null {
    const entry = this.memory.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAtMs) {
      this.memory.delete(key);
      return null;
    }
    return entry.value;
  }

  private memSet(key: string, value: T): void {
    this.memory.set(key, {
      value,
      expiresAtMs: Date.now() + this.ttlSeconds * 1000,
    });
  }

  /**
   * Read-through get: memory -> Redis (JSON) -> null.
   */
  async get(key: string): Promise<T | null> {
    const hit = this.memGet(key);
    if (hit !== null) return hit;
    const raw = await kvGet(this.key(key));
    if (raw === null) return null;
    try {
      const value = JSON.parse(raw) as T;
      this.memSet(key, value);
      return value;
    } catch (err) {
      logger.warning("cache: unparseable Redis value, treating as miss", {
        namespace: this.namespace,
        key,
        error: String(err),
      });
      return null;
    }
  }

  /**
   * Write-through set: Redis (JSON, TTL) + memory.
   */
  async set(key: string, value: T, ttlSeconds: number = this.ttlSeconds): Promise<void> {
    try {
      await kvSet(this.key(key), JSON.stringify(value), ttlSeconds);
    } catch (err) {
      // kvSet already logs; keep going so a Redis outage never breaks callers.
      logger.warning("cache: Redis set failed (memory-only)", {
        namespace: this.namespace,
        key,
        error: String(err),
      });
    }
    this.memSet(key, value);
  }

  /**
   * Delete a single key from both layers.
   */
  async invalidate(key: string): Promise<void> {
    this.memory.delete(key);
    await kvDelete(this.key(key));
  }

  /**
   * Delete every key in this namespace (Redis KEYS scan + DEL + memory clear).
   */
  async invalidateNamespace(): Promise<void> {
    this.memory.clear();
    const keys = await kvKeys(`${this.namespace}:*`);
    for (const fullKey of keys) {
      await kvDelete(fullKey);
    }
    if (keys.length > 0) {
      logger.info("cache: namespace invalidated", { namespace: this.namespace, keys: keys.length });
    }
  }
}
