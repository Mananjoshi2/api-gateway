import { Request, Response } from 'express';
import RedisMock from 'ioredis-mock';
import { TokenService } from '../src/auth/tokens';
import { requireAuth, enforceRouteAuth } from '../src/auth/authMiddleware';
import { HttpError } from '../src/lib/httpError';
import { RouteConfig } from '../src/config/schema';

function mockReq(headers: Record<string, string> = {}, route?: RouteConfig): Partial<Request> {
  return { headers, gatewayRoute: route } as unknown as Request;
}

const user = {
  id: 'user-1',
  email: 'alice@example.com',
  passwordHash: 'x',
  tier: 'pro',
  apiKey: 'sk_test',
  createdAt: new Date().toISOString(),
};

describe('requireAuth middleware', () => {
  const redis = new RedisMock();
  const tokenService = new TokenService(redis as any);
  const middleware = requireAuth(tokenService);

  it('rejects requests with no Authorization header (401)', () => {
    const req = mockReq();
    const next = jest.fn();

    middleware(req as Request, {} as Response, next);

    expect(next).toHaveBeenCalledWith(expect.any(HttpError));
    const err = next.mock.calls[0][0] as HttpError;
    expect(err.status).toBe(401);
    expect(err.code).toBe('missing_token');
  });

  it('rejects an invalid/garbage token (403)', () => {
    const req = mockReq({ authorization: 'Bearer not-a-real-token' });
    const next = jest.fn();

    middleware(req as Request, {} as Response, next);

    expect(next).toHaveBeenCalledWith(expect.any(HttpError));
    const err = next.mock.calls[0][0] as HttpError;
    expect(err.status).toBe(403);
    expect(err.code).toBe('invalid_token');
  });

  it('attaches req.auth and calls next() with no error for a valid token', async () => {
    const { accessToken } = await tokenService.issueTokenPair(user);
    const req = mockReq({ authorization: `Bearer ${accessToken}` });
    const next = jest.fn();

    middleware(req as Request, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
    expect((req as Request).auth).toEqual({
      userId: user.id,
      email: user.email,
      tier: user.tier,
      apiKey: user.apiKey,
    });
  });
});

describe('enforceRouteAuth', () => {
  const redis = new RedisMock();
  const tokenService = new TokenService(redis as any);
  const middleware = enforceRouteAuth(tokenService);

  const publicRoute: RouteConfig = { path: '/api/public', auth: 'none', tier: 'free', stripPrefix: false, upstream: 'http://x' };
  const protectedRoute: RouteConfig = { path: '/api/users', auth: 'required', tier: 'free', stripPrefix: false, upstream: 'http://x' };

  it('skips auth entirely for routes marked auth: none', () => {
    const req = mockReq({}, publicRoute);
    const next = jest.fn();

    middleware(req as Request, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('enforces auth for routes marked auth: required', () => {
    const req = mockReq({}, protectedRoute);
    const next = jest.fn();

    middleware(req as Request, {} as Response, next);

    const err = next.mock.calls[0][0] as HttpError;
    expect(err.status).toBe(401);
  });
});
