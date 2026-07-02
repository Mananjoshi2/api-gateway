import { Router } from 'express';
import { z } from 'zod';
import { ConfigStore } from '../config/configStore';
import { RollbackTracker } from './rollbackTracker';
import { HttpError } from '../lib/httpError';

const setVersionSchema = z.object({
  routePath: z.string().startsWith('/'),
  version: z.string(),
});

export function createAdminRouter(configStore: ConfigStore, tracker: RollbackTracker): Router {
  const router = Router();

  /**
   * @openapi
   * /admin/routes:
   *   get:
   *     summary: List configured routes and, for versioned routes, live rollback/circuit-breaker stats
   *     tags: [Admin]
   *     security: [{ bearerAuth: [] }]
   *     responses:
   *       200:
   *         description: Route status list, including per-version error-window stats for versioned routes
   */
  router.get('/routes', async (_req, res, next) => {
    try {
      const routes = configStore.getRoutes();
      const result = await Promise.all(
        routes.map(async (route) => {
          if (!route.versions) {
            return { path: route.path, upstream: route.upstream, auth: route.auth, tier: route.tier };
          }

          const versions = await Promise.all(
            Object.keys(route.versions).map(async (v) => ({
              version: v,
              upstream: route.versions![v],
              stats: await tracker.getStats(route.path, v),
            })),
          );

          return {
            path: route.path,
            auth: route.auth,
            tier: route.tier,
            activeVersion: route.activeVersion,
            rollback: route.rollback,
            versions,
          };
        }),
      );
      res.json({ routes: result });
    } catch (err) {
      next(err);
    }
  });

  /**
   * @openapi
   * /admin/routes/version:
   *   post:
   *     summary: Manually set the active version for a versioned route
   *     description: >
   *       Same mechanism the circuit breaker uses to auto-rollback -- this is
   *       the manual escape hatch (force a rollback, or roll forward again
   *       once a bad version is fixed).
   *     tags: [Admin]
   *     security: [{ bearerAuth: [] }]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [routePath, version]
   *             properties:
   *               routePath: { type: string, example: /api/orders }
   *               version: { type: string, example: v2 }
   *     responses:
   *       200:
   *         description: Active version updated
   *       404:
   *         description: Route or version not found
   */
  router.post('/routes/version', (req, res, next) => {
    try {
      const body = setVersionSchema.parse(req.body);
      const flipped = configStore.setActiveVersion(body.routePath, body.version);
      if (!flipped) {
        throw new HttpError(404, 'route_or_version_not_found', `No route "${body.routePath}" with version "${body.version}"`);
      }
      res.json({ routePath: body.routePath, activeVersion: body.version });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
