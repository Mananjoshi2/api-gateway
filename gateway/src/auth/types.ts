export type Tier = 'free' | 'pro';

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  tier: string;
  apiKey: string;
  createdAt: string;
}

export interface AccessTokenPayload {
  sub: string; // user id
  email: string;
  tier: string;
  apiKey: string;
  type: 'access';
}

export interface RefreshTokenPayload {
  sub: string;
  jti: string;
  type: 'refresh';
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // access token TTL, seconds
}
