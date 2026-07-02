import express, { Express } from 'express';
import pinoHttp from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { Redis } from 'ioredis';
import { ConfigStore } from './config/configStore';
import { openapiSpec } from './docs/openapiSpec';
import { requestId, REQUEST_ID_HEADER } from './middleware/requestId';
import { resolveRoute } from './middleware/resolveRoute';
import { notFoundHandler, errorHandler } from './middleware/errorHandler';
import { createGatewayProxy } from './proxy/proxy';
import { logger } from './lib/logger';
import { createAuthRouter } from './auth/authRoutes';
import { TokenService } from './auth/tokens';
import { enforceRouteAuth } from './auth/authMiddleware';
import { RateLimiter } from './rateLimit/rateLimiter';
import { rateLimit } from './middleware/rateLimit';
import { metricsMiddleware } from './middleware/metrics';
import { registry, rateLimitRejectionsTotal, upstreamErrorsTotal } from './metrics/metrics';

export function createApp(configStore: ConfigStore, redis: Redis): Express {
  const app = express();
  const tokenService = new TokenService(redis);
  const rateLimiter = new RateLimiter(redis);

  app.disable('x-powered-by');
  app.use(requestId);
  app.use(express.json());
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.headers[REQUEST_ID_HEADER] as string,
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
    }),
  );
  app.use(metricsMiddleware);

  /**
   * @openapi
   * /health:
   *   get:
   *     summary: Gateway liveness check
   *     tags: [Admin]
   *     responses:
   *       200:
   *         description: Gateway process is up
   */
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/docs.json', (_req, res) => res.json(openapiSpec));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec));

  /**
   * @openapi
   * /metrics:
   *   get:
   *     summary: Prometheus-format metrics (request counts, latency histograms, rate-limit rejections, upstream errors)
   *     tags: [Admin]
   *     responses:
   *       200:
   *         description: Metrics in Prometheus text exposition format
   */
  app.get('/metrics', async (_req, res) => {
    res.setHeader('Content-Type', registry.contentType);
    res.end(await registry.metrics());
  });

  app.use('/auth', createAuthRouter(redis));

  // Proxy everything that matches a configured route:
  //  1. resolveRoute   -- match path to routes.yaml, 404 if nothing matches
  //  2. enforceRouteAuth -- 401/403 if the route requires auth and it's missing/invalid
  //  3. rateLimit      -- per-API-key (or per-IP for public routes) token bucket
  const proxy = createGatewayProxy({
    onProxyResponse: (route, version, statusCode) => {
      if (statusCode >= 500) {
        upstreamErrorsTotal.inc({ route: route.path, version: version || 'n/a', status_code: String(statusCode) });
      }
    },
    onProxyError: (route, version) => {
      upstreamErrorsTotal.inc({ route: route?.path || 'unknown', version: version || 'n/a', status_code: 'network_error' });
    },
  });
  app.use(
    resolveRoute(configStore),
    enforceRouteAuth(tokenService),
    rateLimit(configStore, rateLimiter, {
      onDecision: (routePath, tierName, decision) => {
        if (!decision.allowed) rateLimitRejectionsTotal.inc({ route: routePath, tier: tierName });
      },
    }),
    proxy,
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
