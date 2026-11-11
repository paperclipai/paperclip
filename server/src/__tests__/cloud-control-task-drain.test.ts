import { connectionEventWakeRoutes } from "../routes/connection-event-wake.js";
import { registerConnectionEventWake } from "../services/connection-event-wake.js";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
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
  const eventOwner = {};
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
    app.use(connectionEventWakeRoutes(eventOwner));
    app.all("/api/instance/task-drain", (req, res) => {
      res.json({ actor: req.actor });
    });
    app.all("/api/instance/lifecycle", (req, res) => {
      res.json({ actor: req.actor });
    });
    app.all("/api/instance/lifecycle/unarchive-primary", (req, res) => {
      res.json({ actor: req.actor });
    });
    app.get("/api/instance/settings", (req, res) => {
      res.json({ actor: req.actor });
    });
    return app;
  }

  function freshAssertion(action: CloudControlAction) {
    // The middleware verifies against the real clock; sign a live token.
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

  it("accepts only signed exact-action event hints and leaves unavailable receivers retryable", async () => {
    const app = createApp(); const path = "/api/instance/connector-events/wake";
    expect((await request(app).post(path)).status).toBe(403);
    expect((await request(app).post(path).set(CLOUD_CONTROL_HEADER, freshAssertion("lifecycle:read"))).status).toBe(401);
    expect((await request(app).post(path).set(CLOUD_CONTROL_HEADER, freshAssertion("connector-events:wake"))).status).toBe(503);
    const wake = vi.fn(); const stop = registerConnectionEventWake(eventOwner, wake);
    try {
      const token = freshAssertion("connector-events:wake");
      expect((await request(app).post(path).set(CLOUD_CONTROL_HEADER, token)).status).toBe(202);
      expect((await request(app).post(path).set(CLOUD_CONTROL_HEADER, token)).status).toBe(401);
      expect((await request(app).post(path).set(CLOUD_CONTROL_HEADER, freshAssertion("connector-events:wake"))).status).toBe(202);
      expect(wake).toHaveBeenCalledTimes(2);
    } finally { stop(); }
    expect((await request(app).post(path).set(CLOUD_CONTROL_HEADER, freshAssertion("connector-events:wake"))).status).toBe(503);
  });

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

  it("authorizes the lifecycle endpoints, each bound to its own action", async () => {
    const app = createApp();
    const read = await request(app)
      .get("/api/instance/lifecycle")
      .set(CLOUD_CONTROL_HEADER, freshAssertion("lifecycle:read"));
    expect(read.status).toBe(200);
    expect(read.body.actor).toMatchObject({ type: "board", isInstanceAdmin: true, source: "cloud_control" });

    const unarchive = await request(app)
      .post("/api/instance/lifecycle/unarchive-primary")
      .set(CLOUD_CONTROL_HEADER, freshAssertion("lifecycle:unarchive-primary"));
    expect(unarchive.status).toBe(200);
    expect(unarchive.body.actor).toMatchObject({ source: "cloud_control" });

    // Cross-binding: a task-drain assertion opens no lifecycle door, a
    // read assertion cannot unarchive, and lifecycle endpoints accept no
    // extra methods.
    const crossAction = await request(app)
      .get("/api/instance/lifecycle")
      .set(CLOUD_CONTROL_HEADER, freshAssertion("task-drain:read"));
    expect(crossAction.status).toBe(401);
    const readAsWrite = await request(app)
      .post("/api/instance/lifecycle/unarchive-primary")
      .set(CLOUD_CONTROL_HEADER, freshAssertion("lifecycle:read"));
    expect(readAsWrite.status).toBe(401);
    const wrongMethod = await request(app)
      .post("/api/instance/lifecycle")
      .set(CLOUD_CONTROL_HEADER, freshAssertion("lifecycle:read"));
    expect(wrongMethod.status).toBe(400);
    expect(wrongMethod.body.error).toBe("cloud_control_wrong_endpoint");
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


describe("body-bound Cloud idle status assertion", () => {
  const body = Buffer.from(JSON.stringify({ idleCapabilities: { deadlineCatalog: "domain_deadlines_v1" } }));
  const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
  const token = (raw: Uint8Array, extra: Record<string, unknown> = {}) => controlAssertion({ action: "task-drain:read-body", claims: { bodySha256: digest(raw), ...extra } });
  const read = (compactJws: string, rawBody?: Uint8Array) => verifyCloudControlAssertion({ compactJws, rawBody,
    expectedAction: "task-drain:read-body", env: ENV, now: NOW });
  beforeEach(() => resetCloudControlReplayFenceForTests());
  it("installs the complete closed body only after its exact-byte binding and rejects replay", () => {
    const jws = token(body);
    const claims = read(jws, body);
    expect(claims.idleCapabilities).toEqual({ deadlineCatalog: "domain_deadlines_v1" });
    expect(Object.isFrozen(claims.idleCapabilities)).toBe(true);
    expect(() => read(jws, body)).toThrow(/already been used/);
  });
  it("rejects changed or missing bytes without burning the valid exact request", () => {
    const jws = token(body);
    expect(() => read(jws)).toThrow(/body binding/);
    expect(() => read(jws, Buffer.concat([body, Buffer.from(" ")]))).toThrow(/digest changed/);
    expect(read(jws, body).idleCapabilities?.deadlineCatalog).toBe("domain_deadlines_v1");
  });
  it("rejects malformed UTF8 before consuming the same nonce", () => {
    const requestId = "invalid-utf8-status-read";
    const malformed = Buffer.concat([Buffer.from('{"idleCapabilities":{"deadlineCatalog":"'), Buffer.from([0xff]), Buffer.from('"}}')]);
    expect(() => read(token(malformed, { requestId }), malformed)).toThrow(TypeError);
    expect(read(token(body, { requestId }), body).idleCapabilities?.deadlineCatalog).toBe("domain_deadlines_v1");
  });
  it.each([
    ["unknown catalog", '{"idleCapabilities":{"deadlineCatalog":"unowned"}}'],
    ["extra field", '{"idleCapabilities":{"deadlineCatalog":"domain_deadlines_v1"},"extra":true}'],
    ["array body", '[{"idleCapabilities":{"deadlineCatalog":"domain_deadlines_v1"}}]'],
    ["malformed JSON", "{"],
  ])("rejects %s before consuming the same nonce", (_name, text) => {
    const requestId = "rejected-status-body";
    const raw = Buffer.from(text);
    expect(() => read(token(raw, { requestId }), raw)).toThrow();
    expect(read(token(body, { requestId }), body).idleCapabilities?.deadlineCatalog).toBe("domain_deadlines_v1");
  });
  it("rejects mixed embedded capabilities and malformed digest without consuming a nonce", () => {
    for (const extra of [{ idleCapabilities: { deadlineCatalog: "domain_deadlines_v1" } }, { bodySha256: "invalid" }]) {
      resetCloudControlReplayFenceForTests();
      const requestId = "mixed-status-body";
      expect(() => read(token(body, { requestId, ...extra }), body)).toThrow(/body binding/);
      expect(read(token(body, { requestId }), body).idleCapabilities?.deadlineCatalog).toBe("domain_deadlines_v1");
    }
  });
  it("enforces the unchanged ten MiB JSON limit before consuming the same nonce", () => {
    const raw = Buffer.alloc(10 * 1024 * 1024 + 1, 32), requestId = "oversized-status-body";
    expect(() => read(token(raw, { requestId }), raw)).toThrow(/body binding/);
    expect(read(token(body, { requestId }), body).idleCapabilities?.deadlineCatalog).toBe("domain_deadlines_v1");
  });
  it("does not turn body-read authority into start or stop authority", () => {
    for (const action of ["task-drain:start", "task-drain:stop"] as const) {
      const jws = token(body);
      expect(() => verifyCloudControlAssertion({ compactJws: jws, expectedAction: action, rawBody: body, env: ENV, now: NOW })).toThrow(/authorize/);
      expect(read(jws, body).action).toBe("task-drain:read-body");
      expect(() => verifyCloudControlAssertion({ compactJws: controlAssertion({ action, claims: { bodySha256: digest(body) } }),
        expectedAction: action, rawBody: body, env: ENV, now: NOW })).toThrow(/Body|body/);
    }
  });
});
