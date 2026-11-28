import { createHash } from "node:crypto";
import { RUNNER_TOOL_SCOPE_TOKEN_HEADER } from "../drivers/runner-tool-bridge.js";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { request } from "node:http";
import { expect, it, vi } from "vitest";
import { createRunnerdNativeSessionBackend } from "../backends/codex-native-backend.js";
import type { NativeExecutionInputV5 } from "../contracts/native-execution.js";
import { canonicalNativeRuntimeContextDigest, NATIVE_RUNTIME_ASSET_SCHEMA, PAPERCLIP_EXECUTION_PROMPT, PAPERCLIP_EXECUTION_PROMPT_REVISION, nativeRuntimePromptDigest } from "../contracts/runtime-context.js";
import { executeNativeSession } from "../native-session-runtime.js";
import type { PrpEvent, PrpStructuredRunResult } from "../protocol/replay-contract.js";
import type { DurablePrpControlPlane } from "./durable-prp-control-plane.js";
import { createRunnerdCodexTransport, defaultCapabilityRunnerdBinary } from "../live/runnerd-codex-transport.js";
import { buildPrivateCursorCloudProxy, currentCloudScopeHeader, privateCloudNodeCommand } from "./cursor-cloud-runner.harness.js";

async function cloudQuestionHandoff(terminalDelayMs: number, governed: boolean, planning = false) {
  const root = await mkdtemp("/tmp/cc-question-");
  const runtime = join(root, "cloud");
  const configPath = join(runtime, "config.json");
  const socketPath = join(root, "mcp.sock");
  const proxyPath = join(root, "cloud-proxy.cjs");
  const fetchLog = join(root, "controlled-fetches.jsonl");
  buildPrivateCursorCloudProxy(proxyPath);
  const providerNodeCommand = await privateCloudNodeCommand(root);
  const runId = "run-22222222-2222-4222-8222-222222222222";
  const fixture = Buffer.from(`;(() => {
    const assert = require('node:assert/strict'), fs = require('node:fs');
    let agentId = '', status = 'RUNNING';
    const now = '2026-10-28T00:00:00Z', runId = ${JSON.stringify(runId)};
    const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    const run = () => ({ id: runId, agentId, status, createdAt: now, updatedAt: now });
    globalThis.fetch = async (input, init = {}) => {
      const target = new URL(String(input)); assert.equal(target.origin, 'https://api.cursor.com');
      const path = target.pathname, method = init.method ?? 'GET';
      fs.appendFileSync(${JSON.stringify(fetchLog)}, JSON.stringify({ method, path }) + '\\n', { mode: 0o600 });
      if (path === '/v1/agents' && method === 'POST') {
        if (${planning}) {
          const body = JSON.parse(String(init.body));
          assert.equal(body.mode, 'agent');
          const envelope = JSON.parse(body.prompt.text.split('\\n\\nPaperclip task:\\n').at(-1));
          assert.equal(envelope.executionMode, 'plan');
          assert.equal(envelope.task.workMode, 'planning');
          assert.equal(envelope.planningContext.baseRevisionId, 'plan-revision-3');
          assert.equal(envelope.planningContext.markdown, '# Pinned canonical plan');
        }
        agentId = JSON.parse(String(init.body)).agentId;
        return json({ agent: { id: agentId, status: 'ACTIVE', env: { type: 'cloud' }, url: 'https://cursor.com/agents/' + agentId, createdAt: now, updatedAt: now, latestRunId: runId }, run: run() });
      }
      assert.equal(path.startsWith('/v1/agents/' + agentId + '/runs/' + runId), true);
      if (path.endsWith('/stream') && method === 'GET') return new Response(new ReadableStream({ start(controller) {
        init.signal?.addEventListener('abort', () => { try { controller.close(); } catch {} }, { once: true });
      } }), { headers: { 'content-type': 'text/event-stream' } });
      if (path.endsWith('/cancel') && method === 'POST') { await new Promise(resolve => setTimeout(resolve, ${terminalDelayMs})); status = 'FINISHED'; return json({ id: runId }); }
      if (path.endsWith('/' + runId) && method === 'GET') return json(run());
      throw new Error('Unexpected controlled Cloud request');
    };
  })();\n`);
  const builtProxy = await readFile(proxyPath);
  const firstLine = builtProxy.indexOf(10) + 1;
  await writeFile(proxyPath, Buffer.concat([builtProxy.subarray(0, firstLine), fixture, builtProxy.subarray(firstLine)]), { mode: 0o600 });
  await mkdir(runtime, { mode: 0o700 });
  const normalizedSessionId = "cloud-question-session";
  const cursorCloud = { schema: "paperclip.cursor-cloud.config.v1" as const, repos: [{ url: "https://github.com/example/repo" }] };
  await writeFile(configPath, JSON.stringify({ ...cursorCloud, binding: { companyId: "company", agentId: "agent", issueId: "issue", normalizedSessionId } }), { mode: 0o600 });
  let authority: DurablePrpControlPlane | undefined;
  const bundle = createRunnerdCodexTransport({
    provider: "cursor_cloud", cursorCloud, stateDirectory: join(root, "runner-session"),
    runnerBinary: defaultCapabilityRunnerdBinary(), providerNodeCommand, cursorCloudProxyPath: proxyPath,
    cursorCloudProxySha256: `sha256:${createHash("sha256").update(await readFile(proxyPath)).digest("hex")}`,
    lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
    prpIdentity: { runnerInstanceId: "runner-cloud-question", environmentLeaseId: "lease-cloud-question",
      runId: "00000000-0000-4000-8000-000000000763", normalizedSessionId, turnId: "turn-cloud-question", itemId: "item-cloud-question" },
    environment: {
      PATH: process.env.PATH, CURSOR_API_KEY: "synthetic-cloud-launch-key",
      PAPERCLIP_CURSOR_CLOUD_CONFIG_PATH: configPath, PAPERCLIP_CURSOR_CLOUD_ARTIFACT_ROOT: join(runtime, "artifacts"),
      PAPERCLIP_CURSOR_CLOUD_RELAY_SOCKET_PATH: socketPath, PAPERCLIP_CURSOR_CLOUD_RELAY_TOKEN: "synthetic-cloud-relay-token",
      PAPERCLIP_CURSOR_CLOUD_RELAY_URL: "https://relay.example.test/mcp", PAPERCLIP_CURSOR_CLOUD_RELAY_EXPIRES_AT: String(Date.now() + 60_000),
    },
    controlPlaneRegistration: async core => { authority = core; await core.start(); return { release: () => undefined }; },
  });
  const questionApplied = vi.fn(async () => ({ success: true, contentItems: [{ type: "inputText", text: JSON.stringify({ status: "applied", questionId: "question-controlled" }) }] }));
  bundle.transport.setServerRequestHandler(questionApplied);
  const mcp = async (body: Record<string, unknown>, sessionId?: string): Promise<{ sessionId?: string; value: any }> => {
    const scopeHeader = await currentCloudScopeHeader(runtime, normalizedSessionId);
    return new Promise((accept, reject) => {
    const req = request({ socketPath, path: "/mcp", method: "POST", headers: { Authorization: "Bearer synthetic-cloud-relay-token", [RUNNER_TOOL_SCOPE_TOKEN_HEADER]: scopeHeader, "content-type": "application/json", ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}) } }, response => {
      let text = "";
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => accept({ sessionId: response.headers["mcp-session-id"] as string | undefined, value: JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end(JSON.stringify({ jsonrpc: "2.0", ...body }));
    });
  };
  try {
    if (governed) {
      await writeFile(join(root, "AGENTS.md"), "Keep assigned instructions.");
      const digest = "0".repeat(64);
      const context = {
        prompt: { revision: PAPERCLIP_EXECUTION_PROMPT_REVISION, text: PAPERCLIP_EXECUTION_PROMPT, digest: nativeRuntimePromptDigest() },
        instructions: { entryPath: "AGENTS.md", bundle: { schema: NATIVE_RUNTIME_ASSET_SCHEMA, digest, manifestDigest: digest, rootPath: root, fileCount: 1, totalBytes: 27 } },
        skills: [], mcp: { assignmentSetId: "none", digest, bindingId: null },
      };
      const input: NativeExecutionInputV5 = {
        schema: "paperclip.native-execution-input.v5", executionMode: planning ? "plan" : "default",
        planningContext: planning ? { documentId: "plan-document", baseRevisionId: "plan-revision-3", baseRevisionNumber: 3,
          markdown: "# Pinned canonical plan", sha256: createHash("sha256").update("# Pinned canonical plan").digest("hex"), reviewContext: { feedback: "Keep the requested scope" } } : null,
        binding: { companyId: "company", agentId: "agent", issueId: "issue", runId: "00000000-0000-4000-8000-000000000763", executionWorkspaceId: "workspace" },
        task: { identifier: "CLOUD-QUESTION", title: "Ask the assigned question", description: null, prompt: "Ask before proceeding.", workMode: planning ? "planning" : "standard" },
        workspace: { cwd: root, repoUrl: null, repoRef: null, branchName: null },
        session: { normalizedSessionId, driverKind: "cursor_cloud_api", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
        provider: { kind: "cursor_cloud", model: "explicit-model", cursorCloud },
        runtimeContext: { ...context, aggregateDigest: canonicalNativeRuntimeContextDigest(context) },
        completionContract: { id: "contract", sha256: digest, schemaVersion: "paperclip.completion-contract.v1", contract: { revision: "1", objective: "Ask before proceeding.", criteria: [{ id: "question", requirement: "Request the response." }] } },
        interactionResponses: [], credentialBindings: [],
      };
      const yielded: PrpStructuredRunResult = {
        schema: "paperclip.run_result.v1", reportedWorkDisposition: "yielded", summary: "Waiting for the requested response.",
        completionClaim: { contractRevision: "1", objectiveSatisfied: false, criteria: [{ criterionId: "question", status: "unknown", evidenceRefs: ["interaction:pending"] }], remainingWork: [{ description: "Resume after the response.", blocksCompletion: true }] },
        evidence: [{ ref: "interaction:pending" }], verification: [], attentionRequests: [], artifacts: [{ kind: "issue_thread_interaction", ref: "interaction:pending" }],
        continuation: { kind: "response_wake", summary: "Resume from the answer.", idempotencyKey: "interaction-response:pending" },
      };
      const backend = createRunnerdNativeSessionBackend(input, { runnerInstanceId: "runner-cloud-question", transportFactory: () => bundle.transport,
        dynamicTools: [{ name: "request_human_input", description: "Ask the user a required question.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
        dynamicToolHandler: questionApplied,
      });
      const history: PrpEvent[] = [];
      const completeRun = vi.fn(async () => undefined);
      const execution = executeNativeSession({ input, backend, runnerInstanceId: "runner-cloud-question", controlPlaneInstanceId: "control-cloud-question", timeoutMs: 120_000,
        controlPlane: {
          async openRun() {}, async checkpointSession() {}, completeRun,
          async appendEvent(event: PrpEvent) { history.push(event); return { cursor: history.length, highestContiguousSourceSeq: event.sourceSeq, disposition: "committed" }; },
          async replayEvents(replay) { return { events: history.filter(event => event.sourceInstanceId === replay.sourceInstanceId && event.sourceSeq > replay.afterSourceSeq), highestContiguousSourceSeq: 0 }; },
        },
        resolveGovernedWait: ({ event }) => event.eventType === "item.completed" && event.payload.kind === "dynamicToolCall" ? yielded : null,
      });
      void execution.catch(() => undefined);
      await Promise.race([execution, vi.waitFor(() => expect(authority?.store.state.commands.some(command => command.type === "turn.start" && command.status === "completed")).toBe(true), { timeout: 10_000 })]);
      const initialized = await mcp({ id: 0, method: "initialize" });
      const response = await mcp({ id: 1, method: "tools/call", params: { name: "request_human_input", arguments: {} } }, initialized.sessionId);
      expect(response.value.result.isError).not.toBe(true);
      await expect(execution).resolves.toMatchObject({ result: yielded });
      expect(completeRun).toHaveBeenCalledOnce();
      expect(history.some(event => event.eventType === "turn.interrupted")).toBe(true);
    } else {
    const opened = await bundle.transport.request("thread/start", { cwd: root, model: "explicit-model", baseInstructions: "Ask the assigned question.", dynamicTools: [{ name: "request_human_input", description: "Ask the user a required question.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] });
    const threadId = (opened.thread as { id: string }).id;
    const started = await bundle.transport.request("turn/start", { threadId, input: [{ type: "text", text: "Ask before proceeding." }] });
    const initialized = await mcp({ id: 0, method: "initialize" });
    const response = await mcp({ id: 1, method: "tools/call", params: { name: "request_human_input", arguments: {} } }, initialized.sessionId);
    expect(response.value.result.isError).not.toBe(true);
    expect(JSON.stringify(response.value)).toContain("question-controlled");
    expect(questionApplied).toHaveBeenCalledOnce();
    await bundle.transport.request("turn/interrupt", { threadId, turnId: (started.turn as { id: string }).id });
    await vi.waitFor(() => expect(authority!.store.state.committedEvents.some(event => event.eventType === "turn.interrupted")).toBe(true), { timeout: 5_000 });
    expect(authority!.store.state.commands.some(command => command.type === "turn.stop")).toBe(false);
    expect(authority!.store.state.committedEvents.filter(event => ["turn.interrupted", "turn.completed", "turn.failed"].includes(event.eventType))).toHaveLength(1);
    expect(authority!.store.state.commands.filter(command => command.type === "semantic_tool.result")).toHaveLength(1);
    }
    await bundle.transport.close();
    expect(bundle.evidence().runnerExited).toBe(true);
    await expect(stat(socketPath)).rejects.toHaveProperty("code", "ENOENT");
    const calls = (await readFile(fetchLog, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(call => call.path === "/v1/agents" && call.method === "POST")).toHaveLength(1);
    expect(calls.filter(call => call.path.endsWith("/cancel") && call.method === "POST")).toHaveLength(1);
  } finally {
    await bundle.transport.close().catch(() => undefined);
    await authority?.stop();
    await rm(root, { recursive: true, force: true });
  }
}

it.each([0, 18_000])("delivers an applied Cloud question and courtesy-interrupt terminal without Stop (%ims)", async terminalDelayMs => {
  await cloudQuestionHandoff(terminalDelayMs, false);
}, 40_000);

it.each([0, 18_000])("settles a governed Cloud question after its allowed cancellation latency (%ims)", async terminalDelayMs => {
  await cloudQuestionHandoff(terminalDelayMs, true);
}, 45_000);

it("preserves semantic planning and its pinned revision through the real Rust Cloud default harness", async () => {
  await cloudQuestionHandoff(0, true, true);
}, 30_000);
