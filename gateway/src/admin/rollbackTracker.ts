import { Redis } from 'ioredis';

// Single atomic op: push this request's outcome, trim to the configured window
// size, and return the error count + window size -- all in one round trip so
// concurrent requests recording outcomes for the same version can't race.
const RECORD_OUTCOME_SCRIPT = `
local key = KEYS[1]
local outcome = ARGV[1]
local window_size = tonumber(ARGV[2])

redis.call('LPUSH', key, outcome)
redis.call('LTRIM', key, 0, window_size - 1)

local items = redis.call('LRANGE', key, 0, -1)
local errors = 0
for _, v in ipairs(items) do
  if v == '1' then
    errors = errors + 1
  end
end

return { errors, #items }
`;

type RollbackRedis = Redis & {
  recordOutcome(key: string, outcome: '0' | '1', windowSize: number): Promise<[number, number]>;
};

export interface WindowStats {
  errors: number;
  total: number;
}

const windowKey = (routePath: string, version: string) => `rollback:${routePath}:${version}`;

/**
 * Tracks a rolling window of the last N outcomes (success/error) per
 * (route, version) in Redis, so the circuit breaker's view of error rate is
 * shared across every gateway instance -- not just the one that happened to
 * handle a given request.
 */
export class RollbackTracker {
  private readonly redis: RollbackRedis;

  constructor(redis: Redis) {
    const client = redis as RollbackRedis;
    if (typeof client.recordOutcome !== 'function') {
      redis.defineCommand('recordOutcome', { numberOfKeys: 1, lua: RECORD_OUTCOME_SCRIPT });
    }
    this.redis = client;
  }

  async record(routePath: string, version: string, isError: boolean, windowSize: number): Promise<WindowStats> {
    const [errors, total] = await this.redis.recordOutcome(windowKey(routePath, version), isError ? '1' : '0', windowSize);
    return { errors, total };
  }

  /** Read-only peek at current window state, used by the admin status endpoint. */
  async getStats(routePath: string, version: string): Promise<WindowStats> {
    const items = await this.redis.lrange(windowKey(routePath, version), 0, -1);
    const errors = items.filter((v) => v === '1').length;
    return { errors, total: items.length };
  }

  async reset(routePath: string, version: string): Promise<void> {
    await this.redis.del(windowKey(routePath, version));
  }
}
