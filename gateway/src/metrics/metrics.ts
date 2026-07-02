import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'gateway_process_' });

export const httpRequestsTotal = new client.Counter({
  name: 'gateway_http_requests_total',
  help: 'Total HTTP requests handled by the gateway',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [registry],
});

export const httpRequestDurationSeconds = new client.Histogram({
  name: 'gateway_http_request_duration_seconds',
  help: 'HTTP request latency in seconds, measured at the gateway (includes upstream round trip)',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const rateLimitRejectionsTotal = new client.Counter({
  name: 'gateway_rate_limit_rejections_total',
  help: 'Total requests rejected with 429 by the rate limiter',
  labelNames: ['route', 'tier'] as const,
  registers: [registry],
});

export const upstreamErrorsTotal = new client.Counter({
  name: 'gateway_upstream_errors_total',
  help: 'Total 5xx responses or connection failures from an upstream service',
  labelNames: ['route', 'version', 'status_code'] as const,
  registers: [registry],
});
