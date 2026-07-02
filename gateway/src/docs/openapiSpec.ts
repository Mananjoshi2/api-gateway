import path from 'path';
import swaggerJsdoc from 'swagger-jsdoc';

// Picks up JSDoc @openapi blocks from source (dev, via tsx) or compiled output
// (prod, via node dist/index.js) by matching whatever extension this file
// itself was loaded with -- .ts under tsx, .js under the built dist/.
const ext = path.extname(__filename);

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'Developer-Facing API Gateway',
      version: '1.0.0',
      description:
        'Reverse proxy with JWT auth, Redis-backed per-API-key rate limiting, ' +
        'version-aware routing, and an auto-rollback circuit breaker.',
    },
    servers: [{ url: '/', description: 'This gateway instance' }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      headers: {
        'X-RateLimit-Limit': {
          description: 'Max burst size for the caller\'s tier',
          schema: { type: 'integer' },
        },
        'X-RateLimit-Remaining': {
          description: 'Requests left in the current burst allowance',
          schema: { type: 'integer' },
        },
        'X-RateLimit-Reset': {
          description: 'Seconds until the bucket fully refills',
          schema: { type: 'integer' },
        },
        'Retry-After': {
          description: 'Seconds to wait before retrying (429 responses only)',
          schema: { type: 'integer' },
        },
        'X-Request-Id': {
          description: 'Correlates a request across gateway logs and upstream logs',
          schema: { type: 'string' },
        },
      },
    },
    tags: [
      { name: 'Auth', description: 'Registration, login, and token refresh' },
      { name: 'Gateway', description: 'Proxied application routes (configured in routes.yaml)' },
      { name: 'Admin', description: 'Runtime control: version rollback, health' },
    ],
  },
  apis: [path.join(__dirname, '..', '**', `*${ext}`)],
};

export const openapiSpec = swaggerJsdoc(options);
