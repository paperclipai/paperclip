/** Production app with a synthetic execution provider; launched by server.ts. */
import { appendFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { randomInt } from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { createDb, authUsers, instanceUserRoles, issueComments, issues, issueThreadInteractions, issueQuestionResponseDeliveries, chatVoiceInboundCalls, chatVoiceReports, chatVoiceSessions, chatVoiceReplies, chatVoiceToolCalls, chatDeliveries, chatPublications, heartbeatRuns, agentWakeupRequests } from "../../packages/db/src/index.js";
const home = process.env.PAPERCLIP_HOME!;
const port = Number(process.env.SPEKO_NATIVE_PORT ?? 3449);
const origin = `http://127.0.0.1:${port}`;
const callbackOrigin = process.env.SPEKO_NATIVE_CALLBACK_ORIGIN!;
const requireServer = createRequire(new URL("../../server/package.json", import.meta.url));
const { eq } = requireServer("drizzle-orm");
const db = createDb(process.env.DATABASE_URL!);
const authenticated = process.env.SPEKO_NATIVE_AUTH === "1";
const deploymentMode = authenticated ? "authenticated" : "local_trusted";
// Match index.ts's local-trusted bootstrap: agent JWTs retain this real
// responsible user and the memberships created by the normal company route.
if (!authenticated) await db.insert(authUsers).values({ id: "local-board", name: "Board", email: "local@paperclip.local", emailVerified: true, createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
if (!authenticated) await db.insert(instanceUserRoles).values({ userId: "local-board", role: "instance_admin" }).onConflictDoNothing();
const { registerServerAdapter, waitForExternalAdapters } = await import("../../server/src/adapters/registry.js");
await waitForExternalAdapters();
const { instanceSettingsService } = await import("../../server/src/services/instance-settings.js");
await instanceSettingsService(db).updateExperimental({ enableChatConnectors: true });
const firstRun = new Map<string, { began: number; number: number }>();
registerServerAdapter({
  type: "process", supportsLocalAgentJwt: true,
  async testEnvironment() { return { adapterType: "process", status: "pass", checks: [], testedAt: new Date().toISOString() }; },
  async execute(ctx) {
    const issueId = String(ctx.context.issueId ?? "");
    if (!issueId || !ctx.authToken) throw new Error("Expected real task and run-scoped agent identity");
    ctx.onDispatch?.();
    await ctx.onCancellationReady?.();
    if (ctx.config.command === "fixture-phone") {
      // Only execution is synthetic. Discover and invoke through the real
      // run-scoped MCP transport; do not reach into the voice service.
      const server = ctx.runtimeMcp?.getServers().find(server => server.name === "paperclip-assigned");
      if (!server) throw new Error("The assigned phone tool was not delivered to the runtime");
      const { Client } = requireServer("@modelcontextprotocol/sdk/client/index.js");
      const { StreamableHTTPClientTransport } = requireServer("@modelcontextprotocol/sdk/client/streamableHttp.js");
      const client = new Client({ name: "speko-phone-fixture", version: "1.0.0" });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${server.token}` } } }));
        const listed = await client.listTools();
        const tool = listed.tools.find((tool: { name: string }) => tool.name.endsWith(":call_my_phone"));
        if (!tool) throw new Error("The callback tool was not discoverable");
        const result = await client.callTool({ name: tool.name, arguments: {} });
        if (result.isError) throw new Error("The fixture phone call failed");
        // A second click must not dial again while this exact task is on a call.
        let secondRejected = false;
        try { const repeated = await client.callTool({ name: tool.name, arguments: {} }); secondRejected = !!repeated.isError; } catch { secondRejected = true; }
        if (!secondRejected) throw new Error("A simultaneous duplicate phone request was not rejected");
        await appendFile(resolve(home, "execution.jsonl"), JSON.stringify({ event: "phone_called", issueId, runId: ctx.runId, result, secondRejected }) + "\n", { mode: 0o600 });
        return { exitCode: 0, signal: null, timedOut: false, summary: "The assigned phone tool placed one call; the duplicate request was rejected." };
      } finally { await client.close(); }
    }
    let run = firstRun.get(issueId);
    const followupRun = !!run;
    if (!run) { run = { began: Date.now(), number: randomInt(1000, 10000) }; firstRun.set(issueId, run); }
    await appendFile(resolve(home, "execution.jsonl"), JSON.stringify({ event: "started", issueId, runId: ctx.runId, at: new Date().toISOString() }) + "\n", { mode: 0o600 });
    await ctx.onLog("stdout", "Synthetic execution provider is processing the voice request.\n");
    const remaining = run.began + 61_000 - Date.now();
    if (remaining > 0) await delay(remaining, undefined, { signal: ctx.signal });
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    const requests = comments.filter((comment) => !comment.authorAgentId);
    if (requests.some((comment) => comment.body.includes("Ask the structured acceptance question"))) {
      const interactions = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId));
      const question = interactions.find((item) => item.idempotencyKey === `fixture-question:${issueId}`);
      if (!question) {
        const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
        const response = await fetch(`${origin}/api/issues/${issueId}/interactions`, {
          method: "POST", headers: { authorization: `Bearer ${ctx.authToken}`, "content-type": "application/json", "x-paperclip-run-id": ctx.runId },
          body: JSON.stringify({ kind: "ask_user_questions", idempotencyKey: `fixture-question:${issueId}`, addresseeUserId: task.responsibleUserId,
            payload: { version: 1, questions: [{ id: "color", prompt: "Which color should I use?", selectionMode: "single", required: true, allowOther: false, options: [{ id: "cobalt", label: "Cobalt" }, { id: "amber", label: "Amber" }] }] } }), signal: ctx.signal,
        });
        if (!response.ok) throw new Error(`Fixture question API rejected: ${response.status}`);
        return { exitCode: 0, signal: null, timedOut: false, summary: "" };
      }
      if (question.status !== "answered") return { exitCode: 0, signal: null, timedOut: false, summary: "" };
    }
    const answeredQuestion = (await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId))).find((item) => item.idempotencyKey === `fixture-question:${issueId}` && item.status === "answered");
    const summary = answeredQuestion ? `Your structured answer was received: ${JSON.stringify(answeredQuestion.result)}.` : followupRun ? "Your follow-up was included in the completed result." : `The delayed work is complete. Verification number ${run.number}. I received ${Math.max(0, requests.length - 1)} follow-up instructions on this same task.`;
    const response = await fetch(`${origin}/api/issues/${issueId}/comments`, {
      method: "POST", headers: { authorization: `Bearer ${ctx.authToken}`, "content-type": "application/json", "x-paperclip-run-id": ctx.runId },
      body: JSON.stringify({ body: summary }), signal: ctx.signal,
    });
    if (!response.ok) throw new Error(`Normal agent comment API rejected fixture: ${response.status} ${(await response.json() as { error: string }).error}`);
    const comment = await response.json() as { id: string };
    await appendFile(resolve(home, "execution.jsonl"), JSON.stringify({ event: "completed", issueId, runId: ctx.runId, commentId: comment.id, number: run.number, requests: requests.length, elapsedMs: Date.now() - run.began, at: new Date().toISOString() }) + "\n", { mode: 0o600 });
    return { exitCode: 0, signal: null, timedOut: false, summary, resultJson: { summary } };
  },
});
const closeStub = process.env.SPEKO_NATIVE_STUB === "1"
  ? await (await import("./stub-provider.js")).installSpekoTestProvider(origin, Number(process.env.SPEKO_NATIVE_STUB_PORT ?? port + 1))
  : undefined;
const { createApp } = await import("../../server/src/app.js");
const { createStorageService } = await import("../../server/src/storage/service.js");
const { createLocalDiskStorageProvider } = await import("../../server/src/storage/local-disk-provider.js");
const authModule = await import("../../server/src/auth/better-auth.js");
const { loadConfig } = await import("../../server/src/config.js");
const auth = authenticated ? authModule.createBetterAuthInstance(db, loadConfig(), [origin]) : undefined;
const app = await createApp(db, {
  uiMode: "static", serverPort: port, bindHost: "127.0.0.1", allowedHostnames: ["127.0.0.1", "localhost", new URL(callbackOrigin).hostname],
  deploymentMode,
  ...(auth ? { betterAuthHandler: authModule.createBetterAuthHandler(auth), resolveSession: (req: import("express").Request) => authModule.resolveBetterAuthSession(auth, req) } : {}),
  deploymentExposure: "private", authReady: true, companyDeletionEnabled: true,
  chatWebhookPublicBaseUrl: callbackOrigin, authPublicBaseUrl: origin,
  storageService: createStorageService(createLocalDiskStorageProvider(resolve(home, "storage"))),
  decisionServiceOptions: { wakeOriginAgent: async () => {} }, managedPluginAutoInstall: [],
});
let evidenceWriting = false;
async function writeEvidence() {
  if (evidenceWriting) return;
  evidenceWriting = true;
  try {
  const [reports, incoming, sessions, replies, tools, deliveries, publications, runs, wakeups, comments, interactions, questionDeliveries] = await Promise.all([
    db.select({sessionId: chatVoiceReports.sessionId, companyId: chatVoiceReports.companyId, status: chatVoiceReports.status, costMicroUsd: chatVoiceReports.costMicroUsd, transcript: chatVoiceReports.transcript}).from(chatVoiceReports),
    db.select({id: chatVoiceInboundCalls.id, companyId: chatVoiceInboundCalls.companyId, endpointId: chatVoiceInboundCalls.endpointId, state: chatVoiceInboundCalls.state, sessionId: chatVoiceInboundCalls.sessionId}).from(chatVoiceInboundCalls),
    db.select({ id: chatVoiceSessions.id, issueId: chatVoiceSessions.issueId, providerSessionId: chatVoiceSessions.providerSessionId, mode: chatVoiceSessions.mode, state: chatVoiceSessions.state }).from(chatVoiceSessions),
    db.select().from(chatVoiceReplies),
    db.select({ id: chatVoiceToolCalls.id, sessionId: chatVoiceToolCalls.sessionId, tool: chatVoiceToolCalls.tool, response: chatVoiceToolCalls.response }).from(chatVoiceToolCalls),
    db.select({ id: chatDeliveries.id, state: chatDeliveries.state, conversationId: chatDeliveries.conversationId, redactedError: chatDeliveries.redactedError }).from(chatDeliveries),
    db.select({ id: chatPublications.id, issueId: chatPublications.issueId, state: chatPublications.state, payload: chatPublications.payload, redactedError: chatPublications.redactedError }).from(chatPublications),
    db.select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status, error: heartbeatRuns.error, errorCode: heartbeatRuns.errorCode, runtimeMode: heartbeatRuns.runtimeMode, nativeIssueId: heartbeatRuns.nativeIssueId, contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns),
    db.select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status, runId: agentWakeupRequests.runId }).from(agentWakeupRequests),
    db.select({ id: issueComments.id, issueId: issueComments.issueId, body: issueComments.body, authorAgentId: issueComments.authorAgentId, createdByRunId: issueComments.createdByRunId }).from(issueComments),
    db.select().from(issueThreadInteractions),
    db.select().from(issueQuestionResponseDeliveries),
  ]);
  const runEvidence = runs.map(({ contextSnapshot, ...row }) => {
    const context = (contextSnapshot ?? {}) as Record<string, unknown>;
    const wake = (context.paperclipWake ?? {}) as Record<string, unknown>;
    return { ...row, context: { source: context.source, issueId: context.issueId, wakeCommentIds: context.wakeCommentIds,
      paperclipTaskCommunicationGuidance: context.paperclipTaskCommunicationGuidance, paperclipHarnessCheckedOut: context.paperclipHarnessCheckedOut, paperclipExternalChatExecutionBound: context.paperclipExternalChatExecutionBound,
      wake: { externalChatProvider: wake.externalChatProvider, checkedOutByHarness: wake.checkedOutByHarness, externalChatExecutionBound: wake.externalChatExecutionBound } } };
  });
  await writeFile(resolve(home, "evidence.pending.json"), JSON.stringify({ appPid: process.pid, at: new Date().toISOString(), reports, incoming, sessions, replies, tools, deliveries, publications, runs: runEvidence, wakeups, comments, interactions, questionDeliveries }), { mode: 0o600 });
  await rename(resolve(home, "evidence.pending.json"), resolve(home, "evidence.json"));
  } finally { evidenceWriting = false; }
}
await writeEvidence();
const evidenceTimer = setInterval(() => { void writeEvidence().catch((error) => console.error("Evidence snapshot failed:", error.message)); }, 2000);
evidenceTimer.unref();
const { createPaperclipHttpServer } = await import("../../server/src/http/server.js");
const server = createPaperclipHttpServer(app, { apiUrl: origin });
server.listen(port, "127.0.0.1");
const { setupLiveEventsWebSocketServer } = await import("../../server/src/realtime/live-events-ws.js");
const liveEvents = setupLiveEventsWebSocketServer(server, db, { deploymentMode, ...(auth ? { resolveSessionFromHeaders: (headers: Headers) => authModule.resolveBetterAuthSessionFromHeaders(auth, headers) } : {}) });
await once(server, "listening");
console.log(JSON.stringify({ ready: true, origin, home }));
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  clearInterval(evidenceTimer);
  for (const client of liveEvents.clients) client.terminate();
  server.close(); server.closeAllConnections();
  await app.locals.paperclipShutdown?.();
  await closeStub?.();
  process.exit(0);
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
