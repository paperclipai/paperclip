import { randomBytes, randomUUID, verify, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agentIdentityKeys, agents, companies, createDb, closeRegisteredClients, ensurePostgresDatabase, runDatabaseBackup, runDatabaseRestore, type Db } from "@paperclipai/db";
import { resolveWorktreeSeedPlan } from "../../../cli/src/commands/worktree-lib.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentIdentityService, supportsManagedAgentIdentity } from "../services/agent-identity.js";
import { agentService } from "../services/agents.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import { execute } from "../adapters/process/execute.js";
import { createAgentIdentityRedactor } from "../services/agent-identity-redaction.js";
import { heartbeatService } from "../services/heartbeat.js";
import { agentRoutes } from "../routes/agents.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

describe("agent cryptographic identity", () => {
  let db: Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let directory: string;
  let companyId: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "paperclip-identity-"));
    vi.stubEnv("PAPERCLIP_HOME", directory);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", join(directory, "master.key"));
    database = await startEmbeddedPostgresTestDatabase("paperclip-identity-");
    db = createDb(database.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Identity test", issuePrefix: "KEY", defaultResponsibleUserId: "identity-test-owner" });
  });
  afterAll(async () => {
    await database?.cleanup();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  async function oldAgent() {
    const [agent] = await db.insert(agents).values({ companyId, name: randomUUID(), role: "engineer" }).returning();
    return agent;
  }

  it("migration and public reads leave existing agents unprovisioned", async () => {
    const agent = await oldAgent();
    expect(await agentIdentityService(db).getPublicIdentity(companyId, agent.id)).toBeNull();
    expect(await db.select().from(agentIdentityKeys).where(eq(agentIdentityKeys.agentId, agent.id))).toHaveLength(0);
    for (const type of ["http", "openclaw_gateway", "hermes_gateway"]) expect(supportsManagedAgentIdentity(type)).toBe(false);
    for (const provider of ["claude_managed", "aws_agentcore"]) expect(supportsManagedAgentIdentity("paperclip_runner", { provider })).toBe(false);
    expect(supportsManagedAgentIdentity("paperclip_runner", { provider: "codex" }, "claude_managed_agents_api")).toBe(false);
    expect(supportsManagedAgentIdentity("paperclip_runner", { provider: "claude_managed" }, "codex_app_server")).toBe(true);
  });

  it("concurrent first runs converge, restart/model/name changes preserve keys, and ownership is enforced", async () => {
    const agent = await oldAgent();
    const pairs = await Promise.all(Array.from({ length: 8 }, () =>
      agentIdentityService(db).ensureAgentIdentity(companyId, agent.id)));
    expect(new Set(pairs.map(pair => pair.privateKeyPem)).size).toBe(1);
    await db.update(agents).set({ name: "Renamed", adapterConfig: { model: "another-model" }, status: "paused" }).where(eq(agents.id, agent.id));
    const freshDb = createDb(database.connectionString);
    expect(await agentIdentityService(freshDb).ensureAgentIdentity(companyId, agent.id)).toEqual(pairs[0]);
    expect(await agentIdentityService(db).getPublicIdentity(randomUUID(), agent.id)).toBeNull();
    await expect(agentIdentityService(db).ensureAgentIdentity(randomUUID(), agent.id)).rejects.toThrow("Agent not found");
    const second = await oldAgent();
    expect((await agentIdentityService(db).ensureAgentIdentity(companyId, second.id)).keyId).not.toBe(pairs[0].keyId);
    await db.delete(agents).where(eq(agents.id, second.id));
    expect(await agentIdentityService(db).getPublicIdentity(companyId, second.id)).toBeNull();
  });

  it("creates identities in the agent creation transaction and rolls both writes back on failure", async () => {
    const created = await agentService(db).create(companyId, { name: "New identity", role: "engineer", status: "pending_approval" });
    expect(await agentIdentityService(db).getPublicIdentity(companyId, created.id)).toMatchObject({ algorithm: "Ed25519" });
    const id = randomUUID();
    await expect(db.transaction(async tx => {
      await tx.insert(agents).values({ id, companyId, name: "Rollback", role: "engineer" });
      await agentIdentityService(tx as unknown as Db).ensureAgentIdentity(companyId, id);
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(await db.select().from(agents).where(eq(agents.id, id))).toHaveLength(0);
    expect(await agentIdentityService(db).getPublicIdentity(companyId, id)).toBeNull();
    const fail = vi.spyOn(localEncryptedProvider, "createSecret").mockRejectedValueOnce(new Error("encryption unavailable"));
    await expect(agentService(db).create(companyId, { name: "Must roll back", role: "engineer", status: "pending_approval" })).rejects.toThrow("encryption unavailable");
    fail.mockRestore();
    expect(await db.select().from(agents).where(eq(agents.name, "Must roll back"))).toHaveLength(0);
  });

  it("fails closed for wrong master keys, corrupted material and mismatched public keys", async () => {
    const agent = await oldAgent();
    const identity = await agentIdentityService(db).ensureAgentIdentity(companyId, agent.id);
    const [stored] = await db.select().from(agentIdentityKeys).where(eq(agentIdentityKeys.agentId, agent.id));
    expect(JSON.stringify(stored)).not.toContain(identity.privateKeyPem.split("\n")[1]);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", randomBytes(32).toString("base64"));
    await expect(agentIdentityService(db).ensureAgentIdentity(companyId, agent.id)).rejects.toThrow("decryption failed");
    expect(await agentIdentityService(db).getPublicIdentity(companyId, agent.id)).toMatchObject({ keyId: identity.keyId });
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "");
    await db.update(agentIdentityKeys).set({ privateKeyMaterial: { ...stored.privateKeyMaterial, ciphertext: "AAAA" } }).where(eq(agentIdentityKeys.agentId, agent.id));
    await expect(agentIdentityService(db).ensureAgentIdentity(companyId, agent.id)).rejects.toThrow();
    const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    await db.update(agentIdentityKeys).set({ privateKeyMaterial: stored.privateKeyMaterial, publicKeyPem: other }).where(eq(agentIdentityKeys.agentId, agent.id));
    await expect(agentIdentityService(db).ensureAgentIdentity(companyId, agent.id)).rejects.toThrow("do not match");
    expect((await db.select().from(agentIdentityKeys).where(eq(agentIdentityKeys.agentId, agent.id)))[0].keyId).toBe(identity.keyId);
  });

  it("a real managed process signs a random challenge before and after reconnect, ignoring hostile env overrides", async () => {
    const agent = await oldAgent();
    const challenge = randomBytes(32).toString("base64");
    let publicPem = "";
    for (let restart = 0; restart < 2; restart++) {
      const restarted = agentIdentityService(createDb(database.connectionString));
      const identity = await restarted.ensureAgentIdentity(companyId, agent.id);
      const publicIdentity = await restarted.getPublicIdentity(companyId, agent.id);
      if (restart) expect(publicIdentity!.publicKeyPem).toBe(publicPem);
      publicPem = publicIdentity!.publicKeyPem;
      vi.stubEnv("PAPERCLIP_AGENT_PRIVATE_KEY", "inherited override");
      const logs: string[] = [];
      const metas: unknown[] = [];
      await execute({
        runId: randomUUID(), agent, agentIdentity: identity,
        config: { command: process.execPath, cwd: directory, args: ["-e", `const {sign}=require('node:crypto'); process.stdout.write(sign(null,Buffer.from(process.env.CHALLENGE,'base64'),process.env.PAPERCLIP_AGENT_PRIVATE_KEY).toString('base64'));`], env: { CHALLENGE: challenge, PAPERCLIP_AGENT_PRIVATE_KEY: "configured override" } },
        context: {}, runtime: { sessionId: null, sessionParams: null, taskKey: null },
        onLog: async (_stream, chunk) => { logs.push(chunk); }, onMeta: async meta => { metas.push(meta); },
      });
      expect(verify(null, Buffer.from(challenge, "base64"), publicPem, Buffer.from(logs.join(""), "base64"))).toBe(true);
      expect(JSON.stringify(metas)).not.toContain(identity.privateKeyPem.split("\n")[1]);
    }
  });

  it("lazily provisions through managed run preparation, exposes only the public API key, and redacts emitted keys", async () => {
    const agent = await oldAgent();
    const app = express();
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    const firstRead = await request(app).get(`/api/agents/${agent.id}/identity`);
    expect(firstRead.status).toBe(200);
    expect(firstRead.body).toBeNull();
    const challenge = randomBytes(32).toString("base64");
    await db.update(agents).set({ adapterType: "process", adapterConfig: {
      command: process.execPath, cwd: directory,
      args: ["-e", `const {sign}=require('node:crypto'); const k=process.env.PAPERCLIP_AGENT_PRIVATE_KEY; console.log('SIGNATURE:'+sign(null,Buffer.from(process.env.CHALLENGE,'base64'),k).toString('base64')); process.stdout.write(k.slice(0,40)); setTimeout(()=>process.stdout.write(k.slice(40)),30);`],
      env: { CHALLENGE: challenge, PAPERCLIP_AGENT_PRIVATE_KEY: "ignored override" },
    } }).where(eq(agents.id, agent.id));
    let previousKeyId = "";
    for (let restart = 0; restart < 2; restart++) {
      const heartbeat = heartbeatService(createDb(database.connectionString));
      try {
        const run = await heartbeat.invoke(agent.id, "on_demand", {}, "manual");
        expect(run).toBeTruthy();
        await drainHeartbeatRunsToQuiescence(db, heartbeat);
        const finished = await heartbeat.getRun(run!.id);
        expect(finished?.status, JSON.stringify(finished)).toBe("succeeded");
        const publicResponse = await request(app).get(`/api/agents/${agent.id}/identity`);
        expect(publicResponse.status).toBe(200);
        expect(Object.keys(publicResponse.body).sort()).toEqual(["algorithm", "createdAt", "keyId", "publicKeyPem"]);
        if (restart) expect(publicResponse.body.keyId).toBe(previousKeyId);
        previousKeyId = publicResponse.body.keyId;
        const signature = /SIGNATURE:([A-Za-z0-9+/=]+)/.exec(finished!.stdoutExcerpt ?? "")?.[1];
        expect(signature).toBeTruthy();
        expect(verify(null, Buffer.from(challenge, "base64"), publicResponse.body.publicKeyPem, Buffer.from(signature!, "base64"))).toBe(true);
        const privateBody = (await agentIdentityService(db).ensureAgentIdentity(companyId, agent.id)).privateKeyPem.split("\n")[1];
        expect(JSON.stringify(finished)).not.toContain(privateBody);
        expect(JSON.stringify(await heartbeat.readLog(run!.id))).not.toContain(privateBody);
      } finally {
        await drainHeartbeatRunsToQuiescence(db, heartbeat);
      }
    }
  }, 60_000);

  it("disaster recovery retains identity; both development seed modes omit it and mint fresh keys", async () => {
    const agent = await oldAgent();
    const original = await agentIdentityService(db).ensureAgentIdentity(companyId, agent.id);
    for (const mode of ["backup", "minimal", "full"] as const) {
      const seed = mode === "backup" ? undefined : resolveWorktreeSeedPlan(mode);
      const backup = await runDatabaseBackup({
        connectionString: database.connectionString, backupDir: join(directory, mode),
        backupEngine: "javascript", retention: { dailyDays: 1, weeklyWeeks: 0, monthlyMonths: 0 },
        excludeTables: seed?.excludedTables, nullifyColumns: seed?.nullifyColumns,
      });
      const target = new URL(database.connectionString);
      const admin = new URL(database.connectionString);
      admin.pathname = "/postgres";
      await ensurePostgresDatabase(admin.toString(), `identity_${mode}`);
      target.pathname = `/identity_${mode}`;
      await runDatabaseRestore({ connectionString: target.toString(), backupFile: backup.backupFile });
      const restored = agentIdentityService(createDb(target.toString()));
      if (mode === "backup") expect(await restored.ensureAgentIdentity(companyId, agent.id)).toEqual(original);
      else {
        expect(await restored.getPublicIdentity(companyId, agent.id)).toBeNull();
        expect((await restored.ensureAgentIdentity(companyId, agent.id)).keyId).not.toBe(original.keyId);
      }
      await closeRegisteredClients(target.toString());
    }
  }, 60_000);
});

describe("identity output redaction", () => {
  const pem = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  it("redacts PEM, JSON-escaped PEM and raw private material", () => {
    const redactor = createAgentIdentityRedactor(pem);
    for (const text of [pem, JSON.stringify(pem), pem.split("\n")[1]]) {
      expect(redactor.redact({ output: text }).output).not.toContain(pem.split("\n")[1]);
    }
  });
  it("settles ordinary endings and interrupted keys on item and turn completion", () => {
    const redactor = createAgentIdentityRedactor(pem);
    expect(redactor.delta("run:turn:item", { kind: "reasoning", text: "Thinking-" }, "item").text).toBe("Thinking");
    const completed = redactor.settleDeltas("run:turn:item", {}, false);
    expect(completed).toMatchObject({ outputTails: [{ itemId: "item", payload: { kind: "reasoning", text: "-" } }] });
    expect(redactor.settleDeltas("run:turn:", {}, true)).toEqual({});
    redactor.delta("run:turn:other", { text: pem.slice(0, 42) }, "other");
    expect(redactor.settleDeltas("run:turn:", {}, true)).toMatchObject({ outputTails: [{ payload: { text: "***REDACTED***" } }] });
    expect(redactor.delta("run:turn:other", { text: "hello" }).text).toBe("hello");
  });

  it("redacts every split boundary and interleaved streams, including interrupted prefixes", () => {
    for (let split = 1; split < pem.length; split++) {
      const redactor = createAgentIdentityRedactor(pem);
      let output = redactor.chunk("stdout", pem.slice(0, split));
      expect(redactor.chunk("stderr", "ordinary output\n")).toBe("ordinary output\n");
      output += redactor.chunk("stdout", pem.slice(split));
      output += redactor.finish("stdout");
      expect(output).not.toContain(pem.split("\n")[1]);
    }
    const redactor = createAgentIdentityRedactor(pem);
    expect(redactor.chunk("stdout", pem.slice(0, 42))).toBe("");
    expect(redactor.finish("stdout")).toBe("***REDACTED***");
  });
});
