import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, companySecretBindings, companySecrets, createDb, runtimeServiceEvents, runtimeServices, secretAccessEvents, startEmbeddedPostgresTestDatabase, userSecretDefinitions } from "@paperclipai/db";
import { createRuntimeServiceSchema, type CreateRuntimeService, type RuntimeServiceAction } from "@paperclipai/shared";
import { secretService } from "../secrets.js";
import { createRuntimeServiceManager } from "./manager.js";
import { createLocalRuntimeServiceProvider } from "./local-provider.js";
import { createRuntimeServiceCredentials } from "./credentials.js";

describe("service-bound credentials with encrypted storage and real processes", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>; let root: string;
  const board = { type: "board" as const, id: "test-operator" };
  const tracked: Array<{ companyId: string; id: string; manager: ReturnType<typeof createRuntimeServiceManager> }> = [];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-service-credentials-"); db = createDb(database.connectionString);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-service-credentials-"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", path.join(root, "master.key"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));
  }, 30_000);
  afterEach(async () => {
    for (const entry of tracked.splice(0)) {
      const current = await entry.manager.get(entry.companyId, entry.id);
      if (current.state !== "deleted") await control(entry.manager, entry.companyId, entry.id, "stop");
    }
  });
  afterAll(async () => { await database?.cleanup(); if (root) await fs.rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
  async function fixture() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Service credentials", issuePrefix: `C${companyId.slice(0, 6)}` });
    const cwd = path.join(root, companyId); await fs.mkdir(cwd);
    await fs.writeFile(path.join(cwd, "app.cjs"), `const crypto=require('node:crypto');const value=process.env.APP_SECRET||'missing';process.stdout.write(value.slice(0,8));setTimeout(()=>console.log(value.slice(8)),30);require('node:http').createServer((q,s)=>s.end(crypto.createHash('sha256').update(value).digest('hex'))).listen(Number(process.env.PORT),'127.0.0.1');`);
    const make = () => createRuntimeServiceManager(db, { providers: [createLocalRuntimeServiceProvider({ root: path.join(root, "supervisors") })], ...createRuntimeServiceCredentials(db) });
    const manager = make(); const secrets = secretService(db);
    const value = `test-credential-${randomUUID()}`;
    const secret = await secrets.create(companyId, { name: "App credential", provider: "local_encrypted", value });
    const placement = { provider: "local", cwd, reuseKey: cwd };
    const input = createRuntimeServiceSchema.parse({ requestId: randomUUID(), name: "Authenticated app", command: "node app.cjs", endpoints: [{ name: "web" }], env: { APP_SECRET: { type: "secret_ref", secretId: secret.id } } });
    const create = async (next = input, actor = board as Parameters<typeof manager.create>[1]) => {
      const service = await manager.create(companyId, actor, next, placement);
      if (!tracked.some((entry) => entry.id === service.id)) tracked.push({ companyId, id: service.id, manager });
      return service;
    };
    return { companyId, manager, make, secrets, value, secret, input, create, placement };
  }
  async function control(manager: ReturnType<typeof createRuntimeServiceManager>, companyId: string, id: string, action: RuntimeServiceAction) {
    const current = await manager.get(companyId, id);
    await manager.control(companyId, id, board, { requestId: randomUUID(), expectedRevision: current.revision, action });
    await manager.reconcile(companyId, id);
    return manager.get(companyId, id);
  }
  async function ready(manager: ReturnType<typeof createRuntimeServiceManager>, companyId: string, id: string) {
    for (let attempt = 0; attempt < 50; attempt++) {
      await manager.reconcile(companyId, id); const row = await manager.get(companyId, id);
      if (row.state === "ready") return row;
      if (row.state === "failed") throw new Error(row.error ?? "Service failed");
      await delay(50);
    }
    throw new Error("Service did not become ready");
  }
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  async function proof(row: Awaited<ReturnType<ReturnType<typeof createRuntimeServiceManager>["get"]>>) {
    return (await fetch(`http://127.0.0.1:${row.endpoints[0]!.port}`)).text();
  }

  it("binds once, resolves without a run, redacts before storage, and refreshes latest credentials after restart", async () => {
    const f = await fixture(); const service = await f.create();
    expect((await f.create()).id).toBe(service.id);
    const running = await ready(f.manager, f.companyId, service.id);
    expect(await proof(running)).toBe(digest(f.value));
    const bindings = await db.select().from(companySecretBindings).where(eq(companySecretBindings.targetId, service.id));
    expect(bindings).toHaveLength(1); expect(bindings[0]).toMatchObject({ companyId: f.companyId, targetType: "runtime_service", configPath: "env.APP_SECRET" });
    const events = await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.consumerId, service.id));
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ consumerType: "runtime_service", outcome: "success", heartbeatRunId: null })]));
    const persisted = (await f.manager.getRecord(f.companyId, service.id)).service;
    expect(JSON.stringify(persisted)).not.toContain(f.value);
    const savedLogs = await fs.readFile(path.join(root, "supervisors", f.companyId, service.id, "output.log"), "utf8");
    expect(savedLogs).not.toContain(f.value); expect(savedLogs).toContain("REDACTED");
    const replacement = f.make(); await control(replacement, f.companyId, service.id, "stop");
    const rotated = `rotated-credential-${randomUUID()}`; await f.secrets.rotate(f.secret.id, { value: rotated });
    await control(replacement, f.companyId, service.id, "start");
    expect(await proof(await ready(replacement, f.companyId, service.id))).toBe(digest(rotated));
    expect(await replacement.logs(f.companyId, service.id)).not.toContain(rotated);
  });

  it("rolls back service creation for unauthorized, foreign, user-scoped, and disallowed credential bindings", async () => {
    const f = await fixture();
    const otherCompanyId = randomUUID(); await db.insert(companies).values({ id: otherCompanyId, name: "Other", issuePrefix: "OTHER" });
    const foreign = await f.secrets.create(otherCompanyId, { name: "Foreign", provider: "local_encrypted", value: "foreign-fixture-value" });
    const agentId = randomUUID(); await db.insert(agents).values({ id: agentId, companyId: f.companyId, name: "Agent", role: "engineer" });
    await expect(f.create(f.input, { type: "agent", id: agentId })).rejects.toMatchObject({ status: 403 });
    const variants: CreateRuntimeService["env"][] = [
      { APP_SECRET: { type: "secret_ref", secretId: foreign.id } },
      { APP_SECRET: { type: "secret_ref", secretId: f.secret.id, projectionClass: "class_3_static_lease" } },
      { APP_SECRET: { type: "plain", value: "must-not-be-persisted" } },
    ];
    for (const env of variants) await expect(f.create({ ...f.input, env })).rejects.toMatchObject({ status: 422 });
    const definitionId = randomUUID();
    await db.insert(userSecretDefinitions).values({ id: definitionId, companyId: f.companyId, key: "personal", name: "Personal secret" });
    await db.update(companySecrets).set({ scope: "user", ownerUserId: "fixture-owner", userSecretDefinitionId: definitionId }).where(eq(companySecrets.id, f.secret.id));
    await expect(f.create()).rejects.toMatchObject({ status: 422 });
    expect(await db.select().from(runtimeServices).where(eq(runtimeServices.companyId, f.companyId))).toHaveLength(0);
    expect(await db.select().from(companySecretBindings).where(eq(companySecretBindings.companyId, f.companyId))).toHaveLength(0);
  });

  it("requires a stopped service for environment changes and preserves an exact retry and pinned version", async () => {
    const f = await fixture(); const service = await f.create(); await ready(f.manager, f.companyId, service.id);
    const current = await f.manager.get(f.companyId, service.id);
    const update = { requestId: randomUUID(), expectedRevision: current.revision, env: { APP_SECRET: { type: "secret_ref" as const, secretId: f.secret.id, version: 1 } } };
    await expect(f.manager.updateEnvironment(f.companyId, service.id, board, update)).rejects.toMatchObject({ status: 409 });
    const stopped = await control(f.manager, f.companyId, service.id, "stop"); update.expectedRevision = stopped.revision;
    await f.manager.updateEnvironment(f.companyId, service.id, board, update);
    await f.secrets.rotate(f.secret.id, { value: "next-fixture-value" });
    await control(f.manager, f.companyId, service.id, "start");
    expect(await proof(await ready(f.manager, f.companyId, service.id))).toBe(digest(f.value));
    await f.manager.updateEnvironment(f.companyId, service.id, board, update); // accepted receipt survives a later start
    const receipts = await db.select().from(runtimeServiceEvents).where(and(eq(runtimeServiceEvents.serviceId, service.id), eq(runtimeServiceEvents.kind, "environment_changed")));
    expect(receipts).toHaveLength(1);
    await expect(f.manager.updateEnvironment(f.companyId, service.id, { type: "agent", id: randomUUID() }, update)).rejects.toMatchObject({ status: 403 });
  });

  it("fails closed after credential revocation while preserving Stop, saved logs, and binding cleanup on deletion", async () => {
    const f = await fixture(); const service = await f.create(); await ready(f.manager, f.companyId, service.id);
    await f.secrets.update(f.secret.id, { status: "disabled" });
    expect((await control(f.manager, f.companyId, service.id, "stop")).state).toBe("stopped");
    expect(await f.manager.logs(f.companyId, service.id)).toContain("REDACTED");
    await control(f.manager, f.companyId, service.id, "start");
    expect(await f.manager.get(f.companyId, service.id)).toMatchObject({ state: "failed", error: expect.stringContaining("credentials are unavailable") });
    expect((await control(f.manager, f.companyId, service.id, "stop")).state).toBe("stopped");
    expect((await control(f.manager, f.companyId, service.id, "delete")).state).toBe("deleted");
    expect(await db.select().from(companySecretBindings).where(eq(companySecretBindings.targetId, service.id))).toHaveLength(0);
  });
});
