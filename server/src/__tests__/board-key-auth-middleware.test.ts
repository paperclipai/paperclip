import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  authUsers,
  boardApiKeyAuthorizationEvents,
  boardApiKeys,
  companyMemberships,
  instanceUserRoles,
} from "@paperclipai/db";
import { BOARD_API_KEY_SCOPE_PRESETS } from "@paperclipai/shared";
import {
  actorMiddleware,
  resetBoardKeyAuthFailureRateLimitForTests,
  snapshotBoardKeyAuthFailureRateLimitForTests,
} from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import {
  BOARD_KEY_AUTH_FAILURE_RATE_LIMIT_DEFAULTS,
  createBoardKeyAuthFailureRateLimiter,
  type BoardKeyAuthFailureRateLimitConfig,
} from "../security/board-key-auth-failure-rate-limit.js";

const TOKEN = "pcp_board_middleware_valid_token";

function createDbState() {
  const companyId = randomUUID();
  const ownerId = randomUUID();
  const keyId = randomUUID();
  const state = {
    keyExists: true,
    ownerExists: true,
    membershipActive: true,
    malformedScope: false,
    revoked: false,
    revokeOnTouch: false,
    lastUsedAt: null as Date | null,
    boardKeyLookupBarrier: null as Promise<void> | null,
    boardKeyLookupError: null as Error | null,
    boardKeyLookupStarts: 0,
    auditError: null as Error | null,
  };
  const audits: Array<Record<string, unknown>> = [];
  const key = () => ({
    id: keyId,
    userId: ownerId,
    name: "middleware",
    keyHash: createHash("sha256").update(TOKEN).digest("hex"),
    tokenPrefix: "pcp_board_middle",
    scopeConfig: state.malformedScope
      ? { version: 1, kind: "scoped", companyIds: [companyId], permissions: ["not:a:permission"], instanceCapabilities: [] }
      : {
          version: 1,
          kind: "scoped",
          companyIds: [companyId],
          permissions: [...BOARD_API_KEY_SCOPE_PRESETS.read_only.permissions],
          instanceCapabilities: [],
        },
    legacyUnrestricted: false,
    createdAt: new Date(),
    lastUsedAt: state.lastUsedAt,
    expiresAt: null,
    revokedAt: state.revoked ? new Date() : null,
  });

  const db = {
    select: vi.fn(() => ({
      from(table: unknown) {
        const rows = table === boardApiKeys
          ? (state.keyExists ? [key()] : [])
          : table === authUsers
            ? (state.ownerExists ? [{ id: ownerId, name: "Owner", email: "owner@example.com" }] : [])
            : table === companyMemberships
              ? (state.membershipActive ? [{ companyId, membershipRole: "owner", status: "active" }] : [])
              : table === instanceUserRoles
                ? []
                : [];
        return {
          where: async () => {
            if (table === boardApiKeys) {
              state.boardKeyLookupStarts += 1;
              await state.boardKeyLookupBarrier;
              if (state.boardKeyLookupError) throw state.boardKeyLookupError;
            }
            return rows;
          },
          then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
        };
      },
    })),
    update: vi.fn(() => ({
      set(values: { lastUsedAt?: Date }) {
        return {
          where: () => ({
            returning: async () => {
              if (state.revoked || state.revokeOnTouch) {
                state.revoked = state.revoked || state.revokeOnTouch;
                return [];
              }
              state.lastUsedAt = values.lastUsedAt ?? state.lastUsedAt;
              return [{ id: keyId }];
            },
          }),
        };
      },
    })),
    insert: vi.fn((table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        if (table === boardApiKeyAuthorizationEvents) {
          if (state.auditError) throw state.auditError;
          audits.push(values);
        }
        return [];
      },
    })),
  } as any;

  return { db, state, audits, companyId, keyId, ownerId };
}

function createApp(
  db: any,
  resolveSession = vi.fn(async () => null),
  options: { sourceFromHeader?: boolean } = {},
) {
  const app = express();
  if (options.sourceFromHeader) {
    app.use((req, _res, next) => {
      Object.defineProperty(req.socket, "remoteAddress", {
        configurable: true,
        value: req.header("x-test-source") ?? req.socket.remoteAddress,
      });
      next();
    });
  }
  app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession }));
  app.get("/actor", (req, res) => res.json(req.actor));
  app.use(errorHandler);
  return { app, resolveSession };
}

describe("board-key authentication middleware", () => {
  beforeEach(() => resetBoardKeyAuthFailureRateLimitForTests());

  it("builds the board-key principal from a fresh key and live owner authority read", async () => {
    const { db, companyId, keyId, ownerId } = createDbState();
    const { app } = createApp(db);
    const response = await request(app).get("/actor").set("Authorization", `Bearer ${TOKEN}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      type: "board",
      source: "board_key",
      keyId,
      boardKeyOwnerId: ownerId,
      boardKeyPrefix: "pcp_board_middle",
      companyIds: [companyId],
    });
    expect(response.body).not.toHaveProperty("token");
  });

  it("never falls back to cookies for an invalid Bearer and returns a generic 401 for malformed stored scope", async () => {
    const invalid = createDbState();
    invalid.state.keyExists = false;
    const invalidApp = createApp(invalid.db, vi.fn(async () => ({
      session: { id: "session" },
      user: { id: randomUUID() },
    } as any)));
    const invalidResponse = await request(invalidApp.app)
      .get("/actor")
      .set("Authorization", "Bearer pcp_board_unknown");
    expect(invalidResponse.status).toBe(401);
    expect(invalidResponse.body).toEqual({ error: "Unauthorized" });
    expect(invalidApp.resolveSession).not.toHaveBeenCalled();

    const malformed = createDbState();
    malformed.state.malformedScope = true;
    const malformedResponse = await request(createApp(malformed.db).app)
      .get("/actor")
      .set("Authorization", `Bearer ${TOKEN}`);
    expect(malformedResponse.status).toBe(401);
    expect(malformedResponse.body).toEqual({ error: "Unauthorized" });
    expect(JSON.stringify(malformed.audits)).not.toContain(TOKEN);
    expect(JSON.stringify(malformed.audits)).not.toContain("authorization");
  });

  it("rate-limits repeated failures without logging secret material", async () => {
    const { db, state, audits } = createDbState();
    state.keyExists = false;
    const { app } = createApp(db);
    const statuses: number[] = [];
    for (let index = 0; index < 11; index += 1) {
      const response = await request(app)
        .get("/actor")
        .set("Authorization", `Bearer ${TOKEN}bad`);
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(statuses[10]).toBe(429);
    expect(JSON.stringify(audits)).not.toContain(`${TOKEN}bad`);
  });

  it("rate-limits rotating invalid credentials from one source before another database lookup", async () => {
    const { db, state } = createDbState();
    state.keyExists = false;
    const { app } = createApp(db);
    const sourceLimit = BOARD_KEY_AUTH_FAILURE_RATE_LIMIT_DEFAULTS.sourceLimit;

    for (let index = 0; index < sourceLimit; index += 1) {
      const response = await request(app)
        .get("/actor")
        .set("Authorization", `Bearer pcp_board_rotating_${index}`);
      expect(response.status).toBe(401);
    }
    const lookupsBeforeThrottle = db.select.mock.calls.length;
    const limited = await request(app)
      .get("/actor")
      .set("Authorization", "Bearer pcp_board_rotating_blocked");

    expect(limited.status).toBe(429);
    expect(db.select.mock.calls.length).toBe(lookupsBeforeThrottle);
  });

  it("strictly bounds credential and source failure storage during identity floods", () => {
    const limiter = createBoardKeyAuthFailureRateLimiter({
      windowMs: 60_000,
      credentialLimit: 10_000,
      sourceLimit: 10_000,
      globalLimit: 10_000,
      credentialMaxEntries: 7,
      sourceMaxEntries: 5,
      sourceInFlightLimit: 2,
      globalInFlightLimit: 3,
    });

    for (let index = 0; index < 100; index += 1) {
      limiter.recordFailure({
        credentialId: `credential-${index}`,
        sourceId: `source-${index}`,
        now: 1,
      });
    }

    expect(limiter.snapshot()).toEqual({
      credentialEntries: 7,
      sourceEntries: 5,
      globalEntries: 1,
      sourceInFlightEntries: 0,
      globalInFlight: 0,
    });
  });

  it("opens the global circuit breaker across rotating sources and credentials", () => {
    const limiter = createBoardKeyAuthFailureRateLimiter({
      windowMs: 60_000,
      credentialLimit: 100,
      sourceLimit: 100,
      globalLimit: 3,
      credentialMaxEntries: 10,
      sourceMaxEntries: 10,
      sourceInFlightLimit: 10,
      globalInFlightLimit: 10,
    });

    for (let index = 0; index < 3; index += 1) {
      limiter.recordFailure({ credentialId: `credential-${index}`, sourceId: `source-${index}`, now: 1 });
    }

    expect(limiter.isLimited({ credentialId: "novel-credential", sourceId: "novel-source", now: 1 })).toBe(true);
  });

  it("bounds direct admission by source, global capacity, and source-map storage", () => {
    const createLimiter = (overrides: Partial<BoardKeyAuthFailureRateLimitConfig>) =>
      createBoardKeyAuthFailureRateLimiter({
        ...BOARD_KEY_AUTH_FAILURE_RATE_LIMIT_DEFAULTS,
        credentialLimit: 100,
        sourceLimit: 100,
        globalLimit: 100,
        ...overrides,
      });

    const perSource = createLimiter({ sourceMaxEntries: 3, sourceInFlightLimit: 2, globalInFlightLimit: 4 });
    const sourceAFirst = perSource.tryAcquire({ sourceId: "source-a" });
    const sourceASecond = perSource.tryAcquire({ sourceId: "source-a" });
    expect(sourceAFirst).not.toBeNull();
    expect(sourceASecond).not.toBeNull();
    expect(perSource.tryAcquire({ sourceId: "source-a" })).toBeNull();
    sourceAFirst?.release();
    sourceAFirst?.release();
    const reused = perSource.tryAcquire({ sourceId: "source-a" });
    expect(reused).not.toBeNull();
    sourceASecond?.release();
    reused?.release();
    expect(perSource.snapshot()).toMatchObject({ sourceInFlightEntries: 0, globalInFlight: 0 });

    const global = createLimiter({ sourceMaxEntries: 4, sourceInFlightLimit: 2, globalInFlightLimit: 3 });
    const globalAdmissions = ["source-a", "source-b", "source-c"]
      .map((sourceId) => global.tryAcquire({ sourceId }));
    expect(globalAdmissions.every(Boolean)).toBe(true);
    expect(global.tryAcquire({ sourceId: "source-d" })).toBeNull();
    expect(global.snapshot()).toMatchObject({ sourceInFlightEntries: 3, globalInFlight: 3 });
    globalAdmissions.forEach((admission) => admission?.release());
    expect(global.snapshot()).toMatchObject({ sourceInFlightEntries: 0, globalInFlight: 0 });

    const bounded = createLimiter({ sourceMaxEntries: 2, sourceInFlightLimit: 2, globalInFlightLimit: 10 });
    const boundedA = bounded.tryAcquire({ sourceId: "source-a" });
    const boundedB = bounded.tryAcquire({ sourceId: "source-b" });
    expect(bounded.tryAcquire({ sourceId: "source-c" })).toBeNull();
    expect(bounded.snapshot()).toMatchObject({ sourceInFlightEntries: 2, globalInFlight: 2 });
    boundedA?.release();
    boundedB?.release();
    const boundedReused = bounded.tryAcquire({ sourceId: "source-c" });
    expect(boundedReused).not.toBeNull();
    boundedReused?.release();
  });

  it("bounds concurrent database authentication starts with pre-lookup admission", async () => {
    const { db, state } = createDbState();
    state.keyExists = false;
    let releaseLookups!: () => void;
    state.boardKeyLookupBarrier = new Promise<void>((resolve) => {
      releaseLookups = resolve;
    });
    const { app } = createApp(db);
    const inFlightLimit = BOARD_KEY_AUTH_FAILURE_RATE_LIMIT_DEFAULTS.sourceInFlightLimit;

    const requests = Array.from({ length: inFlightLimit + 6 }, (_, index) =>
      request(app)
        .get("/actor")
        .set("Authorization", `Bearer pcp_board_concurrent_${index}`)
        .then((response) => response),
    );

    await vi.waitFor(() => expect(state.boardKeyLookupStarts).toBe(inFlightLimit));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(state.boardKeyLookupStarts).toBe(inFlightLimit);
    releaseLookups();

    const responses = await Promise.all(requests);
    expect(responses.filter((response) => response.status === 401)).toHaveLength(inFlightLimit);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(6);
    expect(state.boardKeyLookupStarts).toBe(inFlightLimit);
  });

  it("bounds concurrent database authentication starts across distinct sources by the global cap", async () => {
    const { db, state } = createDbState();
    state.keyExists = false;
    let releaseLookups!: () => void;
    state.boardKeyLookupBarrier = new Promise<void>((resolve) => {
      releaseLookups = resolve;
    });
    const { app } = createApp(db, undefined, { sourceFromHeader: true });
    const globalLimit = BOARD_KEY_AUTH_FAILURE_RATE_LIMIT_DEFAULTS.globalInFlightLimit;

    const requests = Array.from({ length: globalLimit + 3 }, (_, index) =>
      request(app)
        .get("/actor")
        .set("Authorization", `Bearer pcp_board_global_${index}`)
        .set("x-test-source", `source-${index}`)
        .then((response) => response),
    );

    await vi.waitFor(() => expect(state.boardKeyLookupStarts).toBe(globalLimit));
    expect(snapshotBoardKeyAuthFailureRateLimitForTests()).toMatchObject({
      sourceInFlightEntries: globalLimit,
      globalInFlight: globalLimit,
    });
    releaseLookups();

    const responses = await Promise.all(requests);
    expect(responses.filter((response) => response.status === 401)).toHaveLength(globalLimit);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(3);
    expect(responses.filter((response) => response.status === 429).map((response) => response.body))
      .toEqual(Array(3).fill({ error: "Too many authentication failures" }));
    expect(snapshotBoardKeyAuthFailureRateLimitForTests()).toMatchObject({
      sourceInFlightEntries: 0,
      globalInFlight: 0,
    });
  });

  it.each([
    "success",
    "invalid authentication",
    "audited denial",
    "authentication throw",
    "audit throw",
  ] as const)("releases and reuses admission capacity after %s", async (outcome) => {
    const { db, state } = createDbState();
    if (outcome === "invalid authentication") state.keyExists = false;
    if (outcome === "authentication throw") state.boardKeyLookupError = new Error("lookup failed");
    if (outcome === "audited denial" || outcome === "audit throw") {
      state.malformedScope = true;
    }
    if (outcome === "audit throw") {
      state.auditError = new Error("audit failed");
    }
    const { app } = createApp(db);

    const first = await request(app).get("/actor").set("Authorization", `Bearer ${TOKEN}`);
    if (outcome === "success") expect(first.status).toBe(200);
    else if (outcome === "authentication throw") expect(first.status).toBe(500);
    else expect(first.status).toBe(401);
    expect(snapshotBoardKeyAuthFailureRateLimitForTests()).toMatchObject({
      sourceInFlightEntries: 0,
      globalInFlight: 0,
    });

    state.keyExists = true;
    state.boardKeyLookupError = null;
    state.malformedScope = false;
    state.auditError = null;
    const second = await request(app).get("/actor").set("Authorization", `Bearer ${TOKEN}`);
    expect(second.status).toBe(200);
    expect(snapshotBoardKeyAuthFailureRateLimitForTests()).toMatchObject({
      sourceInFlightEntries: 0,
      globalInFlight: 0,
    });
  });

  it("does not resurrect last-used state when revocation wins the authentication race", async () => {
    const { db, state } = createDbState();
    state.revokeOnTouch = true;
    const response = await request(createApp(db).app)
      .get("/actor")
      .set("Authorization", `Bearer ${TOKEN}`);

    expect(response.status).toBe(401);
    expect(state.revoked).toBe(true);
    expect(state.lastUsedAt).toBeNull();
  });

  it("reflects membership removal on the next request without a positive auth cache", async () => {
    const { db, state, companyId } = createDbState();
    const { app } = createApp(db);
    const first = await request(app).get("/actor").set("Authorization", `Bearer ${TOKEN}`);
    expect(first.body.companyIds).toEqual([companyId]);

    state.membershipActive = false;
    const second = await request(app).get("/actor").set("Authorization", `Bearer ${TOKEN}`);
    expect(second.status).toBe(200);
    expect(second.body.companyIds).toEqual([]);
  });
});
