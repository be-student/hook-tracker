import { authRateLimitKey } from './auth-rate-limit.js';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { REDACTION_PATHS } from '../shared/logger.js';
import { createApiKeyAuth } from './middleware/api-key-auth.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { createIdempotency } from './middleware/idempotency.js';
import { createJwtAuth } from './middleware/jwt-auth.js';
import { createRateLimiter } from './middleware/rate-limit.js';
import { requestId } from './middleware/request-id.js';
import { createPublishCounter, publishRequestMetrics } from './metrics/publish-counter.js';
import { createAuthRouter } from './routes/auth.js';
import { createDeliveryRouter } from './routes/deliveries.js';
import { createEventRouter } from './routes/events.js';
import { createDocsRouter } from './routes/docs.js';
import { createEndpointRouter } from './routes/endpoints.js';
import { createHealthRouter } from './routes/health.js';
import { createMetricsRouter } from './routes/metrics.js';
import { createProjectRouter } from './routes/projects.js';
import { createPublishRouter } from './routes/publish.js';
import { createApiKeyService } from './services/api-key-service.js';
import { createAuthService } from './services/auth-service.js';
import { createDeliveryService } from './services/delivery-service.js';
import { createEventService } from './services/event-service.js';
import { createEndpointService } from './services/endpoint-service.js';
import { createProjectService } from './services/project-service.js';
import { createPublishService } from './services/publish-service.js';

const HSTS_MAX_AGE_SECONDS = 15_552_000;

const PUBLISH_PATH = '/v1/publish';

// Stricter than ingestion and counted per IP rather than per key: these routes
// are where credential stuffing would be attempted, and the attacker has no key.
const AUTH_ATTEMPTS_PER_MINUTE = 20;

export function createApp({ prisma, redis, publisher, connection, topology, config, logger }) {
  const app = express();
  const publishCounter = createPublishCounter();

  app.disable('x-powered-by');

  // Off by default: a hop is trusted only where every path to the API goes
  // through it, because a trusted hop means a client can state its own address
  // in X-Forwarded-For and the rate limiter believes it.
  if (config.TRUST_PROXY > 0) {
    app.set('trust proxy', config.TRUST_PROXY);
  }

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      redact: { paths: REDACTION_PATHS, censor: '[redacted]' },
    }),
  );

  // HSTS only in production: the compose stack serves plain HTTP on localhost,
  // and a browser that has cached the header would refuse to reach it.
  app.use(
    helmet({
      hsts: config.NODE_ENV === 'production' ? { maxAge: HSTS_MAX_AGE_SECONDS } : false,
    }),
  );

  // An empty CORS_ORIGINS means no browser origin is allowed, which is what a
  // deployment that never configured it should get.
  if (config.CORS_ORIGINS.length > 0) {
    app.use(cors({ origin: config.CORS_ORIGINS, credentials: true }));
  }

  app.use(createHealthRouter({ prisma, redis, connection, logger }));
  app.use(createDocsRouter());
  app.use(createMetricsRouter({ prisma, connection, topology, publishCounter, config, logger }));

  const publishService = createPublishService({ prisma, publisher, logger });
  const authService = createAuthService({ prisma, config, logger });
  const projectService = createProjectService({ prisma, config });
  const apiKeyService = createApiKeyService({ prisma });
  const endpointService = createEndpointService({ prisma, config, publishService });
  const deliveryService = createDeliveryService({ prisma, publisher, config, logger });
  const eventService = createEventService({ prisma });

  const jwtAuth = createJwtAuth({ prisma, config });

  app.post(PUBLISH_PATH, publishRequestMetrics(publishCounter));

  app.use(
    '/v1',
    express.json({ limit: config.MAX_PAYLOAD_BYTES }),
    cookieParser(),
    createPublishRouter({
      publishService,
      apiKeyAuth: createApiKeyAuth({ prisma }),
      rateLimit: createRateLimiter({
        redis,
        limit: config.RATE_LIMIT_PUBLISH_PER_MINUTE,
        identify: (req) => [req.auth.apiKeyId, `project:${req.auth.projectId}`],
      }),
      idempotency: createIdempotency({ redis, ttlSeconds: config.IDEMPOTENCY_TTL_SECONDS }),
    }),
    createAuthRouter({
      authService,
      config,
      jwtAuth,
      authRateLimit: createRateLimiter({
        redis,
        limit: AUTH_ATTEMPTS_PER_MINUTE,
        keyPrefix: 'ratelimit:auth',
        identify: authRateLimitKey,
      }),
    }),
    createProjectRouter({
      projectService,
      apiKeyService,
      endpointService,
      deliveryService,
      eventService,
      jwtAuth,
    }),
    createEndpointRouter({ endpointService, jwtAuth }),
    createDeliveryRouter({ deliveryService, jwtAuth }),
    createEventRouter({ eventService, jwtAuth }),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
