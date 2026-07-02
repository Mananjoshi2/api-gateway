// This file has no meaningful runtime code -- it exists purely to hold an
// @openapi JSDoc block for behavior that isn't tied to a single Express route
// handler (the proxy is one dynamic handler for every path in routes.yaml).
// The trailing `export const` isn't used anywhere; it just gives TypeScript a
// real statement to anchor the comment to, so the comment survives into the
// compiled dist/*.js (a comment attached only to an empty `export {}` gets
// dropped during compilation). Keep this block starting exactly at @openapi --
// swagger-jsdoc parses everything after it as raw YAML, so any prose above
// the tag inside the same /** */ block corrupts the parsed spec.
/**
 * @openapi
 * /api/users/{id}:
 *   get:
 *     summary: Proxied to the "users" upstream (see gateway/config/routes.yaml)
 *     description: >
 *       Requires a Bearer access token (auth required). Rate limited per API key
 *       using the caller's account tier. Forwards to whichever upstream is
 *       configured for /api/users.
 *     tags: [Gateway]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Proxied response from the upstream
 *         headers:
 *           X-RateLimit-Limit: { $ref: '#/components/headers/X-RateLimit-Limit' }
 *           X-RateLimit-Remaining: { $ref: '#/components/headers/X-RateLimit-Remaining' }
 *           X-RateLimit-Reset: { $ref: '#/components/headers/X-RateLimit-Reset' }
 *           X-Request-Id: { $ref: '#/components/headers/X-Request-Id' }
 *       401:
 *         description: Missing Authorization header
 *       403:
 *         description: Invalid or expired access token
 *       429:
 *         description: Rate limit exceeded
 *         headers:
 *           Retry-After: { $ref: '#/components/headers/Retry-After' }
 *       502:
 *         description: Upstream unreachable or returned an error
 *
 * /api/orders/{id}:
 *   get:
 *     summary: Proxied to the versioned "orders" upstream (v1/v2, rollback-aware)
 *     description: >
 *       Requires a Bearer access token. Routed to whichever version is
 *       currently active (routes.yaml `activeVersion`). If the active version's
 *       error rate crosses `rollback.errorThreshold` over the last
 *       `rollback.windowSize` requests, the gateway automatically flips back to
 *       the last known-good version -- see Admin > POST /admin/routes/version.
 *     tags: [Gateway]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Proxied response from the active version's upstream
 *       401:
 *         description: Missing Authorization header
 *       403:
 *         description: Invalid or expired access token
 *       429:
 *         description: Rate limit exceeded
 *       502:
 *         description: Upstream unreachable or returned an error
 */
export const gatewayRouteDocs = true;
