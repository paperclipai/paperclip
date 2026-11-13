/** Opt-in paid smoke:
 * PAPERCLIP_LIVE_TOOL_RESULTS=true pnpm --filter @paperclipai/server exec vitest run src/services/native-runtime/runner-tool-results.live.test.ts
 * Requires a built native runner and an existing Codex login. Uses disposable
 * database/storage and a private credential copy. The app response is synthetic;
 * Codex, Runner, PRP, persistence and authenticated asset reads are real.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { agents, heartbeatRuns, issues } from "@paperclipai/db";
import { startRunnerApiTestServer } from "./runner-api-server.js";
import { createAssignedMcpTools } from "../../services/native-runtime/assigned-mcp-tools.js";
import { PaperclipRunnerToolAuthority } from "../../services/native-runtime/paperclip-runner-tool-authority.js";
import type { ToolGatewayService } from "../../services/tool-gateway.js";
import { createRunnerdCodexTransport } from "../../vendor/paperclip-runner/index.js";
import { RUNNER_TOOL_RESULT_MAX_BYTES } from "../../services/native-runtime/runner-tool-results.js";

const root = await mkdtemp(join(tmpdir(), "paperclip-tool-result-live-"));
let server: Awaited<ReturnType<typeof startRunnerApiTestServer>> | undefined;
let bundle: ReturnType<typeof createRunnerdCodexTransport> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  const codexHome = join(root, "codex");
  await mkdir(codexHome, { mode: 0o700 });
  await copyFile(join(process.env.PAPERCLIP_LIVE_CODEX_HOME ?? homedir() + "/.codex", "auth.json"), join(codexHome, "auth.json"));
  await writeFile(join(codexHome, "config.toml"), 'model_reasoning_effort = "low"\n');
  process.env.PAPERCLIP_HOME = join(root, "instance");
  process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
  process.env.PAPERCLIP_TELEMETRY_DISABLED = "1";
  server = await startRunnerApiTestServer();
  const fixture = await server.fixture({ disableWakeOnDemand: true, apiToolsEnabled: false });
  await server.db.update(agents).set({ permissions: { trustPreset: "low_trust_review", authorizationPolicy: {
    trustBoundary: { mode: "low_trust_review", companyId: fixture.companyId, issueIds: [fixture.issueId], allowedAgentIds: [fixture.agentId] },
  } } }).where(eq(agents.id, fixture.agentId));
  const marker = `verified-${randomUUID()}`;
  const original = { untrusted: true, content: "x".repeat(660_000), verificationCode: marker };
  let executions = 0;
  const assignedMcpTools = await createAssignedMcpTools({
    gatewayPublicId: "fixture", bearerToken: "fixture",
    gateway: {
      listToolsForNamedGateway: async () => [{ name: "fixture:read_review_file", displayName: "Read review file",
        description: "Read the synthetic review file.", parametersSchema: { type: "object", properties: {}, additionalProperties: false },
        pluginId: "fixture", providerType: "mcp_remote_http", risk: "read" }],
      executeTool: async () => { executions++; return { status: "completed", result: original }; },
    } as unknown as ToolGatewayService,
  });
  const authority = new PaperclipRunnerToolAuthority(server.db, { ...fixture.authority.binding, assignedMcpTools });
  const toolName = assignedMcpTools.definitions()[0]!.name as string;
  const tools = authority.definitions().filter(tool => [toolName, "read_tool_result"].includes(String(tool.name)));
  const calls: Array<{ tool: string; resultBytes: number }> = [];
  const pages: Array<{ offsetBytes: number; nextOffsetBytes: number | null }> = [];
  let retrieved = "";
  const started = Date.now();
  bundle = createRunnerdCodexTransport({
    codexCommand: process.env.PAPERCLIP_LIVE_CODEX_COMMAND ?? fileURLToPath(new URL("../../../../node_modules/.pnpm/@openai+codex@0.160.0/node_modules/@openai/codex/bin/codex.js", import.meta.url)),
    sourceCodexHome: codexHome, environment: { ...process.env, CODEX_HOME: codexHome },
    disableCodexProjectInstructions: true,
    stateDirectory: join(root, "runner"),
    lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
    prpIdentity: { runnerInstanceId: "tool-result-live", environmentLeaseId: "tool-result-lease",
      runId: fixture.runId, normalizedSessionId: "tool-result-session", turnId: "tool-result-turn", itemId: "tool-result-item" },
  });
  bundle.transport.setServerRequestHandler(async request => {
    const params = request.params;
    const result = await authority.execute({ tool: String(params.tool), arguments: params.arguments, callId: String(params.callId) });
    const json = JSON.stringify(result);
    calls.push({ tool: String(params.tool), resultBytes: Buffer.byteLength(json) });
    const page = result as { data?: string; responseText?: { offsetBytes: number; nextOffsetBytes: number | null } };
    if (params.tool === "read_tool_result" && page.responseText && typeof page.data === "string") {
      assert.equal(page.responseText.offsetBytes, Buffer.byteLength(retrieved), "Pages must continue without gaps or repeated bytes");
      retrieved += page.data;
      pages.push(page.responseText);
    }
    return { success: true, contentItems: [{ type: "inputText", text: json }] };
  });
  await bundle.transport.request("initialize", {});
  await bundle.transport.request("thread/start", {
    cwd: fixture.workspace, model: "gpt-6.1-sol", approvalPolicy: "never", sandbox: "read-only",
    dynamicTools: tools,
  });
  await bundle.transport.request("turn/start", { input: [{ type: "text",
    text: `Call ${toolName} once. Read the entire result. If it is saved, call read_tool_result starting at offsetBytes 0, then follow each responseText.nextOffsetBytes until null. Reply with the verificationCode at the end. Do not skip pages, repeat the original call, or use shell tools. This is a disposable integration test.`,
  }] });
  let answer = "";
  await Promise.race([
    (async () => {
      for await (const notification of bundle!.transport.notifications()) {
        const item = notification.params.item as { type?: string; text?: string } | undefined;
        if (notification.method === "item/completed" && item?.type === "agentMessage") answer += item.text ?? "";
        if (notification.method === "turn/completed") return;
      }
      throw new Error("Provider stream ended without a completed turn");
    })(),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Live tool-result delivery timed out")), 180_000); }),
  ]);
  clearTimeout(timer);
  assert.equal(executions, 1, "The original operation must execute once");
  assert.ok(calls.some(call => call.tool === "read_tool_result"), "Provider must retrieve the saved result");
  assert.ok(calls.every(call => call.resultBytes <= RUNNER_TOOL_RESULT_MAX_BYTES), "All delivered results must fit PRP");
  assert.ok(calls.some(call => call.resultBytes > 490_000), "Provider must receive a page near the 500 KB limit");
  assert.equal(pages.length, 2, "The full 660 KB result should require only two page reads");
  assert.equal(pages.at(-1)?.nextOffsetBytes, null, "Provider must read through EOF");
  assert.equal(retrieved, JSON.stringify(original), "Every byte of the original result must be delivered");
  assert.ok(answer.includes(marker), "Provider must receive the result's final field");
  await bundle.transport.close();
  bundle = undefined;
  await server.db.update(issues).set({ executionRunId: null }).where(eq(issues.id, fixture.issueId));
  await server.db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, fixture.runId));
  const evidence = { passed: true, model: "gpt-6.1-sol", trust: "low_trust_review", platform: `${process.platform}-${process.arch}`,
    responseBytes: Buffer.byteLength(JSON.stringify(original)), executions, calls, allPagesDelivered: true, providerReceivedFinalField: true,
    runnerClosed: true, durationMs: Date.now() - started, upstream: "synthetic governed response" };
  if (process.env.PAPERCLIP_LIVE_EVIDENCE_PATH) await writeFile(process.env.PAPERCLIP_LIVE_EVIDENCE_PATH, JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence));
} finally {
  clearTimeout(timer);
  await bundle?.transport.close();
  await server?.close();
  await rm(root, { recursive: true, force: true });
}
