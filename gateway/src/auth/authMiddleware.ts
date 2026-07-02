import { Request, Response, NextFunction } from 'express';
import { TokenService } from './tokens';
import { HttpError } from '../lib/httpError';

/**
 * Verifies the Authorization: Bearer <accessToken> header and attaches the
 * decoded identity (including tier + apiKey, both embedded as JWT claims) to
 * req.auth. Downstream middleware (rate limiter) reads req.auth.apiKey/tier
 * without a second Redis lookup.
 */
export function requireAuth(tokenService: TokenService) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      next(new HttpError(401, 'missing_token', 'Authorization: Bearer <token> header is required'));
      return;
    }

    const token = header.slice('Bearer '.length);
    try {
      const payload = tokenService.verifyAccessToken(token);
      req.auth = { userId: payload.sub, email: payload.email, tier: payload.tier, apiKey: payload.apiKey };
      next();
    } catch (err) {
      const message = err instanceof Error && err.name === 'TokenExpiredError' ? 'access token expired' : 'invalid access token';
      next(new HttpError(403, 'invalid_token', message));
    }
  };
}

/** Applies requireAuth only to routes whose matched config says auth: required. */
export function enforceRouteAuth(tokenService: TokenService) {
  const protectedAuth = requireAuth(tokenService);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.gatewayRoute?.auth === 'required') {
      protectedAuth(req, res, next);
      return;
    }
    next();
  };
}
