import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import express, { type Request } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, dotAgentBindings, dotMailboxItems, dotRunnerAssignments, dotRunnerOperations,
  heartbeatRuns, agentWakeupRequests, issueComments, issues, nativeRunResults, nativeRunFinalizations, completionContracts, mcpEventDeliveries, workspaceOperations, workAssessments, statusDecisions, issueThreadInteractions } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createPublicMcpOAuth, DEVICE_GRANT } from "../services/public-mcp/oauth.js";
import { createPublicMcpExecutor } from "../services/public-mcp/capabilities.js";
import { publicMcpIngressRoutes, publicMcpManagementRoutes } from "../routes/public-mcp.js";
import { createPublicMcpEvents, type EventFetch } from "../services/public-mcp/events.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { canonicalNativeRuntimeContextDigest, type StrictCompletionContractInput } from "../vendor/paperclip-runner/index.js";
import { createDotRunnerMcpTools, dotRunnerBroker } from "../services/dot-runner-broker.js";
import { prepareNativeHeartbeatRun } from "../services/native-runtime/prepare-native-run.js";
import { buildNativeExecutionInput } from "../services/native-runtime/native-execution-input.js";
import { nativeRuntimeContextFixture } from "../services/native-runtime/runtime-context.test-fixture.js";
import { executePaperclipNativeSession } from "../services/native-runtime/native-session-executor.js";
import { registerAssignedMcpGateway } from "../services/native-runtime/assigned-mcp-tools.js";
import type { ToolGatewayService } from "../services/tool-gateway.js";
import { documentService } from "../services/documents.js";
import { setupRunnerPrpWebSocketServer } from "../realtime/runner-prp-ws.js";
import { finalizeNativeRun } from "../services/native-runtime/native-run-finalizer.js";
import { resolveHeartbeatNativeRuntimeMode, resolveNativeRuntimeMode } from "../services/native-runtime/runtime-mode.js";
import { heartbeatService } from "../services/heartbeat.js";

describe("durable Dot Runner integration", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  beforeAll(async () => {
    const runnerRoot = fileURLToPath(new URL("../../../packages/paperclip-runner/", import.meta.url));
    execFileSync("cargo", ["build", "--release", "--locked", "--manifest-path", join(runnerRoot, "runner/Cargo.toml"), "-p", "paperclip-runner-core", "--bin", "paperclip-runnerd"], { cwd: runnerRoot, stdio: "pipe", timeout: 300000 });
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-dot-runner-");
    db = createDb(temporary.connectionString);
    root = await mkdtemp(join(tmpdir(), "paperclip-dot-state-"));
    vi.stubEnv("PAPERCLIP_IN_WORKTREE", "false");
    vi.stubEnv("PAPERCLIP_RUNNER_BINARY", join(runnerRoot, "runner/target/release", process.platform === "win32" ? "paperclip-runnerd.exe" : "paperclip-runnerd"));
    vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", join(root, "runner-state"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", randomBytes(32).toString("base64"));
    await instanceSettingsService(db).updateExperimental({ enablePublicMcp: true, enableOpenAiDot: true, enableNativeRunner: false });
  }, 360000);
  afterAll(async () => { await temporary?.cleanup(); await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });

  it("requires each persisted prerequisite for pairing and new work without relying on the retired environment flag", async () => {
    const settings = instanceSettingsService(db);
    const broker = dotRunnerBroker(db);
    for (const key of ["enableOpenAiDot", "enablePublicMcp"] as const) {
      await settings.updateExperimental({ [key]: false });
      try {
        vi.stubEnv("PAPERCLIP_ENABLE_OPENAI_DOT", "1");
        expect(await broker.enabled()).toBe(false);
        await expect(broker.createPairing({ companyId: randomUUID(), agentId: randomUUID(), operatorId: randomUUID() })).rejects.toThrow("experimental settings");
      } finally { await settings.updateExperimental({ [key]: true }); }
    }
    vi.stubEnv("PAPERCLIP_ENABLE_OPENAI_DOT", "0");
    expect(await broker.enabled()).toBe(true);
  });

  it("gates fresh Dot runtime selection while preserving the existing run recovery path", () => {
    const input = {
      enabled: true,
      runtimeConfig: {},
      adapterConfig: { provider: "openai_dot", dotBindingId: randomUUID(), allowUnmeteredProvider: true },
      agent: { status: "active", adapterType: "paperclip_runner" },
      issue: { id: randomUUID(), workMode: "standard" },
      target: { kind: "local" },
      workspaceId: null,
    };
    expect(() => resolveNativeRuntimeMode(input)).toThrow("experimental settings");
    expect(resolveNativeRuntimeMode({ ...input, enabled: false, dotEnabled: true })).toMatchObject({ kind: "native", profile: { backend: "openai_dot_mcp" } });
    expect(resolveNativeRuntimeMode({ ...input, enabled: false, dotEnabled: true,
      adapterConfig: { provider: "codex" },
    })).toMatchObject({ kind: "native", profile: { backend: "codex_app_server" } });
    expect(resolveHeartbeatNativeRuntimeMode({ ...input, enabled: false, dotEnabled: false,
      persisted: { runtimeMode: "native", runtimeModeReason: null, runtimeModeResolvedAt: new Date(), driverKind: "openai_dot_mcp" },
    })).toMatchObject({ kind: "native", profile: { backend: "openai_dot_mcp" } });
  });

  async function fixture() {
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Dot operator", email: userId + "@example.test", createdAt: new Date(), updatedAt: new Date() });
    const [company] = await db.insert(companies).values({ name: "Dot test", issuePrefix: "DT" + randomBytes(3).toString("hex") }).returning();
    await db.insert(companyMemberships).values({ companyId: company!.id, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "Dot", adapterType: "paperclip_runner", status: "active", adapterConfig: { provider: "openai_dot", allowUnmeteredProvider: true } }).returning();
    const config = { origin: "https://paperclip.example", resource: "https://paperclip.example/mcp/runner" };
    const oauth = createPublicMcpOAuth(db, config);
    const client = await oauth.register({ client_name: "Dedicated Dot", redirect_uris: ["https://chatgpt.com/connector_platform/oauth/callback"] }, randomUUID());
    const verifier = randomBytes(32).toString("base64url");
    const input = { client_id: client.client_id, redirect_uri: "https://chatgpt.com/connector_platform/oauth/callback", response_type: "code", resource: config.resource,
      scope: "paperclip:agent offline_access", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" };
    const requestId = (await oauth.authorize(input)).split("/").at(-1)!;
    const consent = await oauth.consent(requestId, { type: "board", source: "session", userId }, { decision: "approve", companyId: company!.id, allowWrites: false });
    const tokens = await oauth.token({ grant_type: "authorization_code", client_id: client.client_id, redirect_uri: input.redirect_uri,
      resource: config.resource, code: new URL(consent.redirectUrl).searchParams.get("code"), code_verifier: verifier });
    const unpaired = await oauth.authenticate(tokens.access_token);
    expect(unpaired.actor.type).toBe("none");
    const broker = dotRunnerBroker(db);
    const pairing = await broker.createPairing({ companyId: company!.id, agentId: agent!.id, operatorId: userId });
    await broker.pair(unpaired, pairing.pairingCode);
    expect((await db.select().from(agents).where(eq(agents.id, agent!.id)))[0]!.adapterConfig.dotBindingId).toBe(pairing.bindingId);
    await expect(broker.pair(unpaired, pairing.pairingCode)).rejects.toThrow();
    const principal = await oauth.authenticate(tokens.access_token);
    expect(principal.actor).toMatchObject({ type: "agent", agentId: agent!.id, companyId: company!.id });
    const personal = createPublicMcpOAuth(db, { ...config, resource: config.origin + "/mcp/paperclip" });
    await expect(personal.authenticate(tokens.access_token)).rejects.toThrow();
    const secret = "whsec_" + randomBytes(32).toString("base64");
    const received: Array<Record<string, any>> = [];
    let verifications = 0;
    const fetcher: EventFetch = async (_url, init) => {
      const headers = new Headers(init.headers); const bytes = String(init.body); const body = JSON.parse(bytes);
      const signature = "v1," + createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
        .update(`${headers.get("webhook-id")}.${headers.get("webhook-timestamp")}.${bytes}`).digest("base64");
      expect(headers.get("webhook-signature")).toContain(signature);
      if (body.type === "verification") { verifications++; return Response.json({ challenge: body.challenge }); }
      received.push(body); return new Response(null, { status: 204 });
    };
    const events = createPublicMcpEvents(db, oauth, async () => { throw new Error("personal API dispatch forbidden"); }, { enableDotRunner: true, fetch: fetcher });
    const subscription = { name: "paperclip.dot.mailbox_updated", arguments: { companyId: company!.id, bindingId: pairing.bindingId }, delivery: { mode: "webhook", url: "https://example.com/dot-hook", secret } };
    await events.subscribe(principal, subscription);
    await broker.challenge(company!.id, agent!.id); await events.tick();
    if (!received.length) throw new Error("Dot readiness delivery missing: " + JSON.stringify(await db.select({ outcome: mcpEventDeliveries.outcome, event: mcpEventDeliveries.event }).from(mcpEventDeliveries)));
    expect(received.at(-1)?.data.kind).toBe("readiness_challenge");
    expect(received.at(-1)?.data).not.toHaveProperty("challenge");
    const challenge = (await broker.mailbox(principal)).items.find(i => i.kind === "readiness_challenge")!;
    await broker.confirmChallenge(principal, String(challenge.references.challenge));
    const snapshot = await broker.snapshot(company!.id, agent!.id, pairing.bindingId);
    await db.update(agents).set({ adapterConfig: { provider: "openai_dot", dotBindingId: pairing.bindingId, allowUnmeteredProvider: true, lifecycleMode: "per_turn" } }).where(eq(agents.id, agent!.id));
    return { company: company!, agent: agent!, userId, broker, principal, oauth, events, subscription, received, snapshot, tokens, client, verifications: () => verifications };
  }

  async function offeredWork(f: Awaited<ReturnType<typeof fixture>>) {
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id,
      status: "queued", invocationSource: "assignment", triggerDetail: "system" }).returning();
    const [assignment] = await db.insert(dotRunnerAssignments).values({ companyId: f.company.id, bindingId: f.snapshot.bindingId,
      bindingGeneration: f.snapshot.bindingGeneration, runId: run!.id, agentId: f.agent.id, normalizedSessionId: randomUUID(),
      turnId: randomUUID(), controllerGeneration: 1, catalogDigest: "test", status: "offered", projection: {},
      acceptBy: new Date(Date.now() + 10 * 60_000), expiresAt: new Date(Date.now() + 2 * 60 * 60_000) }).returning();
    await db.insert(dotMailboxItems).values({ companyId: f.company.id, bindingId: f.snapshot.bindingId,
      bindingGeneration: f.snapshot.bindingGeneration, assignmentId: assignment!.id, kind: "assignment", sourceEventId: randomUUID(),
      references: { assignmentId: assignment!.id, runId: run!.id, revision: 1 } });
    return { run: run!, assignment: assignment! };
  }

  function gateway(oauth: ReturnType<typeof createPublicMcpOAuth>, actor: Request["actor"]) {
    const personal = createPublicMcpOAuth(db, { ...oauth.config, resource: oauth.config.origin + "/mcp/paperclip" });
    const dispatch = async () => { throw new Error("Personal API dispatch forbidden"); };
    const app = express();
    app.use(express.json());
    app.use(publicMcpIngressRoutes(personal, createPublicMcpExecutor(db, personal, dispatch)));
    app.use(publicMcpIngressRoutes(oauth, createPublicMcpExecutor(db, oauth, dispatch)));
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", publicMcpManagementRoutes(personal, oauth));
    return { app, personal };
  }

  it("reapplies the Dot-only migration after the merged gateway schema", async () => {
    const migration = await readFile(new URL("../../../packages/db/src/migrations/0317_messy_famine.sql", import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await db.execute(sql.raw(statement));
    }
  });

  it("admits one durable idle intake without requiring a preassigned task", async () => {
    const f = await fixture();
    await db.update(companies).set({ defaultResponsibleUserId: f.userId }).where(eq(companies.id, f.company.id));
    const holding = await offeredWork(f);
    await db.update(heartbeatRuns).set({ status: "running", startedAt: new Date() }).where(eq(heartbeatRuns.id, holding.run.id));
    const requestId = randomUUID();
    try {
      const requests = await Promise.all([1, 2, 3].map(() => f.broker.requestTurn(f.principal, "Create hello and assign it to my owner", requestId)));
      expect(requests[1]).toEqual(requests[0]); expect(requests[2]).toEqual(requests[0]);
      const intake = await db.select().from(issues).where(eq(issues.id, requests[0]!.issueId));
      expect(intake).toHaveLength(1);
      expect(intake[0]).toMatchObject({ assigneeAgentId: f.agent.id, createdByAgentId: f.agent.id, responsibleUserId: f.userId });
      expect(await f.broker.capabilities(f.principal)).toMatchObject({ agentId: f.agent.id, responsibleUser: { id: f.userId }, idle: { start: "paperclip_dot_request_turn" } });
      await expect(f.broker.requestTurn(f.principal, "Different request", requestId)).rejects.toThrow("reused");
      await db.update(companies).set({ budgetMonthlyCents: 1, spentMonthlyCents: 1 }).where(eq(companies.id, f.company.id));
      await expect(f.broker.requestTurn(f.principal, "Spend more", randomUUID())).rejects.toThrow("budget");
      await db.update(companies).set({ budgetMonthlyCents: 0, spentMonthlyCents: 0 }).where(eq(companies.id, f.company.id));
      await f.broker.revoke(f.company.id, f.agent.id, f.userId);
      expect((await db.select().from(agents).where(eq(agents.id, f.agent.id)))[0]!.adapterConfig).not.toHaveProperty("dotBindingId");
      await expect(f.broker.requestTurn(f.principal, "After revoke", randomUUID())).rejects.toThrow();
    } finally { await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, holding.run.id)); }
  });

  it("keeps competing Dot assignments queued and replays durable work requests", async () => {
    const f = await fixture();
    await db.update(companies).set({ defaultResponsibleUserId: f.userId }).where(eq(companies.id, f.company.id));
    await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 20, wakeOnDemand: true } } }).where(eq(agents.id, f.agent.id));
    const holding = await offeredWork(f);
    await db.update(heartbeatRuns).set({ status: "running", startedAt: new Date() }).where(eq(heartbeatRuns.id, holding.run.id));
    const task = async (title: string) => (await db.insert(issues).values({ companyId: f.company.id, title, status: "todo", assigneeAgentId: f.agent.id, responsibleUserId: f.userId }).returning())[0]!;
    const first = await task("First queued task");
    const second = await task("Second queued task");
    try {
      const id = randomUUID();
      const responses = await Promise.all(Array.from({ length: 3 }, () => f.broker.requestWork(f.principal, first.id, id)));
      expect(responses[0]?.runId).toBeTruthy();
      expect(responses).toEqual([responses[0], responses[0], responses[0]]);
      const wakes = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, f.agent.id), eq(agentWakeupRequests.idempotencyKey, `dot-work:${f.snapshot.bindingId}:${f.snapshot.bindingGeneration}:${id}`)));
      expect(wakes).toHaveLength(1);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, responses[0]!.runId!)))[0]?.status).toBe("queued");
      await heartbeatService(db).resumeQueuedRuns();
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, responses[0]!.runId!)))[0]?.status).toBe("queued");
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, responses[0]!.runId!));
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, first.id));
      expect(await f.broker.requestWork(f.principal, first.id, id)).toEqual(responses[0]);
      await expect(f.broker.requestWork(f.principal, second.id, id)).rejects.toThrow("another task");
      const third = await task("Third queued task");
      const raceId = randomUUID();
      const race = await Promise.allSettled([f.broker.requestWork(f.principal, second.id, raceId), f.broker.requestWork(f.principal, third.id, raceId)]);
      expect(race.filter(r => r.status === "fulfilled")).toHaveLength(1);
      expect(race.filter(r => r.status === "rejected")).toHaveLength(1);
      const raceWakes = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, f.agent.id), eq(agentWakeupRequests.idempotencyKey, `dot-work:${f.snapshot.bindingId}:${f.snapshot.bindingGeneration}:${raceId}`)));
      expect(raceWakes).toHaveLength(1);
      const allRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agent.id));
      expect(allRuns).toHaveLength(3); // Holding turn plus one admitted run per unique request.
      expect(allRuns.filter(r => r.status === "queued")).toHaveLength(1);
    } finally {
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.agentId, f.agent.id));
      await f.events.unsubscribe(f.principal, f.subscription); await f.events.stop();
    }
  }, 30000);

  it("delivers deduplicated follow-up references only for the accepted current assignment", async () => {
    const f = await fixture(), { run, assignment } = await offeredWork(f);
    const [task] = await db.insert(issues).values({ companyId: f.company.id, title: "Follow-up fixture", assigneeAgentId: f.agent.id }).returning();
    await db.update(heartbeatRuns).set({ nativeIssueId: task!.id, status: "running" }).where(eq(heartbeatRuns.id, run.id));
    await db.update(dotRunnerAssignments).set({ status: "accepted" }).where(eq(dotRunnerAssignments.id, assignment.id));
    const [incoming] = await db.insert(issueComments).values({ companyId: f.company.id, issueId: task!.id, authorUserId: f.userId, body: "Synthetic comment body must not be in webhook data" }).returning();
    await db.insert(issueComments).values({ companyId: f.company.id, issueId: task!.id, authorAgentId: f.agent.id, body: "Dot's own output" });
    try {
      await f.events.tick(); await f.events.tick();
      const rows = await db.select().from(dotMailboxItems).where(and(eq(dotMailboxItems.assignmentId, assignment.id), eq(dotMailboxItems.kind, "follow_up")));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.references).toEqual({ assignmentId: assignment.id, commentId: incoming!.id });
      const delivered = f.received.filter(event => event.data?.kind === "follow_up");
      expect(delivered).toHaveLength(1);
      expect(JSON.stringify(delivered)).not.toContain("Synthetic comment body");
      expect(JSON.stringify(delivered)).not.toContain("commentId");
      await db.update(dotRunnerAssignments).set({ status: "fenced" }).where(eq(dotRunnerAssignments.id, assignment.id));
      await db.insert(issueComments).values({ companyId: f.company.id, issueId: task!.id, authorUserId: f.userId, body: "Too late" });
      await f.events.tick();
      expect(await db.select().from(dotMailboxItems).where(and(eq(dotMailboxItems.assignmentId, assignment.id), eq(dotMailboxItems.kind, "follow_up")))).toHaveLength(1);
    } finally { await f.events.unsubscribe(f.principal, f.subscription); await f.events.stop(); }
  });

  it("serializes tool-result writes and cursor reads with the binding mailbox lock", async () => {
    const f = await fixture();
    const { run, assignment } = await offeredWork(f);
    const requestId = randomUUID();
    await db.insert(dotRunnerOperations).values({ companyId: f.company.id, assignmentId: assignment.id, requestId,
      digest: "test", command: { action: "tool" }, status: "admitted" });
    let release!: () => void;
    let held!: () => void;
    const locked = new Promise<void>(resolve => { held = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const firstEvent = randomUUID();
    const transaction = db.transaction(async tx => {
      await tx.select().from(dotAgentBindings).where(eq(dotAgentBindings.id, f.snapshot.bindingId)).for("update");
      await tx.insert(dotMailboxItems).values({ companyId: f.company.id, bindingId: f.snapshot.bindingId,
        bindingGeneration: f.snapshot.bindingGeneration, kind: "operation_result", sourceEventId: firstEvent, references: {} });
      held(); await gate;
    });
    await locked;
    const port = f.broker.port({ binding: { companyId: f.company.id, agentId: f.agent.id, runId: run.id }, provider: { binding: f.snapshot } });
    let written = false, read = false;
    const secondEvent = randomUUID();
    const writer = port.settle({ sourceEventId: secondEvent, payload: { requestId, binding: { ...f.snapshot, runId: run.id,
      normalizedSessionId: assignment.normalizedSessionId, turnId: assignment.turnId, assignmentRevision: assignment.revision }, outcome: { status: "completed", result: {} } } } as Parameters<typeof port.settle>[0]).then(() => { written = true; });
    const reader = f.broker.mailbox(f.principal).then(value => { read = true; return value; });
    try {
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(written).toBe(false); expect(read).toBe(false);
    } finally { release(); }
    await Promise.all([transaction, writer]);
    const initial = await reader;
    const next = await f.broker.mailbox(f.principal, initial.nextCursor);
    expect([...initial.items, ...next.items].map(i => i.sourceEventId)).toEqual(expect.arrayContaining([firstEvent, secondEvent]));
    await f.events.unsubscribe(f.principal, f.subscription); await f.events.stop();
  }, 30000);

  it("allows paused Dot fence delivery and acknowledgements without task authority", async () => {
    const f = await fixture();
    const { run, assignment } = await offeredWork(f);
    const [issue] = await db.insert(issues).values({ companyId: f.company.id, title: "Work paused before inbox read", assigneeAgentId: f.agent.id }).returning();
    await db.update(heartbeatRuns).set({ nativeIssueId: issue!.id }).where(eq(heartbeatRuns.id, run.id));
    await db.insert(nativeRunFinalizations).values({ runId: run.id, companyId: f.company.id, issueId: issue!.id, phase: "observed" });
    const port = f.broker.port({ binding: { companyId: f.company.id, agentId: f.agent.id, runId: run.id }, provider: { binding: f.snapshot } });
    await port.dispatch({ sourceEventId: randomUUID(), payload: { kind: "authority_revoked", binding: {
      ...f.snapshot, runId: run.id, normalizedSessionId: assignment.normalizedSessionId,
      turnId: assignment.turnId, assignmentRevision: assignment.revision,
    } } });
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agent.id));
    const principal = await f.oauth.authenticate(f.tokens.access_token);
    const tools = createDotRunnerMcpTools(db);
    await f.events.tick();
    expect(f.received.at(-1)?.data.kind).toBe("authority_revoked");
    const inbox = await tools.callTool(principal, "paperclip_dot_inbox", { after: 0 });
    expect(inbox).toMatchObject({ result: { nextCursor: 0, items: [{ kind: "authority_revoked", assignmentId: assignment.id, references: { assignmentId: assignment.id } }] } });
    const fencedAssignmentId = (inbox!.result as { items: Array<{ references: { assignmentId: string } }> }).items[0]!.references.assignmentId;
    await expect(tools.callTool(principal, "paperclip_dot_tasks", {})).rejects.toThrow("authority");
    await expect(tools.callTool(principal, "paperclip_dot_read", { assignmentId: assignment.id })).rejects.toThrow("authority");
    await expect(tools.callTool(principal, "paperclip_dot_accept", { assignmentId: assignment.id, requestId: randomUUID() })).rejects.toThrow("authority");
    expect(await tools.callTool(principal, "paperclip_dot_control_ack", { assignmentId: fencedAssignmentId, requestId: randomUUID() })).toMatchObject({ result: { status: "acknowledged", externalStopConfirmed: false } });
    await f.events.unsubscribe(principal, f.subscription); await f.events.stop();
  }, 30000);

  it("authorizes admitted Dot reviews while preserving the worker and rejecting stale review authority", async () => {
    const f = await fixture();
    const companyId = f.company.id;
    const [worker] = await db.insert(agents).values({ companyId, name: "Original worker", status: "active", adapterType: "paperclip_runner" }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Review another agent's work", status: "in_review", statusVersion: 3, assigneeAgentId: worker!.id }).returning();
    const issueId = issue!.id;
    const [contract] = await db.insert(completionContracts).values({ companyId, issueId, revision: 1, schemaVersion: "paperclip.completion-contract.v1", policyVersion: "fixture",
      risk: "low", completionAuthority: "agent", incompleteCriteriaPolicy: "block", contractJson: {}, canonicalSha256: randomUUID(), createdByActorType: "user", createdByActorId: f.userId }).returning();
    const [source] = await db.insert(heartbeatRuns).values({ companyId, agentId: worker!.id, nativeIssueId: issueId, runtimeMode: "native", status: "succeeded",
      completionContractId: contract!.id, completionContractSha256: contract!.canonicalSha256 }).returning();
    const [result] = await db.insert(nativeRunResults).values({ companyId, issueId, runId: source!.id, completionContractId: contract!.id,
      serverFingerprint: randomUUID(), schemaStatus: "accepted", resultJson: {}, canonicalSha256: randomUUID() }).returning();
    const [assessment] = await db.insert(workAssessments).values({ companyId, issueId, runId: source!.id, contractId: contract!.id, resultId: result!.id,
      triggerKind: "native_result", triggerActorCompanyId: companyId, priorIssueStatus: "in_progress", priorStatusVersion: 2, policyVersion: "fixture", assessmentJson: {}, inputDigest: randomUUID() }).returning();
    const [decision] = await db.insert(statusDecisions).values({ companyId, issueId, runId: source!.id, assessmentId: assessment!.id, decisionVersion: 1,
      policyVersion: "fixture", fromStatus: "in_progress", toStatus: "in_review", reasonCode: "explicit_review", decisionJson: { projectedStatusVersion: 3 }, decisionDigest: randomUUID(), applicationState: "applied" }).returning();
    const [interaction] = await db.insert(issueThreadInteractions).values({ companyId, issueId, kind: "request_confirmation", sourceRunId: source!.id,
      addresseeAgentId: f.agent.id, createdByAgentId: worker!.id,
      payload: { version: 1, prompt: "Review the completed work.", target: { type: "custom", key: "native_completion_review", revisionId: decision!.id } } }).returning();
    const { run, assignment } = await offeredWork(f);
    const contextSnapshot = { issueId, nativeReviewInteractionId: interaction!.id, nativeReviewDecisionId: decision!.id };
    await db.update(heartbeatRuns).set({ status: "running", runtimeMode: "native", nativeIssueId: issueId, nativeSessionId: assignment.normalizedSessionId, contextSnapshot }).where(eq(heartbeatRuns.id, run.id));
    await db.update(issues).set({ lastStatusDecisionId: decision!.id, executionRunId: run.id, checkoutRunId: source!.id }).where(eq(issues.id, issueId));
    await db.insert(nativeRunFinalizations).values({ runId: run.id, companyId, issueId, phase: "observed", controllerGeneration: assignment.controllerGeneration, leaseExpiresAt: new Date(Date.now() + 60_000) });
    await expect(f.broker.read(f.principal, assignment.id)).resolves.toMatchObject({ assignmentId: assignment.id });
    await expect(f.broker.operation(f.principal, assignment.id, randomUUID(), "accept", {})).resolves.toMatchObject({ status: "pending" });
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, issueId));
    await expect(f.broker.read(f.principal, assignment.id)).rejects.toThrow("execution authority");
    await db.update(issues).set({ executionRunId: run.id }).where(eq(issues.id, issueId));
    await db.update(issueThreadInteractions).set({ addresseeAgentId: worker!.id }).where(eq(issueThreadInteractions.id, interaction!.id));
    await expect(f.broker.read(f.principal, assignment.id)).rejects.toThrow("execution authority");
    await db.update(issueThreadInteractions).set({ addresseeAgentId: f.agent.id, status: "accepted", resolvedByAgentId: f.agent.id, resolvedByRunId: run.id }).where(eq(issueThreadInteractions.id, interaction!.id));
    await db.update(issues).set({ status: "done", executionRunId: null }).where(eq(issues.id, issueId));
    await expect(f.broker.read(f.principal, assignment.id)).resolves.toMatchObject({ assignmentId: assignment.id });
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]?.assigneeAgentId).toBe(worker!.id);
    await db.update(heartbeatRuns).set({ contextSnapshot: { ...contextSnapshot, nativeReviewDecisionId: randomUUID() } }).where(eq(heartbeatRuns.id, run.id));
    await expect(f.broker.read(f.principal, assignment.id)).rejects.toThrow("execution authority");
    await f.events.unsubscribe(f.principal, f.subscription); await f.events.stop();
  }, 30000);

  it("verifies reconnects and wakes the same outstanding assignment after exhausted delivery", async () => {
    const f = await fixture();
    const { assignment } = await offeredWork(f);
    await f.events.tick();
    const previousEventId = f.received.at(-1)?.eventId;
    const before = await f.broker.mailbox(f.principal);
    const oldItem = before.items.find(item => item.assignmentId === assignment.id)!;
    await db.update(mcpEventDeliveries).set({ attempts: 6, finishedAt: new Date(), outcome: "delivery_exhausted" })
      .where(eq(mcpEventDeliveries.mailboxItemId, oldItem.id));
    const failedReconnect = createPublicMcpEvents(db, f.oauth, async () => { throw new Error("personal dispatch forbidden"); },
      { enableDotRunner: true, fetch: async () => Response.json({ challenge: "wrong" }) });
    await expect(failedReconnect.subscribe(f.principal, f.subscription)).rejects.toThrow();
    expect((await f.broker.mailbox(f.principal, before.nextCursor)).items).toEqual([]);
    const verificationCount = f.verifications();
    await f.events.subscribe(f.principal, f.subscription);
    expect(f.verifications()).toBe(verificationCount + 1);
    const after = await f.broker.mailbox(f.principal, before.nextCursor);
    expect(after.items).toHaveLength(1);
    expect(after.items[0]).toMatchObject({ kind: "assignment", assignmentId: assignment.id });
    expect(await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.bindingId, f.snapshot.bindingId))).toHaveLength(1);
    await f.events.tick();
    expect(f.received.at(-1)?.data.mailboxItemId).toBe(after.items[0]!.id);
    expect(f.received.at(-1)?.eventId).not.toBe(previousEventId);
  }, 30000);

  it.each(["OAuth revocation", "refresh-token replay"])("%s fences Dot and cancels waiting work", async reason => {
    const f = await fixture();
    const { run, assignment } = await offeredWork(f);
    const { app, personal } = gateway(f.oauth, { type: "board", source: "session", userId: f.userId });
    // A token submitted to the other resource's revocation endpoint has no effect.
    await personal.revokeToken(f.tokens.access_token, f.client.client_id);
    expect(await f.broker.bindingForAgent(f.company.id, f.agent.id)).not.toBeNull();
    if (reason === "OAuth revocation") {
      expect((await request(app).post("/mcp/runner/oauth/revoke").send({ token: f.tokens.access_token, client_id: f.client.client_id })).status).toBe(200);
    } else {
      const refresh = { grant_type: "refresh_token", refresh_token: f.tokens.refresh_token, client_id: f.client.client_id, resource: f.oauth.config.resource };
      await f.oauth.token(refresh);
      await expect(f.oauth.token(refresh)).rejects.toThrow();
    }
    expect(await f.broker.bindingForAgent(f.company.id, f.agent.id)).toBeNull();
    expect((await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.id, assignment.id)))[0]?.status).toBe("fenced");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0]?.status).toBe("cancelled");
    await expect(f.oauth.authenticate(f.tokens.access_token)).rejects.toThrow();
    const next = await f.broker.createPairing({ companyId: f.company.id, agentId: f.agent.id, operatorId: f.userId });
    await f.oauth.revokeToken(f.tokens.access_token, f.client.client_id);
    expect((await f.broker.bindingForAgent(f.company.id, f.agent.id))?.id).toBe(next.bindingId);
  }, 30000);

  it("uses merged client metadata and scoped browser consent with a distinct Dot issuer", async () => {
    const f = await fixture();
    const clientId = `https://dot-${randomUUID()}.example/oauth.json`;
    const redirectUri = "https://chatgpt.com/connector_platform/oauth/callback";
    const oauth = createPublicMcpOAuth(db, f.oauth.config, { metadataFetch: async () => Response.json({
      client_id: clientId, client_name: "Dot metadata client", redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token", DEVICE_GRANT],
    }) });
    const { app, personal } = gateway(oauth, { type: "board", source: "session", userId: f.userId });
    const metadata = await request(app).get("/.well-known/oauth-protected-resource/mcp/runner");
    expect(metadata.body.authorization_servers).toEqual([oauth.config.origin + "/mcp/runner/oauth"]);
    const issuer = await request(app).get("/.well-known/oauth-authorization-server/mcp/runner/oauth");
    expect(issuer.body).toMatchObject({ issuer: oauth.config.origin + "/mcp/runner/oauth", client_id_metadata_document_supported: true,
      scopes_supported: ["paperclip:agent", "offline_access"], device_authorization_endpoint: oauth.config.origin + "/mcp/runner/oauth/device_authorization" });
    expect((await request(app).get("/.well-known/oauth-authorization-server")).body.issuer).toBe(oauth.config.origin);
    const verifier = randomBytes(32).toString("base64url");
    const input = { client_id: clientId, redirect_uri: redirectUri, response_type: "code", resource: oauth.config.resource,
      company_id: f.company.id, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" };
    const id = (await oauth.authorize(input)).split("/").at(-1)!;
    await expect(personal.describeRequest(id, { type: "board", source: "session", userId: f.userId }, null)).rejects.toThrow();
    const description = await request(app).get("/api/mcp/requests/" + id);
    expect(description.body).toMatchObject({ agentConnection: true, requestedCompanyId: f.company.id, clientOrigin: new URL(clientId).origin });
    expect(description.body.companies.map((c: { id: string }) => c.id)).toEqual([f.company.id]);
    expect((await request(app).post(`/api/mcp/requests/${id}/consent`).set("Origin", oauth.config.origin)
      .send({ decision: "approve", companyId: randomUUID(), allowWrites: false })).status).toBe(403);
    const consent = await request(app).post(`/api/mcp/requests/${id}/consent`).set("Origin", oauth.config.origin)
      .send({ decision: "approve", companyId: f.company.id, allowWrites: false });
    expect(consent.status).toBe(200);
    const redirect = new URL(consent.body.redirectUrl);
    expect(redirect.searchParams.get("iss")).toBe(issuer.body.issuer);
    const tokens = await oauth.token({ grant_type: "authorization_code", client_id: clientId, redirect_uri: redirectUri,
      resource: oauth.config.resource, code: redirect.searchParams.get("code"), code_verifier: verifier });
    expect((await oauth.authenticate(tokens.access_token)).grant).toMatchObject({ purpose: "agent", agentId: null, scopes: ["paperclip:agent"] });
    await expect(personal.authenticate(tokens.access_token)).rejects.toThrow();
    await expect(oauth.authorize({ ...input, scope: "paperclip:read" })).rejects.toMatchObject({ code: "invalid_scope" });
    await f.events.unsubscribe(f.principal, f.subscription);
  }, 30000);

  it("routes merged device consent to Dot without granting personal or cross-company access", async () => {
    const f = await fixture();
    const { app, personal } = gateway(f.oauth, { type: "board", source: "session", userId: f.userId });
    const client = await f.oauth.register({ client_name: "Dot device", redirect_uris: [], response_types: [], grant_types: [DEVICE_GRANT, "refresh_token"] }, randomUUID());
    const started = await request(app).post("/mcp/runner/oauth/device_authorization")
      .send({ client_id: client.client_id, resource: f.oauth.config.resource, scope: "paperclip:agent offline_access", company_id: f.company.id });
    expect(started.status).toBe(200);
    const codes = started.body;
    expect(await f.oauth.ownsDevice(codes.user_code)).toBe(true);
    await expect(personal.describeDevice(codes.user_code, { type: "none" })).rejects.toThrow();
    const description = await request(app).get("/api/mcp/device").query({ user_code: codes.user_code });
    expect(description.body).toMatchObject({ agentConnection: true, requestedCompanyId: f.company.id });
    await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(eq(companyMemberships.principalId, f.userId));
    expect((await request(app).post("/api/mcp/device/consent").set("Origin", f.oauth.config.origin)
      .send({ userCode: codes.user_code, decision: "approve", companyId: f.company.id, allowWrites: false })).status).toBe(403);
    await db.update(companyMemberships).set({ membershipRole: "owner" }).where(eq(companyMemberships.principalId, f.userId));
    const approved = await request(app).post("/api/mcp/device/consent").set("Origin", f.oauth.config.origin)
      .send({ userCode: codes.user_code, decision: "approve", companyId: f.company.id, allowWrites: false });
    expect(approved.body).toEqual({ status: "approved" });
    const exchange = { grant_type: DEVICE_GRANT, client_id: client.client_id, resource: f.oauth.config.resource, device_code: codes.device_code };
    const tokens = (await request(app).post("/mcp/runner/oauth/token").send(exchange)).body;
    expect((await f.oauth.authenticate(tokens.access_token)).actor.type).toBe("none");
    await expect(personal.authenticate(tokens.access_token)).rejects.toThrow();
    const renewed = await f.oauth.token({ grant_type: "refresh_token", client_id: client.client_id, resource: f.oauth.config.resource, refresh_token: tokens.refresh_token });
    expect((await f.oauth.authenticate(renewed.access_token)).grant.purpose).toBe("agent");
    await expect(f.oauth.token(exchange)).rejects.toMatchObject({ code: "invalid_grant" });
    await instanceSettingsService(db).updateExperimental({ enableOpenAiDot: false });
    try {
      expect((await request(app).get("/.well-known/oauth-protected-resource/mcp/runner")).status).toBe(503);
      expect((await request(app).get("/.well-known/oauth-protected-resource/mcp/paperclip")).status).toBe(200);
    } finally { await instanceSettingsService(db).updateExperimental({ enableOpenAiDot: true }); }
    await f.events.unsubscribe(f.principal, f.subscription);
  }, 30000);

  it("signed readiness, normal native authority, one document write and finalization through real Rust", async () => {
    const f = await fixture();
    const [issue] = await db.insert(issues).values({ companyId: f.company.id, title: "Save the arithmetic report", description: "Save 17 + 25 = 42 as a task document.",
      status: "in_progress", workMode: "standard", assigneeAgentId: f.agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: "running", invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId: issue!.id } }).returning();
    await db.update(issues).set({ executionRunId: run!.id, checkoutRunId: run!.id }).where(eq(issues.id, issue!.id));
    const prepared = await prepareNativeHeartbeatRun({ db, run: run!, issue: issue!, environmentLeaseId: randomUUID() });
    await db.insert(nativeRunFinalizations).values({ runId: run!.id, companyId: f.company.id, issueId: issue!.id, phase: "observed" });
    const [boundRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.id, boundRun!.completionContractId!));
    const runtimeContext = nativeRuntimeContextFixture();
    await writeFile(join(root, "AGENTS.md"), "Use Paperclip tools to save the report.");
    runtimeContext.instructions.bundle.rootPath = root;
    runtimeContext.aggregateDigest = canonicalNativeRuntimeContextDigest(runtimeContext);
    const execution = buildNativeExecutionInput({ companyId: f.company.id, agentId: f.agent.id, runId: run!.id, issue: issue!,
      taskPrompt: issue!.description!, normalizedSessionId: prepared.normalizedSessionId, provider: "openai_dot", dotBinding: f.snapshot,
      workspace: { id: randomUUID(), cwd: root, repoUrl: null, repoRef: null, branchName: null }, runtimeContext,
      completionContract: { id: contract!.id, sha256: contract!.canonicalSha256,
        schemaVersion: contract!.schemaVersion, contract: contract!.contractJson as unknown as StrictCompletionContractInput } });
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, run!.id));
    const server = createServer(); await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing test server");
    setupRunnerPrpWebSocketServer(server, { apiUrl: `http://127.0.0.1:${address.port}` });
    const observed: Array<Record<string, any>> = [];
    const appCall = vi.fn().mockResolvedValue({ status: "completed", result: { content: [{ type: "text", text: "synthetic gateway result" }] } });
    const gatewayTools = [{ name: "fixture:read_status", displayName: "Read fixture status", description: "Read a synthetic app", parametersSchema: { type: "object", properties: {}, additionalProperties: false }, risk: "read" }];
    registerAssignedMcpGateway(db, { listToolsForNamedGateway: vi.fn().mockResolvedValue(gatewayTools), executeTool: appCall } as unknown as ToolGatewayService);
    await db.update(agents).set({ adapterConfig: { ...f.agent.adapterConfig, dotWorkspaceAccess: true, dotAttachmentAccess: true } }).where(eq(agents.id, f.agent.id));
    const resultPromise = executePaperclipNativeSession({ db, execution, dotWorkspaceRoot: root, runnerInstanceId: prepared.runnerInstanceId,
      runnerEnvironment: { PAPERCLIP_NATIVE_MCP_NAME: "paperclip-assigned", PAPERCLIP_NATIVE_MCP_URL: "http://127.0.0.1:3217/mcp/gateways/dot-fixture", PAPERCLIP_NATIVE_MCP_TOKEN: "fixture-gateway-secret" },
      useRunnerd: true, turnTimeoutMs: 45000, onEvent: async event => { observed.push(event); }, onLog: async () => {} });
    // Attach a handler immediately: a bootstrap error must never become an unhandled rejection.
    let startupError: unknown;
    let startupOutcome: unknown;
    void resultPromise.then(result => { startupOutcome = result; }, () => {});
    void resultPromise.catch(error => { startupError = error; });
    try {
      await vi.waitFor(async () => { if (startupError) throw startupError; expect(await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.runId, run!.id))).toHaveLength(1); }, { timeout: 30000, interval: 50 });
      const [assignment] = await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.runId, run!.id));
      await f.events.tick();
      expect(JSON.stringify(f.received)).not.toContain("17 + 25");
      const work = await f.broker.read(f.principal, assignment!.id);
      expect(work.accounting).toEqual({ usage: null, cost: null });
      expect(work.status).toBe("offered");
      expect(observed.filter(event => event.eventType === "turn.started")).toHaveLength(0);
      expect(JSON.stringify(work)).not.toContain(root);
      expect((work.tools as Array<{ operationId: string }>).some(tool => tool.operationId === "register_deliverable")).toBe(true);
      expect(await f.broker.operation(f.principal, assignment!.id, randomUUID(), "tool", { name: "write_document", arguments: {} })).toMatchObject({ status: "rejected" });
      await f.broker.operation(f.principal, assignment!.id, randomUUID(), "accept", {});
      expect(JSON.stringify(work)).not.toContain("fixture-gateway-secret");
      const app = (work.tools as Array<{ operationId: string }>).find(tool => tool.operationId.startsWith("app_"))!;
      expect(app).toBeTruthy();
      const missingReadId = randomUUID();
      await f.broker.operation(f.principal, assignment!.id, missingReadId, "tool", { name: "workspace_read", arguments: { path: "missing-fixture.txt", offset: 0 } });
      await vi.waitFor(async () => expect(await f.broker.operationStatus(f.principal, assignment!.id, missingReadId)).toMatchObject({ status: "completed", isError: true, result: { outcome: "failed", code: "runner_bridge_file_not_found" } }), { timeout: 10000 });
      // A definite read failure must not poison later calls or finalization.
      const attachmentListId = randomUUID();
      expect((work.tools as Array<{ operationId: string }>).some(tool => tool.operationId === "read_task_attachment")).toBe(true);
      await f.broker.operation(f.principal, assignment!.id, attachmentListId, "tool", { name: "list_task_attachments", arguments: {} });
      await vi.waitFor(async () => expect(await f.broker.operationStatus(f.principal, assignment!.id, attachmentListId)).toMatchObject({ status: "completed", isError: false, result: { attachments: [] } }), { timeout: 10000 });
      const appRequestId = randomUUID();
      await f.broker.operation(f.principal, assignment!.id, appRequestId, "tool", { name: app.operationId, arguments: {} });
      await vi.waitFor(async () => expect(await f.broker.operationStatus(f.principal, assignment!.id, appRequestId)).toMatchObject({ status: "completed", isError: false }), { timeout: 10000 });
      expect(appCall).toHaveBeenCalledWith(expect.objectContaining({ gatewayPublicId: "dot-fixture", sessionToken: "fixture-gateway-secret", tool: "fixture:read_status" }));
      await db.update(agents).set({ budgetMonthlyCents: 100, spentMonthlyCents: 100 }).where(eq(agents.id, f.agent.id));
      await expect(f.broker.read(f.principal, assignment!.id)).rejects.toThrow("execution authority");
      await db.update(agents).set({ budgetMonthlyCents: 0, spentMonthlyCents: 0, status: "paused" }).where(eq(agents.id, f.agent.id));
      await expect(f.broker.read(f.principal, assignment!.id)).rejects.toThrow("authority");
      await db.update(agents).set({ status: "active" }).where(eq(agents.id, f.agent.id));
      await db.update(issues).set({ executionRunId: null, checkoutRunId: null }).where(eq(issues.id, issue!.id));
      await expect(f.broker.read(f.principal, assignment!.id)).rejects.toThrow("execution authority");
      await db.update(issues).set({ executionRunId: run!.id, checkoutRunId: run!.id }).where(eq(issues.id, issue!.id));
      const writeId = randomUUID();
      const args = { name: "write_document", arguments: { key: "report", title: "Arithmetic", body: "17 + 25 = 42.", baseRevisionId: null, idempotencyKey: writeId } };
      await f.broker.operation(f.principal, assignment!.id, writeId, "tool", args);
      await vi.waitFor(async () => expect(await f.broker.operationStatus(f.principal, assignment!.id, writeId)).toMatchObject({ status: "completed", isError: false }), { timeout: 10000 });
      await f.broker.operation(f.principal, assignment!.id, writeId, "tool", args);
      await expect(f.broker.operation(f.principal, assignment!.id, writeId, "tool", { ...args, arguments: { ...args.arguments, body: "changed" } })).rejects.toThrow("different arguments");
      const document = await documentService(db).getIssueDocumentByKey(issue!.id, "report");
      expect(document?.body).toBe("17 + 25 = 42.");
      const result = { reportedWorkDisposition: "completed", summary: "Saved the arithmetic report.",
        completionClaim: { contractRevision: execution.completionContract.contract.revision, objectiveSatisfied: true,
          criteria: execution.completionContract.contract.criteria.map(c => ({ criterionId: c.id, status: "passed", evidenceRefs: [] })), remainingWork: [] },
        evidence: [], verification: [{ commandOrCheck: "17 + 25", status: "pass" }] };
      const completionId = randomUUID();
      await f.broker.operation(f.principal, assignment!.id, completionId, "tool", { name: "paperclip_finish", arguments: result });
      await vi.waitFor(async () => expect(await f.broker.operationStatus(f.principal, assignment!.id, completionId)).toMatchObject({ status: "completed", isError: false }), { timeout: 10000 });
      expect(await f.broker.operationStatus(f.principal, assignment!.id, completionId)).toMatchObject({ result: { completionReport: {
        schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", artifacts: [], attentionRequests: [],
        verification: [{ commandOrCheck: "17 + 25", status: "passed" }],
      } } });
      await f.broker.operation(f.principal, assignment!.id, randomUUID(), "finish", { result });
      await resultPromise;
      // The heartbeat records its controller workspace settlement before the
      // ordinary status finalizer commits the task disposition.
      await db.insert(workspaceOperations).values({ companyId: f.company.id, heartbeatRunId: run!.id, issueId: issue!.id,
        phase: "workspace_finalize", status: "succeeded", exitCode: 0, cwd: root, finishedAt: new Date() });
      await finalizeNativeRun({ db, runId: run!.id, workspaceFinalizeStatus: "succeeded" });
      await finalizeNativeRun({ db, runId: run!.id, workspaceFinalizeStatus: "succeeded" });
      expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, run!.id))).toHaveLength(1);
      expect((await db.select().from(issues).where(eq(issues.id, issue!.id)))[0]?.status).toBe("done");
      expect(await db.select().from(dotRunnerOperations).where(eq(dotRunnerOperations.requestId, writeId))).toHaveLength(1);
      expect(startupOutcome).toMatchObject({ exitCode: 0, model: null, nativeFinalization: { providerSessionId: null, driverKind: "openai_dot_mcp" } });
      expect(observed.filter(event => event.eventType === "turn.started")).toHaveLength(1);
    } catch (error) {
      if (startupError) throw startupError;
      await Promise.race([resultPromise.catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000))]);
      if (startupError) throw startupError;
      throw error;
    } finally { await f.events.unsubscribe(f.principal, f.subscription); await f.events.stop(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  }, 90000);

  it("revocation, membership loss and a foreign company cannot recover authority", async () => {
    const f = await fixture(); const other = await fixture();
    await expect(f.broker.authorizeBinding(other.principal, f.company.id, f.snapshot.bindingId)).rejects.toThrow();
    await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.principalId, f.userId));
    await expect(f.broker.mailbox(f.principal)).rejects.toThrow();
    await db.update(companyMemberships).set({ status: "active" }).where(eq(companyMemberships.principalId, f.userId));
    await f.broker.revoke(f.company.id, f.agent.id, f.userId);
    await expect(f.broker.mailbox(f.principal)).rejects.toThrow();
    await expect(f.oauth.authorizeGrant(f.principal.grant.id)).rejects.toThrow();
    expect(await db.select().from(dotMailboxItems).where(eq(dotMailboxItems.bindingId, f.snapshot.bindingId))).toHaveLength(1);
    await other.events.unsubscribe(other.principal, other.subscription);
  }, 30000);
});
