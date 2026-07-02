import RedisMock from 'ioredis-mock';
import { RateLimiter } from '../src/rateLimit/rateLimiter';
import { Tier } from '../src/config/schema';

describe('RateLimiter (GCRA token bucket via Lua script)', () => {
  let redis: InstanceType<typeof RedisMock>;
  let limiter: RateLimiter;

  const tier: Tier = { requestsPerSecond: 10, burst: 5 };

  beforeEach(() => {
    redis = new RedisMock();
    limiter = new RateLimiter(redis as any);
  });

  afterEach(async () => {
    await redis.flushall();
  });

  it('allows up to `burst` requests immediately, then rejects', async () => {
    const now = 1_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);

    const results = [];
    for (let i = 0; i < tier.burst + 2; i++) {
      results.push(await limiter.check('client-a', tier));
    }

    const allowed = results.filter((r) => r.allowed);
    const rejected = results.filter((r) => !r.allowed);

    expect(allowed).toHaveLength(tier.burst);
    expect(rejected).toHaveLength(2);
  });

  it('returns decreasing remaining counts as the burst is consumed', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(2_000_000);

    const first = await limiter.check('client-b', tier);
    const second = await limiter.check('client-b', tier);

    expect(first.remaining).toBe(tier.burst - 1);
    expect(second.remaining).toBe(tier.burst - 2);
  });

  it('sets a non-zero Retry-After (retryAfterMs) when rejected', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(3_000_000);

    for (let i = 0; i < tier.burst; i++) {
      await limiter.check('client-c', tier);
    }
    const rejected = await limiter.check('client-c', tier);

    expect(rejected.allowed).toBe(false);
    expect(rejected.retryAfterMs).toBeGreaterThan(0);
  });

  it('refills over time: a request succeeds again after waiting one emission interval', async () => {
    const start = 4_000_000;
    const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(start);

    for (let i = 0; i < tier.burst; i++) {
      await limiter.check('client-d', tier);
    }
    const exhausted = await limiter.check('client-d', tier);
    expect(exhausted.allowed).toBe(false);

    // emission interval = 1000ms / 10rps = 100ms per token
    const emissionIntervalMs = 1000 / tier.requestsPerSecond;
    dateSpy.mockReturnValue(start + emissionIntervalMs + 5);

    const afterWait = await limiter.check('client-d', tier);
    expect(afterWait.allowed).toBe(true);
  });

  it('tracks separate buckets per key (per-API-key isolation)', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(5_000_000);

    for (let i = 0; i < tier.burst; i++) {
      await limiter.check('client-e', tier);
    }
    const clientEExhausted = await limiter.check('client-e', tier);
    const clientFFresh = await limiter.check('client-f', tier);

    expect(clientEExhausted.allowed).toBe(false);
    expect(clientFFresh.allowed).toBe(true);
  });

  it('respects different tiers (pro gets a bigger burst than free)', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(6_000_000);
    const free: Tier = { requestsPerSecond: 5, burst: 2 };
    const pro: Tier = { requestsPerSecond: 50, burst: 20 };

    let freeAllowed = 0;
    let proAllowed = 0;
    for (let i = 0; i < 10; i++) {
      if ((await limiter.check('free-client', free)).allowed) freeAllowed++;
      if ((await limiter.check('pro-client', pro)).allowed) proAllowed++;
    }

    expect(proAllowed).toBeGreaterThan(freeAllowed);
    expect(freeAllowed).toBe(2);
    expect(proAllowed).toBe(10);
  });
});
