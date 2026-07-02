import { z } from 'zod';

export const tierSchema = z.object({
  requestsPerSecond: z.number().positive(),
  burst: z.number().positive(),
});

export const rollbackSchema = z.object({
  enabled: z.boolean().default(false),
  // fraction of requests in the window that must error (5xx or proxy failure) to trigger rollback
  errorThreshold: z.number().min(0).max(1).default(0.5),
  // number of most recent requests to consider per version
  windowSize: z.number().int().positive().default(50),
});

export const routeSchema = z
  .object({
    path: z.string().startsWith('/'),
    auth: z.enum(['none', 'required']).default('none'),
    tier: z.string().default('free'),
    stripPrefix: z.boolean().default(false),
    upstream: z.string().url().optional(),
    versions: z.record(z.string(), z.string().url()).optional(),
    activeVersion: z.string().optional(),
    rollback: rollbackSchema.optional(),
  })
  .refine((r) => Boolean(r.upstream) || Boolean(r.versions && r.activeVersion), {
    message: 'route must define either "upstream" or both "versions" and "activeVersion"',
  });

export const gatewayConfigSchema = z.object({
  tiers: z.record(z.string(), tierSchema),
  routes: z.array(routeSchema),
});

export type Tier = z.infer<typeof tierSchema>;
export type RollbackConfig = z.infer<typeof rollbackSchema>;
export type RouteConfig = z.infer<typeof routeSchema>;
export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;
