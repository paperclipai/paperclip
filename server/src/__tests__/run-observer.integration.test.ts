import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerRunObserverScheduler, startRunObserverDelivery } from "../services/run-observer-delivery.js";
import { createWorkScheduler } from "../services/work-scheduler.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { heartbeatRuns, instanceUserRoles, issueComments, runIdentityContexts } from "@paperclipai/db";
import { reserveSteeredIdentity } from "../services/run-identity.js";
import { agentService } from "../services/agents.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";

describe("run observer capability", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  const scheduler = createWorkScheduler();
  const deadlines = { scheduleActiveDeadline: scheduler.schedule, cancelActiveDeadline: scheduler.cancel };
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID());
    vi.stubEnv("PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE", "shadow");
    vi.stubEnv("PAPERCLIP_AUTH_RATE_LIMIT_ENABLED", "false");
    server = await startRunnerApiTestServer({ humanSessions: true, databaseUrl: process.env.PAPERCLIP_OBSERVER_TEST_DATABASE_URL });
  }, 90_000);
  afterAll(async () => { scheduler.stop(); await server?.close(); vi.unstubAllEnvs(); });
  it("fails closed when the shared scheduler is unavailable", async () => {
    const db = {} as typeof server.db;
    const run = { id: randomUUID(), companyId: randomUUID(), agentId: randomUUID() };
    await expect(startRunObserverDelivery(db, run, { socketPath: "/tmp/unused", companyId: run.companyId,
      agentId: run.agentId })).rejects.toThrow("scheduler is unavailable");
  });

  it("automatically delivers and renews only a scoped token over a private local socket", async () => {
    const f = await server.fixture({ connectionScenario: "fresh" });
    const directory = await mkdtemp(path.join(await realpath(tmpdir()), "observer-sink-"));
    await chmod(directory, 0o700);
    const socketPath = path.join(directory, "sink.sock");
    const received: Array<{ runId: string; token: string }> = [];
    const sink = createServer(socket => {
      let data = "";
      socket.on("data", chunk => {
        data += chunk.toString();
        if (data.includes("\n")) { received.push(JSON.parse(data)); socket.end("ok\n"); }
      });
    });
    await new Promise<void>((resolve, reject) => sink.once("error", reject).listen(socketPath, resolve));
    await chmod(socketPath, 0o600);
    const run = { id: f.runId, companyId: f.companyId, agentId: f.agentId };
    const config = { socketPath, companyId: f.companyId, agentId: f.agentId };
    let delivery: Awaited<ReturnType<typeof startRunObserverDelivery>> = null;
    try {
      expect(await startRunObserverDelivery(server.db, run, { ...config, agentId: randomUUID() })).toBeNull();
      await chmod(directory, 0o755);
      await expect(startRunObserverDelivery(server.db, run, config)).rejects.toThrow("private socket");
      await chmod(directory, 0o700);
      delivery = await startRunObserverDelivery(server.db, run, config, { refreshMs: 100 });
      expect(received[0]?.runId).toBe(f.runId);
      const headers = { authorization: `Bearer ${received[0]!.token}` };
      expect((await fetch(`${server.apiUrl}/api/heartbeat-runs/${f.runId}/observer-status`, { headers })).status).toBe(200);
      expect((await fetch(`${server.apiUrl}/api/agents/me`, { headers })).status).toBe(403);
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(received.length).toBeGreaterThan(1);
      await server.db.update(heartbeatRuns).set({ resultJson: { executionCancellation: { state: "requested" } } }).where(eq(heartbeatRuns.id, f.runId));
      await new Promise(resolve => setTimeout(resolve, 200));
      const count = received.length;
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(received).toHaveLength(count);
      expect((await fetch(`${server.apiUrl}/api/heartbeat-runs/${f.runId}/observer-status`, { headers })).status).toBe(403);
      await expect(startRunObserverDelivery(server.db, run, config)).rejects.toThrow("not active");
    } finally {
      await delivery?.close();
      await new Promise<void>(resolve => sink.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("closes without waiting for a stalled renewal and never sends its late result", async () => {
    const directory = await mkdtemp(path.join(await realpath(tmpdir()), "observer-stalled-"));
    await chmod(directory, 0o700);
    const socketPath = path.join(directory, "sink.sock");
    let messages = 0, queries = 0, reached!: () => void, release!: (rows: unknown[]) => void;
    const waiting = new Promise<void>(resolve => { reached = resolve; });
    const stalled = new Promise<unknown[]>(resolve => { release = resolve; });
    const sink = createServer(socket => { socket.once("data", () => { messages++; socket.end("ok\n"); }); });
    await new Promise<void>((resolve, reject) => sink.once("error", reject).listen(socketPath, resolve));
    await chmod(socketPath, 0o600);
    const fakeDb = { select: () => ({ from: () => ({ where: () => {
      if (++queries === 1) return Promise.resolve([{ status: "running", resultJson: null }]);
      reached(); return stalled;
    } }) }) } as unknown as typeof server.db;
    const run = { id: randomUUID(), companyId: randomUUID(), agentId: randomUUID() };
    const unregister = registerRunObserverScheduler(fakeDb, deadlines);
    const delivery = await startRunObserverDelivery(fakeDb, run,
      { socketPath, companyId: run.companyId, agentId: run.agentId }, { refreshMs: 100 });
    try {
      await waiting;
      const start = Date.now();
      unregister();
      expect(Date.now() - start).toBeLessThan(500);
      release([{ status: "running", resultJson: null }]);
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(messages).toBe(1);
    } finally {
      unregister(); delivery?.close(); release([]);
      await new Promise<void>(resolve => sink.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("stops scheduling checks after the run is no longer active", async () => {
    const directory = await mkdtemp(path.join(await realpath(tmpdir()), "observer-finished-"));
    await chmod(directory, 0o700);
    const socketPath = path.join(directory, "sink.sock");
    let queries = 0;
    const sink = createServer(socket => { socket.once("data", () => socket.end("ok\n")); });
    await new Promise<void>((resolve, reject) => sink.once("error", reject).listen(socketPath, resolve));
    await chmod(socketPath, 0o600);
    const fakeDb = { select: () => ({ from: () => ({ where: async () =>
      [{ status: ++queries === 1 ? "running" : "cancelled", resultJson: null }] }) }) } as unknown as typeof server.db;
    const run = { id: randomUUID(), companyId: randomUUID(), agentId: randomUUID() };
    registerRunObserverScheduler(fakeDb, deadlines);
    const delivery = await startRunObserverDelivery(fakeDb, run,
      { socketPath, companyId: run.companyId, agentId: run.agentId }, { refreshMs: 100 });
    try {
      await new Promise(resolve => setTimeout(resolve, 350));
      expect(queries).toBe(2);
      await new Promise(resolve => setTimeout(resolve, 250));
      expect(queries).toBe(2);
    } finally {
      delivery?.close();
      await new Promise<void>(resolve => sink.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("renews the same run capability after the sink restarts without replaying work", async () => {
    const f = await server.fixture({ connectionScenario: "fresh" });
    const directory = await mkdtemp(path.join(await realpath(tmpdir()), "observer-restart-"));
    await chmod(directory, 0o700);
    const socketPath = path.join(directory, "sink.sock");
    const received: Array<{ runId: string; token: string }> = [];
    async function listen() {
      const sink = createServer(socket => { let data = ""; socket.on("data", chunk => {
        data += chunk.toString(); if (data.includes("\n")) { received.push(JSON.parse(data)); socket.end("ok\n"); }
      }); });
      await new Promise<void>((resolve, reject) => sink.once("error", reject).listen(socketPath, resolve));
      await chmod(socketPath, 0o600);
      return sink;
    }
    let sink = await listen();
    let delivery: Awaited<ReturnType<typeof startRunObserverDelivery>> = null;
    try {
      delivery = await startRunObserverDelivery(server.db, { id: f.runId, companyId: f.companyId, agentId: f.agentId },
        { socketPath, companyId: f.companyId, agentId: f.agentId }, { refreshMs: 100 });
      expect(received).toHaveLength(1);
      await new Promise<void>(resolve => sink.close(() => resolve()));
      await new Promise(resolve => setTimeout(resolve, 200));
      sink = await listen();
      const until = Date.now() + 3000;
      while (received.length < 2 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
      expect(received.length).toBeGreaterThan(1);
      expect(received.every(message => message.runId === f.runId)).toBe(true);
      const headers = { authorization: `Bearer ${received.at(-1)!.token}` };
      expect((await fetch(`${server.apiUrl}/api/heartbeat-runs/${f.runId}/observer-status`, { headers })).status).toBe(200);
    } finally {
      await delivery?.close();
      await new Promise<void>(resolve => sink.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("stops a separate fictional process after observer renewal is lost", async () => {
    const f = await server.fixture({ connectionScenario: "fresh" });
    const directory = await mkdtemp(path.join(await realpath(tmpdir()), "observer-process-"));
    await chmod(directory, 0o700);
    const socketPath = path.join(directory, "sink.sock");
    const script = fileURLToPath(new URL("./fixtures/observer-sink-process.mjs", import.meta.url));
    const sink = spawn(process.execPath, [script, socketPath, server.apiUrl], { stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "" } });
    let output = "";
    sink.stdout.on("data", data => { output += data.toString(); });
    const waitFor = async (message: string) => {
      const until = Date.now() + 7000;
      while (!output.includes(message) && Date.now() < until) {
        if (sink.exitCode !== null) throw new Error("Fictional sink exited early");
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      if (!output.includes(message)) throw new Error(`Fictional sink did not report ${message}`);
    };
    let delivery: Awaited<ReturnType<typeof startRunObserverDelivery>> = null;
    vi.stubEnv("PAPERCLIP_AGENT_JWT_TTL_SECONDS", "1");
    try {
      await waitFor("READY");
      delivery = await startRunObserverDelivery(server.db, { id: f.runId, companyId: f.companyId, agentId: f.agentId },
        { socketPath, companyId: f.companyId, agentId: f.agentId }, { refreshMs: 150 });
      await waitFor("WORKER_STARTED");
      await new Promise(resolve => setTimeout(resolve, 1300));
      expect(output).not.toContain("WORKER_STOPPED");
      await delivery!.close();
      await waitFor("WORKER_STOPPED");
      expect((await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].status).toBe("running");
    } finally {
      await delivery?.close();
      if (sink.exitCode === null && sink.signalCode === null) {
        await new Promise<void>(resolve => { sink.once("exit", () => resolve()); sink.kill("SIGTERM"); });
      }
      await rm(directory, { recursive: true, force: true });
      vi.stubEnv("PAPERCLIP_AGENT_JWT_TTL_SECONDS", "172800");
    }
  }, 15_000);

  it("allows only its own active status and is revoked on stop", async () => {
    const f = await server.fixture({ connectionScenario: "fresh" });
    const other = await server.fixture({ connectionScenario: "fresh" });
    await server.db.insert(instanceUserRoles).values({ userId: f.responsibleUserId!, role: "instance_admin" });
    const cookie = await server.humanSession(f.responsibleUserId!);
    const issue = await fetch(`${server.apiUrl}/api/heartbeat-runs/${f.runId}/observer-token`, { method: "POST", headers: { cookie, origin: server.apiUrl } });
    expect(issue.status).toBe(201);
    expect(issue.headers.get("cache-control")).toBe("no-store");
    const { token } = await issue.json();
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(120);
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const status = () => fetch(`${server.apiUrl}/api/heartbeat-runs/${f.runId}/observer-status`, { headers });
    expect(await (await status()).json()).toEqual({ active: true });
    expect((await fetch(`${server.apiUrl}/api/heartbeat-runs/${f.runId}`, { headers })).status).toBe(403);
    expect((await fetch(`${server.apiUrl}/api/heartbeat-runs/${other.runId}/observer-status`, { headers })).status).toBe(403);
    expect((await fetch(`${server.apiUrl}/api/companies/${f.companyId}/approvals`, { method: "POST", headers, body: "{}" })).status).toBe(403);
    expect((await fetch(`${server.apiUrl}/api/heartbeat-runs/${f.runId}/observer-status`, { method: "HEAD", headers })).status).toBe(403);
    const agentToken = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId);
    expect((await fetch(`${server.apiUrl}/api/heartbeat-runs/${f.runId}/observer-token`, { method: "POST", headers: { authorization: `Bearer ${agentToken}` } })).status).toBe(403);
    const messageId = randomUUID();
    await server.db.insert(issueComments).values({ id: messageId, companyId: f.companyId, issueId: f.issueId,
      authorUserId: f.responsibleUserId!, body: "Fictional pending steering" });
    const pending = await reserveSteeredIdentity(server.db, { companyId: f.companyId, agentId: f.agentId,
      runId: f.runId, issueId: f.issueId, messageId });
    expect(pending).toBeTruthy();
    expect((await status()).status).toBe(200);
    const [steering] = await server.db.select().from(runIdentityContexts).where(eq(runIdentityContexts.id, pending!.id));
    expect(steering.status).toBe("pending");
    vi.stubEnv("PAPERCLIP_AGENT_JWT_TTL_SECONDS", "1");
    const shortToken = createLocalAgentJwt(f.agentId, f.companyId, "run_observer", f.runId, null, { kind: "run_status_observer" });
    vi.stubEnv("PAPERCLIP_AGENT_JWT_TTL_SECONDS", "172800");
    await new Promise(resolve => setTimeout(resolve, 2100));
    expect((await fetch(`${server.apiUrl}/api/heartbeat-runs/${f.runId}/observer-status`, { headers: { authorization: `Bearer ${shortToken}` } })).status).toBe(401);
    const rejectedCreation = await fetch(`${server.apiUrl}/api/agents/${f.agentId}/keys`, { method: "POST",
      headers: { cookie, origin: server.apiUrl, "content-type": "application/json" },
      body: JSON.stringify({ name: "fictitious", scope: { kind: "run_status_observer" } }) });
    expect(rejectedCreation.status).toBe(400);
    // Existing malformed persistent keys must also be denied on ordinary routes.
    const persistent = await agentService(server.db).createApiKey(f.agentId, "fictitious", { kind: "run_status_observer" }, { responsibleUserId: f.responsibleUserId });
    const forbidden = await fetch(`${server.apiUrl}/api/agents/me`, { headers: { authorization: `Bearer ${persistent.token}` } });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ error: "Run observer capabilities require a run-scoped token" });
    await server.db.update(heartbeatRuns).set({ resultJson: { executionCancellation: { state: "requested" } } }).where(eq(heartbeatRuns.id, f.runId));
    expect((await status()).status).toBe(403);
    await server.db.update(heartbeatRuns).set({ status: "cancelled", resultJson: null }).where(eq(heartbeatRuns.id, f.runId));
    expect((await status()).status).toBe(403);
  });
});
