import { Router } from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { Redis } from 'ioredis';
import { UserStore } from './userStore';
import { TokenService } from './tokens';
import { HttpError } from '../lib/httpError';

const BCRYPT_ROUNDS = 10;

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'password must be at least 8 characters'),
  // Demo affordance: normally tier comes from a billing system, not user input.
  tier: z.enum(['free', 'pro']).default('free'),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

const refreshSchema = z.object({
  refreshToken: z.string(),
});

export function createAuthRouter(redis: Redis): Router {
  const router = Router();
  const userStore = new UserStore(redis);
  const tokenService = new TokenService(redis);

  /**
   * @openapi
   * /auth/register:
   *   post:
   *     summary: Create an account
   *     tags: [Auth]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [email, password]
   *             properties:
   *               email: { type: string, format: email }
   *               password: { type: string, minLength: 8 }
   *               tier: { type: string, enum: [free, pro], default: free }
   *     responses:
   *       201:
   *         description: Account created, returns API key + token pair
   *       409:
   *         description: Email already registered
   */
  router.post('/register', async (req, res, next) => {
    try {
      const body = registerSchema.parse(req.body);
      const passwordHash = await bcrypt.hash(body.password, BCRYPT_ROUNDS);

      let user;
      try {
        user = await userStore.create(body.email, passwordHash, body.tier);
      } catch (err) {
        if (err instanceof Error && err.message === 'email_taken') {
          throw new HttpError(409, 'email_taken', 'An account with this email already exists');
        }
        throw err;
      }

      const tokens = await tokenService.issueTokenPair(user);
      res.status(201).json({
        user: { id: user.id, email: user.email, tier: user.tier, apiKey: user.apiKey },
        ...tokens,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * @openapi
   * /auth/login:
   *   post:
   *     summary: Exchange email + password for a token pair
   *     tags: [Auth]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [email, password]
   *             properties:
   *               email: { type: string, format: email }
   *               password: { type: string }
   *     responses:
   *       200:
   *         description: Token pair issued
   *       401:
   *         description: Invalid credentials
   */
  router.post('/login', async (req, res, next) => {
    try {
      const body = loginSchema.parse(req.body);
      const user = await userStore.findByEmail(body.email);
      const passwordMatches = user ? await bcrypt.compare(body.password, user.passwordHash) : false;

      if (!user || !passwordMatches) {
        throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect');
      }

      const tokens = await tokenService.issueTokenPair(user);
      res.json({
        user: { id: user.id, email: user.email, tier: user.tier, apiKey: user.apiKey },
        ...tokens,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * @openapi
   * /auth/refresh:
   *   post:
   *     summary: Rotate a refresh token for a new access + refresh token pair
   *     tags: [Auth]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [refreshToken]
   *             properties:
   *               refreshToken: { type: string }
   *     responses:
   *       200:
   *         description: New token pair issued, old refresh token is now invalid
   *       401:
   *         description: Refresh token invalid, expired, or already used (all sessions revoked)
   */
  router.post('/refresh', async (req, res, next) => {
    try {
      const body = refreshSchema.parse(req.body);
      const result = await tokenService.rotateRefreshToken(body.refreshToken);

      if (result === 'invalid') {
        throw new HttpError(401, 'invalid_refresh_token', 'Refresh token is invalid or expired');
      }
      if (result === 'reused') {
        throw new HttpError(401, 'refresh_token_reused', 'Refresh token was already used; all sessions revoked');
      }

      const user = await userStore.findById(result.userId);
      if (!user) {
        throw new HttpError(401, 'invalid_refresh_token', 'User no longer exists');
      }

      const tokens = await tokenService.issueTokenPair(user);
      res.json(tokens);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
