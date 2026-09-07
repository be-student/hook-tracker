import { z } from 'zod';
import { MAX_SUPPORTED_ATTEMPTS } from './retry.js';

export const PLACEHOLDER_JWT_SECRET = 'change-me-this-is-a-placeholder-secret';
export const PLACEHOLDER_ENCRYPTION_KEY = '0'.repeat(64);

const booleanFromEnv = z.enum(['true', 'false']).transform((value) => value === 'true');

const csv = z.string().transform((value) =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean),
);

const portList = csv.pipe(z.array(z.coerce.number().int().min(1).max(65535)));

const durationString = z.string().regex(/^\d+[smhd]$/, 'must be a duration such as 30m, 1h or 7d');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1).startsWith('postgres'),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).default(10),
  REDIS_URL: z.string().min(1).startsWith('redis'),
  RABBITMQ_URL: z.string().min(1).startsWith('amqp'),

  JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
  JWT_ACCESS_TTL: durationString.default('1h'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(7),
  SECRET_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters (32 bytes)'),
  CORS_ORIGINS: csv.prefault(''),

  DELIVERY_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).default(3000),
  DELIVERY_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),
  MAX_ATTEMPTS: z.coerce.number().int().min(1).default(MAX_SUPPORTED_ATTEMPTS),
  WORKER_PREFETCH: z.coerce.number().int().min(1).max(1000).default(10),

  MAX_PAYLOAD_BYTES: z.coerce.number().int().min(1).default(262_144),
  RESPONSE_SNIPPET_BYTES: z.coerce.number().int().min(1).default(8192),

  RATE_LIMIT_PUBLISH_PER_MINUTE: z.coerce.number().int().min(1).default(600),
  RATE_LIMIT_PUBLISH_PROJECT_PER_MINUTE: z.coerce.number().int().min(1).default(6000),
  IDEMPOTENCY_TTL_SECONDS: z.coerce.number().int().min(1).default(86_400),
  BULK_REPLAY_LIMIT: z.coerce.number().int().min(1).default(500),

  SSRF_ALLOW_PRIVATE: booleanFromEnv.prefault('false'),
  SSRF_ALLOWLIST_HOSTS: csv.prefault(''),
  SSRF_BLOCKED_PORTS: portList.prefault('22,23,25,3306,5432,6379,9200,11211,27017'),

  ENDPOINT_AUTO_DISABLE_THRESHOLD: z.coerce.number().int().min(1).default(20),
  SECRET_ROTATION_GRACE_HOURS: z.coerce.number().int().min(1).default(24),

  DLQ_MESSAGE_TTL_HOURS: z.coerce.number().int().min(1).default(24),
  ALERT_TIMEOUT_MS: z.coerce.number().int().min(100).default(5_000),
  ALERT_SUPPRESSION_MINUTES: z.coerce.number().int().min(1).default(60),
  ALERT_DLQ_THRESHOLD: z.coerce.number().int().min(1).default(100),
  RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  STUCK_DELIVERY_MINUTES: z.coerce.number().int().min(1).default(15),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).default(15_000),

  REALTIME_MAX_EVENTS_PER_SECOND: z.coerce.number().int().min(1).default(20),

  DEMO_ENDPOINT_SECRET: z.string().min(1).optional(),
});

const envSchemaWithCrossFieldRules = envSchema.superRefine((env, ctx) => {
  if (env.RATE_LIMIT_PUBLISH_PROJECT_PER_MINUTE < env.RATE_LIMIT_PUBLISH_PER_MINUTE) {
    ctx.addIssue({
      code: 'custom',
      path: ['RATE_LIMIT_PUBLISH_PROJECT_PER_MINUTE'],
      message: 'must be greater than or equal to RATE_LIMIT_PUBLISH_PER_MINUTE',
    });
  }

  if (env.MAX_ATTEMPTS > MAX_SUPPORTED_ATTEMPTS) {
    ctx.addIssue({
      code: 'custom',
      path: ['MAX_ATTEMPTS'],
      message: `may not exceed ${MAX_SUPPORTED_ATTEMPTS} (retry levels + 1); raising it requires a new retry queue, see docs/architecture.md §4`,
    });
  }

  if (env.DELIVERY_CONNECT_TIMEOUT_MS > env.DELIVERY_TIMEOUT_MS) {
    ctx.addIssue({
      code: 'custom',
      path: ['DELIVERY_CONNECT_TIMEOUT_MS'],
      message: 'may not exceed DELIVERY_TIMEOUT_MS, which is the total budget',
    });
  }

  if (env.JWT_SECRET === env.SECRET_ENCRYPTION_KEY) {
    ctx.addIssue({
      code: 'custom',
      path: ['SECRET_ENCRYPTION_KEY'],
      message: 'must differ from JWT_SECRET',
    });
  }

  if (env.NODE_ENV !== 'production') return;

  if (env.JWT_SECRET === PLACEHOLDER_JWT_SECRET) {
    ctx.addIssue({
      code: 'custom',
      path: ['JWT_SECRET'],
      message: 'is still the .env.example placeholder; generate one with `openssl rand -hex 32`',
    });
  }

  if (env.SECRET_ENCRYPTION_KEY === PLACEHOLDER_ENCRYPTION_KEY) {
    ctx.addIssue({
      code: 'custom',
      path: ['SECRET_ENCRYPTION_KEY'],
      message: 'is still the .env.example placeholder; generate one with `openssl rand -hex 32`',
    });
  }
});

export function parseEnv(source) {
  return envSchemaWithCrossFieldRules.safeParse(source);
}

export function formatEnvIssues(error) {
  return error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
}
