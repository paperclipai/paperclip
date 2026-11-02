import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { PaperclipRunnerToolAuthority } from "../services/native-runtime/paperclip-runner-tool-authority.js";
import { buildNativeModelEnvelope, parseNativeExecutionInput, type NativeExecutionInput } from "../../../packages/paperclip-runner/src/contracts/native-execution.js";
import type { PersistedNativeSession } from "../../../packages/paperclip-runner/src/contracts/native-session-backend.js";
import { NATIVE_RUNTIME_ASSET_SCHEMA, PAPERCLIP_EXECUTION_PROMPT, PAPERCLIP_EXECUTION_PROMPT_REVISION, canonicalNativeRuntimeContextDigest, nativeRuntimePromptDigest } from "../../../packages/paperclip-runner/src/contracts/runtime-context.js";
import { createRunnerdNativeSessionBackend } from "../../../packages/paperclip-runner/src/backends/codex-native-backend.js";
import { resolveQualifiedAcpxProfile } from "../../../packages/paperclip-runner/src/drivers/acpx/qualified-profiles.js";
import { FakeCodexTransport, WORKSPACE } from "../../../packages/paperclip-runner/src/drivers/codex/codex-app-server-driver.test-support.js";
import { startOpenCodeMcpBridge } from "../../../packages/paperclip-runner/src/drivers/opencode/mcp-bridge.js";

// Production catalog selection, scripted provider transport: this measures what
// Paperclip delivers, not the vendor's private prompt, tokenizer or billing.
const root = new URL("../../../", import.meta.url);
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const identity = { companyId: "company", agentId: "agent", issueId: "issue", runId: "run", sessionId: "session" };
const tools = new PaperclipRunnerToolAuthority({} as Db, {
  ...identity, apiToolsEnabled: true, workspaceRoot: WORKSPACE,
}).definitions();
const { qualificationModel: _model, reportedModelId: _reportedModel, permissionPolicy: _policy, ...profile } = resolveQualifiedAcpxProfile("claude", "claude-sonnet-5");
const providers: NativeExecutionInput["provider"][] = [
  { kind: "codex", model: "gpt-5.6-sol", approvalPolicy: "never" },
  { kind: "acpx", agent: "claude", model: "claude-sonnet-5", permissionMode: "approve-all", profile },
  { kind: "opencode", model: "openrouter/deepseek/deepseek-v4-flash-0731", permissionMode: "allow" },
];
const receipts: unknown[] = [];
let mcpReceipt: unknown;
function measure(value: unknown) {
  const json = JSON.stringify(value);
  const normalized = json.replaceAll(WORKSPACE, "/workspace");
  return {
    utf8Bytes: Buffer.byteLength(json), characters: json.length, sha256: sha(json),
    normalizedComparison: { utf8Bytes: Buffer.byteLength(normalized), characters: normalized.length, sha256: sha(normalized) },
  };
}
function execution(provider: NativeExecutionInput["provider"]): NativeExecutionInput {
  const entry = readFileSync(new URL("server/src/onboarding-assets/default/AGENTS.md", root), "utf8");
  writeFileSync(`${WORKSPACE}/AGENTS.md`, entry);
  const context = {
    prompt: { revision: PAPERCLIP_EXECUTION_PROMPT_REVISION, text: PAPERCLIP_EXECUTION_PROMPT, digest: nativeRuntimePromptDigest() },
    instructions: { entryPath: "AGENTS.md", bundle: { schema: NATIVE_RUNTIME_ASSET_SCHEMA, rootPath: WORKSPACE, digest: sha(entry), manifestDigest: sha(entry), fileCount: 1, totalBytes: Buffer.byteLength(entry) } },
    skills: [], mcp: { assignmentSetId: "none", digest: "0".repeat(64), bindingId: null },
  };
  return parseNativeExecutionInput({
    schema: "paperclip.native-execution-input.v5", binding: { companyId: identity.companyId, agentId: identity.agentId, issueId: identity.issueId, runId: identity.runId, executionWorkspaceId: "workspace" },
    task: { identifier: "TASK-1", title: "Review delegated work", description: "Review delegated work", prompt: "Review delegated work.", workMode: "standard" },
    workspace: { cwd: WORKSPACE, repoUrl: null, repoRef: null, branchName: null },
    session: { normalizedSessionId: "session", driverKind: provider.kind === "acpx" ? "acpx_runtime" : provider.kind === "opencode" ? "opencode_server" : "codex_app_server", protocolVersion: 1 },
    provider, executionMode: "default", planningContext: null,
    completionContract: { id: "contract", sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.completion-contract.v1", contract: { revision: "1", objective: "Review delegated work", criteria: [{ id: "objective", requirement: "Review complete" }] } },
    interactionResponses: [], credentialBindings: [],
    runtimeContext: { ...context, aggregateDigest: canonicalNativeRuntimeContextDigest(context) },
  });
}
function transport(provider: NativeExecutionInput["provider"]) {
  return new FakeCodexTransport("thread-1", "provider-session-1", provider.kind === "acpx" ? {
    kind: "acpx", normalizedSessionId: "session", acpxRecordId: "fixture-record", backendSessionId: "fixture-backend",
    agentSessionId: "fixture-agent", profileDigest: `sha256:${"a".repeat(64)}`, workspaceDigest: `sha256:${"b".repeat(64)}`,
    requestedModel: provider.model, effectiveModel: provider.model, permissionMode: "approve-all",
    providerLifetimeFenceCandidates: [60001, 60002, 60003],
  } : undefined);
}

describe("production native procedure instruction measurement", () => {
  it("retains delivered serialized bytes separately from path-normalized comparison", () => {
    const value = { cwd: WORKSPACE, text: "λ" };
    expect(measure(value).utf8Bytes).toBe(Buffer.byteLength(JSON.stringify(value)));
    expect(measure(value).normalizedComparison.utf8Bytes).toBe(Buffer.byteLength(JSON.stringify({ ...value, cwd: "/workspace" })));
    expect(measure(value).sha256).not.toBe(measure(value).normalizedComparison.sha256);
  });

  it("uses the real standard-mode authority, including optional and connection tools", () => {
    expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      "hire_agent", "list_agents", "create_task", "set_dependencies", "connections_search", "connection_request", "register_deliverable",
    ]));
    expect(new Set(tools.map(tool => tool.name)).size).toBe(tools.length);
    const withoutApi = new PaperclipRunnerToolAuthority({} as Db, { ...identity, apiToolsEnabled: false }).definitions();
    expect(withoutApi.some(tool => tool.name === "hire_agent")).toBe(false);
  });

  for (const provider of providers) it(`captures the full ${provider.kind} start/resume/continuation payload`, async () => {
    const input = execution(provider);
    let checkpoint: PersistedNativeSession | undefined;
    for (const phase of ["start", "resume", "continuation"] as const) {
      const captured = transport(provider);
      captured.readResponse = { thread: { id: "thread-1", sessionId: "provider-session-1", cwd: WORKSPACE, turns: [] } };
      const current = phase === "continuation" ? parseNativeExecutionInput({ ...input, continuationPrompt: "Review the teammate's saved result." }) : input;
      const backend = createRunnerdNativeSessionBackend(current, { transportFactory: () => captured, dynamicTools: tools, environment: { PAPERCLIP_WORKSPACE_CWD: WORKSPACE } });
      const recovery = checkpoint ? await backend.recoverSession!(checkpoint, { signal: new AbortController().signal }) : null;
      if (recovery) expect(recovery.recovered).toBe(true);
      const session = recovery?.session ?? await backend.openSession({ identity, workingDirectory: WORKSPACE });
      try {
        checkpoint ??= await session.snapshot();
        const envelope = buildNativeModelEnvelope(current, phase === "continuation" ? { resumedSession: true } : undefined);
        if ("requestedSkills" in envelope && backend.preparedTaskConstraints) envelope.constraints = [...backend.preparedTaskConstraints];
        await session.startTurn({ message: { role: "user", text: JSON.stringify(envelope) } });
        const setup = captured.calls.find(call => call.method === (phase === "start" ? "thread/start" : "thread/resume"))!.params;
        const turn = captured.calls.find(call => call.method === "turn/start")!.params;
        const instructions = setup.developerInstructions ?? setup.baseInstructions;
        const delivered = setup.dynamicTools as Record<string, unknown>[];
        expect(delivered.filter(tool => !["paperclip_finish", "paperclip_block"].includes(String(tool.name)))).toEqual(tools);
        expect(delivered).toHaveLength(tools.length + 2);
        expect(instructions).toContain(PAPERCLIP_EXECUTION_PROMPT);
        expect(JSON.parse((turn.input as {text: string}[])[0]!.text)).toEqual(envelope);
        receipts.push({ provider: provider.kind, phase, instructions: measure(instructions), tools: measure(delivered), input: measure(turn.input),
          fullProjection: measure({ instructions, tools: delivered, input: turn.input }), deliveredToolCount: delivered.length });
      } finally { await session.close({ reason: "measurement" }); }
    }
  });

  it("preserves the full catalog through the actual OpenCode MCP tools/list bridge", async () => {
    const bridge = await startOpenCodeMcpBridge({ tools, handler: async () => { throw new Error("No tool execution in measurement"); } });
    try {
      const response = await fetch(bridge.url, { method: "POST", headers: { authorization: `Bearer ${bridge.secret}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
      expect(response.ok).toBe(true);
      const result = await response.json() as { result: { tools: Record<string, unknown>[] } };
      expect(result.result.tools.filter(tool => !["paperclip_finish", "paperclip_block"].includes(String(tool.name)))).toEqual(
        tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      );
      mcpReceipt = { boundary: "authenticated loopback MCP tools/list; no OpenCode/provider process", serverAnnotationsForwarded: false, tools: measure(result.result.tools), count: result.result.tools.length };
    } finally { await bridge.close(); }
  });
});

afterAll(() => {
  const output = process.env.PAPERCLIP_NATIVE_PROCEDURE_MEASUREMENT;
  if (!output) return;
  if (receipts.length !== 9 || !mcpReceipt) throw new Error("Refusing incomplete instruction measurement");
  const paths = [
    "server/src/onboarding-assets/default/AGENTS.md",
    "packages/paperclip-runner/src/contracts/runtime-context.ts",
    "packages/paperclip-runner/src/protocol-actions/hire-agent.ts",
    "packages/paperclip-runner/src/protocol-actions/create-task.ts",
    "packages/paperclip-runner/src/protocol-actions/set-dependencies.ts",
    "packages/paperclip-runner/src/catalog/semantic-action-catalog.ts",
    "packages/paperclip-runner/generated/semantic-action-catalog.json",
    "packages/paperclip-runner/generated/capability/semantic-tool-contracts.json",
    "packages/paperclip-runner/protocol/fixtures/evals/native-execution-seeded.json",
    "packages/paperclip-runner/protocol/manifest.json",
    "packages/paperclip-runner/src/backends/codex-native-backend.ts",
    "packages/paperclip-runner/src/drivers/opencode/mcp-bridge.ts",
    "server/src/services/native-runtime/paperclip-runner-tool-authority.ts",
    "server/src/services/connection-tool-definitions.ts",
    "packages/shared/src/connection-intent-guidance.ts",
    "packages/shared/src/validators/connection-intent.ts",
    "server/src/services/native-runtime/native-session-resume.ts",
    "server/src/__tests__/native-procedure-measurement.test.ts",
  ];
  writeFileSync(output, `${JSON.stringify({ schema: "paperclip.native-procedure-measurement.v2",
    sourceSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    sourceDirty: execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim().length > 0,
    measuredInputsDirty: execFileSync("git", ["status", "--porcelain", "--", ...paths], { cwd: root, encoding: "utf8" }).trim().length > 0,
    sourceHashes: Object.fromEntries(paths.map(path => [path, sha(readFileSync(new URL(path, root)))])),
    boundary: "scripted runnerd RPC with production standard-mode authority, API tools enabled, local workspace, no assigned external apps",
    byteAccounting: "utf8Bytes counts the unmodified JSON serialization of each extracted component/projection; normalizedComparison substitutes only the fixture workspace path. Neither is the entire transport request.",
    providerCalls: 0, tokenCount: null, upstreamLoadingOrTruncation: "unverified", vendorStockPrompt: "unavailable",
    toolDescriptions: tools.map(tool => ({ name: tool.name, characters: String(tool.description).length, utf8Bytes: Buffer.byteLength(String(tool.description)), inputSchema: measure(tool.inputSchema) })),
    receipts, mcpReceipt,
  }, null, 2)}\n`);
});
