import express from 'express';
import jwt from 'jsonwebtoken';
import { io as connectSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachRealtime } from '../../src/api/realtime/socket.js';
import { REFRESH_COOKIE } from '../../src/api/routes/auth.js';
import { createHealthRouter } from '../../src/api/routes/health.js';
import { createAuthService } from '../../src/api/services/auth-service.js';
import { assertTopology, createTopology } from '../../src/shared/queue/topology.js';
import { createRealtimePublisher } from '../../src/shared/realtime.js';
import { newId } from '../../src/shared/ids.js';
import { createEvent } from '../support/fixtures.js';
import { wait } from '../support/poll.js';
import {
  closeClients,
  openClients,
  readJson,
  silentLogger,
  startApi,
  testConfig,
} from '../support/stack.js';

// Mirrors AUTH_ATTEMPTS_PER_MINUTE in src/api/app.js, which is not exported.
const AUTH_ATTEMPTS_PER_MINUTE = 20;

const topology = createTopology({ namespace: 'itest-dashboard' });

const logger = silentLogger();

let clients;
let prisma;
let queue;
let realtime;
let server;
let baseUrl;
let alice;
let bob;
let endpoint;

const appConfig = testConfig({
  SSRF_ALLOWLIST_HOSTS: ['localhost'],
  REALTIME_MAX_EVENTS_PER_SECOND: 50,
});

async function call(method, path, { token, body, cookie } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  return {
    status: response.status,
    headers: response.headers,
    cookies: response.headers.getSetCookie(),
    body: await readJson(response),
  };
}

function refreshCookieOf(response) {
  const raw = response.cookies.find((value) => value.startsWith(`${REFRESH_COOKIE}=`));

  return raw ? raw.split(';')[0] : undefined;
}

async function register(email, projectName) {
  const response = await call('POST', '/v1/auth/register', {
    body: { email, password: 'a-long-enough-password', name: email.split('@')[0], projectName },
  });

  return {
    ...response.body,
    token: response.body.accessToken,
    cookie: refreshCookieOf(response),
    raw: response,
  };
}

async function openSocket(token) {
  const socket = connectSocket(`${baseUrl}/realtime`, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
  });

  const received = [];

  socket.onAny((event, payload) => received.push({ event, payload }));

  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });

  return { socket, received };
}

beforeAll(async () => {
  clients = await openClients();
  prisma = clients.prisma;
  queue = clients.queue;

  await assertTopology(queue.channel, topology);

  ({ server, baseUrl } = await startApi({
    clients,
    topology,
    config: appConfig,
    logger,
  }));

  realtime = attachRealtime({ server, prisma, redis: clients.redis, config: appConfig, logger });

  alice = await register('alice@hook-tracker.test', 'Alice Project');
  bob = await register('bob@hook-tracker.test', 'Bob Project');
});

afterAll(async () => {
  await realtime?.close();

  server?.close();

  await closeClients(clients);
});

describe('authentication', () => {
  it('registers a user with a project and makes them its owner', async () => {
    expect(alice.raw.status).toBe(201);
    expect(alice.accessToken).toBeTruthy();
    expect(alice.project.id).toMatch(/^prj_/);

    const cookie = alice.raw.cookies.find((value) => value.startsWith(`${REFRESH_COOKIE}=`));

    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/v1/auth');

    const me = await call('GET', '/v1/auth/me', { token: alice.token });

    expect(me.body.email).toBe('alice@hook-tracker.test');
    expect(me.body.memberships).toEqual([
      expect.objectContaining({
        role: 'OWNER',
        project: expect.objectContaining({ id: alice.project.id }),
      }),
    ]);
  });

  it('refuses a second account with the same email', async () => {
    const response = await call('POST', '/v1/auth/register', {
      body: {
        email: 'alice@hook-tracker.test',
        password: 'a-long-enough-password',
        name: 'Alice',
        projectName: 'Another',
      },
    });

    expect(response.status).toBe(409);
  });

  it('answers a wrong password and an unknown account identically', async () => {
    const wrongPassword = await call('POST', '/v1/auth/login', {
      body: { email: 'alice@hook-tracker.test', password: 'not-the-password' },
    });

    const unknownAccount = await call('POST', '/v1/auth/login', {
      body: { email: 'nobody@hook-tracker.test', password: 'not-the-password' },
    });

    expect(wrongPassword.status).toBe(401);
    expect(unknownAccount.status).toBe(401);
    expect(wrongPassword.body.detail).toBe(unknownAccount.body.detail);
  });

  it('rotates the refresh token and refuses the one that was just used', async () => {
    const login = await call('POST', '/v1/auth/login', {
      body: { email: 'bob@hook-tracker.test', password: 'a-long-enough-password' },
    });

    const first = refreshCookieOf(login);
    const refreshed = await call('POST', '/v1/auth/refresh', { cookie: first });

    expect(refreshed.status).toBe(200);
    expect(refreshed.body.accessToken).toBeTruthy();

    const replayed = await call('POST', '/v1/auth/refresh', { cookie: first });

    expect(replayed.status).toBe(401);

    const second = refreshCookieOf(refreshed);
    const loggedOut = await call('POST', '/v1/auth/logout', { cookie: second });

    expect(loggedOut.status).toBe(204);
    expect((await call('POST', '/v1/auth/refresh', { cookie: second })).status).toBe(401);
  });

  // Two requests carrying the same cookie must not both mint a session: a
  // single stolen cookie would otherwise become two independent logins.
  it('lets exactly one of two concurrent refreshes with the same token win', async () => {
    const login = await call('POST', '/v1/auth/login', {
      body: { email: 'bob@hook-tracker.test', password: 'a-long-enough-password' },
    });

    const cookie = refreshCookieOf(login);

    const [first, second] = await Promise.all([
      call('POST', '/v1/auth/refresh', { cookie }),
      call('POST', '/v1/auth/refresh', { cookie }),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 401]);
  });

  // Over HTTP the two requests usually serialise on their own, so the read of
  // the second lands after the write of the first and the race never forms.
  // Holding both reads open until both have happened is what actually puts the
  // conditional write under test.
  it('refuses the loser of a rotation race even when both reads see a live token', async () => {
    let arrived = 0;
    let openTheGate;

    const gate = new Promise((resolve) => {
      openTheGate = resolve;
    });

    async function waitForBoth() {
      arrived += 1;

      if (arrived === 2) {
        openTheGate();
      }

      await gate;
    }

    const bind = (target, property) => {
      const value = target[property];

      return typeof value === 'function' ? value.bind(target) : value;
    };

    const gatedPrisma = new Proxy(prisma, {
      get(target, property) {
        if (property !== 'refreshToken') {
          return bind(target, property);
        }

        return new Proxy(target.refreshToken, {
          get(delegate, method) {
            if (method !== 'findUnique') {
              return bind(delegate, method);
            }

            return async (args) => {
              const record = await delegate.findUnique(args);

              await waitForBoth();

              return record;
            };
          },
        });
      },
    });

    const service = createAuthService({ prisma: gatedPrisma, config: appConfig, logger });
    const opened = await service.login({
      email: 'bob@hook-tracker.test',
      password: 'a-long-enough-password',
    });

    const outcomes = await Promise.allSettled([
      service.refresh({ token: opened.refresh.token }),
      service.refresh({ token: opened.refresh.token }),
    ]);

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(outcomes.find((outcome) => outcome.status === 'rejected').reason.status).toBe(401);
  });

  it('revokes the whole family when a token that was already rotated comes back', async () => {
    const login = await call('POST', '/v1/auth/login', {
      body: { email: 'bob@hook-tracker.test', password: 'a-long-enough-password' },
    });

    const stolen = refreshCookieOf(login);
    const rotated = await call('POST', '/v1/auth/refresh', { cookie: stolen });

    expect(rotated.status).toBe(200);

    const issued = refreshCookieOf(rotated);
    const replayed = await call('POST', '/v1/auth/refresh', { cookie: stolen });

    expect(replayed.status).toBe(401);

    const afterFamilyRevoked = await call('POST', '/v1/auth/refresh', { cookie: issued });

    expect(afterFamilyRevoked.status).toBe(401);
  });

  it('rejects a request with no access token', async () => {
    expect((await call('GET', '/v1/auth/me')).status).toBe(401);
  });

  // Behind the dashboard's nginx every login arrives from one address, so a
  // counter keyed on the address alone would let one account's failures lock
  // everyone else out.
  it('spends the login attempt limit per account, not per address', async () => {
    const attempt = (email) =>
      call('POST', '/v1/auth/login', { body: { email, password: 'wrong-password-entirely' } });

    const spent = [];

    for (let i = 0; i < AUTH_ATTEMPTS_PER_MINUTE + 1; i += 1) {
      spent.push(await attempt('lockout-a@hook-tracker.test'));
    }

    expect(spent.slice(0, AUTH_ATTEMPTS_PER_MINUTE).map(({ status }) => status)).toEqual(
      Array(AUTH_ATTEMPTS_PER_MINUTE).fill(401),
    );
    expect(spent.at(-1).status).toBe(429);
    expect(spent.at(-1).body.detail).toBe(
      `${AUTH_ATTEMPTS_PER_MINUTE} requests per minute allowed for this address or account`,
    );

    const other = await attempt('lockout-b@hook-tracker.test');

    expect(other.status).toBe(401);
  });
});

describe('project settings', () => {
  it('stores an alert address and clears it again', async () => {
    const saved = await call('PATCH', `/v1/projects/${alice.project.id}`, {
      token: alice.token,
      body: { alertWebhookUrl: 'http://localhost:4000/ok' },
    });

    expect(saved.status).toBe(200);
    expect(saved.body.alertWebhookUrl).toBe('http://localhost:4000/ok');
    expect(saved.body.name).toBe(alice.project.name);

    const cleared = await call('PATCH', `/v1/projects/${alice.project.id}`, {
      token: alice.token,
      body: { alertWebhookUrl: null },
    });

    expect(cleared.body.alertWebhookUrl).toBeNull();
  });

  it('refuses an alert address the delivery pipeline would refuse', async () => {
    const response = await call('PATCH', `/v1/projects/${alice.project.id}`, {
      token: alice.token,
      body: { alertWebhookUrl: 'http://127.0.0.1:9/hook' },
    });

    expect(response.status).toBe(422);
    expect(response.body.detail).toContain('not an allowed alert target');
  });
});

describe('endpoints', () => {
  it('creates an endpoint and returns its signing secret exactly once', async () => {
    const response = await call('POST', `/v1/projects/${alice.project.id}/endpoints`, {
      token: alice.token,
      body: { url: 'http://localhost:4000/ok', description: 'demo receiver', eventTypes: [] },
    });

    expect(response.status).toBe(201);
    expect(response.body.secret).toMatch(/^whsec_/);

    endpoint = response.body;

    const list = await call('GET', `/v1/projects/${alice.project.id}/endpoints`, {
      token: alice.token,
    });

    expect(list.body.endpoints[0].id).toBe(endpoint.id);
    expect(list.body.endpoints[0].secret).toBeUndefined();
  });

  // An empty eventTypes list subscribes to every event, so this endpoint is
  // removed again: left behind, it would join the fan-out of every later test.
  it('leaves eventTypes alone when an update does not mention it', async () => {
    const created = await call('POST', `/v1/projects/${alice.project.id}/endpoints`, {
      token: alice.token,
      body: { url: 'http://localhost:4000/ok', eventTypes: ['refactor.probe'] },
    });

    const updated = await call('PATCH', `/v1/endpoints/${created.body.id}`, {
      token: alice.token,
      body: { description: 'renamed, subscriptions untouched' },
    });

    expect(updated.status).toBe(200);
    expect(updated.body.eventTypes).toEqual(['refactor.probe']);

    const cleared = await call('PATCH', `/v1/endpoints/${created.body.id}`, {
      token: alice.token,
      body: { eventTypes: [] },
    });

    expect(cleared.body.eventTypes).toEqual([]);

    const removed = await call('DELETE', `/v1/endpoints/${created.body.id}`, {
      token: alice.token,
    });

    expect(removed.status).toBe(204);
  });

  it('refuses a URL the SSRF guard would block, at configuration time', async () => {
    const response = await call('POST', `/v1/projects/${alice.project.id}/endpoints`, {
      token: alice.token,
      body: { url: 'http://10.0.0.5/hooks' },
    });

    expect(response.status).toBe(422);
    expect(response.body.detail).toContain('private');
  });

  it('rotates the secret and reports when the previous one stops being accepted', async () => {
    const response = await call('POST', `/v1/endpoints/${endpoint.id}/rotate-secret`, {
      token: alice.token,
    });

    expect(response.status).toBe(200);
    expect(response.body.secret).toMatch(/^whsec_/);
    expect(response.body.secret).not.toBe(endpoint.secret);
    expect(new Date(response.body.previousSecretExpiresAt).getTime()).toBeGreaterThan(Date.now());

    const stored = await prisma.endpoint.findUnique({ where: { id: endpoint.id } });

    expect(stored.previousSecret).not.toBeNull();
    expect(stored.secret).not.toContain(response.body.secret);
  });

  it('disables and enables an endpoint, clearing the failure counter', async () => {
    await prisma.endpoint.update({
      where: { id: endpoint.id },
      data: { consecutiveFailures: 7 },
    });

    const disabled = await call('POST', `/v1/endpoints/${endpoint.id}/disable`, {
      token: alice.token,
    });

    expect(disabled.body.status).toBe('DISABLED');

    const enabled = await call('POST', `/v1/endpoints/${endpoint.id}/enable`, {
      token: alice.token,
    });

    expect(enabled.body.status).toBe('ACTIVE');
    expect(enabled.body.consecutiveFailures).toBe(0);
  });

  it('hides an endpoint of another project behind the same 404 as a missing one', async () => {
    const response = await call('PATCH', `/v1/endpoints/${endpoint.id}`, {
      token: bob.token,
      body: { description: 'stolen' },
    });

    expect(response.status).toBe(404);
  });
});

describe('api keys and ingestion', () => {
  it('issues a key that the ingestion route accepts', async () => {
    const created = await call('POST', `/v1/projects/${alice.project.id}/api-keys`, {
      token: alice.token,
      body: { name: 'dashboard-issued' },
    });

    expect(created.status).toBe(201);
    expect(created.body.key).toMatch(/^ht_/);

    const published = await fetch(`${baseUrl}/v1/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${created.body.key}` },
      body: JSON.stringify({ eventType: 'order.created', payload: { orderId: 1 } }),
    });

    expect(published.status).toBe(202);

    const listed = await call('GET', `/v1/projects/${alice.project.id}/api-keys`, {
      token: alice.token,
    });

    expect(listed.body.apiKeys[0].keyPrefix).toBe(created.body.keyPrefix);
    expect(listed.body.apiKeys[0].key).toBeUndefined();

    const revoked = await call(
      'DELETE',
      `/v1/projects/${alice.project.id}/api-keys/${created.body.id}`,
      { token: alice.token },
    );

    expect(revoked.body.revokedAt).not.toBeNull();

    const afterRevoke = await fetch(`${baseUrl}/v1/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${created.body.key}` },
      body: JSON.stringify({ eventType: 'order.created', payload: { orderId: 2 } }),
    });

    expect(afterRevoke.status).toBe(401);
  });
});

describe('deliveries', () => {
  let deliveries;

  beforeAll(async () => {
    const event = await createEvent(prisma, {
      projectId: alice.project.id,
      eventType: 'order.paid',
      payload: { orderId: 99 },
    });

    deliveries = [];

    for (const status of ['SUCCEEDED', 'FAILED_PERMANENTLY', 'RETRYING']) {
      deliveries.push(
        await prisma.delivery.create({
          data: {
            id: newId('delivery'),
            eventId: event.id,
            endpointId: endpoint.id,
            status,
            attemptCount: 1,
          },
        }),
      );
    }

    await prisma.deliveryAttempt.createMany({
      data: [
        {
          id: newId('attempt'),
          deliveryId: deliveries[2].id,
          attemptNumber: 1,
          responseStatus: 500,
          durationMs: 90,
        },
        {
          id: newId('attempt'),
          deliveryId: deliveries[2].id,
          attemptNumber: 2,
          responseStatus: 503,
          durationMs: 142,
        },
      ],
    });
  });

  it('pages with a keyset cursor instead of an offset', async () => {
    const first = await call('GET', `/v1/projects/${alice.project.id}/deliveries?limit=2`, {
      token: alice.token,
    });

    expect(first.status).toBe(200);
    expect(first.body.deliveries).toHaveLength(2);
    expect(first.body.nextCursor).toBeTruthy();

    const second = await call(
      'GET',
      `/v1/projects/${alice.project.id}/deliveries?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`,
      { token: alice.token },
    );

    const firstIds = first.body.deliveries.map((delivery) => delivery.id);
    const secondIds = second.body.deliveries.map((delivery) => delivery.id);

    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
  });

  it('filters by status and event type', async () => {
    const byStatus = await call(
      'GET',
      `/v1/projects/${alice.project.id}/deliveries?status=FAILED_PERMANENTLY`,
      { token: alice.token },
    );

    expect(
      byStatus.body.deliveries.every((delivery) => delivery.status === 'FAILED_PERMANENTLY'),
    ).toBe(true);

    const byType = await call(
      'GET',
      `/v1/projects/${alice.project.id}/deliveries?eventType=order.paid`,
      { token: alice.token },
    );

    expect(byType.body.deliveries.every((delivery) => delivery.eventType === 'order.paid')).toBe(
      true,
    );
  });

  it('carries the newest attempt status and duration on every list row', async () => {
    const response = await call('GET', `/v1/projects/${alice.project.id}/deliveries`, {
      token: alice.token,
    });

    const rows = response.body.deliveries;
    const withAttempts = rows.find((delivery) => delivery.id === deliveries[2].id);
    const withoutAttempts = rows.find((delivery) => delivery.id === deliveries[0].id);

    expect(withAttempts.lastResponseStatus).toBe(503);
    expect(withAttempts.lastDurationMs).toBe(142);
    expect(withoutAttempts.lastResponseStatus).toBeNull();
    expect(withoutAttempts.lastDurationMs).toBeNull();
  });

  it('returns the delivery with its payload and attempt list', async () => {
    const response = await call('GET', `/v1/deliveries/${deliveries[0].id}`, {
      token: alice.token,
    });

    expect(response.status).toBe(200);
    expect(response.body.payload).toEqual({ orderId: 99 });
    expect(response.body.attempts).toEqual([]);
  });

  it('refuses to show a delivery of one project to a member of another', async () => {
    const byId = await call('GET', `/v1/deliveries/${deliveries[0].id}`, { token: bob.token });
    const byList = await call('GET', `/v1/projects/${alice.project.id}/deliveries`, {
      token: bob.token,
    });

    expect(byId.status).toBe(404);
    expect(byList.status).toBe(404);
  });

  it('replays a delivery into a new row that points back at the original', async () => {
    const response = await call('POST', `/v1/deliveries/${deliveries[1].id}/replay`, {
      token: alice.token,
    });

    expect(response.status).toBe(202);
    expect(response.body.replayedFromId).toBe(deliveries[1].id);
    expect(response.body.status).toBe('PENDING');
    expect(response.body.id).not.toBe(deliveries[1].id);

    const original = await prisma.delivery.findUnique({ where: { id: deliveries[1].id } });

    expect(original.status).toBe('FAILED_PERMANENTLY');
  });

  it('replays a filtered set in bulk, under the configured cap', async () => {
    const response = await call('POST', `/v1/projects/${alice.project.id}/deliveries/bulk-replay`, {
      token: alice.token,
      body: { status: 'FAILED_PERMANENTLY', limit: 10 },
    });

    expect(response.status).toBe(202);
    expect(response.body.replayed).toBeGreaterThan(0);
    expect(response.body.cappedAt).toBe(10);
  });

  it('reports per-project counts and latency', async () => {
    const response = await call('GET', `/v1/projects/${alice.project.id}/stats`, {
      token: alice.token,
    });

    expect(response.status).toBe(200);
    expect(response.body.total).toBeGreaterThan(0);
    expect(Object.keys(response.body.byStatus)).toContain('SUCCEEDED');
    expect(response.body.latency).toHaveProperty('averageMs');
  });
});

async function publish(apiKey, payload) {
  const response = await fetch(`${baseUrl}/v1/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ eventType: 'order.searched', payload }),
  });

  return response.status;
}

describe('events', () => {
  let searchable;

  beforeAll(async () => {
    const key = await call('POST', `/v1/projects/${alice.project.id}/api-keys`, {
      token: alice.token,
      body: { name: 'events-suite' },
    });

    const endpoint = await call('POST', `/v1/projects/${alice.project.id}/endpoints`, {
      token: alice.token,
      body: { url: 'http://localhost:4000/ok', eventTypes: ['order.searched'] },
    });

    searchable = { apiKey: key.body.key, endpointId: endpoint.body.id };

    await publish(searchable.apiKey, { orderId: 5150, customer: { id: 'cus_9' } });
    await publish(searchable.apiKey, { orderId: 6000, customer: { id: 'cus_1' } });
  });

  it('lists events with the deliveries each one produced', async () => {
    const response = await call(
      'GET',
      `/v1/projects/${alice.project.id}/events?eventType=order.searched`,
      { token: alice.token },
    );

    expect(response.status).toBe(200);
    expect(response.body.events).toHaveLength(2);

    // Other endpoints in this suite subscribe to every event type, so the
    // fan-out width is whatever the project holds; what the summary owes the
    // caller is that it adds up to the deliveries the event actually produced.
    const [newest] = response.body.events;
    const counted = Object.values(newest.byStatus).reduce((total, value) => total + value, 0);

    expect(newest.deliveryCount).toBeGreaterThanOrEqual(1);
    expect(counted).toBe(newest.deliveryCount);
  });

  it('finds an event by a value inside its payload, at a nested path too', async () => {
    const byNumber = await call(
      'GET',
      `/v1/projects/${alice.project.id}/events?payloadPath=orderId&payloadValue=5150`,
      { token: alice.token },
    );

    expect(byNumber.body.events).toHaveLength(1);

    const detail = await call('GET', `/v1/events/${byNumber.body.events[0].id}`, {
      token: alice.token,
    });

    expect(detail.body.payload).toEqual({ orderId: 5150, customer: { id: 'cus_9' } });
    expect(detail.body.deliveries.map((entry) => entry.endpointId)).toContain(
      searchable.endpointId,
    );

    const byNestedPath = await call(
      'GET',
      `/v1/projects/${alice.project.id}/events?payloadPath=customer.id&payloadValue=cus_1`,
      { token: alice.token },
    );

    expect(byNestedPath.body.events).toHaveLength(1);
    expect(byNestedPath.body.events[0].id).not.toBe(byNumber.body.events[0].id);
  });

  it('does not find an event of another project holding the same value', async () => {
    const response = await call(
      'GET',
      `/v1/projects/${bob.project.id}/events?payloadPath=orderId&payloadValue=5150`,
      { token: bob.token },
    );

    expect(response.status).toBe(200);
    expect(response.body.events).toEqual([]);
  });

  it('hides an event of another project behind the same 404 as a missing one', async () => {
    const mine = await call('GET', `/v1/projects/${alice.project.id}/events?limit=1`, {
      token: alice.token,
    });

    const response = await call('GET', `/v1/events/${mine.body.events[0].id}`, {
      token: bob.token,
    });

    expect(response.status).toBe(404);
  });

  it('serves the payload search from the index rather than a sequential scan', async () => {
    await clients.prisma.$executeRawUnsafe('SET enable_seqscan = off');

    const plan = await clients.prisma.$queryRawUnsafe(
      `EXPLAIN SELECT id FROM webhook_events WHERE payload @> '{"orderId":5150}'::jsonb`,
    );

    await clients.prisma.$executeRawUnsafe('SET enable_seqscan = on');

    expect(JSON.stringify(plan)).toContain('webhook_events_payload_idx');
  });
});

describe('realtime', () => {
  it('delivers a project event to that project only', async () => {
    const publisher = createRealtimePublisher({ redis: clients.redis });
    const aliceSocket = await openSocket(alice.token);
    const bobSocket = await openSocket(bob.token);

    try {
      await publisher.emit({
        projectId: alice.project.id,
        event: 'delivery.succeeded',
        payload: { deliveryId: 'dlv_realtime', attempt: 1 },
      });

      await wait(400);

      expect(aliceSocket.received).toEqual([
        { event: 'delivery.succeeded', payload: { deliveryId: 'dlv_realtime', attempt: 1 } },
      ]);
      expect(bobSocket.received).toEqual([]);
    } finally {
      aliceSocket.socket.disconnect();
      bobSocket.socket.disconnect();
    }
  });

  // The duplicate-broadcast trap only shows with more than one API instance:
  // every instance receives the worker's pub/sub message, so an emit through the
  // adapter would send one copy per instance.
  it('delivers exactly one copy while a second API instance is running', async () => {
    const { server: secondServer, baseUrl: secondUrl } = await startApi({
      clients,
      topology,
      config: appConfig,
      logger,
    });

    const secondRealtime = attachRealtime({
      server: secondServer,
      prisma,
      redis: clients.redis,
      config: appConfig,
      logger,
    });

    const socket = connectSocket(`${secondUrl}/realtime`, {
      auth: { token: alice.token },
      transports: ['websocket'],
      reconnection: false,
    });

    const received = [];

    socket.onAny((event, payload) => received.push({ event, payload }));

    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });

    try {
      await createRealtimePublisher({ redis: clients.redis }).emit({
        projectId: alice.project.id,
        event: 'delivery.succeeded',
        payload: { deliveryId: 'dlv_two_instances', attempt: 1 },
      });

      await wait(500);

      expect(received).toHaveLength(1);
    } finally {
      socket.disconnect();

      await secondRealtime.close();

      secondServer.close();
    }
  });

  it('refuses a handshake without a valid token', async () => {
    const socket = connectSocket(`${baseUrl}/realtime`, {
      auth: { token: 'not-a-token' },
      transports: ['websocket'],
      reconnection: false,
    });

    const error = await new Promise((resolve) => {
      socket.once('connect_error', resolve);
    });

    expect(error.message).toBe('unauthorized');

    socket.disconnect();
  });

  it('disconnects a socket when the access token it opened with expires', async () => {
    const shortLived = jwt.sign({ sub: alice.user.id }, appConfig.JWT_SECRET, { expiresIn: '2s' });
    const { socket } = await openSocket(shortLived);

    const reason = await new Promise((resolve) => {
      socket.once('token_expired', () => resolve('token_expired'));
      socket.once('disconnect', resolve);
    });

    expect(reason).toBe('token_expired');

    socket.disconnect();
  });
});

describe('endpoint authorization', () => {
  let member;
  let guarded;

  beforeAll(async () => {
    member = await register('carol@hook-tracker.test', 'Carol Project');

    const added = await call('POST', `/v1/projects/${alice.project.id}/members`, {
      token: alice.token,
      body: { email: 'carol@hook-tracker.test', role: 'MEMBER' },
    });

    expect(added.status).toBe(201);
    expect(added.body.role).toBe('MEMBER');

    const created = await call('POST', `/v1/projects/${alice.project.id}/endpoints`, {
      token: alice.token,
      body: { url: 'http://localhost:4000/ok', eventTypes: ['authz.probe'] },
    });

    expect(created.status).toBe(201);

    guarded = created.body;
  });

  it('refuses a member who tries to point an endpoint at another URL', async () => {
    const response = await call('PATCH', `/v1/endpoints/${guarded.id}`, {
      token: member.token,
      body: { url: 'http://localhost:4000/attacker' },
    });

    expect(response.status).toBe(403);

    const stored = await prisma.endpoint.findUnique({ where: { id: guarded.id } });

    expect(stored.url).toBe(guarded.url);
  });

  it('refuses a member who tries to disable or enable an endpoint', async () => {
    const disabled = await call('POST', `/v1/endpoints/${guarded.id}/disable`, {
      token: member.token,
    });

    expect(disabled.status).toBe(403);

    const enabled = await call('POST', `/v1/endpoints/${guarded.id}/enable`, {
      token: member.token,
    });

    expect(enabled.status).toBe(403);

    const stored = await prisma.endpoint.findUnique({ where: { id: guarded.id } });

    expect(stored.status).toBe('ACTIVE');
  });

  it('refuses a member who tries to rotate the secret or delete the endpoint', async () => {
    const rotated = await call('POST', `/v1/endpoints/${guarded.id}/rotate-secret`, {
      token: member.token,
    });

    expect(rotated.status).toBe(403);

    const removed = await call('DELETE', `/v1/endpoints/${guarded.id}`, {
      token: member.token,
    });

    expect(removed.status).toBe(403);
  });

  it('lets a member send a test event, the operational twin of replay', async () => {
    const response = await call('POST', `/v1/endpoints/${guarded.id}/test`, {
      token: member.token,
    });

    expect(response.status).toBe(202);
    expect(response.body.deliveries.map((delivery) => delivery.endpointId)).toEqual([guarded.id]);
  });

  it('lets the owner run every endpoint action the member was refused', async () => {
    const updated = await call('PATCH', `/v1/endpoints/${guarded.id}`, {
      token: alice.token,
      body: { description: 'owner may rename' },
    });

    expect(updated.status).toBe(200);
    expect(updated.body.description).toBe('owner may rename');

    const disabled = await call('POST', `/v1/endpoints/${guarded.id}/disable`, {
      token: alice.token,
    });

    expect(disabled.status).toBe(200);
    expect(disabled.body.status).toBe('DISABLED');

    const enabled = await call('POST', `/v1/endpoints/${guarded.id}/enable`, {
      token: alice.token,
    });

    expect(enabled.status).toBe(200);
    expect(enabled.body.status).toBe('ACTIVE');

    const tested = await call('POST', `/v1/endpoints/${guarded.id}/test`, {
      token: alice.token,
    });

    expect(tested.status).toBe(202);
  });

  // The distinction is deliberate: a non-member must not be able to tell an
  // endpoint they may not touch from one that does not exist.
  it('still answers 404, not 403, to a member of another project', async () => {
    const patched = await call('PATCH', `/v1/endpoints/${guarded.id}`, {
      token: bob.token,
      body: { description: 'stolen' },
    });

    expect(patched.status).toBe(404);

    const disabled = await call('POST', `/v1/endpoints/${guarded.id}/disable`, {
      token: bob.token,
    });

    expect(disabled.status).toBe(404);

    const tested = await call('POST', `/v1/endpoints/${guarded.id}/test`, {
      token: bob.token,
    });

    expect(tested.status).toBe(404);
  });
});

describe('GET /ready', () => {
  // The probe messages name the internal host and port of a failing dependency,
  // and the endpoint takes no credentials, so the body carries the verdict only.
  async function readyOf(router) {
    const app = express();

    app.use(router);

    const listener = app.listen(0);

    await new Promise((resolve) => listener.once('listening', resolve));

    try {
      const response = await fetch(`http://127.0.0.1:${listener.address().port}/ready`);

      return { status: response.status, body: await readJson(response) };
    } finally {
      listener.close();
    }
  }

  it('names each dependency and its verdict', async () => {
    const response = await call('GET', '/ready');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ready');

    for (const check of response.body.checks) {
      expect(Object.keys(check).sort()).toEqual(['name', 'ok']);
    }
  });

  it('keeps the reason a dependency is down out of the body', async () => {
    const refused = (address) => () => {
      throw new Error(`connect ECONNREFUSED ${address}`);
    };

    const response = await readyOf(
      createHealthRouter({
        prisma: { $queryRaw: refused('10.0.3.14:5432') },
        redis: { ping: refused('10.0.3.15:6379') },
        connection: { createChannel: refused('10.0.3.16:5672') },
        logger,
      }),
    );

    expect(response.status).toBe(503);
    expect(response.body.status).toBe('degraded');
    expect(response.body.checks.map((check) => check.ok)).toEqual([false, false, false]);

    for (const check of response.body.checks) {
      expect(Object.keys(check).sort()).toEqual(['name', 'ok']);
    }

    expect(JSON.stringify(response.body)).not.toContain('ECONNREFUSED');
  });
});
