import { describe, expect, it } from 'vitest';
import {
  PLACEHOLDER_ENCRYPTION_KEY,
  PLACEHOLDER_JWT_SECRET,
  parseEnv,
} from '../../src/shared/env-schema.js';

const validEnv = {
  DATABASE_URL: 'postgresql://user:pass@postgres:5432/hooktracker',
  REDIS_URL: 'redis://redis:6379',
  RABBITMQ_URL: 'amqp://user:pass@rabbitmq:5672',
  JWT_SECRET: PLACEHOLDER_JWT_SECRET,
  SECRET_ENCRYPTION_KEY: PLACEHOLDER_ENCRYPTION_KEY,
};

function pathsOf(result) {
  return result.error.issues.map((issue) => issue.path.join('.'));
}

describe('env schema', () => {
  it('applies the documented defaults', () => {
    const result = parseEnv(validEnv);

    expect(result.success).toBe(true);
    expect(result.data.NODE_ENV).toBe('development');
    expect(result.data.PORT).toBe(3000);
    expect(result.data.DATABASE_POOL_SIZE).toBe(10);
    expect(result.data.MAX_ATTEMPTS).toBe(6);
    expect(result.data.MAX_PAYLOAD_BYTES).toBe(262144);
    expect(result.data.RATE_LIMIT_PUBLISH_PER_MINUTE).toBe(600);
    expect(result.data.RATE_LIMIT_PUBLISH_PROJECT_PER_MINUTE).toBe(6000);
    expect(result.data.IDEMPOTENCY_TTL_SECONDS).toBe(86400);
    expect(result.data.BULK_REPLAY_LIMIT).toBe(500);
    expect(result.data.ENDPOINT_AUTO_DISABLE_THRESHOLD).toBe(20);
    expect(result.data.RETENTION_DAYS).toBe(30);
    expect(result.data.SSRF_ALLOW_PRIVATE).toBe(false);
    expect(result.data.CORS_ORIGINS).toEqual([]);
  });

  it('rejects a project publish limit below the per-key limit', () => {
    const result = parseEnv({
      ...validEnv,
      RATE_LIMIT_PUBLISH_PER_MINUTE: '600',
      RATE_LIMIT_PUBLISH_PROJECT_PER_MINUTE: '599',
    });

    expect(result.success).toBe(false);
    expect(pathsOf(result)).toContain('RATE_LIMIT_PUBLISH_PROJECT_PER_MINUTE');
  });

  it('reports every missing required variable at once', () => {
    const result = parseEnv({});

    expect(result.success).toBe(false);
    expect(pathsOf(result)).toEqual(
      expect.arrayContaining([
        'DATABASE_URL',
        'REDIS_URL',
        'RABBITMQ_URL',
        'JWT_SECRET',
        'SECRET_ENCRYPTION_KEY',
      ]),
    );
  });

  it('parses comma separated lists into arrays', () => {
    const result = parseEnv({
      ...validEnv,
      CORS_ORIGINS: 'http://localhost:5173, http://localhost:4173',
      SSRF_ALLOWLIST_HOSTS: 'receiver',
      SSRF_BLOCKED_PORTS: '22, 5432',
    });

    expect(result.success).toBe(true);
    expect(result.data.CORS_ORIGINS).toEqual(['http://localhost:5173', 'http://localhost:4173']);
    expect(result.data.SSRF_ALLOWLIST_HOSTS).toEqual(['receiver']);
    expect(result.data.SSRF_BLOCKED_PORTS).toEqual([22, 5432]);
  });

  it('rejects a MAX_ATTEMPTS the retry ladder has no queue for', () => {
    const result = parseEnv({ ...validEnv, MAX_ATTEMPTS: '7' });

    expect(result.success).toBe(false);
    expect(pathsOf(result)).toContain('MAX_ATTEMPTS');
  });

  it('accepts a MAX_ATTEMPTS below the ladder length, which needs no new queue', () => {
    const result = parseEnv({ ...validEnv, MAX_ATTEMPTS: '3' });

    expect(result.success).toBe(true);
    expect(result.data.MAX_ATTEMPTS).toBe(3);
  });

  it('rejects a connect timeout larger than the total delivery budget', () => {
    const result = parseEnv({
      ...validEnv,
      DELIVERY_CONNECT_TIMEOUT_MS: '20000',
      DELIVERY_TIMEOUT_MS: '10000',
    });

    expect(result.success).toBe(false);
    expect(pathsOf(result)).toContain('DELIVERY_CONNECT_TIMEOUT_MS');
  });

  it('rejects reusing one value for both secrets', () => {
    const secret = 'a'.repeat(64);
    const result = parseEnv({
      ...validEnv,
      JWT_SECRET: secret,
      SECRET_ENCRYPTION_KEY: secret,
    });

    expect(result.success).toBe(false);
    expect(pathsOf(result)).toContain('SECRET_ENCRYPTION_KEY');
  });

  it('rejects a SECRET_ENCRYPTION_KEY that is not 32 bytes of hex', () => {
    const result = parseEnv({ ...validEnv, SECRET_ENCRYPTION_KEY: 'not-hex' });

    expect(result.success).toBe(false);
    expect(pathsOf(result)).toContain('SECRET_ENCRYPTION_KEY');
  });

  it('allows the .env.example placeholders outside production', () => {
    expect(parseEnv({ ...validEnv, NODE_ENV: 'development' }).success).toBe(true);
  });

  it('refuses the .env.example placeholders in production', () => {
    const result = parseEnv({ ...validEnv, NODE_ENV: 'production' });

    expect(result.success).toBe(false);
    expect(pathsOf(result)).toEqual(
      expect.arrayContaining(['JWT_SECRET', 'SECRET_ENCRYPTION_KEY']),
    );
  });
});
