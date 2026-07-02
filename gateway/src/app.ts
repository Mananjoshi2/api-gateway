import express, { Express } from 'express';
import pinoHttp from 'pino-http';
import { Redis } from 'ioredis';
import { ConfigStore } from './config/configStore';
import { requestId, REQUEST_ID_HEADER } from './middleware/requestId';
import { resolveRoute } from './middleware/resolveRoute';
import { notFoundHandler, errorHandler } from './middleware/errorHandler';
import { createGatewayProxy } from './proxy/proxy';
import { logger } from './lib/logger';
import { createAuthRouter } from './auth/authRoutes';
import { TokenService } from './auth/tokens';
import { enforceRouteAuth } from './auth/authMiddleware';

export function createApp(configStore: ConfigStore, redis: Redis): Express {
  const app = express();
  const tokenService = new TokenService(redis);

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

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/auth', createAuthRouter(redis));

  // Proxy everything that matches a configured route. Auth is enforced per-route
  // based on routes.yaml (auth: required), after the route is resolved.
  const proxy = createGatewayProxy();
  app.use(resolveRoute(configStore), enforceRouteAuth(tokenService), proxy);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
