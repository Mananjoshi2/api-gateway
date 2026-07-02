import RedisMock from 'ioredis-mock';
import bcrypt from 'bcrypt';
import { UserStore } from '../src/auth/userStore';
import { TokenService } from '../src/auth/tokens';

describe('UserStore', () => {
  const redis = new RedisMock();
  const userStore = new UserStore(redis as any);

  afterEach(async () => {
    await redis.flushall();
  });

  it('creates a user and finds it by email', async () => {
    const hash = await bcrypt.hash('password123', 4);
    const user = await userStore.create('Alice@Example.com', hash, 'free');

    expect(user.email).toBe('alice@example.com');
    expect(user.apiKey).toMatch(/^sk_/);

    const found = await userStore.findByEmail('alice@example.com');
    expect(found?.id).toBe(user.id);
  });

  it('rejects duplicate emails', async () => {
    const hash = await bcrypt.hash('password123', 4);
    await userStore.create('bob@example.com', hash, 'free');
    await expect(userStore.create('bob@example.com', hash, 'free')).rejects.toThrow('email_taken');
  });
});

describe('TokenService', () => {
  const redis = new RedisMock();
  const tokenService = new TokenService(redis as any);
  const user = {
    id: 'user-1',
    email: 'alice@example.com',
    passwordHash: 'x',
    tier: 'pro',
    apiKey: 'sk_test',
    createdAt: new Date().toISOString(),
  };

  afterEach(async () => {
    await redis.flushall();
  });

  it('issues an access token that embeds tier and apiKey claims', async () => {
    const { accessToken } = await tokenService.issueTokenPair(user);
    const payload = tokenService.verifyAccessToken(accessToken);

    expect(payload.sub).toBe(user.id);
    expect(payload.tier).toBe('pro');
    expect(payload.apiKey).toBe('sk_test');
  });

  it('rotates a refresh token exactly once', async () => {
    const { refreshToken } = await tokenService.issueTokenPair(user);

    const first = await tokenService.rotateRefreshToken(refreshToken);
    expect(first).not.toBe('invalid');
    expect(first).not.toBe('reused');

    // Reusing the same (now-rotated-out) refresh token must be rejected.
    const second = await tokenService.rotateRefreshToken(refreshToken);
    expect(second).toBe('reused');
  });

  it('rejects a malformed refresh token', async () => {
    const result = await tokenService.rotateRefreshToken('not-a-real-token');
    expect(result).toBe('invalid');
  });

  it('revokes all sessions when a rotated-out token is replayed', async () => {
    const { refreshToken: token1 } = await tokenService.issueTokenPair(user);
    const rotated = await tokenService.rotateRefreshToken(token1);
    expect(rotated).not.toBe('invalid');
    expect(rotated).not.toBe('reused');

    // Issue a second, independent session for the same user.
    const { refreshToken: token2 } = await tokenService.issueTokenPair(user);

    // Replay the already-used token1 -> triggers revoke-all.
    await tokenService.rotateRefreshToken(token1);

    // token2, though never used, should now be revoked too.
    const resultForToken2 = await tokenService.rotateRefreshToken(token2);
    expect(resultForToken2).toBe('reused');
  });
});
