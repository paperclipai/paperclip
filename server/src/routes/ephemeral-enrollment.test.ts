import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { ephemeralEnrollmentRoutes } from "./ephemeral-enrollment.js";
import { cloudControlMiddleware } from "../middleware/cloud-control.js";
import { isSecretSensitiveHttpRequest } from "../middleware/http-log-policy.js";
import { CLOUD_CONTROL_AUDIENCE, CLOUD_CONTROL_HEADER, CLOUD_CONTROL_JWS_TYPE,
  CLOUD_RUNTIME_IDENTITY_ISSUER, resetCloudControlReplayFenceForTests } from "../services/cloud-runtime-identity.js";

const prepare = vi.hoisted(() => vi.fn());
vi.mock("../services/ephemeral-enrollment.js", () => ({ prepareOnlineEphemeralEnrollment: prepare }));
const pair = generateKeyPairSync("ed25519");
const jwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "enrollment-fixture", alg: "EdDSA", use: "sig" };
const path = "/api/instance/ephemeral-enrollment/prepare";
const attemptId = randomUUID();
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function assertion(action = "ephemeral-enrollment:prepare", stackId = "stack-fixture") {
  const iat = Math.floor(Date.now() / 1000);
  const body = `${encode({ alg: "EdDSA", typ: CLOUD_CONTROL_JWS_TYPE, kid: jwk.kid })}.${encode({
    v: 1, iss: CLOUD_RUNTIME_IDENTITY_ISSUER, aud: CLOUD_CONTROL_AUDIENCE,
    sub: stackId, action, requestId: randomUUID(), iat, exp: iat + 60,
  })}`;
  return `${body}.${sign(null, Buffer.from(body, "ascii"), pair.privateKey).toString("base64url")}`;
}
function app(tenant = false) {
  const result = express(); result.use(express.json());
  result.use((req, _res, next) => {
    req.actor = tenant ? { type: "board", source: "cloud_tenant", userId: "fixture-user", isInstanceAdmin: true }
      : { type: "none", source: "none" };
    next();
  });
  result.use(cloudControlMiddleware()); result.use("/api", ephemeralEnrollmentRoutes({} as Db));
  result.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ error: "fixture_validation_failed" });
  });
  return result;
}
beforeEach(() => {
  vi.resetAllMocks(); resetCloudControlReplayFenceForTests();
  vi.stubEnv("PAPERCLIP_CLOUD_STACK_ID", "stack-fixture");
  vi.stubEnv("PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS", JSON.stringify({ keys: [jwk] }));
  prepare.mockResolvedValue({ attemptId, enrollmentReady: false, decisionSigningSecret: "fixture-original-key" });
});
afterEach(() => vi.unstubAllEnvs());

it("exports once only to a fresh stack-bound signed prepare assertion", async () => {
  const server = app(), token = assertion();
  const accepted = await request(server).post(path).set(CLOUD_CONTROL_HEADER, token).send({ attemptId });
  expect(accepted.status).toBe(200);
  expect(accepted.headers["cache-control"]).toBe("no-store");
  expect(accepted.body).toMatchObject({ decisionSigningSecret: "fixture-original-key", enrollmentReady: false });
  expect((await request(server).post(path).set(CLOUD_CONTROL_HEADER, token).send({ attemptId })).status).toBe(401);
  expect(prepare).toHaveBeenCalledOnce();
});

it.each([false, true])("refuses an unsigned caller, including a tenant instance admin (%s)", async tenant => {
  expect((await request(app(tenant)).post(path).send({ attemptId })).status).toBe(403);
  expect(prepare).not.toHaveBeenCalled();
});

it.each([["task-drain:read", "stack-fixture"], ["ephemeral-enrollment:prepare", "stack-other"]])(
  "refuses mismatched action or stack (%s, %s)", async (action, stack) => {
    const result = await request(app()).post(path).set(CLOUD_CONTROL_HEADER, assertion(action, stack)).send({ attemptId });
    expect(result.status).toBe(401); expect(prepare).not.toHaveBeenCalled();
  });

it("rejects malformed or additional caller-supplied authority before export", async () => {
  for (const body of [{ attemptId: "bad" }, { attemptId, stackId: "stack-other" }]) {
    expect((await request(app()).post(path).set(CLOUD_CONTROL_HEADER, assertion()).send(body)).status).toBe(400);
  }
  expect(prepare).not.toHaveBeenCalled();
});

it("keeps enrollment HTTP diagnostics secret-sensitive, including rejected methods", () => {
  for (const method of ["POST", "GET", "DELETE"]) {
    expect(isSecretSensitiveHttpRequest(method, path)).toBe(true);
    expect(isSecretSensitiveHttpRequest(method, `https://fixture.test${path}`)).toBe(true);
  }
});
