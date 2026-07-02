import express, { Express } from 'express';
import pinoHttp from 'pino-http';
import { ConfigStore } from './config/configStore';
import { requestId, REQUEST_ID_HEADER } from './middleware/requestId';
import { resolveRoute } from './middleware/resolveRoute';
import { notFoundHandler, errorHandler } from './middleware/errorHandler';
import { createGatewayProxy } from './proxy/proxy';
import { logger } from './lib/logger';

export function createApp(configStore: ConfigStore): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(requestId);
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

  // Proxy everything that matches a configured route.
  const proxy = createGatewayProxy();
  app.use(resolveRoute(configStore), proxy);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
