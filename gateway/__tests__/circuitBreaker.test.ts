import RedisMock from 'ioredis-mock';
import { ConfigStore } from '../src/config/configStore';
import { RollbackTracker } from '../src/admin/rollbackTracker';
import { evaluateRollback } from '../src/admin/circuitBreaker';
import { RouteConfig } from '../src/config/schema';

function makeConfigStore(route: RouteConfig): ConfigStore {
  // ConfigStore reads from disk in its constructor; bypass that for a unit
  // test by building the instance then overwriting its private state.
  const store = Object.create(ConfigStore.prototype) as ConfigStore;
  (store as any).config = { tiers: {}, routes: [route] };
  return store;
}

describe('evaluateRollback (circuit breaker)', () => {
  let redis: InstanceType<typeof RedisMock>;
  let tracker: RollbackTracker;
  let route: RouteConfig;

  beforeEach(() => {
    redis = new RedisMock();
    tracker = new RollbackTracker(redis as any);
    route = {
      path: '/api/orders',
      auth: 'required',
      tier: 'pro',
      stripPrefix: false,
      versions: { v1: 'http://v1', v2: 'http://v2' },
      activeVersion: 'v2',
      rollback: { enabled: true, errorThreshold: 0.5, windowSize: 50 },
    };
  });

  afterEach(async () => {
    await redis.flushall();
  });

  it('does nothing below the minimum sample size, even at 100% errors', async () => {
    const store = makeConfigStore(route);
    for (let i = 0; i < 4; i++) {
      await evaluateRollback(store, tracker, route, 'v2', true);
    }
    expect(route.activeVersion).toBe('v2');
  });

  it('rolls back once the error rate crosses the threshold with enough samples', async () => {
    const store = makeConfigStore(route);
    // 5 samples, 3 errors = 60% >= 50% threshold, and 5 >= MIN_SAMPLE_SIZE
    await evaluateRollback(store, tracker, route, 'v2', true);
    await evaluateRollback(store, tracker, route, 'v2', true);
    await evaluateRollback(store, tracker, route, 'v2', false);
    await evaluateRollback(store, tracker, route, 'v2', true);
    await evaluateRollback(store, tracker, route, 'v2', false);

    expect(route.activeVersion).toBe('v1');
  });

  it('does not roll back when the error rate stays under the threshold', async () => {
    const store = makeConfigStore(route);
    for (let i = 0; i < 10; i++) {
      // 1 error out of every 5 = 20%, under the 50% threshold
      await evaluateRollback(store, tracker, route, 'v2', i % 5 === 0);
    }
    expect(route.activeVersion).toBe('v2');
  });

  it('ignores outcomes for a version that is no longer active', async () => {
    const store = makeConfigStore(route);
    route.activeVersion = 'v1'; // already rolled back / rolled forward elsewhere
    for (let i = 0; i < 10; i++) {
      await evaluateRollback(store, tracker, route, 'v2', true);
    }
    // v2 isn't the active version, so its errors should never trigger a flip
    expect(route.activeVersion).toBe('v1');
  });

  it('is a no-op for routes with rollback disabled', async () => {
    route.rollback = { enabled: false, errorThreshold: 0.5, windowSize: 50 };
    const store = makeConfigStore(route);
    for (let i = 0; i < 10; i++) {
      await evaluateRollback(store, tracker, route, 'v2', true);
    }
    expect(route.activeVersion).toBe('v2');
  });
});

describe('RollbackTracker', () => {
  let redis: InstanceType<typeof RedisMock>;
  let tracker: RollbackTracker;

  beforeEach(() => {
    redis = new RedisMock();
    tracker = new RollbackTracker(redis as any);
  });

  afterEach(async () => {
    await redis.flushall();
  });

  it('keeps only the most recent windowSize outcomes', async () => {
    for (let i = 0; i < 10; i++) {
      await tracker.record('/api/orders', 'v2', true, 5);
    }
    const stats = await tracker.getStats('/api/orders', 'v2');
    expect(stats.total).toBe(5);
    expect(stats.errors).toBe(5);
  });

  it('reset clears the window', async () => {
    await tracker.record('/api/orders', 'v2', true, 50);
    await tracker.reset('/api/orders', 'v2');
    const stats = await tracker.getStats('/api/orders', 'v2');
    expect(stats.total).toBe(0);
  });
});
