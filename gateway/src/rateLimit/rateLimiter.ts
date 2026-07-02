import { Redis } from 'ioredis';
import { GCRA_SCRIPT } from './gcraScript';
import { Tier } from '../config/schema';

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAfterMs: number;
  retryAfterMs: number;
}

type GcraRedis = Redis & {
  gcra(
    key: string,
    burst: number,
    ratePerPeriod: number,
    periodMs: number,
    nowMs: number,
    cost: number,
  ): Promise<[number, number, number, number]>;
};

// Tiers are expressed as requestsPerSecond, so the GCRA "period" is a fixed 1000ms.
const PERIOD_MS = 1000;

export class RateLimiter {
  private readonly redis: GcraRedis;

  constructor(redis: Redis) {
    const client = redis as GcraRedis;
    if (typeof client.gcra !== 'function') {
      redis.defineCommand('gcra', { numberOfKeys: 1, lua: GCRA_SCRIPT });
    }
    this.redis = client;
  }

  async check(key: string, tier: Tier, cost = 1): Promise<RateLimitDecision> {
    const now = Date.now();
    const [allowed, remaining, resetAfterMs, retryAfterMs] = await this.redis.gcra(
      `ratelimit:${key}`,
      tier.burst,
      tier.requestsPerSecond,
      PERIOD_MS,
      now,
      cost,
    );

    return {
      allowed: allowed === 1,
      limit: tier.burst,
      remaining,
      resetAfterMs,
      retryAfterMs,
    };
  }
}
