import { generateKeyPairSync, sign } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLOUD_CONTROL_AUDIENCE,
  CLOUD_CONTROL_HEADER,
  CLOUD_CONTROL_JWS_TYPE,
  CLOUD_RUNTIME_IDENTITY_AUDIENCE,
  CLOUD_RUNTIME_IDENTITY_ISSUER,
  CLOUD_RUNTIME_IDENTITY_JWS_TYPE,
  resetCloudControlReplayFenceForTests,
  verifyCloudControlAssertion,
  type CloudControlAction,
} from "../services/cloud-runtime-identity.js";
import { cloudControlMiddleware } from "../middleware/cloud-control.js";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";
import { errorHandler } from "../middleware/index.js";
import { instanceSettingsRoutes } from "../routes/instance-settings.js";

const mockHeartbeatService = vi.hoisted(() => ({
  computeTaskDrain: vi.fn(),
  applyTaskDrain: vi.fn(),
  stopTaskDrain: vi.fn(),
  getTaskDrainStatus: vi.fn(),
  isTaskDrainGenerationLive: vi.fn(),
  terminateActiveRunsForTaskDrain: vi.fn(),
}));
const mockInstanceSettingsService = vi.hoisted(() => ({
  listCompanyIds: vi.fn(),
}));
const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
  findManagedSandboxEnvironment: vi.fn(),
  update: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockPublishActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => mockInstanceSettingsService,
  logActivity: mockLogActivity,
  publishActivity: mockPublishActivity,
}));
vi.mock("../services/environments.js", () => ({
  environmentService: () => mockEnvironmentService,
}));

const STACK_ID = "stack-drain-test";
const NOW = new Date("2099-01-01T00:00:00.000Z");

const pair = generateKeyPairSync("ed25519");
const otherPair = generateKeyPairSync("ed25519");
const publicJwk = {
  ...pair.publicKey.export({ format: "jwk" }),
  kid: "cloud-control-test-key",
  use: "sig",
  alg: "EdDSA",
};

const ENV = {
  PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS: JSON.stringify({ keys: [publicJwk] }),
  PAPERCLIP_CLOUD_STACK_ID: STACK_ID,
} as NodeJS.ProcessEnv;

function encodeJson(value: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

let requestIdCounter = 0;

function controlAssertion(input: {
  claims?: Record<string, unknown>;
  header?: Record<string, unknown>;
  signingKey?: typeof pair.privateKey;
  action?: CloudControlAction;
} = {}) {
  const iat = Math.floor(NOW.getTime() / 1000);
  const header = encodeJson({
    alg: "EdDSA",
    typ: CLOUD_CONTROL_JWS_TYPE,
    kid: publicJwk.kid,
    ...input.header,
  });
  const payload = encodeJson({
    v: 1,
    iss: CLOUD_RUNTIME_IDENTITY_ISSUER,
    aud: CLOUD_CONTROL_AUDIENCE,
    sub: STACK_ID,
    action: input.action ?? "task-drain:start",
    // Unique per assertion: request ids are single-use by design.
    requestId: `drain-req-${(requestIdCounter += 1)}`,
    iat,
    exp: iat + 60,
    ...input.claims,
  });
  const signature = sign(
    null,
    Buffer.from(`${header}.${payload}`, "ascii"),
    input.signingKey ?? pair.privateKey,
  ).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

/** The middleware verifies against the real clock, so sign a live token. */
function freshAssertion(action: CloudControlAction) {
  const iat = Math.floor(Date.now() / 1000);
  const header = encodeJson({ alg: "EdDSA", typ: CLOUD_CONTROL_JWS_TYPE, kid: publicJwk.kid });
  const payload = encodeJson({
    v: 1,
    iss: CLOUD_RUNTIME_IDENTITY_ISSUER,
    aud: CLOUD_CONTROL_AUDIENCE,
    sub: STACK_ID,
    action,
    requestId: `drain-req-live-${(requestIdCounter += 1)}`,
    iat,
    exp: iat + 60,
  });
  const signature = sign(null, Buffer.from(`${header}.${payload}`, "ascii"), pair.privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

describe("verifyCloudControlAssertion", () => {
  beforeEach(() => {
    resetCloudControlReplayFenceForTests();
  });

  const verify = (jws: string, expectedAction: CloudControlAction = "task-drain:start") =>
    verifyCloudControlAssertion({ compactJws: jws, expectedAction, env: ENV, now: NOW });

  it("accepts a well-formed assertion bound to the expected action", () => {
    const claims = verify(controlAssertion());
    expect(claims.sub).toBe(STACK_ID);
    expect(claims.action).toBe("task-drain:start");
    expect(claims.requestId).toMatch(/^drain-req-\d+$/);
  });

  it("rejects a replay: each assertion's request id is single-use", () => {
    const jws = controlAssertion();
    verify(jws);
    expect(() => verify(jws)).toThrow(/already been used/);
    // A distinct assertion (fresh request id) still verifies.
    verify(controlAssertion());
  });

  it("a rejected assertion does not burn its request id", () => {
    // The consume runs last: replaying a mangled copy first must not
    // deny the legitimate call.
    const jws = controlAssertion();
    expect(() => verify(jws, "task-drain:stop")).toThrow(/does not authorize/);
    verify(jws);
  });

  it("rejects an assertion for a different action — read cannot start a drain", () => {
    expect(() => verify(controlAssertion({ action: "task-drain:read" }))).toThrow(
      /does not authorize this action/,
    );
  });

  it("rejects an unknown action even when it matches the expectation", () => {
    expect(() =>
      verifyCloudControlAssertion({
        compactJws: controlAssertion({ claims: { action: "instance:shutdown" } }),
        expectedAction: "instance:shutdown" as CloudControlAction,
        env: ENV,
        now: NOW,
      }),
    ).toThrow(/does not authorize this action/);
  });

  it("rejects a runtime identity assertion replayed as a control assertion", () => {
    // Same key, disjoint typ/aud/claims — the one-time bootstrap claim can
    // never double as a management credential.
    const iat = Math.floor(NOW.getTime() / 1000);
    const header = encodeJson({ alg: "EdDSA", typ: CLOUD_RUNTIME_IDENTITY_JWS_TYPE, kid: publicJwk.kid });
    const payload = encodeJson({
      v: 1,
      iss: CLOUD_RUNTIME_IDENTITY_ISSUER,
      aud: CLOUD_RUNTIME_IDENTITY_AUDIENCE,
      sub: STACK_ID,
      claimId: "claim-1",
      previousOrigin: "https://pool-1.staging.paperclip.app",
      canonicalOrigin: "https://gonzo.staging.paperclip.app",
      stackSlug: "gonzo",
      iat,
      exp: iat + 60,
    });
    const signature = sign(null, Buffer.from(`${header}.${payload}`, "ascii"), pair.privateKey).toString("base64url");
    expect(() => verify(`${header}.${payload}.${signature}`)).toThrow(/protected header is invalid/);
  });

  it("rejects a control assertion whose audience is the runtime identity audience", () => {
    expect(() => verify(controlAssertion({ claims: { aud: CLOUD_RUNTIME_IDENTITY_AUDIENCE } }))).toThrow(
      /claims are incomplete|is invalid/,
    );
  });

  it("rejects an assertion for another stack, and any assertion when the instance is self-hosted", () => {
    expect(() => verify(controlAssertion({ claims: { sub: "stack-other" } }))).toThrow(
      /does not match this instance/,
    );
    expect(() =>
      verifyCloudControlAssertion({
        compactJws: controlAssertion(),
        expectedAction: "task-drain:start",
        env: { PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS: ENV.PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS } as NodeJS.ProcessEnv,
        now: NOW,
      }),
    ).toThrow(/does not match this instance/);
  });

  it("rejects expired assertions and oversized lifetimes", () => {
    const iat = Math.floor(NOW.getTime() / 1000);
    expect(() => verify(controlAssertion({ claims: { iat: iat - 600, exp: iat - 300 } }))).toThrow(
      /expired or has an invalid lifetime/,
    );
    expect(() => verify(controlAssertion({ claims: { exp: iat + 3600 } }))).toThrow(
      /expired or has an invalid lifetime/,
    );
  });

  it("rejects a signature from an unknown key", () => {
    expect(() => verify(controlAssertion({ signingKey: otherPair.privateKey }))).toThrow(
      /signature is invalid/,
    );
  });

  it("rejects a blank or padded request id", () => {
    expect(() => verify(controlAssertion({ claims: { requestId: "" } }))).toThrow(/claims are incomplete|request id/);
    expect(() => verify(controlAssertion({ claims: { requestId: " padded " } }))).toThrow(/request id is invalid/);
  });
});

describe("cloudControlMiddleware", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    resetCloudControlReplayFenceForTests();
    savedEnv.PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS = process.env.PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS;
    savedEnv.PAPERCLIP_CLOUD_STACK_ID = process.env.PAPERCLIP_CLOUD_STACK_ID;
    process.env.PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS = ENV.PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS;
    process.env.PAPERCLIP_CLOUD_STACK_ID = STACK_ID;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function createApp() {
    const app = express();
    app.use((req, _res, next) => {
      req.actor = { type: "none", source: "none" };
      next();
    });
    app.use(cloudControlMiddleware());
    app.all("/api/instance/task-drain", (req, res) => {
      res.json({ actor: req.actor });
    });
    app.get("/api/instance/settings", (req, res) => {
      res.json({ actor: req.actor });
    });
    return app;
  }

  it("installs a synthetic instance-admin board actor for a valid assertion, per method", async () => {
    const app = createApp();
    for (const [method, action] of [
      ["get", "task-drain:read"],
      ["post", "task-drain:start"],
      ["delete", "task-drain:stop"],
    ] as const) {
      const res = await (request(app) as any)[method]("/api/instance/task-drain")
        .set(CLOUD_CONTROL_HEADER, freshAssertion(action));
      expect(res.status).toBe(200);
      expect(res.body.actor).toMatchObject({
        type: "board",
        userId: "paperclip-cloud",
        isInstanceAdmin: true,
        source: "cloud_control",
      });
    }
  });

  it("rejects an assertion bound to a different method's action", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/instance/task-drain")
      .set(CLOUD_CONTROL_HEADER, freshAssertion("task-drain:read"));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_cloud_control_assertion");
  });

  it("accepts the conventional trailing-slash form of the endpoint", async () => {
    const app = createApp();
    const res = await request(app)
      .get("/api/instance/task-drain/")
      .set(CLOUD_CONTROL_HEADER, freshAssertion("task-drain:read"));
    expect(res.status).toBe(200);
    expect(res.body.actor).toMatchObject({ source: "cloud_control" });
  });

  it("rejects a replayed assertion at the middleware", async () => {
    const app = createApp();
    const jws = freshAssertion("task-drain:read");
    const first = await request(app).get("/api/instance/task-drain").set(CLOUD_CONTROL_HEADER, jws);
    expect(first.status).toBe(200);
    const replay = await request(app).get("/api/instance/task-drain").set(CLOUD_CONTROL_HEADER, jws);
    expect(replay.status).toBe(401);
  });

  it("rejects the header anywhere but the task-drain endpoint", async () => {
    const app = createApp();
    const res = await request(app)
      .get("/api/instance/settings")
      .set(CLOUD_CONTROL_HEADER, freshAssertion("task-drain:read"));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("cloud_control_wrong_endpoint");
  });

  it("rejects methods with no bound action even on the right endpoint", async () => {
    const app = createApp();
    const res = await request(app)
      .patch("/api/instance/task-drain")
      .set(CLOUD_CONTROL_HEADER, freshAssertion("task-drain:start"));
    expect(res.status).toBe(400);
  });

  it("passes requests without the header through untouched", async () => {
    const app = createApp();
    const res = await request(app).get("/api/instance/task-drain");
    expect(res.status).toBe(200);
    expect(res.body.actor).toMatchObject({ type: "none" });
  });

  it("the board mutation guard exempts cloud_control mutations from the browser-origin check", async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "paperclip-cloud",
        isInstanceAdmin: true,
        source: "cloud_control",
      };
      next();
    });
    app.use(boardMutationGuard());
    app.post("/api/instance/task-drain", (_req, res) => {
      res.json({ ok: true });
    });
    const res = await request(app).post("/api/instance/task-drain");
    expect(res.status).toBe(200);
  });
});

describe("the termination option through the production chain", () => {
  // An injected actor (as the route tests use) does not prove the
  // signed-capability boundary: it never exercises verifyCloudControlAssertion
  // or the method-to-action map. These tests mint a real signed assertion and
  // pass it through the real cloudControlMiddleware and the real task-drain
  // route, so they pin the board's decision that a task-drain:start assertion
  // may also set terminateActiveTasks, with no extra permission.
  // The termination deadline handler checks for an already-committed
  // outcome row before it writes one (see instance-settings.ts), so this
  // mock db needs a chainable select().from().where().limit() alongside
  // transaction(). Every test here wants the write to proceed, so the
  // check always reports no prior row.
  const mockDb = {
    transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn({})),
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([] as { id: string }[]),
        }),
      }),
    })),
  };

  beforeEach(() => {
    resetCloudControlReplayFenceForTests();
    process.env.PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS = ENV.PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS;
    process.env.PAPERCLIP_CLOUD_STACK_ID = STACK_ID;
    mockHeartbeatService.computeTaskDrain.mockReset();
    mockHeartbeatService.applyTaskDrain.mockReset();
    mockHeartbeatService.stopTaskDrain.mockReset();
    mockHeartbeatService.getTaskDrainStatus.mockReset();
    mockHeartbeatService.isTaskDrainGenerationLive.mockReset();
    mockHeartbeatService.terminateActiveRunsForTaskDrain.mockReset();
    mockHeartbeatService.terminateActiveRunsForTaskDrain.mockResolvedValue(new Map());
    mockInstanceSettingsService.listCompanyIds.mockReset();
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1"]);
    mockLogActivity.mockReset();
    mockLogActivity.mockImplementation(
      (_db: unknown, input: { companyId: string }, postCommit?: unknown[]) => {
        postCommit?.push({ companyId: input.companyId, payload: input, pluginEvent: null });
        return Promise.resolve({ id: `activity-${input.companyId}` });
      },
    );
    mockPublishActivity.mockReset();
    mockDb.transaction.mockClear();
  });

  afterEach(() => {
    delete process.env.PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS;
    delete process.env.PAPERCLIP_CLOUD_STACK_ID;
  });

  function createTaskDrainApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "none", source: "none" };
      next();
    });
    app.use(cloudControlMiddleware());
    app.use("/api", instanceSettingsRoutes(mockDb as any));
    app.use(errorHandler);
    return app;
  }

  it("a_signed_task_drain_start_assertion_can_request_termination_through_the_middleware", async () => {
    mockHeartbeatService.computeTaskDrain.mockReturnValue({
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      terminateActiveTasks: true,
      terminateAt: new Date(Date.now() + 30_000),
    });
    mockHeartbeatService.applyTaskDrain.mockReturnValue(1);
    const app = createTaskDrainApp();

    const res = await request(app)
      .post("/api/instance/task-drain")
      .set(CLOUD_CONTROL_HEADER, freshAssertion("task-drain:start"))
      .send({ ttlMs: 60_000, terminateActiveTasks: true });

    expect(res.status).toBe(200);
    expect(res.body.terminateActiveTasks).toBe(true);
    expect(mockHeartbeatService.computeTaskDrain).toHaveBeenCalledWith({
      ttlMs: 60_000,
      terminateActiveTasks: true,
    });
  });

  it("a_task_drain_read_assertion_cannot_post_the_termination_option", async () => {
    const app = createTaskDrainApp();

    const res = await request(app)
      .post("/api/instance/task-drain")
      .set(CLOUD_CONTROL_HEADER, freshAssertion("task-drain:read"))
      .send({ ttlMs: 60_000, terminateActiveTasks: true });

    expect(res.status).toBe(401);
    expect(mockHeartbeatService.applyTaskDrain).not.toHaveBeenCalled();
  });

  it("a_task_drain_stop_assertion_cannot_post_the_termination_option", async () => {
    const app = createTaskDrainApp();

    const res = await request(app)
      .post("/api/instance/task-drain")
      .set(CLOUD_CONTROL_HEADER, freshAssertion("task-drain:stop"))
      .send({ ttlMs: 60_000, terminateActiveTasks: true });

    expect(res.status).toBe(401);
    expect(mockHeartbeatService.applyTaskDrain).not.toHaveBeenCalled();
  });

  it("the_middleware_records_the_verified_cloud_request_id_on_the_request", async () => {
    mockHeartbeatService.computeTaskDrain.mockReturnValue({
      startedAt: new Date(),
      expiresAt: null,
      terminateActiveTasks: false,
      terminateAt: null,
    });
    const app = createTaskDrainApp();

    const res = await request(app)
      .post("/api/instance/task-drain")
      .set(CLOUD_CONTROL_HEADER, freshAssertion("task-drain:start"))
      .send({});

    expect(res.status).toBe(200);
    const startCall = mockLogActivity.mock.calls.find(
      ([, input]: [unknown, { action: string }]) => input.action === "instance.task_drain.started",
    );
    expect(startCall?.[1].details.initiatingActor).toMatchObject({
      actorSource: "cloud_control",
      cloudControlRequestId: expect.stringMatching(/^drain-req-live-\d+$/),
    });
  });

  it("the_timer_outcome_record_carries_the_verified_cloud_control_actor", async () => {
    // Fake only the timer functions, so the signed assertion still verifies
    // against the real clock while the test controls when the deadline fires.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const terminateAt = new Date(Date.now() + 30_000);
      mockHeartbeatService.computeTaskDrain.mockReturnValue({
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        terminateActiveTasks: true,
        terminateAt,
      });
      mockHeartbeatService.applyTaskDrain.mockReturnValue(1);
      mockHeartbeatService.isTaskDrainGenerationLive.mockReturnValue(true);
      const app = createTaskDrainApp();

      const res = await request(app)
        .post("/api/instance/task-drain")
        .set(CLOUD_CONTROL_HEADER, freshAssertion("task-drain:start"))
        .send({ ttlMs: 60_000, terminateActiveTasks: true });
      expect(res.status).toBe(200);

      mockLogActivity.mockClear();
      await vi.advanceTimersByTimeAsync(30_000);

      const outcomeCall = mockLogActivity.mock.calls.find(
        ([, input]: [unknown, { action: string }]) =>
          input.action === "instance.task_drain.active_tasks_terminated",
      );
      expect(outcomeCall?.[1].details.initiatingActor).toMatchObject({
        actorSource: "cloud_control",
        cloudControlRequestId: expect.stringMatching(/^drain-req-live-\d+$/),
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
