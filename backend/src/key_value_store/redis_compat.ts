/**
 * Owned by Task 2-d. Port of backend/onyx/redis (Standard's Redis layer).
 *
 * Python sources consulted:
 *   - /home/z/onyx/backend/onyx/redis/redis_pool.py
 *     (get_redis_client / RedisPool: single shared client bound to REDIS_HOST/PORT/DB,
 *      retries + health checks; here collapsed to one lazy ioredis singleton on REDIS_URL)
 *   - /home/z/onyx/backend/onyx/redis/redis_connector.py
 *     (RedisConnector fence/task-key conventions -> REDIS_KEY_PREFIX applied to every key)
 *   - /home/z/onyx/backend/onyx/key_value_store/store.py (PgRedisKVStore)
 *     (KV surface: store/load/delete with JSON values + TTL, SCAN via keys(),
 *      and the "never crash the API when Redis goes down" fail-open behavior)
 *
 * Deviation from Standard: Onyx pairs the Redis cache with a Postgres kv_store
 * table for durability. This port is Redis-only (the onyx_ts KV store is a
 * cache of ephemeral connector state), so kvGet/kvSet are fail-open: every
 * operation is wrapped in try/catch and logs a warning instead of throwing.
 */
import Redis from "ioredis";
import { REDIS_KEY_PREFIX, REDIS_URL } from "../configs/constants";
import { getLogger } from "../utils/logger";

const logger = getLogger("key_value_store.redis");

let client: Redis | null = null;

/**
 * Minimal no-op client used when REDIS_URL is unset (e.g. Vercel serverless
 * without a managed Redis). Every operation resolves to the "miss/empty"
 * shape; the surrounding kv* functions are fail-open anyway. This avoids
 * ioredis connection storms against an undefined endpoint.
 */
function createNoopRedis(): Redis {
  const stub = {
    get: async () => null,
    set: async () => "OK",
    del: async () => 0,
    keys: async () => [] as string[],
    ping: async () => "PONG",
    quit: async () => "OK",
    disconnect: () => {},
    on: () => stub,
    status: "noop",
  } as unknown as Redis;
  return stub;
}

/** Lazy singleton ioredis client (port of redis_pool.get_redis_client). */
export function getRedis(): Redis {
  if (!client) {
    if (!REDIS_URL) {
      logger.warning("REDIS_URL not set — using no-op in-memory KV (fail-open mode)");
      client = createNoopRedis();
      return client;
    }
    client = new Redis(REDIS_URL, {
      lazyConnect: false,
      maxRetriesPerRequest: 1,
      // Keep the process alive even if Redis is briefly unreachable.
      enableOfflineQueue: true,
      retryStrategy: (times) => Math.min(times * 500, 5000),
    });
    client.on("error", (err: unknown) => {
      logger.warning("redis connection error", { error: String(err) });
    });
  }
  return client;
}

/** Full physical key: REDIS_KEY_PREFIX + logical key (port of tenant prefixing). */
export function redisKey(key: string): string {
  return `${REDIS_KEY_PREFIX}${key}`;
}

/** Strip the REDIS_KEY_PREFIX from a physical key; non-prefixed keys pass through. */
export function stripRedisKeyPrefix(key: string): string {
  return key.startsWith(REDIS_KEY_PREFIX) ? key.slice(REDIS_KEY_PREFIX.length) : key;
}

/** Close the shared Redis connection (graceful shutdown). */
export async function closeRedis(): Promise<void> {
  if (client) {
    const c = client;
    client = null;
    try {
      await c.quit();
    } catch {
      c.disconnect();
    }
  }
}

/**
 * GET a string value. Returns null on miss or on Redis failure (fail-open).
 */
export async function kvGet(key: string): Promise<string | null> {
  try {
    return await getRedis().get(redisKey(key));
  } catch (err) {
    logger.warning("kvGet failed", { key, error: String(err) });
    return null;
  }
}

/**
 * SET a string value, with optional TTL in seconds (SETEX semantics).
 */
export async function kvSet(key: string, value: string, ttlSeconds?: number): Promise<void> {
  try {
    if (ttlSeconds !== undefined && ttlSeconds > 0) {
      await getRedis().set(redisKey(key), value, "EX", Math.floor(ttlSeconds));
    } else {
      await getRedis().set(redisKey(key), value);
    }
  } catch (err) {
    logger.warning("kvSet failed", { key, error: String(err) });
  }
}

/** DEL a key. */
export async function kvDelete(key: string): Promise<void> {
  try {
    await getRedis().del(redisKey(key));
  } catch (err) {
    logger.warning("kvDelete failed", { key, error: String(err) });
  }
}

/**
 * KEYS with a glob pattern relative to the logical (unprefixed) namespace.
 * Port of onyx/redis SCAN usage (SCAN_ITER_COUNT_DEFAULT); plain KEYS is
 * acceptable at onyx-ts scale. Returned keys have the prefix stripped.
 */
export async function kvKeys(pattern: string): Promise<string[]> {
  try {
    const physical = await getRedis().keys(redisKey(pattern));
    return physical.map(stripRedisKeyPrefix);
  } catch (err) {
    logger.warning("kvKeys failed", { pattern, error: String(err) });
    return [];
  }
}

/** JSON-typed KV helpers used by connector state + generic cache (port of PgRedisKVStore.store/load JSON serialization). */
export async function kvGetJson<T>(key: string): Promise<T | null> {
  const raw = await kvGet(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    logger.warning("kvGetJson: unparseable value", { key, error: String(err) });
    return null;
  }
}

export async function kvSetJson(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
  await kvSet(key, JSON.stringify(value), ttlSeconds);
}
