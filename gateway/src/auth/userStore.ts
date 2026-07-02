import { randomBytes, randomUUID } from 'crypto';
import { Redis } from 'ioredis';
import { User } from './types';

const userKey = (id: string) => `user:${id}`;
const emailIndexKey = (email: string) => `user:email:${email.toLowerCase()}`;

/**
 * Users live in Redis (hashes), not a relational DB. Deliberate for this project:
 * keeps the stack lean (Redis is already required for rate limiting) and is plenty
 * for a demo. In a real product this would be a Postgres table with migrations.
 */
export class UserStore {
  constructor(private readonly redis: Redis) {}

  async findByEmail(email: string): Promise<User | null> {
    const id = await this.redis.get(emailIndexKey(email));
    if (!id) return null;
    return this.findById(id);
  }

  async findById(id: string): Promise<User | null> {
    const data = await this.redis.hgetall(userKey(id));
    if (!data || Object.keys(data).length === 0) return null;
    return data as unknown as User;
  }

  async create(email: string, passwordHash: string, tier: string): Promise<User> {
    const existing = await this.redis.get(emailIndexKey(email));
    if (existing) {
      throw new Error('email_taken');
    }

    const user: User = {
      id: randomUUID(),
      email: email.toLowerCase(),
      passwordHash,
      tier,
      apiKey: `sk_${randomBytes(20).toString('hex')}`,
      createdAt: new Date().toISOString(),
    };

    const multi = this.redis.multi();
    multi.hset(userKey(user.id), { ...user });
    multi.set(emailIndexKey(user.email), user.id);
    await multi.exec();

    return user;
  }
}
