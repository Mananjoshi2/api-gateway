import { Request, Response, NextFunction } from 'express';
import { httpRequestsTotal, httpRequestDurationSeconds } from '../metrics/metrics';

/**
 * Mounted before route resolution so it wraps every request, including 401s,
 * 404s, and 429s. Reads req.gatewayRoute inside the res.on('finish') callback
 * (evaluated once the request has fully completed), by which point
 * downstream middleware has already resolved and attached it.
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
    // req.path is relative to the mount point for sub-routers (e.g. "/register"
    // inside the /auth router) -- prefix with baseUrl to get "/auth/register".
    const route = req.gatewayRoute?.path || `${req.baseUrl}${req.path}` || req.path;
    const labels = { method: req.method, route, status_code: String(res.statusCode) };
    httpRequestsTotal.inc(labels);
    httpRequestDurationSeconds.observe(labels, durationSeconds);
  });

  next();
}
