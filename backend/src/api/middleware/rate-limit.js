import { randomUUID } from 'node:crypto';
import { RateLimitedError } from '../../shared/errors.js';

const WINDOW_MS = 60_000;

// A sorted set of request timestamps: entries older than the window are dropped
// on every call, so the window slides instead of resetting on a fixed boundary.
export function createRateLimiter({
  redis,
  limit,
  windowMs = WINDOW_MS,
  keyPrefix = 'ratelimit:publish',
  identify = (req) => req.auth.apiKeyId,
  subject = 'this API key',
}) {
  async function resetSeconds(key, now) {
    const [, oldestScore] = await redis.zrange(key, 0, 0, 'WITHSCORES');

    if (!oldestScore) {
      return Math.ceil(windowMs / 1000);
    }

    return Math.max(1, Math.ceil((Number(oldestScore) + windowMs - now) / 1000));
  }

  return async function rateLimit(req, res, next) {
    const identified = identify(req);
    const identities = (Array.isArray(identified) ? identified : [identified]).map((identity) =>
      typeof identity === 'object' ? identity : { value: identity, limit, subject },
    );
    const keys = identities.map(({ value }) => `${keyPrefix}:${value}`);
    const now = Date.now();
    const member = `${now}-${randomUUID()}`;

    const transaction = redis.multi();

    for (const key of keys) {
      transaction
        .zremrangebyscore(key, 0, now - windowMs)
        .zadd(key, now, member)
        .zcard(key)
        .pexpire(key, windowMs);
    }

    const results = await transaction.exec();
    const usedByKey = keys.map((_, index) => Number(results[index * 4 + 2][1]));
    const resets = await Promise.all(keys.map((key) => resetSeconds(key, now)));
    const remainingByKey = identities.map(
      ({ limit: identityLimit }, index) => identityLimit - usedByKey[index],
    );
    const limitingIndex = remainingByKey.indexOf(Math.min(...remainingByKey));
    const limitingIdentity = identities[limitingIndex];
    const reset = resets[limitingIndex];

    res.setHeader('RateLimit-Limit', String(limitingIdentity.limit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, remainingByKey[limitingIndex])));
    res.setHeader('RateLimit-Reset', String(reset));

    if (remainingByKey.every((remaining) => remaining >= 0)) {
      next();

      return;
    }

    // The rejected call is removed again: a client that keeps hammering would
    // otherwise keep pushing its own window forward and never recover.
    const rollback = redis.multi();

    for (const key of keys) {
      rollback.zrem(key, member);
    }

    await rollback.exec();

    throw new RateLimitedError(
      `${limitingIdentity.limit} requests per minute allowed for ${limitingIdentity.subject}`,
      {
        'Retry-After': String(reset),
        'RateLimit-Limit': String(limitingIdentity.limit),
        'RateLimit-Remaining': '0',
        'RateLimit-Reset': String(reset),
      },
    );
  };
}
