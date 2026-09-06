import { z } from 'zod';
import { createDocument } from 'zod-openapi';
import {
  apiKeySchema,
  bulkReplaySchema,
  deliveryFilterSchema,
  eventFilterSchema,
  endpointCreateSchema,
  endpointUpdateSchema,
  loginSchema,
  memberSchema,
  projectSchema,
  registerSchema,
} from '../schemas/dashboard.js';
import { publishSchema } from '../schemas/publish.js';
import {
  accessTokenResponse,
  apiKeyCreatedResponse,
  apiKeyListResponse,
  apiKeyResponse,
  bulkReplayResponse,
  deliveryDetailResponse,
  deliveryListResponse,
  eventListResponse,
  eventResponse,
  deliveryResponse,
  endpointCreatedResponse,
  endpointListResponse,
  endpointResponse,
  endpointRotatedResponse,
  healthResponse,
  meResponse,
  memberListResponse,
  memberResponse,
  problemResponse,
  projectListResponse,
  projectResponse,
  publishAcceptedResponse,
  readyResponse,
  sessionResponse,
  statsResponse,
} from '../schemas/responses.js';

const DOCUMENT_VERSION = '1.0.0';

const API_KEY_SCHEME = 'apiKey';

const USER_JWT_SCHEME = 'userJwt';

const PROBLEM_MEDIA_TYPE = 'application/problem+json';

const PROBLEM_REF = { $ref: '#/components/schemas/Problem' };

const FAILURES = Object.freeze({
  400: 'The request body or query string failed validation.',
  401: 'The credential is missing, unknown, revoked or expired.',
  403: 'The caller is a member of the project but lacks the required role.',
  404: 'No such resource, or one the caller may not see — the two answer alike.',
  409: 'The request conflicts with the current state of the resource.',
  413: 'The request body exceeds MAX_PAYLOAD_BYTES.',
  422: 'The request is well formed but cannot be carried out.',
  429: 'The rate limit for this API key, project or IP address was exceeded.',
});

function problems(...codes) {
  return Object.fromEntries(
    codes.map((code) => [
      code,
      { description: FAILURES[code], content: { [PROBLEM_MEDIA_TYPE]: { schema: PROBLEM_REF } } },
    ]),
  );
}

function json(description, schema) {
  return { description, content: { 'application/json': { schema } } };
}

function body(schema) {
  return { required: true, content: { 'application/json': { schema } } };
}

function pathParams(shape) {
  return { path: z.object(shape) };
}

const projectId = pathParams({ projectId: z.string() });

const endpointId = pathParams({ endpointId: z.string() });

const deliveryId = pathParams({ deliveryId: z.string() });

const eventId = pathParams({ eventId: z.string() });

const dashboard = { security: [{ [USER_JWT_SCHEME]: [] }], tags: ['Dashboard'] };

const NO_CONTENT = { description: 'Deleted. No body is returned.' };

// Everything below is assembled from the zod schemas the routes validate with,
// so a change to a request shape reaches the document without a second edit.
export function createOpenApiDocument() {
  return createDocument({
    openapi: '3.1.0',
    servers: [{ url: '/', description: 'This deployment' }],
    info: {
      title: 'hook-tracker',
      version: DOCUMENT_VERSION,
      description:
        'Webhook gateway and retry engine. Errors follow RFC 9457 and are served as application/problem+json. Every response carries X-Request-Id.',
    },
    tags: [
      { name: 'Ingestion', description: 'Publishing events, authenticated with an API key.' },
      { name: 'Auth', description: 'Dashboard sessions.' },
      { name: 'Dashboard', description: 'Projects, endpoints and delivery history.' },
      { name: 'Operational', description: 'Liveness, readiness and metrics.' },
    ],
    components: {
      schemas: { Problem: problemResponse },
      securitySchemes: {
        [API_KEY_SCHEME]: {
          type: 'http',
          scheme: 'bearer',
          description: 'Ingestion only. Authorization: Bearer ht_<key>.',
        },
        [USER_JWT_SCHEME]: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Dashboard access token. Authorization: Bearer <jwt>.',
        },
      },
    },
    paths: {
      '/v1/publish': {
        post: {
          operationId: 'publishEvent',
          summary: 'Publish an event and fan it out to the matching endpoints',
          tags: ['Ingestion'],
          security: [{ [API_KEY_SCHEME]: [] }],
          requestParams: {
            header: z.object({
              'Idempotency-Key': z.string().max(200).optional().meta({
                description: 'Replays the stored response for a repeat of the same call.',
              }),
            }),
          },
          requestBody: body(publishSchema),
          responses: {
            202: json('The event was stored and its deliveries queued.', publishAcceptedResponse),
            ...problems(400, 401, 409, 413, 422, 429),
          },
        },
      },
      '/v1/auth/register': {
        post: {
          operationId: 'register',
          summary: 'Create the first user and its project',
          tags: ['Auth'],
          requestBody: body(registerSchema),
          responses: {
            201: json('The account was created and a session opened.', sessionResponse),
            ...problems(400, 409, 429),
          },
        },
      },
      '/v1/auth/login': {
        post: {
          operationId: 'login',
          summary: 'Open a session',
          tags: ['Auth'],
          requestBody: body(loginSchema),
          responses: {
            200: json('A session was opened.', sessionResponse),
            ...problems(400, 401, 429),
          },
        },
      },
      '/v1/auth/refresh': {
        post: {
          operationId: 'refreshSession',
          summary: 'Rotate the refresh cookie and issue a new access token',
          description:
            'The presented token is revoked as the new one is issued, so a second call with the same cookie is a 401.',
          tags: ['Auth'],
          responses: {
            200: json('A new access token was issued.', accessTokenResponse),
            ...problems(401, 429),
          },
        },
      },
      '/v1/auth/logout': {
        post: {
          operationId: 'logout',
          summary: 'Revoke the refresh token',
          tags: ['Auth'],
          responses: { 204: { description: 'The session was closed.' } },
        },
      },
      '/v1/auth/me': {
        get: {
          operationId: 'currentUser',
          summary: 'The authenticated user with its memberships',
          tags: ['Auth'],
          security: [{ [USER_JWT_SCHEME]: [] }],
          responses: { 200: json('The current user.', meResponse), ...problems(401) },
        },
      },
      '/v1/projects': {
        get: {
          ...dashboard,
          operationId: 'listProjects',
          summary: 'Projects the caller belongs to',
          responses: {
            200: json('The caller memberships.', projectListResponse),
            ...problems(401),
          },
        },
        post: {
          ...dashboard,
          operationId: 'createProject',
          summary: 'Create a project, the caller becomes its owner',
          requestBody: body(projectSchema),
          responses: {
            201: json('The project was created.', projectResponse),
            ...problems(400, 401),
          },
        },
      },
      '/v1/projects/{projectId}': {
        patch: {
          ...dashboard,
          operationId: 'renameProject',
          summary: 'Rename a project',
          requestParams: projectId,
          requestBody: body(projectSchema),
          responses: {
            200: json('The project was renamed.', projectResponse),
            ...problems(400, 401, 403, 404),
          },
        },
      },
      '/v1/projects/{projectId}/members': {
        get: {
          ...dashboard,
          operationId: 'listMembers',
          summary: 'Project members',
          requestParams: projectId,
          responses: {
            200: json('The project members.', memberListResponse),
            ...problems(401, 404),
          },
        },
        post: {
          ...dashboard,
          operationId: 'addMember',
          summary: 'Add an existing account to the project',
          requestParams: projectId,
          requestBody: body(memberSchema),
          responses: {
            201: json('The member was added.', memberResponse),
            ...problems(400, 401, 403, 404, 409, 422),
          },
        },
      },
      '/v1/projects/{projectId}/members/{userId}': {
        delete: {
          ...dashboard,
          operationId: 'removeMember',
          summary: 'Remove a member',
          requestParams: pathParams({ projectId: z.string(), userId: z.string() }),
          responses: { 204: NO_CONTENT, ...problems(401, 403, 404, 409) },
        },
      },
      '/v1/projects/{projectId}/api-keys': {
        get: {
          ...dashboard,
          operationId: 'listApiKeys',
          summary: 'API keys of the project, prefix only',
          requestParams: projectId,
          responses: { 200: json('The API keys.', apiKeyListResponse), ...problems(401, 404) },
        },
        post: {
          ...dashboard,
          operationId: 'createApiKey',
          summary: 'Create an API key and return its plaintext once',
          requestParams: projectId,
          requestBody: body(apiKeySchema),
          responses: {
            201: json('The key was created.', apiKeyCreatedResponse),
            ...problems(400, 401, 403, 404),
          },
        },
      },
      '/v1/projects/{projectId}/api-keys/{keyId}': {
        delete: {
          ...dashboard,
          operationId: 'revokeApiKey',
          summary: 'Revoke an API key',
          requestParams: pathParams({ projectId: z.string(), keyId: z.string() }),
          responses: {
            200: json('The key was revoked.', apiKeyResponse),
            ...problems(401, 403, 404),
          },
        },
      },
      '/v1/projects/{projectId}/endpoints': {
        get: {
          ...dashboard,
          operationId: 'listEndpoints',
          summary: 'Endpoints of the project',
          requestParams: projectId,
          responses: { 200: json('The endpoints.', endpointListResponse), ...problems(401, 404) },
        },
        post: {
          ...dashboard,
          operationId: 'createEndpoint',
          summary: 'Create an endpoint and return its signing secret once',
          description: 'The URL passes the SSRF guard here; a blocked target is refused with 422.',
          requestParams: projectId,
          requestBody: body(endpointCreateSchema),
          responses: {
            201: json('The endpoint was created.', endpointCreatedResponse),
            ...problems(400, 401, 403, 404, 422),
          },
        },
      },
      '/v1/projects/{projectId}/events': {
        get: {
          ...dashboard,
          operationId: 'listEvents',
          summary: 'Events this project received, keyset paginated, searchable by payload value',
          requestParams: { ...projectId, query: eventFilterSchema },
          responses: {
            200: json('One page of events.', eventListResponse),
            ...problems(400, 401, 404),
          },
        },
      },
      '/v1/projects/{projectId}/deliveries': {
        get: {
          ...dashboard,
          operationId: 'listDeliveries',
          summary: 'Delivery history, keyset paginated',
          requestParams: { ...projectId, query: deliveryFilterSchema },
          responses: {
            200: json('One page of deliveries.', deliveryListResponse),
            ...problems(400, 401, 404),
          },
        },
      },
      '/v1/projects/{projectId}/deliveries/bulk-replay': {
        post: {
          ...dashboard,
          operationId: 'bulkReplayDeliveries',
          summary: 'Replay a filtered set of deliveries, capped at BULK_REPLAY_LIMIT',
          requestParams: projectId,
          requestBody: body(bulkReplaySchema),
          responses: {
            202: json('The replays were created and queued.', bulkReplayResponse),
            ...problems(400, 401, 404),
          },
        },
      },
      '/v1/projects/{projectId}/stats': {
        get: {
          ...dashboard,
          operationId: 'projectStats',
          summary: 'Counts by status and a delivery-latency summary',
          requestParams: projectId,
          responses: { 200: json('The project figures.', statsResponse), ...problems(401, 404) },
        },
      },
      '/v1/endpoints/{endpointId}': {
        patch: {
          ...dashboard,
          operationId: 'updateEndpoint',
          summary: 'Update an endpoint',
          requestParams: endpointId,
          requestBody: body(endpointUpdateSchema),
          responses: {
            200: json('The endpoint was updated.', endpointResponse),
            ...problems(400, 401, 404, 422),
          },
        },
        delete: {
          ...dashboard,
          operationId: 'deleteEndpoint',
          summary: 'Delete an endpoint that has no delivery history',
          requestParams: endpointId,
          responses: { 204: NO_CONTENT, ...problems(401, 403, 404, 409) },
        },
      },
      '/v1/endpoints/{endpointId}/rotate-secret': {
        post: {
          ...dashboard,
          operationId: 'rotateEndpointSecret',
          summary: 'Rotate the signing secret and open the grace window',
          requestParams: endpointId,
          responses: {
            200: json('The secret was rotated.', endpointRotatedResponse),
            ...problems(401, 403, 404),
          },
        },
      },
      '/v1/endpoints/{endpointId}/enable': {
        post: {
          ...dashboard,
          operationId: 'enableEndpoint',
          summary: 'Enable an endpoint and clear its failure counter',
          requestParams: endpointId,
          responses: {
            200: json('The endpoint is active.', endpointResponse),
            ...problems(401, 404),
          },
        },
      },
      '/v1/endpoints/{endpointId}/disable': {
        post: {
          ...dashboard,
          operationId: 'disableEndpoint',
          summary: 'Disable an endpoint',
          requestParams: endpointId,
          responses: {
            200: json('The endpoint is disabled.', endpointResponse),
            ...problems(401, 404),
          },
        },
      },
      '/v1/endpoints/{endpointId}/test': {
        post: {
          ...dashboard,
          operationId: 'testEndpoint',
          summary: 'Send a synthetic ping through the normal pipeline',
          requestParams: endpointId,
          responses: {
            202: json('The test event was queued.', publishAcceptedResponse),
            ...problems(401, 404, 422),
          },
        },
      },
      '/v1/events/{eventId}': {
        get: {
          ...dashboard,
          operationId: 'getEvent',
          summary: 'An event with its payload and the deliveries it produced',
          requestParams: eventId,
          responses: {
            200: json('The event.', eventResponse),
            ...problems(401, 404),
          },
        },
      },
      '/v1/deliveries/{deliveryId}': {
        get: {
          ...dashboard,
          operationId: 'getDelivery',
          summary: 'A delivery with its full attempt list',
          requestParams: deliveryId,
          responses: {
            200: json('The delivery.', deliveryDetailResponse),
            ...problems(401, 404),
          },
        },
      },
      '/v1/deliveries/{deliveryId}/replay': {
        post: {
          ...dashboard,
          operationId: 'replayDelivery',
          summary: 'Create a new delivery from an existing one',
          requestParams: deliveryId,
          responses: {
            202: json('The replay was created and queued.', deliveryResponse),
            ...problems(401, 404),
          },
        },
      },
      '/health': {
        get: {
          operationId: 'health',
          summary: 'Liveness, with no dependency checks',
          tags: ['Operational'],
          responses: { 200: json('The process is up.', healthResponse) },
        },
      },
      '/ready': {
        get: {
          operationId: 'ready',
          summary: 'Postgres, Redis and RabbitMQ reachability',
          tags: ['Operational'],
          responses: {
            200: json('Every dependency answered.', readyResponse),
            503: json('At least one dependency did not answer.', readyResponse),
          },
        },
      },
      '/metrics': {
        get: {
          operationId: 'metrics',
          summary: 'Prometheus exposition',
          description:
            'Rides the published API port; block at the reverse proxy in a deployment. Low-cardinality labels (architecture §14) keep it non-sensitive.',
          tags: ['Operational'],
          responses: {
            200: {
              description: 'The metric families described in architecture §14.',
              content: { 'text/plain': { schema: z.string() } },
            },
          },
        },
      },
      '/docs': {
        get: {
          operationId: 'docs',
          summary: 'Swagger UI over the generated OpenAPI document',
          tags: ['Operational'],
          responses: { 200: { description: 'The Swagger UI page.', content: { 'text/html': {} } } },
        },
      },
      '/openapi.json': {
        get: {
          operationId: 'openApiDocument',
          summary: 'This document, as JSON',
          tags: ['Operational'],
          responses: {
            200: json('The OpenAPI 3.1 document.', z.record(z.string(), z.unknown())),
          },
        },
      },
    },
  });
}
