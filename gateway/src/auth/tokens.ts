import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { Redis } from 'ioredis';
import { AccessTokenPayload, RefreshTokenPayload, TokenPair, User } from './types';

const ACCESS_TOKEN_TTL_SECONDS = parseInt(process.env.ACCESS_TOKEN_TTL_SECONDS || '900', 10); // 15 min
const REFRESH_TOKEN_TTL_SECONDS = parseInt(process.env.REFRESH_TOKEN_TTL_SECONDS || '604800', 10); // 7 days

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-me';
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-change-me';

const refreshKey = (jti: string) => `refresh:${jti}`;
const userSessionsKey = (userId: string) => `user:${userId}:refreshJtis`;

export class TokenService {
  constructor(private readonly redis: Redis) {}

  private signAccessToken(user: User): string {
    const payload: AccessTokenPayload = {
      sub: user.id,
      email: user.email,
      tier: user.tier,
      apiKey: user.apiKey,
      type: 'access',
    };
    return jwt.sign(payload, ACCESS_SECRET, { expiresIn: ACCESS_TOKEN_TTL_SECONDS });
  }

  private async signRefreshToken(userId: string): Promise<string> {
    const jti = randomUUID();
    const payload: RefreshTokenPayload = { sub: userId, jti, type: 'refresh' };
    const token = jwt.sign(payload, REFRESH_SECRET, { expiresIn: REFRESH_TOKEN_TTL_SECONDS });

    const multi = this.redis.multi();
    multi.set(refreshKey(jti), userId, 'EX', REFRESH_TOKEN_TTL_SECONDS);
    multi.sadd(userSessionsKey(userId), jti);
    multi.expire(userSessionsKey(userId), REFRESH_TOKEN_TTL_SECONDS);
    await multi.exec();

    return token;
  }

  async issueTokenPair(user: User): Promise<TokenPair> {
    const [accessToken, refreshToken] = await Promise.all([
      Promise.resolve(this.signAccessToken(user)),
      this.signRefreshToken(user.id),
    ]);
    return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
  }

  verifyAccessToken(token: string): AccessTokenPayload {
    return jwt.verify(token, ACCESS_SECRET) as AccessTokenPayload;
  }

  /**
   * Verifies + rotates a refresh token. Rotation: the presented jti is deleted
   * the moment it's redeemed, and a new jti is issued. If a jti is presented
   * that isn't in the active set (already used, or forged), every session for
   * that user is revoked -- that's the signal a refresh token was stolen and
   * replayed after the legitimate client already rotated past it.
   */
  async rotateRefreshToken(token: string): Promise<{ userId: string; jti: string } | 'reused' | 'invalid'> {
    let payload: RefreshTokenPayload;
    try {
      payload = jwt.verify(token, REFRESH_SECRET) as RefreshTokenPayload;
    } catch {
      return 'invalid';
    }

    const storedUserId = await this.redis.get(refreshKey(payload.jti));
    if (!storedUserId || storedUserId !== payload.sub) {
      await this.revokeAllSessions(payload.sub);
      return 'reused';
    }

    const multi = this.redis.multi();
    multi.del(refreshKey(payload.jti));
    multi.srem(userSessionsKey(payload.sub), payload.jti);
    await multi.exec();

    return { userId: payload.sub, jti: payload.jti };
  }

  async revokeAllSessions(userId: string): Promise<void> {
    const jtis = await this.redis.smembers(userSessionsKey(userId));
    if (jtis.length === 0) return;
    const multi = this.redis.multi();
    for (const jti of jtis) multi.del(refreshKey(jti));
    multi.del(userSessionsKey(userId));
    await multi.exec();
  }
}
