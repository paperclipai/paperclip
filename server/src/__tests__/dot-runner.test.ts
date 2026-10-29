import { applyPendingMigrations } from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { createGrokRoutineDispatcher } from "../services/grok-bot/dispatcher.js";
import { grokRoutineService } from "../services/grok-bot/routine.js";
import { assertNoExternalOverlap } from "../modules/external-agents/admission.js";
import { accessService } from "../services/access.js";
import { Readable } from "node:stream";
import { createPublicMcpTransfers } from "../services/public-mcp/file-transfers.js";
import { issueService } from "../services/issues.js";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import express, { type Request } from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { grokBotRoutines, grokBotDispatches, agents, authUsers, companies, companyMemberships, createDb, dotAgentBindings, dotMailboxItems, dotRunnerAssignments, dotRunnerOperations,
  heartbeatRuns, mcpOauthGrants, issueAttachments, activityLog, agentWakeupRequests, issueComments, issues, nativeRunResults, nativeRunFinalizations, completionContracts, mcpEventDeliveries, mcpEventSubscriptions, workspaceOperations, workAssessments, statusDecisions, issueThreadInteractions } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createPublicMcpOAuth, DEVICE_GRANT } from "../services/public-mcp/oauth.js";
import { createPublicMcpExecutor } from "../services/public-mcp/capabilities.js";
import { publicMcpIngressRoutes, publicMcpManagementRoutes } from "../routes/public-mcp.js";
import { createPublicMcpEvents, type EventFetch } from "../services/public-mcp/events.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { canonicalNativeRuntimeContextDigest, type StrictCompletionContractInput } from "../vendor/paperclip-runner/index.js";
import { createDotRunnerMcpTools, dotRunnerBroker } from "../services/dot-runner-broker.js";
import { PaperclipRunnerToolAuthority } from "../services/native-runtime/paperclip-runner-tool-authority.js";
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
import { consumeDotHistoryReceipt, publishActiveDotComment } from "../services/dot-assignment-follow-up.js";
import { createPostgresWakeQueueAdapter } from "../modules/wake-queue/adapters/postgres.js";
import { createReleaseIssueExecution } from "../modules/wake-queue/application/use-cases.js";

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_DOT_RUNNER_TEST_DATABASE_URL");

describe("durable Dot Runner integration", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  beforeAll(async () => {
    const runnerRoot = fileURLToPath(new URL("../../../packages/paperclip-runner/", import.meta.url));
    execFileSync("cargo", ["build", "--release", "--locked", "--manifest-path", join(runnerRoot, "runner/Cargo.toml"), "-p", "paperclip-runner-core", "--bin", "paperclip-runnerd"], { cwd: runnerRoot, stdio: "inherit", timeout: 300000 });
    if (externalUrl) await applyPendingMigrations(externalUrl);
    else temporary = await startEmbeddedPostgresTestDatabase("paperclip-dot-runner-");
    db = createDb(externalUrl ?? temporary.connectionString);
    root = await mkdtemp(join(tmpdir(), "paperclip-dot-state-"));
    vi.stubEnv("PAPERCLIP_IN_WORKTREE", "false");
    vi.stubEnv("PAPERCLIP_RUNNER_BINARY", join(runnerRoot, "runner/target/release", process.platform === "win32" ? "paperclip-runnerd.exe" : "paperclip-runnerd"));
    vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", join(root, "runner-state"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", randomBytes(32).toString("base64"));
    await instanceSettingsService(db).updateExperimental({ enablePublicMcp: true, enableOpenAiDot: true, enableNativeRunner: false });
  }, 360000);
  afterEach(async () => {
    const { heartbeatService } = await import("../services/heartbeat.js");
    dotRunnerBroker(db, { heartbeat: heartbeatService(db) });
    await instanceSettingsService(db).updateExperimental({ enableGrokBot: false, enableNativeRunner: false });
  });
  afterAll(async () => {
    try {
      await db?.$client.end({ timeout: 1 });
      await temporary?.cleanup();
    } finally {
      try {
        if (root) await rm(root, { recursive: true, force: true });
      } finally {
        vi.unstubAllEnvs();
      }
    }
  });

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
    expect(() => resolveNativeRuntimeMode({ ...input, enabled: false, dotEnabled: true,
      adapterConfig: { provider: "acpx", acpxAgent: "grok", model: "anthropic/claude-sonnet-4-6" },
    })).toThrow("Paperclip Runner is experimental and disabled");
    expect(resolveHeartbeatNativeRuntimeMode({ ...input, enabled: false, dotEnabled: false,
      persisted: { runtimeMode: "native", runtimeModeReason: null, runtimeModeResolvedAt: new Date(), driverKind: "openai_dot_mcp" },
    })).toMatchObject({ kind: "native", profile: { backend: "openai_dot_mcp" } });
  });

  async function fixture(options: { cloudOrigin?: string; provider?: "openai_dot" | "grok_bot" } = {}) {
    const provider = options.provider ?? "openai_dot";
    if (provider === "grok_bot") await instanceSettingsService(db).updateExperimental({ enableGrokBot: true, enableNativeRunner: true });
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Dot operator", email: userId + "@example.test", createdAt: new Date(), updatedAt: new Date() });
    const [company] = await db.insert(companies).values({ name: "Dot test", issuePrefix: "DT" + randomBytes(3).toString("hex") }).returning();
    await db.insert(companyMemberships).values({ companyId: company!.id, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
    await accessService(db).setPrincipalPermission(company!.id, "user", userId, "agents:create", true, userId);
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: provider === "grok_bot" ? "Grok Bot" : "Dot", adapterType: "paperclip_runner", status: "active", adapterConfig: { provider, allowUnmeteredProvider: true } }).returning();
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
    const pairing = await broker.createPairing({ companyId: company!.id, agentId: agent!.id, operatorId: userId, provider });
    await broker.pair(unpaired, pairing.pairingCode);
    expect((await db.select().from(agents).where(eq(agents.id, agent!.id)))[0]!.adapterConfig[provider === "grok_bot" ? "externalBindingId" : "dotBindingId"]).toBe(pairing.bindingId);
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
    const events = createPublicMcpEvents(db, oauth, async () => { throw new Error("personal API dispatch forbidden"); }, { enableDotRunner: true, fetch: fetcher, ...options });
    const subscription = { name: "paperclip.dot.mailbox_updated", arguments: { companyId: company!.id, bindingId: pairing.bindingId }, delivery: { mode: "webhook", url: "https://example.com/dot-hook", secret } };
    if (provider === "grok_bot") {
      const routines = grokRoutineService(db, async () => ({ delivery: "accepted", httpStatus: 200 }));
      await routines.configure({ companyId: company!.id, agentId: agent!.id, bindingId: pairing.bindingId, operatorId: userId,
        expectedRevision: 0, botName: "Synthetic Grok", webhookUrl: "https://bot.example.test/routine", webhookKey: "synthetic-key" });
      const wake = await routines.reserve({ companyId: company!.id, agentId: agent!.id, bindingId: pairing.bindingId, sourceEventId: randomUUID(), kind: "verify" });
      await routines.send(company!.id, agent!.id, wake.id);
      await routines.acknowledge(principal, { correlationId: wake.id, bindingId: wake.bindingId, bindingGeneration: wake.bindingGeneration, challenge: String(wake.payload.challenge) });
      const snapshot = await broker.snapshot(company!.id, agent!.id, pairing.bindingId);
      const [fresh] = await db.select().from(agents).where(eq(agents.id, agent!.id));
      return { company: company!, agent: fresh!, userId, broker, principal, oauth, events, subscription, received, snapshot, tokens, client, verifications: () => verifications };
    }
    await events.subscribe(principal, subscription);
    await events.tick();
    if (!received.length) throw new Error("Dot readiness delivery missing: " + JSON.stringify(await db.select({ outcome: mcpEventDeliveries.outcome, event: mcpEventDeliveries.event }).from(mcpEventDeliveries)));
    expect(received.at(-1)?.data.kind).toBe("readiness_challenge");
    expect(received.at(-1)?.data).not.toHaveProperty("challenge");
    const challenge = (await broker.mailbox(principal)).items.find(i => i.kind === "readiness_challenge")!;
    await broker.confirmChallenge(principal, String(challenge.references.challenge));
    const snapshot = await broker.snapshot(company!.id, agent!.id, pairing.bindingId);
    await db.update(agents).set({ adapterConfig: { provider: "openai_dot", dotBindingId: pairing.bindingId, allowUnmeteredProvider: true, lifecycleMode: "per_turn" } }).where(eq(agents.id, agent!.id));
    return { company: company!, agent: agent!, userId, broker, principal, oauth, events, subscription, received, snapshot, tokens, client, verifications: () => verifications };
  }

  it("keeps scoped Dot events on tenant OAuth when the Cloud personal broker is configured", async () => {
    const f = await fixture({ cloudOrigin: "https://cloud-broker.example" });
    expect(f.verifications()).toBe(1);
    expect(f.received.at(-1)?.data.kind).toBe("readiness_challenge");
    await f.broker.revoke(f.company.id, f.agent.id, f.userId);
    await expect(f.events.subscribe(f.principal, f.subscription)).rejects.toThrow();
  }, 30000);

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

  it.each(["grok_bot_mcp", "codex_app_server"] as const)("fences a running Grok overlap before assignment materialization with %s", async driverKind => {
    const f = await fixture({ provider: "grok_bot" });
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id,
      status: "running", runtimeMode: "native", nativePhase: "preparing", driverKind,
      invocationSource: "assignment", triggerDetail: "system" }).returning();
    expect(await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.runId, run!.id))).toHaveLength(0);
    await expect(db.transaction(tx => assertNoExternalOverlap(tx, f.company.id, f.agent.id))).rejects.toThrow("External work is live or unresolved");
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run!.id));
    await expect(db.transaction(tx => assertNoExternalOverlap(tx, f.company.id, f.agent.id))).resolves.toBeUndefined();
  });

  it.each(["openai_dot", "grok_bot"] as const)("requires a matching %s descriptor for a V6 authority fence", async provider => {
    const f = await fixture({ provider }), { run, assignment } = await offeredWork(f);
    const [issue] = await db.insert(issues).values({ companyId: f.company.id, title: "Owned descriptor fence", assigneeAgentId: f.agent.id, checkoutRunId: run.id, executionRunId: run.id }).returning();
    await db.update(heartbeatRuns).set({ nativeIssueId: issue!.id }).where(eq(heartbeatRuns.id, run.id));
    const binding = { companyId: f.company.id, agentId: f.agent.id, runId: run.id };
    const event = { sourceEventId: randomUUID(), payload: { kind: "authority_revoked" as const, binding: {
      ...f.snapshot, runId: run.id, normalizedSessionId: assignment.normalizedSessionId,
      turnId: assignment.turnId, assignmentRevision: assignment.revision,
    } } };
    const foreign = provider === "openai_dot" ? "grok_bot" as const : "openai_dot" as const;
    await expect(f.broker.port({ binding, provider: { kind: foreign, binding: f.snapshot } }).dispatch(event)).rejects.toThrow("binding unavailable");
    expect((await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.id, assignment.id)))[0]!.status).toBe("offered");
    await f.broker.port({ binding, provider: { kind: provider, binding: f.snapshot } }).dispatch(event);
    expect((await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.id, assignment.id)))[0]!.status).toBe("fenced");
  });

  it("admits a native Grok operation while an actual upload waits for its task lock", async () => {
    const f = await fixture({ provider: "grok_bot" }), { run, assignment } = await offeredWork(f);
    const [issue] = await db.insert(issues).values({ companyId: f.company.id, title: "Concurrent Grok publication", assigneeAgentId: f.agent.id,
      checkoutRunId: run.id, executionRunId: run.id }).returning();
    await db.update(heartbeatRuns).set({ status: "running", runtimeMode: "native", nativePhase: "running", driverKind: "grok_bot_mcp",
      nativeIssueId: issue!.id, nativeSessionId: assignment.normalizedSessionId }).where(eq(heartbeatRuns.id, run.id));
    await db.update(dotRunnerAssignments).set({ status: "accepted", acceptedAt: new Date() }).where(eq(dotRunnerAssignments.id, assignment.id));
    await db.insert(nativeRunFinalizations).values({ runId: run.id, companyId: f.company.id, issueId: issue!.id, phase: "running",
      controllerGeneration: assignment.controllerGeneration, leaseExpiresAt: new Date(Date.now() + 60_000) });
    const files = new Map<string, Buffer>();
    const transfers = createPublicMcpTransfers(db, f.oauth, async () => { throw new Error("Personal API dispatch forbidden"); }, {
      provider: "local_disk", putFile: async input => {
        if (!Buffer.isBuffer(input.body)) throw new Error("Expected bounded upload bytes");
        files.set(input.objectKey!, input.body);
        return { provider: "local_disk", objectKey: input.objectKey!, contentType: input.contentType, originalFilename: input.originalFilename,
          byteSize: input.body.length, sha256: createHash("sha256").update(input.body).digest("hex") };
      }, getObject: async (_company, key) => ({ stream: Readable.from(files.get(key)!) }),
      headObject: async () => ({ exists: true }), deleteObject: async (_company, key) => { files.delete(key); },
    }, { pathPrefix: "/mcp/runner/files", agentSession: { authorize: (principal, sessionId, taskId, write, database) => dotRunnerBroker(database ?? db).authorizeFileSession(principal, sessionId, taskId, write) } });
    const body = Buffer.from("Authenticated concurrent deliverable"), uploadRequestId = randomUUID(), operationId = randomUUID();
    const upload = await transfers.getUploadUrl(f.principal, { companyId: f.company.id, taskId: issue!.id, requestId: uploadRequestId,
      filename: "concurrent.txt", contentType: "text/plain", byteSize: body.length, sha256: createHash("sha256").update(body).digest("hex") }, assignment.id);
    const url = new URL(String(upload.url)), api = express(); api.use(transfers.router);
    let uploading: Promise<request.Response> | undefined, uploaded: request.Response | undefined, uploadError: unknown;
    try {
      await db.transaction(async tx => {
        await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issue!.id)).for("update");
        const [holder] = await tx.execute(sql`select pg_backend_pid() as pid`) as unknown as Array<{ pid: number }>;
        uploading = request(api).put(url.pathname + url.search).set("Content-Type", "text/plain").send(body).then(response => response);
        await vi.waitFor(async () => {
          const [state] = await db.execute(sql`select exists (
            select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock'
              and query ilike '%issues%' and ${holder!.pid}=any(pg_blocking_pids(pid))
          ) as waiting`) as unknown as Array<{ waiting: boolean }>;
          expect(state!.waiting).toBe(true);
        }, { timeout: 5000, interval: 20 });
        const operationDb = Object.assign(Object.create(tx), {
          transaction: async (effect: (database: typeof db) => Promise<unknown>) => effect(tx as unknown as typeof db),
        }) as typeof db;
        await expect(dotRunnerBroker(operationDb).operation(f.principal, assignment.id, operationId, "progress", { text: "Concurrent progress" }))
          .resolves.toMatchObject({ status: "pending", assignmentId: assignment.id, requestId: operationId });
      });
    } finally {
      try { uploaded = await uploading; } catch (error) { uploadError = error; }
    }
    expect(uploadError).toBeUndefined(); expect(uploaded?.status).toBe(200);
    expect((await db.select().from(dotRunnerOperations).where(and(eq(dotRunnerOperations.assignmentId, assignment.id), eq(dotRunnerOperations.requestId, operationId))))).toHaveLength(1);
    const attachments = await db.select().from(issueAttachments).where(eq(issueAttachments.issueId, issue!.id));
    expect(attachments).toHaveLength(1);
    const attachment = await issueService(db).getAttachmentById(attachments[0]!.id);
    expect(attachment).toMatchObject({ companyId: f.company.id, issueId: issue!.id, assetId: attachments[0]!.assetId,
      createdByAgentId: f.agent.id, originatingRunId: run.id, createdByUserId: null });
    const audit = await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.company.id),
      eq(activityLog.action, "issue.attachment_added"), eq(activityLog.entityType, "issue"), eq(activityLog.entityId, issue!.id),
      sql`${activityLog.details}->>'attachmentId' = ${attachments[0]!.id}`));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorType: "agent", actorId: f.agent.id, details: { attachmentId: attachments[0]!.id,
      authorizingPersonId: f.userId, workSessionId: assignment.id, mcpConnectionId: f.principal.grant.id } });
    expect(uploaded!.body.attachment).toEqual({ id: attachments[0]!.id, issueId: issue!.id, originalFilename: "concurrent.txt",
      contentType: "text/plain", byteSize: body.length, sha256: createHash("sha256").update(body).digest("hex"),
      createdAt: attachment!.createdAt.toISOString() });
    expect((await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.id, assignment.id)))[0]!.status).toBe("accepted");
  }, 30000);

  it.each(["openai_dot", "grok_bot"] as const)("keeps %s assignment authority after a rejected finish receipt until a completed finish", async provider => {
    const f = await fixture({ provider }), { run, assignment } = await offeredWork(f);
    const acceptedAt = new Date("2026-10-01T00:00:00.000Z");
    await db.update(dotRunnerAssignments).set({ status: "accepted", acceptedAt }).where(eq(dotRunnerAssignments.id, assignment.id));
    const port = f.broker.port({ binding: { companyId: f.company.id, agentId: f.agent.id, runId: run.id },
      provider: { kind: provider, binding: f.snapshot } });
    const binding = { ...f.snapshot, runId: run.id, normalizedSessionId: assignment.normalizedSessionId,
      turnId: assignment.turnId, assignmentRevision: assignment.revision };
    const rejectedId = randomUUID();
    await db.insert(dotRunnerOperations).values({ companyId: f.company.id, assignmentId: assignment.id,
      requestId: rejectedId, digest: "rejected-finish", command: { action: "finish" }, status: "admitted" });
    const rejection = { sourceEventId: randomUUID(), payload: { binding, requestId: rejectedId,
      outcome: { status: "rejected", message: "Completion evidence was not accepted" } } };
    await port.settle(rejection);
    const [rejected] = await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.id, assignment.id));
    expect(rejected).toMatchObject({ status: "accepted", acceptedAt, settledAt: null });
    const [receipt] = await db.select().from(dotRunnerOperations).where(eq(dotRunnerOperations.requestId, rejectedId));
    expect(receipt!.outcome).toEqual(rejection.payload.outcome);
    await port.settle(rejection);
    expect((await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.id, assignment.id)))[0]).toEqual(rejected);
    const completedId = randomUUID();
    await db.insert(dotRunnerOperations).values({ companyId: f.company.id, assignmentId: assignment.id,
      requestId: completedId, digest: "completed-finish", command: { action: "finish" }, status: "admitted" });
    await port.settle({ sourceEventId: randomUUID(), payload: { binding, requestId: completedId,
      outcome: { status: "completed" } } });
    const [completed] = await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.id, assignment.id));
    expect(completed).toMatchObject({ status: "settled", acceptedAt });
    expect(completed!.settledAt).toBeInstanceOf(Date);
  });

  it("reapplies the Dot-only migration after the merged gateway schema", async () => {
    const migration = await readFile(new URL("../../../packages/db/src/migrations/0317_messy_famine.sql", import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await db.execute(sql.raw(statement));
    }
  });

  it.each(["revoked binding", "removed subscription"])("handles an automatic event-test race with a %s", async change => {
    const f = await fixture();
    await db.update(dotAgentBindings).set({ readyAt: null, status: "connected" }).where(eq(dotAgentBindings.id, f.snapshot.bindingId));
    const readBinding = f.broker.bindingForAgent.bind(f.broker);
    const read = vi.spyOn(f.broker, "bindingForAgent").mockImplementationOnce(async (companyId, agentId) => {
      const state = await readBinding(companyId, agentId);
      if (change === "revoked binding") await db.update(dotAgentBindings).set({ revokedAt: new Date() }).where(eq(dotAgentBindings.id, f.snapshot.bindingId));
      else await db.update(mcpEventSubscriptions).set({ stoppedAt: new Date() }).where(eq(mcpEventSubscriptions.bindingId, f.snapshot.bindingId));
      return state;
    });
    try {
      await expect(f.broker.challenge(f.company.id, f.agent.id, { automatic: true, bindingId: f.snapshot.bindingId })).resolves.toEqual({ status: "unavailable" });
      await expect(f.broker.challenge(f.company.id, f.agent.id)).rejects.toThrow("Connect and subscribe");
    } finally {
      read.mockRestore();
      await f.events.unsubscribe(f.principal, f.subscription); await f.events.stop();
    }
  });

  it.each(["openai_dot", "grok_bot"] as const)("admits one durable %s idle intake without requiring a preassigned task", async provider => {
    const f = await fixture({ provider });
    await db.update(companies).set({ defaultResponsibleUserId: f.userId }).where(eq(companies.id, f.company.id));
    const holding = await offeredWork(f);
    await db.update(heartbeatRuns).set({ status: "running", startedAt: new Date() }).where(eq(heartbeatRuns.id, holding.run.id));
    const requestId = randomUUID();
    try {
      const requests = await Promise.all([1, 2, 3].map(() => f.broker.requestTurn(f.principal, "Create hello and assign it to my owner", requestId)));
      expect(requests[1]).toEqual(requests[0]); expect(requests[2]).toEqual(requests[0]);
      expect(requests[0]!.instruction).toContain(provider === "grok_bot"
        ? "Queued admission does not start another Grok routine"
        : "Events also notify queued work");
      const intake = await db.select().from(issues).where(eq(issues.id, requests[0]!.issueId));
      expect(intake).toHaveLength(1);
      expect(intake[0]).toMatchObject({ assigneeAgentId: f.agent.id, createdByAgentId: f.agent.id, responsibleUserId: f.userId });
      expect(await f.broker.capabilities(f.principal)).toMatchObject({ agentId: f.agent.id, responsibleUser: { id: f.userId }, idle: { start: provider === "grok_bot" ? "paperclip_grok_request_turn" : "paperclip_dot_request_turn" } });
      await expect(f.broker.requestTurn(f.principal, "Different request", requestId)).rejects.toThrow("reused");
      await db.update(companies).set({ budgetMonthlyCents: 1, spentMonthlyCents: 1 }).where(eq(companies.id, f.company.id));
      await expect(f.broker.requestTurn(f.principal, "Spend more", randomUUID())).rejects.toThrow("budget");
      await db.update(companies).set({ budgetMonthlyCents: 0, spentMonthlyCents: 0 }).where(eq(companies.id, f.company.id));
      await f.broker.revoke(f.company.id, f.agent.id, f.userId);
      expect((await db.select().from(agents).where(eq(agents.id, f.agent.id)))[0]!.adapterConfig).not.toHaveProperty(provider === "grok_bot" ? "externalBindingId" : "dotBindingId");
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

  it("coalesces a normal comment wake into the accepted Dot mailbox without a second run", async () => {
    const f = await fixture(), { run, assignment } = await offeredWork(f);
    const [task] = await db.insert(issues).values({ companyId: f.company.id, title: "Active Dot comment",
      status: "in_progress", assigneeAgentId: f.agent.id, executionRunId: run.id, checkoutRunId: run.id }).returning();
    await db.update(heartbeatRuns).set({ nativeIssueId: task!.id, issueId: task!.id, status: "running",
      runtimeMode: "native", nativeSessionId: assignment.normalizedSessionId }).where(eq(heartbeatRuns.id, run.id));
    await db.update(dotRunnerAssignments).set({ status: "accepted" }).where(eq(dotRunnerAssignments.id, assignment.id));
    const [comment] = await db.insert(issueComments).values({ companyId: f.company.id, issueId: task!.id,
      authorUserId: f.userId, body: "Continue the same assignment" }).returning();
    try {
      const admitted = await heartbeatService(db).wakeup(f.agent.id, { source: "assignment", triggerDetail: "system",
        reason: "issue_commented", payload: { issueId: task!.id, commentId: comment!.id },
        requestedByActorType: "user", requestedByActorId: f.userId,
        contextSnapshot: { issueId: task!.id, wakeCommentId: comment!.id, wakeReason: "issue_commented" } });
      expect(admitted?.id).toBe(run.id);
      await f.events.tick(); await f.events.tick();
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agent.id))).toHaveLength(1);
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agent.id));
      expect(wakes).toHaveLength(1);
      expect(wakes[0]).toMatchObject({ status: "deferred_issue_execution", runId: null, finishedAt: null });
      const mailbox = await db.select().from(dotMailboxItems).where(and(eq(dotMailboxItems.assignmentId, assignment.id), eq(dotMailboxItems.kind, "follow_up")));
      expect(mailbox).toHaveLength(1);
      expect(mailbox[0]!.references).toEqual({ assignmentId: assignment.id, commentId: comment!.id });
      expect(f.received.filter(event => event.data?.kind === "follow_up")).toHaveLength(1);
      await f.broker.mailbox(f.principal);
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakes[0]!.id)))[0]?.status).toBe("deferred_issue_execution");
      const [receipt] = await db.insert(dotRunnerOperations).values({ companyId: f.company.id,
        assignmentId: assignment.id, requestId: randomUUID(), digest: "history", status: "completed",
        command: { action: "tool", input: { name: "get_task_history", arguments: {} } },
        outcome: { status: "completed", isError: false, result: { comments: [{ id: comment!.id }] } } }).returning();
      await consumeDotHistoryReceipt(db, receipt!);
      await consumeDotHistoryReceipt(db, receipt!);
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakes[0]!.id)))[0]).toMatchObject({ status: "coalesced", runId: run.id });
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agent.id))).toHaveLength(1);
    } finally {
      await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, run.id));
      await db.update(dotRunnerAssignments).set({ status: "fenced" }).where(eq(dotRunnerAssignments.id, assignment.id));
      await f.events.unsubscribe(f.principal, f.subscription); await f.events.stop();
    }
  }, 30000);

  it.each(["finish before delivery", "read before wake admission", "partial history", "failed history"])(
    "preserves comment delivery when %s", async scenario => {
      const f = await fixture(), { run, assignment } = await offeredWork(f);
      await db.update(companies).set({ defaultResponsibleUserId: f.userId }).where(eq(companies.id, f.company.id));
      const [task] = await db.insert(issues).values({ companyId: f.company.id, title: "Dot comment race",
        status: "in_progress", assigneeAgentId: f.agent.id, responsibleUserId: f.userId,
        executionRunId: run.id, checkoutRunId: run.id }).returning();
      await db.update(heartbeatRuns).set({ nativeIssueId: task!.id, issueId: task!.id, status: "running",
        contextSnapshot: { issueId: task!.id }, runtimeMode: "native", nativeSessionId: assignment.normalizedSessionId }).where(eq(heartbeatRuns.id, run.id));
      await db.update(dotRunnerAssignments).set({ status: "accepted" }).where(eq(dotRunnerAssignments.id, assignment.id));
      const comments = await db.insert(issueComments).values([1, 2].map(index => ({ companyId: f.company.id,
        issueId: task!.id, authorUserId: f.userId, body: "Input " + index }))).returning();
      const [history] = await db.insert(dotRunnerOperations).values({ companyId: f.company.id,
        assignmentId: assignment.id, requestId: randomUUID(), digest: "history", status: "completed",
        command: { action: "tool", input: { name: "get_task_history", arguments: {} } },
        outcome: { status: "completed", isError: scenario === "failed history",
          result: { comments: [{ id: comments[0]!.id }] } } }).returning();
      try {
        if (scenario === "read before wake admission") await consumeDotHistoryReceipt(db, history!);
        for (const comment of comments) await heartbeatService(db).wakeup(f.agent.id, {
          source: "assignment", triggerDetail: "system", reason: "issue_commented",
          payload: { issueId: task!.id, commentId: comment.id }, requestedByActorType: "user", requestedByActorId: f.userId,
          contextSnapshot: { issueId: task!.id, wakeCommentId: comment.id, wakeReason: "issue_commented" },
        });
        if (scenario === "finish before delivery") {
          const requestId = randomUUID();
          await db.insert(dotRunnerOperations).values({ companyId: f.company.id, assignmentId: assignment.id,
            requestId, digest: "finish", command: { action: "finish" }, status: "admitted" });
          const port = f.broker.port({ binding: { companyId: f.company.id, agentId: f.agent.id, runId: run.id }, provider: { binding: f.snapshot } });
          await port.settle({ sourceEventId: randomUUID(), payload: { requestId,
            binding: { ...f.snapshot, runId: run.id, normalizedSessionId: assignment.normalizedSessionId,
              turnId: assignment.turnId, assignmentRevision: assignment.revision }, outcome: { status: "completed" } } } as Parameters<typeof port.settle>[0]);
          await f.events.tick();
          expect(f.received.filter(event => event.data?.kind === "follow_up")).toHaveLength(0);
        }
        await consumeDotHistoryReceipt(db, history!);
        let wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agent.id));
        expect(wakes).toHaveLength(scenario === "read before wake admission" ? 2 : 1);
        const pending = wakes.find(wake => wake.status === "deferred_issue_execution")!;
        expect(pending.payload?._paperclipWakeContext).toMatchObject({ wakeCommentIds:
          ["finish before delivery", "failed history"].includes(scenario)
            ? comments.map(comment => comment.id) : [comments[1]!.id] });
        if (scenario === "read before wake admission") expect(wakes.find(wake => wake.payload?.commentId === comments[0]!.id)?.status).toBe("coalesced");
        if (scenario === "finish before delivery") {
          await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
          await db.update(issues).set({ status: "done" }).where(eq(issues.id, task!.id));
          const release = createReleaseIssueExecution({ issueLock: createPostgresWakeQueueAdapter(db, {
            resolveResponsibleUserId: async () => f.userId,
            getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
            resolveSessionBeforeForWakeup: async () => null,
          }), recovery: {
            escalateStrandedAssignedIssue: async () => { throw new Error("unexpected escalation"); },
            escalateStrandedRecoveryIssueInPlace: async () => { throw new Error("unexpected escalation"); },
          } });
          await release({ companyId: f.company.id, runId: run.id, now: new Date(), suppressImmediateRecovery: true });
          await release({ companyId: f.company.id, runId: run.id, now: new Date(), suppressImmediateRecovery: true });
          const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agent.id));
          expect(runs).toHaveLength(2);
          expect(runs.find(row => row.id !== run.id)).toMatchObject({ status: "queued",
            contextSnapshot: { wakeCommentIds: comments.map(comment => comment.id) } });
          wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agent.id));
          expect(wakes).toHaveLength(1);
          expect(wakes[0]).toMatchObject({ status: "queued", runId: runs.find(row => row.id !== run.id)!.id });
        }
      } finally {
        await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.agentId, f.agent.id));
        await db.update(dotRunnerAssignments).set({ status: "fenced" }).where(eq(dotRunnerAssignments.id, assignment.id));
        await f.events.unsubscribe(f.principal, f.subscription); await f.events.stop();
      }
    }, 30000);

  it.each(["foreign comment", "self comment", "revoked binding", "fenced assignment", "expired assignment", "prior generation"])(
    "refuses active comment delivery for %s", async kind => {
      const f = await fixture(), { run, assignment } = await offeredWork(f);
      const [task] = await db.insert(issues).values({ companyId: f.company.id, title: "Bounded follow-up", assigneeAgentId: f.agent.id }).returning();
      await db.update(heartbeatRuns).set({ nativeIssueId: task!.id, status: "running", runtimeMode: "native",
        nativeSessionId: assignment.normalizedSessionId }).where(eq(heartbeatRuns.id, run.id));
      await db.update(dotRunnerAssignments).set({ status: "accepted" }).where(eq(dotRunnerAssignments.id, assignment.id));
      const [comment] = await db.insert(issueComments).values({ companyId: f.company.id, issueId: task!.id,
        ...(kind === "self comment" ? { authorAgentId: f.agent.id } : { authorUserId: f.userId }), body: "Bounded input" }).returning();
      if (kind === "revoked binding") await db.update(dotAgentBindings).set({ revokedAt: new Date() }).where(eq(dotAgentBindings.id, f.snapshot.bindingId));
      if (kind === "fenced assignment") await db.update(dotRunnerAssignments).set({ status: "fenced" }).where(eq(dotRunnerAssignments.id, assignment.id));
      if (kind === "expired assignment") await db.update(dotRunnerAssignments).set({ expiresAt: new Date(0) }).where(eq(dotRunnerAssignments.id, assignment.id));
      if (kind === "prior generation") await db.update(dotAgentBindings).set({ generation: f.snapshot.bindingGeneration + 1 }).where(eq(dotAgentBindings.id, f.snapshot.bindingId));
      try {
        expect(await db.transaction(tx => publishActiveDotComment(tx as unknown as typeof db, {
          companyId: f.company.id, agentId: f.agent.id, bindingId: f.snapshot.bindingId, runId: run.id,
          issueId: task!.id, commentId: kind === "foreign comment" ? randomUUID() : comment!.id }))).toBe(false);
        expect(await db.select().from(dotMailboxItems).where(and(eq(dotMailboxItems.assignmentId, assignment.id), eq(dotMailboxItems.kind, "follow_up")))).toHaveLength(0);
      } finally { await f.events.stop(); }
    }, 30000);

  it("fences a failed Grok run's remaining external assignment without stopping a successor", async () => {
    const f = await fixture({ provider: "grok_bot" });
    const old = await offeredWork(f);
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, old.run.id));
    expect(await f.broker.stopGrokWork(f.company.id, f.agent.id, f.userId, old.run.id))
      .toMatchObject({ stopped: true, remoteTerminationConfirmed: false });
    expect((await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.runId, old.run.id)))[0]?.status).toBe("fenced");
    expect(await grokRoutineService(db).recoveryNeeded(f.company.id, f.agent.id)).toBe(true);
    await expect(f.broker.read(f.principal, old.assignment.id)).rejects.toThrow();
    const current = await offeredWork(f);
    await expect(f.broker.stopGrokWork(f.company.id, f.agent.id, f.userId, old.run.id)).rejects.toThrow("changed");
    expect((await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.id, current.assignment.id)))[0]?.status).toBe("offered");
    await f.events.stop();
  });

  it.each(["queued", "running"] as const)("stops a %s Grok run before an external assignment exists", async status => {
    const f = await fixture({ provider: "grok_bot" });
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status, invocationSource: "assignment", triggerDetail: "system" }).returning();
    const cancelRun = vi.fn().mockResolvedValue(null);
    const broker = dotRunnerBroker(db, { heartbeat: { wakeup: vi.fn(), cancelRun } });
    expect(await broker.stopGrokWork(f.company.id, f.agent.id, f.userId, run!.id)).toMatchObject({ stopped: true, remoteTerminationConfirmed: false });
    expect(cancelRun).toHaveBeenCalledWith(run!.id, "Paperclip work stopped; Grok execution unconfirmed");
    expect(await grokRoutineService(db).recoveryNeeded(f.company.id, f.agent.id)).toBe(status === "running");
    expect(await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.runId, run!.id))).toHaveLength(0);
    const other = await fixture({ provider: "grok_bot" });
    await expect(broker.stopGrokWork(other.company.id, other.agent.id, other.userId, run!.id)).rejects.toThrow("changed");
    expect(cancelRun).toHaveBeenCalledTimes(1);
    await f.events.stop(); await other.events.stop();
  });

  it("cancels queued Grok work without fencing another active assignment", async () => {
    const f = await fixture({ provider: "grok_bot" }), active = await offeredWork(f);
    const [queued] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: "queued", invocationSource: "assignment", triggerDetail: "system" }).returning();
    const cancelRun = vi.fn().mockResolvedValue(null);
    const broker = dotRunnerBroker(db, { heartbeat: { wakeup: vi.fn(), cancelRun } });
    await broker.stopGrokWork(f.company.id, f.agent.id, f.userId, queued!.id);
    expect(cancelRun).toHaveBeenCalledTimes(1);
    expect(cancelRun).toHaveBeenCalledWith(queued!.id, "Paperclip work stopped; Grok execution unconfirmed");
    expect((await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.id, active.assignment.id)))[0]!.status).toBe("offered");
    expect(await grokRoutineService(db).recoveryNeeded(f.company.id, f.agent.id)).toBe(false);
    await f.events.stop();
  });

  it("rejects a stale Grok Stop click without fencing the newly displayed work", async () => {
    const f = await fixture({ provider: "grok_bot" });
    const old = await offeredWork(f);
    await db.update(dotRunnerAssignments).set({ status: "settled" }).where(eq(dotRunnerAssignments.id, old.assignment.id));
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, old.run.id));
    const current = await offeredWork(f);
    await expect(f.broker.stopGrokWork(f.company.id, f.agent.id, f.userId, old.run.id)).rejects.toThrow("changed");
    expect((await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.id, current.assignment.id)))[0]!.status).toBe("offered");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, current.run.id)))[0]!.status).toBe("queued");
    await f.events.stop();
  });

  it("preserves Grok feedback and its deferred wake while routine recovery blocks notification", async () => {
    const f = await fixture({ provider: "grok_bot" }), { run, assignment } = await offeredWork(f);
    const [task] = await db.insert(issues).values({ companyId: f.company.id, title: "Grok feedback", assigneeAgentId: f.agent.id }).returning();
    await db.update(heartbeatRuns).set({ nativeIssueId: task!.id, status: "running", runtimeMode: "native", nativeSessionId: assignment.normalizedSessionId }).where(eq(heartbeatRuns.id, run.id));
    await db.update(dotRunnerAssignments).set({ status: "accepted" }).where(eq(dotRunnerAssignments.id, assignment.id));
    await db.update(grokBotRoutines).set({ recoveryRequiredAt: new Date(), recoveryReason: "dispatch" }).where(eq(grokBotRoutines.bindingId, f.snapshot.bindingId));
    const [comment] = await db.insert(issueComments).values({ companyId: f.company.id, issueId: task!.id, authorUserId: f.userId, body: "Please include the source dates." }).returning();
    await db.transaction(async tx => {
      expect(await publishActiveDotComment(tx as unknown as typeof db, { companyId: f.company.id, agentId: f.agent.id,
        bindingId: f.snapshot.bindingId, runId: run.id, issueId: task!.id, commentId: comment!.id })).toMatchObject({ consumed: false });
      await tx.insert(agentWakeupRequests).values({ companyId: f.company.id, agentId: f.agent.id, source: "assignment", triggerDetail: "system",
        reason: "issue_comment", status: "deferred_issue_execution", payload: { issueId: task!.id, commentId: comment!.id } });
    });
    const delivery = vi.fn().mockResolvedValue({ delivery: "accepted", httpStatus: 200 });
    const dispatcher = createGrokRoutineDispatcher(db, () => true, delivery);
    await dispatcher.tick();
    expect(delivery).not.toHaveBeenCalled();
    expect(await db.select().from(dotMailboxItems).where(and(eq(dotMailboxItems.assignmentId, assignment.id), eq(dotMailboxItems.kind, "follow_up")))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, f.agent.id), eq(agentWakeupRequests.status, "deferred_issue_execution")))).toHaveLength(1);
    await f.events.stop();
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

  it.each(["succeeded", "failed", "cancelled", "timed_out"] as const)("fences a stranded %s assignment before new admission without claiming external stop", async status => {
    const f = await fixture();
    const { run, assignment } = await offeredWork(f);
    try {
      await expect(f.broker.snapshot(f.company.id, f.agent.id, f.snapshot.bindingId)).rejects.toThrow("active assignment");
      await db.update(heartbeatRuns).set({ status }).where(eq(heartbeatRuns.id, run.id));
      await f.broker.snapshot(f.company.id, f.agent.id, f.snapshot.bindingId);
      await f.broker.snapshot(f.company.id, f.agent.id, f.snapshot.bindingId);
      expect((await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.id, assignment.id)))[0]?.status).toBe("fenced");
      const inbox = await f.broker.mailbox(f.principal);
      const fences = inbox.items.filter(item => item.assignmentId === assignment.id && item.kind === "authority_revoked");
      expect(fences).toHaveLength(1);
      expect(fences[0]?.references).toMatchObject({ assignmentId: assignment.id, runId: run.id, externalStopConfirmed: false });
      await expect(createDotRunnerMcpTools(db).callTool(f.principal, "paperclip_dot_accept", { assignmentId: assignment.id, requestId: randomUUID() })).rejects.toThrow("revoked");
    } finally { await f.events.unsubscribe(f.principal, f.subscription); await f.events.stop(); }
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

  it.each([
    { name: "Dot local Rust", managed: false, provider: "openai_dot" as const, revokeDuringUpload: false },
    { name: "Grok local Rust", managed: false, provider: "grok_bot" as const, revokeDuringUpload: false },
    { name: "Grok upload revocation Rust", managed: false, provider: "grok_bot" as const, revokeDuringUpload: true },
    ...(process.env.PAPERCLIP_DOT_DAYTONA_LIVE === "1" ? [{ name: "private Daytona Rust", managed: true, provider: "openai_dot" as const, revokeDuringUpload: false }] : []),
  ])("signed readiness, native tools and finalization through $name", async ({ managed, provider, revokeDuringUpload }) => {
    const remote = managed ? await (await import("./helpers/dot-daytona.js")).startDotDaytona(root) : null;
    try {
      const f = await fixture({ provider });
      const [issue] = await db.insert(issues).values({ companyId: f.company.id, title: "Save the arithmetic report", description: provider === "grok_bot" ? "Save 17 + 25 = 42 as a task document and attach report.txt." : "Save 17 + 25 = 42 as a task document.",
        status: "in_progress", workMode: "standard", assigneeAgentId: f.agent.id }).returning();
      const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: "running", invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId: issue!.id } }).returning();
      await db.update(issues).set({ executionRunId: run!.id, checkoutRunId: run!.id }).where(eq(issues.id, issue!.id));
      const prepared = await prepareNativeHeartbeatRun({ db, run: run!, issue: issue!, environmentLeaseId: randomUUID() });
      await db.update(heartbeatRuns).set({ driverKind: provider === "grok_bot" ? "grok_bot_mcp" : "openai_dot_mcp" }).where(eq(heartbeatRuns.id, run!.id));
      await db.insert(nativeRunFinalizations).values({ runId: run!.id, companyId: f.company.id, issueId: issue!.id, phase: "observed" });
      const [boundRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
      const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.id, boundRun!.completionContractId!));
      const runtimeContext = nativeRuntimeContextFixture();
      await writeFile(join(root, "AGENTS.md"), "Use Paperclip tools to save the report.");
      runtimeContext.instructions.bundle.rootPath = root;
      runtimeContext.aggregateDigest = canonicalNativeRuntimeContextDigest(runtimeContext);
      const execution = buildNativeExecutionInput({ companyId: f.company.id, agentId: f.agent.id, runId: run!.id, issue: issue!,
        taskPrompt: issue!.description!, normalizedSessionId: prepared.normalizedSessionId, provider, dotBinding: f.snapshot,
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
      if (provider === "openai_dot") {
        const [connectedAgent] = await db.select().from(agents).where(eq(agents.id, f.agent.id));
        await db.update(agents).set({ adapterConfig: { ...connectedAgent!.adapterConfig, dotBindingId: f.snapshot.bindingId, dotWorkspaceAccess: true, dotAttachmentAccess: true } }).where(eq(agents.id, f.agent.id));
      }
      vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "fixture-cloud");
      try {
        for (const useRunnerd of [false, true]) {
          await expect(executePaperclipNativeSession({ db, execution, runnerInstanceId: prepared.runnerInstanceId,
            useRunnerd, turnTimeoutMs: 1000, onEvent: async () => {} }))
            .rejects.toThrow("dot_cloud_requires_managed_runner");
        }
      } finally { vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", ""); }
      const resultPromise = executePaperclipNativeSession({ db, execution,
        ...(remote ? { runnerExecutionTarget: remote.target, runnerRemoteBinaryPath: remote.runnerBinary, runnerIngressAuthorized: true }
          : { dotWorkspaceRoot: root }),
        runnerInstanceId: prepared.runnerInstanceId,
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
        if (provider === "openai_dot") await f.events.tick();
        expect(JSON.stringify(f.received)).not.toContain("17 + 25");
        const work = await f.broker.read(f.principal, assignment!.id);
        expect(work.accounting).toEqual({ usage: null, cost: null });
        expect(work.status).toBe("offered");
        expect(observed.filter(event => event.eventType === "turn.started")).toHaveLength(0);
        expect(JSON.stringify(work)).not.toContain(root);
        expect((work.tools as Array<{ operationId: string }>).some(tool => tool.operationId === "register_deliverable")).toBe(provider === "openai_dot");
        expect(await f.broker.operation(f.principal, assignment!.id, randomUUID(), "tool", { name: "write_document", arguments: {} })).toMatchObject({ status: "rejected" });
        await f.broker.operation(f.principal, assignment!.id, randomUUID(), "accept", {});
        expect(JSON.stringify(work)).not.toContain("fixture-gateway-secret");
        let uploadedDeliverableId: string | undefined;
        if (provider === "grok_bot") {
          const files = new Map<string, Buffer>();
          let storingUpload = false;
          let releaseUploadStorage!: () => void;
          const uploadStorageRelease = new Promise<void>(resolve => { releaseUploadStorage = resolve; });
          const transfers = createPublicMcpTransfers(db, f.oauth, async () => { throw new Error("Personal API dispatch forbidden"); }, {
            provider: "local_disk", putFile: async input => {
              if (!Buffer.isBuffer(input.body)) throw new Error("Expected bounded bytes");
              const objectKey = input.objectKey!; files.set(objectKey, input.body);
              if (revokeDuringUpload) { storingUpload = true; await uploadStorageRelease; }
              return { provider: "local_disk", objectKey, contentType: input.contentType, byteSize: input.body.length,
                sha256: createHash("sha256").update(input.body).digest("hex"), originalFilename: input.originalFilename };
            }, getObject: async (_company, key) => ({ stream: Readable.from(files.get(key)!) }),
            headObject: async () => ({ exists: true }), deleteObject: async (_company, key) => { files.delete(key); },
          }, { pathPrefix: "/mcp/runner/files", agentSession: { authorize: (principal, sessionId, taskId, write, database) => dotRunnerBroker(database ?? db).authorizeFileSession(principal, sessionId, taskId, write) } });
          const api = express(); api.use(transfers.router);
          const body = Buffer.from("Grok arithmetic file: 42\n"), uploadId = randomUUID();
          const args = { companyId: f.company.id, taskId: issue!.id, requestId: uploadId, filename: "report.txt", contentType: "text/plain", byteSize: body.length, sha256: createHash("sha256").update(body).digest("hex") };
          const grant = await transfers.getUploadUrl(f.principal, args, assignment!.id);
          const url = new URL(String(grant.url));
          if (revokeDuringUpload) {
            const uploading = request(api).put(url.pathname + url.search).set("Content-Type", "text/plain").send(body)
              .then(response => response);
            let revoked = false;
            let revoking: Promise<void> | undefined;
            try {
              await vi.waitFor(() => expect(storingUpload).toBe(true), { timeout: 10000, interval: 20 });
              revoking = f.broker.revoke(f.company.id, f.agent.id, f.userId).then(() => { revoked = true; });
              void revoking.catch(() => {});
              // Revocation must not wait for remote storage, and late bytes
              // cannot produce accepted artifacts or completion evidence.
              await vi.waitFor(() => expect(revoked).toBe(true), { timeout: 3000, interval: 20 });
            } finally { releaseUploadStorage(); }
            await revoking;
            expect((await uploading).status).toBe(403);
            await resultPromise.catch(() => {});
            const [revokedGrant] = await db.select().from(mcpOauthGrants).where(eq(mcpOauthGrants.id, f.principal.grant.id));
            expect(revokedGrant!.revokedAt).not.toBeNull();
            expect((await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.id, assignment!.id)))[0]!.status).toBe("fenced");
            expect(await db.select().from(issueAttachments).where(eq(issueAttachments.issueId, issue!.id))).toHaveLength(0);
            const [cancelledRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
            expect(Object.keys((cancelledRun?.resultJson?.semanticToolReceipts ?? {}) as Record<string, unknown>)
              .filter(key => key.startsWith("external-upload:"))).toHaveLength(0);
            return;
          }
          // Hold the document transaction at its task lock, then start the real
          // HTTP upload. The native document write must still acquire its run
          // lock and commit; a run-before-task upload deadlocks this overlap.
          let concurrentUpload: Promise<request.Response> | undefined;
          let earlyUpload: request.Response | undefined;
          await db.transaction(async tx => {
            await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issue!.id)).for("update");
            const [backend] = await tx.execute(sql`select pg_backend_pid() as pid`) as unknown as Array<{ pid: number }>;
            concurrentUpload = request(api).put(url.pathname + url.search).set("Content-Type", "text/plain").send(body)
              .then(response => { earlyUpload = response; return response; });
            await vi.waitFor(async () => {
              expect(earlyUpload?.status, JSON.stringify(earlyUpload?.body)).toBeUndefined();
              const [state] = await db.execute(sql`select exists (
                select 1 from pg_stat_activity where ${backend!.pid} = any(pg_blocking_pids(pid))
              ) as waiting`) as unknown as Array<{ waiting: boolean }>;
              expect(state!.waiting).toBe(true);
            }, { timeout: 10000, interval: 20 });
            // Use the same native authority inside this already-open document
            // transaction, retaining every real identity and mutation check.
            const documentDb = Object.assign(Object.create(tx), {
              transaction: async (effect: (database: typeof db) => Promise<unknown>) => effect(tx as unknown as typeof db),
            }) as typeof db;
            const authority = new PaperclipRunnerToolAuthority(documentDb, {
              companyId: f.company.id, issueId: issue!.id, agentId: f.agent.id, runId: run!.id, firstPartyOnly: true,
            });
            try {
              expect(await authority.execute({ tool: "write_document", callId: randomUUID(), arguments: {
                key: "upload-overlap", title: "Concurrent document", body: "Saved while the file is uploading.",
                baseRevisionId: null, idempotencyKey: "upload-overlap",
              } })).toMatchObject({ disposition: "applied" });
            } finally { authority.close(); }
          });
          const uploaded = await concurrentUpload!;
          expect(uploaded.status).toBe(200);
          expect((await documentService(db).getIssueDocumentByKey(issue!.id, "upload-overlap"))?.body)
            .toBe("Saved while the file is uploading.");
          uploadedDeliverableId = uploaded.body.attachment.id;
          expect(uploaded.body.publication).toMatchObject({ evidenceRef: `deliverable:${uploadedDeliverableId}`,
            commandId: `deliverable-uploaded:${uploadedDeliverableId}`, source: "authenticated_upload" });
          const duplicates = await Promise.all([0, 1].map(() => request(api).put(url.pathname + url.search)
            .set("Content-Type", "text/plain").send(body)));
          expect(duplicates.every(response => response.status === 200)).toBe(true);
          expect(duplicates[0]!.body).toEqual(duplicates[1]!.body);
          const duplicate = duplicates[0]!;
          expect(duplicate.body.attachment.id).toBe(uploaded.body.attachment.id);
          expect(duplicate.body.publication).toEqual(uploaded.body.publication);
          expect(await transfers.getUploadUrl(f.principal, args, assignment!.id)).toMatchObject({
            status: "completed", publication: uploaded.body.publication, attachment: { id: uploadedDeliverableId },
          });
          const [publishedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
          expect(Object.values(publishedRun!.resultJson!.semanticToolReceipts as Record<string, unknown>))
            .toEqual(expect.arrayContaining([
              expect.objectContaining({ operationId: "publish_external_deliverable" }),
              expect.objectContaining({ operationId: "write_document", input: expect.objectContaining({ key: "upload-overlap" }) }),
            ]));
          expect(Object.keys(publishedRun!.resultJson!.semanticToolReceipts as Record<string, unknown>)
            .filter(key => key.startsWith("external-upload:"))).toHaveLength(1);
          expect(await issueService(db).getAttachmentById(uploaded.body.attachment.id)).toMatchObject({ createdByAgentId: f.agent.id, originatingRunId: run!.id, createdByUserId: null });
          await expect(transfers.getUploadUrl(f.principal, { ...args, taskId: randomUUID() }, assignment!.id)).rejects.toThrow();
          const download = new URL(String((await transfers.getDownloadUrl(f.principal, uploaded.body.attachment.id, assignment!.id)).url));
          expect((await request(api).get(download.pathname + download.search)).status).toBe(200);
          const pendingUpload = new URL(String((await transfers.getUploadUrl(f.principal, { ...args, requestId: randomUUID() }, assignment!.id)).url));
          await db.update(issues).set({ workMode: "ask" }).where(eq(issues.id, issue!.id));
          await expect(transfers.getUploadUrl(f.principal, { ...args, requestId: randomUUID() }, assignment!.id)).rejects.toThrow("work mode");
          expect((await request(api).put(pendingUpload.pathname + pendingUpload.search).set("Content-Type", "text/plain").send(body)).status).toBeGreaterThanOrEqual(400);
          await db.update(issues).set({ workMode: "standard" }).where(eq(issues.id, issue!.id));
          await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agent.id));
          expect((await request(api).get(download.pathname + download.search)).status).toBeGreaterThanOrEqual(400);
          await db.update(agents).set({ status: "active" }).where(eq(agents.id, f.agent.id));
        }

        const app = (work.tools as Array<{ operationId: string }>).find(tool => tool.operationId.startsWith("app_"))!;
        if (provider === "openai_dot") {
        expect(app).toBeTruthy();
        if (remote) {
          expect((work.tools as Array<{ operationId: string }>).some(tool => tool.operationId.startsWith("workspace_"))).toBe(false);
        } else {
        const missingReadId = randomUUID();
        await f.broker.operation(f.principal, assignment!.id, missingReadId, "tool", { name: "workspace_read", arguments: { path: "missing-fixture.txt", offset: 0 } });
        await vi.waitFor(async () => expect(await f.broker.operationStatus(f.principal, assignment!.id, missingReadId)).toMatchObject({ status: "completed", isError: true, result: { outcome: "failed", code: "runner_bridge_file_not_found" } }), { timeout: 10000 });
        }
        // A definite read failure must not poison later calls or finalization.
        const attachmentListId = randomUUID();
        expect((work.tools as Array<{ operationId: string }>).some(tool => tool.operationId === "read_task_attachment")).toBe(true);
        await f.broker.operation(f.principal, assignment!.id, attachmentListId, "tool", { name: "list_task_attachments", arguments: {} });
        await vi.waitFor(async () => expect(await f.broker.operationStatus(f.principal, assignment!.id, attachmentListId)).toMatchObject({ status: "completed", isError: false, result: { attachments: [] } }), { timeout: 10000 });
        const appRequestId = randomUUID();
        await f.broker.operation(f.principal, assignment!.id, appRequestId, "tool", { name: app.operationId, arguments: {} });
        await vi.waitFor(async () => expect(await f.broker.operationStatus(f.principal, assignment!.id, appRequestId)).toMatchObject({ status: "completed", isError: false }), { timeout: 10000 });
        expect(appCall).toHaveBeenCalledWith(expect.objectContaining({ gatewayPublicId: "dot-fixture", sessionToken: "fixture-gateway-secret", tool: "fixture:read_status" }));
        } else {
          expect(app).toBeUndefined();
          expect((work.tools as Array<{ operationId: string }>).some(tool => ["get_workspace", "prepare_repository", "workspace_read"].includes(tool.operationId))).toBe(false);
        }
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
          evidence: uploadedDeliverableId ? [{ ref: `deliverable:${uploadedDeliverableId}` }] : [], verification: [{ commandOrCheck: "17 + 25", status: "pass" }] };
        if (uploadedDeliverableId) {
          const missingEvidenceId = randomUUID();
          await f.broker.operation(f.principal, assignment!.id, missingEvidenceId, "tool", {
            name: "paperclip_finish", arguments: { ...result, evidence: [] },
          });
          await vi.waitFor(async () => expect(await f.broker.operationStatus(f.principal, assignment!.id, missingEvidenceId))
            .toMatchObject({ status: "completed", isError: true, result: { error: expect.stringContaining("requested file") } }), { timeout: 10000 });
        }
        const completionId = randomUUID();
        await f.broker.operation(f.principal, assignment!.id, completionId, "tool", { name: "paperclip_finish", arguments: result });
        await vi.waitFor(async () => expect(await f.broker.operationStatus(f.principal, assignment!.id, completionId)).toMatchObject({ status: "completed", isError: false }), { timeout: 10000 });
        expect(await f.broker.operationStatus(f.principal, assignment!.id, completionId)).toMatchObject({ result: { completionReport: {
          schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", artifacts: [], attentionRequests: [],
          verification: [{ commandOrCheck: "17 + 25", status: "passed" }],
        } } });
        if (provider === "grok_bot") await db.update(grokBotDispatches).set({ status: "accepted", sentAt: new Date() })
          .where(and(eq(grokBotDispatches.assignmentId, assignment!.id), eq(grokBotDispatches.kind, "mailbox_updated")));
        await f.broker.operation(f.principal, assignment!.id, randomUUID(), "finish", { result });
        if (provider === "grok_bot") {
          await vi.waitFor(async () => expect(await db.select().from(grokBotDispatches).where(and(eq(grokBotDispatches.assignmentId, assignment!.id),
            eq(grokBotDispatches.kind, "mailbox_updated"), inArray(grokBotDispatches.status, ["prepared", "sending", "accepted", "unknown"])))).toHaveLength(0));
          expect(await grokRoutineService(db).recoveryNeeded(f.company.id, f.agent.id)).toBe(false);
        }
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
        expect(startupOutcome).toMatchObject({ exitCode: 0, model: null, nativeFinalization: { providerSessionId: null, driverKind: provider === "grok_bot" ? "grok_bot_mcp" : "openai_dot_mcp" } });
        expect(observed.filter(event => event.eventType === "turn.started")).toHaveLength(1);
      } catch (error) {
        if (startupError) throw startupError;
        await Promise.race([resultPromise.catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000))]);
        if (startupError) throw startupError;
        throw error;
      } finally { if (provider === "openai_dot") await f.events.unsubscribe(f.principal, f.subscription); await f.events.stop(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
    } finally { await remote?.close(); }
  }, 360000);

  it.each(["failed", "cancelled", "timed_out"])("reports %s admission without creating another wake or waiting for a nonexistent assignment", async status => {
    const f = await fixture();
    const { run } = await offeredWork(f);
    await db.update(heartbeatRuns).set({ status }).where(eq(heartbeatRuns.id, run.id));
    const requestId = randomUUID(), issueId = randomUUID();
    await db.insert(agentWakeupRequests).values({ companyId: f.company.id, agentId: f.agent.id,
      source: "assignment", status: "admitted", runId: run.id, payload: { issueId },
      idempotencyKey: `dot-work:${f.snapshot.bindingId}:${f.snapshot.bindingGeneration}:${requestId}` });
    const result = await f.broker.requestWork(f.principal, issueId, requestId);
    expect(result).toMatchObject({ status: "admission_failed", runId: run.id, admissionStatus: status });
    expect(result.message).toContain("Stop waiting");
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agent.id))).toHaveLength(1);
  });

  it("uses the app-configured heartbeat for Dot-originated managed admission and cancellation", async () => {
    const f = await fixture();
    const wakeup = vi.fn().mockResolvedValue(null);
    const cancelRun = vi.fn().mockResolvedValue(null);
    createDotRunnerMcpTools(db, { wakeup, cancelRun });
    try {
      const requestId = randomUUID();
      const intake = await f.broker.requestTurn(f.principal, "Managed intake context test", requestId);
      expect(wakeup).toHaveBeenCalledExactlyOnceWith(f.agent.id, expect.objectContaining({
        source: "assignment", requestedByActorType: "agent", requestedByActorId: f.agent.id,
        durableDotRequest: expect.objectContaining({ issueId: intake.issueId, requestId }),
      }));
      const assignment = await offeredWork(f);
      await f.broker.revoke(f.company.id, f.agent.id, f.userId);
      expect(cancelRun).toHaveBeenCalledExactlyOnceWith(assignment.run.id, "Dot connection revoked");
    } finally { dotRunnerBroker(db, { heartbeat: heartbeatService(db) }); }
  });

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
