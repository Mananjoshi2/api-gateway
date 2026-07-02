import { Request, Response, NextFunction } from 'express';
import { RateLimiter, RateLimitDecision } from '../rateLimit/rateLimiter';
import { ConfigStore } from '../config/configStore';
import { HttpError } from '../lib/httpError';

export type RateLimitHooks = {
  onDecision?: (routePath: string, tierName: string, decision: RateLimitDecision) => void;
};

/**
 * Rate limits by API key when the request is authenticated (req.auth is set by
 * requireAuth, which runs before this in the chain), falling back to source IP
 * for public routes. The tier -- and therefore the limit -- comes from the
 * user's account (req.auth.tier) when authenticated, or the route's configured
 * default tier otherwise.
 */
export function rateLimit(configStore: ConfigStore, limiter: RateLimiter, hooks: RateLimitHooks = {}) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const route = req.gatewayRoute;
      const tierName = req.auth?.tier || route?.tier || 'free';
      const tier = configStore.getTier(tierName);

      if (!tier) {
        next(new HttpError(500, 'bad_gateway_config', `routes.yaml references unknown tier "${tierName}"`));
        return;
      }

      const key = req.auth?.apiKey ? `apikey:${req.auth.apiKey}` : `ip:${req.ip}`;
      const decision = await limiter.check(key, tier);
      hooks.onDecision?.(route?.path || req.path, tierName, decision);

      res.setHeader('X-RateLimit-Limit', decision.limit);
      res.setHeader('X-RateLimit-Remaining', decision.remaining);
      res.setHeader('X-RateLimit-Reset', Math.ceil(decision.resetAfterMs / 1000));

      if (!decision.allowed) {
        res.setHeader('Retry-After', Math.ceil(decision.retryAfterMs / 1000));
        next(new HttpError(429, 'rate_limit_exceeded', 'Too many requests, slow down'));
        return;
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
