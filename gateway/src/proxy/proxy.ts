import { createProxyMiddleware, Options } from 'http-proxy-middleware';
import { Response } from 'express';
import { IncomingMessage } from 'http';
import { RouteConfig } from '../config/schema';
import { HttpError } from '../lib/httpError';
import { logger } from '../lib/logger';

type GatewayRequest = IncomingMessage & {
  gatewayRoute?: RouteConfig;
  gatewayProxyStart?: number;
};

export type ProxyHooks = {
  onProxyResponse?: (route: RouteConfig, version: string | undefined, statusCode: number, durationMs: number) => void;
  onProxyError?: (route: RouteConfig, version: string | undefined) => void;
};

function resolveTarget(route: RouteConfig): { target: string; version?: string } {
  if (route.upstream) return { target: route.upstream };
  if (route.versions && route.activeVersion) {
    const target = route.versions[route.activeVersion];
    if (!target) throw new HttpError(500, 'bad_gateway_config', `unknown active version for ${route.path}`);
    return { target, version: route.activeVersion };
  }
  throw new HttpError(500, 'bad_gateway_config', `route ${route.path} has no resolvable upstream`);
}

/**
 * One dynamic proxy mounted for all routes. The target is resolved per-request
 * from req.gatewayRoute (set by resolveRoute middleware), which lets version
 * flips from the rollback/admin logic take effect on the very next request
 * with no proxy re-creation.
 */
export function createGatewayProxy(hooks: ProxyHooks = {}) {
  const options: Options = {
    changeOrigin: true,
    router: (req) => resolveTarget((req as GatewayRequest).gatewayRoute as RouteConfig).target,
    pathRewrite: (path, req) => {
      const route = (req as GatewayRequest).gatewayRoute as RouteConfig;
      if (route?.stripPrefix) {
        return path.slice(route.path.length) || '/';
      }
      return path;
    },
    on: {
      proxyReq: (_proxyReq, req) => {
        (req as GatewayRequest).gatewayProxyStart = Date.now();
      },
      proxyRes: (proxyRes, req) => {
        const request = req as GatewayRequest;
        const route = request.gatewayRoute as RouteConfig;
        const start = request.gatewayProxyStart;
        const duration = start ? Date.now() - start : 0;
        const { version } = resolveTarget(route);
        hooks.onProxyResponse?.(route, version, proxyRes.statusCode || 0, duration);
      },
      error: (err, req, res) => {
        const request = req as GatewayRequest;
        const route = request.gatewayRoute;
        const version = route ? resolveTarget(route).version : undefined;
        logger.error({ err, path: route?.path }, 'upstream proxy error');
        hooks.onProxyError?.(route as RouteConfig, version);

        const response = res as Response;
        if (response && !response.headersSent && 'writeHead' in response) {
          response.writeHead(502, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: 'bad_gateway', message: 'Upstream service unavailable' }));
        }
      },
    },
  };

  return createProxyMiddleware(options);
}
