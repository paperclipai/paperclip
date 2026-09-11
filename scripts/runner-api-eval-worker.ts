/** JSONL worker for the companion paperclip-evals API suite. Never selects cases or retries. */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { runnerApiCatalog } from "../server/src/services/native-runtime/runner-api-catalog.js";
import { startRunnerApiTestServer } from "../server/src/__tests__/helpers/runner-api-server.js";
import { registerRunnerPrpAuthority } from "../server/src/realtime/runner-prp-ws.js";
import { createRunnerdCodexTransport, defaultCapabilityRunnerdBinary } from "../packages/paperclip-runner/src/live/runnerd-codex-transport.js";
import { createSkilllessCodexThreadConfig } from "../packages/paperclip-runner/src/drivers/codex/codex-app-server-driver.js";
import { AttemptJournal } from "../packages/paperclip-runner/src/evals/attempt-journal.js";
import { estimateModelCostNanodollars } from "../packages/paperclip-runner/src/evals/model-pricing.js";
import { CONNECTION_INTENT_AGENT_GUIDANCE } from "../packages/shared/src/connection-intent-guidance.js";

if (process.argv.includes("--catalog")) {
  process.stdout.write(JSON.stringify(runnerApiCatalog()) + "\n");
  process.exit(0);
}
if (!process.argv.includes("--jsonl")) throw new Error("Use --catalog or --jsonl; there is no default campaign");
process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID() + randomUUID();
const output = (value: unknown) => process.stdout.write("RUNNER_API_EVAL " + JSON.stringify(value) + "\n");
const OPENROUTER_MODELS = new Set(["openrouter/anthropic/claude-sonnet-5", "openrouter/deepseek/deepseek-v4-flash-0731", "openrouter/google/gemini-3.8-flash"]);
// The controller selects and injects one provider credential. The worker never
// reads ambient home credential files or desktop keychains.
function openRouterEnvironment() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key || /\s/.test(key)) throw new Error("Controller must inject OPENROUTER_API_KEY");
  return { PATH: process.env.PATH, OPENROUTER_API_KEY: key };
}
const server = await startRunnerApiTestServer();
const fileDigests = new Map<string, Promise<string | null>>();
function fileDigest(path: string): Promise<string | null> {
  let digest = fileDigests.get(path);
  if (!digest) {
    digest = (async () => {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      return hash.digest("hex");
    })().catch(() => null);
    fileDigests.set(path, digest);
  }
  return digest;
}
const runtimeBuild = {
  runnerBinarySha256: await fileDigest(defaultCapabilityRunnerdBinary()),
  workerSourceSha256: await fileDigest(resolve("scripts/runner-api-eval-worker.ts")),
  lockfileSha256: await fileDigest(resolve("pnpm-lock.yaml")),
};
output({ ready: true });
const record = (value: unknown): Record<string, any> => value && typeof value === "object" ? value as Record<string, any> : {};

try {
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    if (request.shutdown) break;
    const directory = resolve(request.outputDirectory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const journal = new AttemptJournal(join(directory, "journal.jsonl"));
    const startedAt = new Date().toISOString();
    journal.append({ kind: "attempt_started", attemptId: request.attemptId, model: request.model, startedAt });
    const started = performance.now();
    const isOpenRouter = OPENROUTER_MODELS.has(request.model);
    const provider = isOpenRouter ? "opencode" : request.model === "claude-sonnet-5" ? "acpx" : "codex";
    let providerVersion: string | null = null;
    const fixture = await server.fixture({ mode: request.mode, apiToolsEnabled: request.arm !== "baseline", reset: true, connectionScenario: request.connectionScenario });
    const initialState = await fixture.snapshot();
    const substitutions = Object.fromEntries(Object.entries(fixture).filter(([, value]) => typeof value === "string"));
    const expand = (value: any): any => typeof value === "string" ? value.replace(/\{\{(\w+)\}\}/g, (_, key) => String(substitutions[key] ?? (() => { throw new Error(`Unknown fixture variable ${key}`); })())) : Array.isArray(value) ? value.map(expand) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expand(entry)])) : value;
    const calls: Record<string, any>[] = [], notifications: unknown[] = [];
    const observedToolCallIds = new Set<string>();
    const definitions = await fixture.authority.definitions();
    const prompt = expand(request.prompt ?? "");
    let error: string | null = null, evidence: unknown = null, thread: Record<string, any> = {}, usage: Record<string, any> | null = null;
    let usageUpdates = 0, lastUsageFingerprint = "", terminalSeen = false, providerTurnStarted = false;
    let diagnosticTail: string | null = null;
    let bundle: ReturnType<typeof createRunnerdCodexTransport> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const invoke = async (tool: string, args: unknown, callId: string) => {
      observedToolCallIds.add(callId);
      if (observedToolCallIds.size > 12) throw new Error("Attempt tool-call ceiling reached");
      const call: Record<string, any> = { tool, arguments: args, callId, startedMs: performance.now() - started };
      calls.push(call);
      journal.append({ kind: "tool_dispatch", ...call });
      try { call.result = await fixture.authority.execute({ tool, arguments: args, callId }); }
      catch (caught) { call.error = caught instanceof Error ? caught.message : String(caught); call.status = record(caught).status; }
      call.durationMs = performance.now() - started - call.startedMs;
      journal.append({ kind: "tool_result", ...call });
      return call;
    };
    try {
      if (request.calls) {
        for (const [i, call] of request.calls.entries()) await invoke(call.tool, expand(call.arguments), call.callId ?? `direct-${i}`);
        usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, estimatedCostNanodollars: 0, providerRequests: 0, accountingProvenance: "Provider-free direct authority contract; no provider or runnerd dispatched" };
      } else {
        if (request.model === "claude-sonnet-5" && (process.platform !== "linux" || process.arch !== "x64")) throw new Error("Qualified ACPX Claude requires Linux x64; no provider turn was dispatched");
        if (!request.reservationId || request.maxCostUsd !== 0.5 || !["gpt-5.6-luna", "claude-sonnet-5", ...OPENROUTER_MODELS].includes(request.model)) throw new Error("Paid attempt requires ledger reservation and qualified model");
        if (isOpenRouter) {
          providerVersion = execFileSync(resolve("packages/paperclip-runner/node_modules/opencode-ai/bin/opencode.exe"), ["--version"], { encoding: "utf8" }).trim();
          if (providerVersion !== "1.18.29") throw new Error("OpenCode profile requires version 1.18.29");
        }
        const providerEnvironment = isOpenRouter ? openRouterEnvironment() : request.model === "claude-sonnet-5" ? (() => {
            const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
            if (!token) throw new Error("Controller must inject CLAUDE_CODE_OAUTH_TOKEN");
            return { PATH: process.env.PATH, CLAUDE_CODE_OAUTH_TOKEN: token };
          })() : undefined;
        bundle = createRunnerdCodexTransport({
          provider, acpxAgent: "claude", acpxPermissionMode: "approve-reads",
          environment: { ...providerEnvironment, PAPERCLIP_PROVIDER_TRACE_PATH: join(directory, "provider-trace.jsonl"), PAPERCLIP_PROVIDER_TRACE_MAX_BYTES: String(32 * 1024 * 1024) },
          codexCommand: request.model === "gpt-5.6-luna" ? realpathSync(execFileSync("which", ["codex"], { encoding: "utf8" }).trim()) : undefined,
          sourceCodexHome: process.env.CODEX_HOME ?? join(homedir(), ".codex"),
          runnerBinary: defaultCapabilityRunnerdBinary(), stateDirectory: join(server.root, `runner-${request.attemptId}`),
          lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
          prpIdentity: { runnerInstanceId: `runner-${fixture.runId}`, environmentLeaseId: `lease-${fixture.runId}`, runId: fixture.runId, normalizedSessionId: `session-${fixture.runId}`, turnId: `turn-${fixture.runId}`, itemId: `item-${fixture.runId}` },
          controlPlaneRegistration: (prp) => registerRunnerPrpAuthority({ companyId: fixture.companyId, runId: fixture.runId, authority: prp }),
        });
        const active = bundle;
        timer = setTimeout(() => { error = "Attempt exceeded 120 seconds"; void active.transport.close(error); }, 120_000);
        bundle.transport.setServerRequestHandler(async (request) => {
          const params = record(request.params);
          const result = await invoke(String(params.tool), params.arguments, String(params.callId));
          return { success: !result.error, contentItems: [{ type: "inputText", text: JSON.stringify(result.error ? { ok: false, error: result.error, status: result.status } : { ok: true, result: result.result }) }] };
        });
        await bundle.transport.request("initialize", {});
        thread = await bundle.transport.request("thread/start", {
          cwd: fixture.workspace, model: request.model,
          completionContract: { revision: "runner-api-eval-v1", criterionIds: ["objective"] },
          config: { ...createSkilllessCodexThreadConfig(fixture.workspace), model_reasoning_effort: "low" },
          permissions: "paperclip-runner-workspace-only", runtimeWorkspaceRoots: [fixture.workspace], approvalPolicy: "never",
          baseInstructions: "You are operating a disposable real Paperclip company. Use the provided tools to do the user's task. Do not use shell, network, skills, or credentials. Stop when the requested work is verified. " + (request.arm === "baseline" ? "" : "Prefer available dedicated tools. Only use search_api and call_api when no dedicated tool supports the required operation or parameters. Do not search before ordinary dedicated tool use.") + "\n" + CONNECTION_INTENT_AGENT_GUIDANCE,
          dynamicTools: definitions, experimentalRawEvents: true, persistExtendedHistory: true,
        });
        if (request.preflight) {
          terminalSeen = true;
          usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, estimatedCostNanodollars: 0, providerRequests: 0, preflight: true };
        } else {
        journal.append({ kind: "provider_turn_dispatch", thread, at: new Date().toISOString() });
        providerTurnStarted = true;
        await bundle.transport.request("turn/start", { input: [{ type: "text", text: prompt }] });
        for await (const notification of bundle.transport.notifications()) {
          const retained = { ...notification, observedAt: new Date().toISOString() };
          journal.append({ kind: "notification", ...retained });
          notifications.push(retained);
          const item = record(record(notification.params).item);
          if (["dynamicToolCall", "tool_call", "tool_result"].includes(item.type) && typeof item.id === "string") {
            observedToolCallIds.add(item.id);
            if (observedToolCallIds.size > 12) { error = "Attempt tool-call ceiling reached, including provider-rejected calls"; break; }
          }
          if (notification.method === "thread/tokenUsage/updated") {
            const params = record(notification.params);
            const tokenUsage = record(params.tokenUsage);
            const cumulative = record(tokenUsage.total ?? tokenUsage.totalTokenUsage ?? tokenUsage.total_token_usage ?? tokenUsage);
            if (request.model === "claude-sonnet-5" && params.runDeltaAvailable !== true) continue;
            const total = request.model === "claude-sonnet-5" ? record(tokenUsage.runDelta) : cumulative;
            const cacheWriteTokens = total.cacheWriteTokens ?? 0;
            const inputTokens = (total.inputTokens ?? total.input_tokens) + (request.model === "claude-sonnet-5" ? (total.cacheReadTokens ?? 0) : isOpenRouter ? (total.cacheReadTokens ?? total.cachedInputTokens ?? 0) : 0);
            const outputTokens = total.outputTokens ?? total.output_tokens;
            const cachedInputTokens = total.cacheReadTokens ?? total.cachedInputTokens ?? total.cache_read_input_tokens ?? 0;
            if ([inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens].every(value => Number.isSafeInteger(value) && value >= 0)) {
              const fingerprint = `${inputTokens}:${outputTokens}:${cachedInputTokens}`;
              if (fingerprint !== lastUsageFingerprint) { usageUpdates++; lastUsageFingerprint = fingerprint; }
              usage = { inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens, providerRequests: (total.requests ?? total.providerRequests ?? 0) > 0 ? total.requests ?? total.providerRequests : null, providerUsageUpdateCount: usageUpdates, providerRequestCountSource: (total.requests ?? total.providerRequests ?? 0) > 0 ? "provider" : "not reported; providerUsageUpdateCount is a proxy", providerReportedCostNanodollars: cumulative.providerCostUsd > 0 ? Math.round(cumulative.providerCostUsd * 1e9) : null, ...estimateModelCostNanodollars(request.model, { inputTokens, outputTokens, cachedInputTokens }) };
              // A conservative one-hour cache-write ceiling (2× standard input)
              // covers either cache duration when the runtime omits its TTL.
              if (request.model === "claude-sonnet-5" || request.model === "openrouter/anthropic/claude-sonnet-5") {
                usage.estimatedCostNanodollars += cacheWriteTokens * 4_000;
                usage.cacheWriteUsdPerMillionTokens = 4;
                usage.cacheWritePricing = "Conservative one-hour cache-write rate; TTL not exposed";
              }
              if (Math.max(usage.estimatedCostNanodollars, usage.providerReportedCostNanodollars ?? 0) >= 500_000_000) { error = "Attempt cost ceiling reached"; break; }
            }
          }
          if (notification.method === "turn/completed") {
            terminalSeen = true;
            const params = record(notification.params);
            const terminal = record(params.turn);
            if ((params.status ?? terminal.status) === "failed") error = String(record(params.error ?? terminal.error).message ?? "Provider turn failed");
            break;
          }
        }
        }
        evidence = bundle.evidence();
        if (!request.preflight && (!usage || usage.inputTokens + usage.outputTokens === 0)) {
          usage = null;
          error ??= "Missing provider accounting; block further paid attempts";
        }
      }
    } catch (caught) { error ??= caught instanceof Error ? caught.message : String(caught); }
    finally {
      if (timer) clearTimeout(timer);
      if (bundle) {
        evidence = bundle.evidence();
        diagnosticTail = await readFile(join(server.root, `runner-${request.attemptId}`, "diagnostics", "runnerd.stderr.log"), "utf8").then(text => text.slice(-16000).replace(/sk-(?:ant-|or-v1-)[A-Za-z0-9_-]+/g, "[redacted]").replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]").replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted JWT]")).catch(() => null);
      }
      await bundle?.transport.close();
    }
    if (!providerTurnStarted && !request.calls) {
      usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, estimatedCostNanodollars: 0, providerRequests: 0, accountingProvenance: "No provider turn/start was dispatched" };
    }
    const artifact = {
      schema: "paperclip-runner/eval-session-artifact/v1", attemptId: request.attemptId,
      requestedModel: request.calls ? "provider-free" : request.model ?? "provider-free", provider: request.calls ? "none" : provider, driver: request.calls ? "direct-authority-contract" : "real-server-api-tools",
      evidenceMode: request.calls ? "provider-free-contract" : "live-provider",
      providerSessionId: record(thread.thread).id ?? null, effectiveModel: record(thread.thread).model ?? null,
      providerVersion: request.calls ? null : request.model === "gpt-5.6-luna" ? execFileSync("codex", ["--version"], { encoding: "utf8" }).trim() : providerVersion ?? record(evidence).providerVersion ?? null,
      runtimeVersions: { node: process.versions.node, acpx: record(evidence).providerVersion, agentServer: record(evidence).agentServerVersion, agentRuntime: record(evidence).agentRuntimeVersion },
      runtimeBuild,
      timing: { startedAt, finishedAt: new Date().toISOString(), durationMs: performance.now() - started },
      usage, accountingComplete: Boolean(request.calls) || !providerTurnStarted || terminalSeen, providerTurnStarted, observedProviderToolCalls: observedToolCallIds.size, diagnosticTail, error, calls, notifications, evidence, thread, prompt, arm: request.arm ?? "treatment",
      fixture: substitutions, initialState, state: await fixture.snapshot(),
      toolSchemaBytes: Buffer.byteLength(JSON.stringify(definitions)), definitions,
    };
    // The controller supplies a unique retained attempt directory; never overwrite evidence.
    journal.append({ kind: "attempt_finished", error, usage, terminalSeen, at: new Date().toISOString() });
    journal.close();
    await writeFile(join(directory, "artifact.json"), JSON.stringify(artifact, null, 2), { flag: "wx", mode: 0o600 });
    output({ attemptId: request.attemptId, artifactPath: join(directory, "artifact.json"), error, usage });
  }
} finally { await server.close(); }
