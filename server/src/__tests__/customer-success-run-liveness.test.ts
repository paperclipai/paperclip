import { randomUUID, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { count, eq } from "drizzle-orm";
import * as schema from "@paperclipai/db";
import { canonicalJson, INSPECTION_HEADER } from "@paperclipai/shared";
import {
  customerSuccessRoutes,
  RUN_LIVENESS_AUDIENCE,
  RUN_LIVENESS_TYPE,
  type RunLivenessClaims,
} from "../routes/customer-success.js";
import { errorHandler } from "../middleware/error-handler.js";
import type { StorageService } from "../storage/types.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const PATH = "/api/customer-success/v1/run-liveness";
const STACK = "fixture-stack";
const storage = {} as StorageService;
const keys = generateKeyPairSync("ed25519");
const jwks = { keys: [{ ...keys.publicKey.export({ format: "jwk" }), kid: "cloud" }] };

function token(claims: RunLivenessClaims, options: { privateKey?: KeyObject; typ?: string } = {}) {
  const header = Buffer.from(
    canonicalJson({ alg: "EdDSA", typ: options.typ ?? RUN_LIVENESS_TYPE, kid: "cloud" }),
  ).toString("base64url");
  const payload = Buffer.from(canonicalJson(claims)).toString("base64url");
  const input = `${header}.${payload}`;
  return `${input}.${sign(null, Buffer.from(input), options.privateKey ?? keys.privateKey).toString("base64url")}`;
}

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("Cloud run liveness check for inspection authority", () => {
  let db: schema.Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let companyId: string;
  let agentId: string;
  let runId: string;
  let finishedRunId: string;
  let app: express.Express;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("run-liveness-db-");
    db = schema.createDb(database.connectionString);
    const [company] = await db.insert(schema.companies).values({ name: "Customer", issuePrefix: "LIV" }).returning();
    companyId = company.id;
    // A plain process agent: liveness needs no managed identity key.
    const [agent] = await db.insert(schema.agents).values({ companyId, name: "Fixture agent", adapterType: "process" }).returning();
    agentId = agent.id;
    const runs = await db.insert(schema.heartbeatRuns).values([
      { companyId, agentId, status: "running", startedAt: new Date() },
      { companyId, agentId, status: "succeeded", startedAt: new Date(), finishedAt: new Date() },
    ]).returning();
    runId = runs[0].id;
    finishedRunId = runs[1].id;
    app = express();
    app.use(express.json());
    app.use("/api/customer-success/v1", customerSuccessRoutes(db, storage));
    app.use(errorHandler);
  }, 60_000);
  afterAll(async () => { await database?.cleanup(); });
  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_CUSTOMER_SUCCESS_AUTHORITY_ENABLED", "true");
    vi.stubEnv("PAPERCLIP_CLOUD_STACK_ID", STACK);
    vi.stubEnv("PAPERCLIP_CUSTOMER_SUCCESS_INSPECTION_JWKS", JSON.stringify(jwks));
  });
  afterEach(() => vi.unstubAllEnvs());

  function claims(overrides: Partial<RunLivenessClaims> = {}): RunLivenessClaims {
    const now = Math.floor(Date.now() / 1000);
    return {
      v: 1, iss: "paperclip-cloud", aud: RUN_LIVENESS_AUDIENCE, sub: STACK, jti: randomUUID(),
      iat: now, exp: now + 60, companyId, agentId, runId, ...overrides,
    };
  }
  const body = (value: RunLivenessClaims) => canonicalJson({ agentId: value.agentId, companyId: value.companyId, runId: value.runId });
  const ask = (value: RunLivenessClaims, jws = token(value), payload = body(value)) =>
    request(app).post(PATH).set("Content-Type", "application/json").set(INSPECTION_HEADER, jws).send(payload);
  const sideEffectCounts = async () => Promise.all([
    schema.activityLog, schema.agentApiKeys, schema.agentIdentityKeys,
  ].map(async (table) => (await db.select({ value: count() }).from(table))[0].value));

  it("answers active for a running run without creating any state", async () => {
    const before = await sideEffectCounts();
    const question = claims();
    const response = await ask(question);
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({ version: 1, companyId, agentId, runId, active: true });
    expect(await sideEffectCounts()).toEqual(before);
  });

  it("answers inactive for a finished or write-revoked run, a paused agent, another company or an unknown run", async () => {
    expect((await ask(claims({ runId: finishedRunId }))).body).toMatchObject({ runId: finishedRunId, active: false });
    expect((await ask(claims({ runId: randomUUID() }))).body).toMatchObject({ active: false });
    expect((await ask(claims({ companyId: randomUUID() }))).body).toMatchObject({ active: false });
    await db.update(schema.heartbeatRuns).set({ resultJson: { executionCancellation: { state: "requested" } } }).where(eq(schema.heartbeatRuns.id, runId));
    try {
      expect((await ask(claims())).body).toMatchObject({ active: false });
    } finally {
      await db.update(schema.heartbeatRuns).set({ resultJson: null }).where(eq(schema.heartbeatRuns.id, runId));
    }
    await db.update(schema.agents).set({ status: "paused" }).where(eq(schema.agents.id, agentId));
    try {
      expect((await ask(claims())).body).toEqual({ version: 1, companyId, agentId, runId, active: false });
    } finally {
      await db.update(schema.agents).set({ status: "idle" }).where(eq(schema.agents.id, agentId));
    }
  });

  it("rejects a question for another stack, an expired or over-long window, a bad signature and another token type", async () => {
    const now = Math.floor(Date.now() / 1000);
    expect((await ask(claims({ sub: "other-stack" }))).status).toBe(403);
    expect((await ask(claims({ iat: now - 120, exp: now - 60 }))).status).toBe(403);
    expect((await ask(claims({ iat: now, exp: now + 61 }))).status).toBe(403);
    const value = claims();
    expect((await ask(value, token(value, { privateKey: generateKeyPairSync("ed25519").privateKey }))).status).toBe(403);
    expect((await ask(value, token(value, { typ: "paperclip-inspection+jwt" }))).status).toBe(403);
    expect((await ask(claims({ aud: "paperclip-customer-success/v1" as never }))).status).toBe(403);
  });

  it("rejects a body that differs from the signed question", async () => {
    const value = claims();
    expect((await ask(value, token(value), body({ ...value, runId: finishedRunId }))).status).toBe(403);
    expect((await ask(value, token(value), canonicalJson({ agentId, companyId, runId, extra: true }))).status).toBe(403);
  });

  it("is off unless run authority is enabled, and refuses browser or bearer credentials", async () => {
    const value = claims();
    vi.stubEnv("PAPERCLIP_CUSTOMER_SUCCESS_AUTHORITY_ENABLED", "false");
    expect((await ask(value)).status).toBe(403);
    vi.stubEnv("PAPERCLIP_CUSTOMER_SUCCESS_AUTHORITY_ENABLED", "true");
    expect((await ask(value).set("Cookie", "session=ignored")).status).toBe(403);
    expect((await ask(value).set("Authorization", "Bearer ignored")).status).toBe(403);
    expect((await ask(value)).status).toBe(200);
  });
});
