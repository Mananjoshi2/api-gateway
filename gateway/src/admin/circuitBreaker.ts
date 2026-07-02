import { ConfigStore } from '../config/configStore';
import { RouteConfig } from '../config/schema';
import { RollbackTracker } from './rollbackTracker';
import { logger } from '../lib/logger';

// Don't trip the breaker off a handful of noisy requests -- wait for at least
// this many samples (or the full window, if it's smaller) before judging.
const MIN_SAMPLE_SIZE = 5;

/**
 * Called after every proxied response on a versioned route. Records the
 * outcome in a Redis-backed rolling window for (route, version), and flips
 * routing back to the other version if the error rate crosses the configured
 * threshold.
 *
 * Simplification, worth calling out: with exactly two versions this always
 * rolls back to "the other one." It doesn't track which version was last
 * known-good, so if both versions are unhealthy it will flap between them.
 * A real system would require N consecutive healthy samples before
 * re-promoting a version, and would track more than two candidates -- out of
 * scope for this demo, where v2 is deliberately the only one seeded with a
 * nonzero error rate.
 */
export async function evaluateRollback(
  configStore: ConfigStore,
  tracker: RollbackTracker,
  route: RouteConfig,
  version: string,
  isError: boolean,
): Promise<void> {
  if (!route.rollback?.enabled || !route.versions) return;
  // A response for a version that's no longer active is either stale (raced a
  // manual/auto flip) or from a version nobody's routing to anymore -- skip it
  // so we don't keep tripping the breaker on traffic that already moved on.
  if (version !== route.activeVersion) return;

  const { errorThreshold, windowSize } = route.rollback;
  const stats = await tracker.record(route.path, version, isError, windowSize);

  if (stats.total < Math.min(MIN_SAMPLE_SIZE, windowSize)) return;

  const errorRate = stats.errors / stats.total;
  if (errorRate < errorThreshold) return;

  const fallback = Object.keys(route.versions).find((v) => v !== version);
  if (!fallback) return;

  const flipped = configStore.setActiveVersion(route.path, fallback);
  if (flipped) {
    logger.warn(
      { route: route.path, from: version, to: fallback, errorRate, sampleSize: stats.total },
      'circuit breaker tripped: rolling back to previous version',
    );
  }
}
