/**
 * Core execution for amplifier-local — wraps the amplifier-agent CLI via the
 * amplifier-agent-ts wrapper (≥0.6.1).
 *
 * Flow:
 *   1. Extract config (model, provider, env, timeout, instructions, cwd)
 *   2. Resolve effective cwd (paperclip workspace > config.cwd > process.cwd)
 *   3. Resolve managed dir, host_config path, skills dir
 *   4. Symlink paperclip skills into the managed skills dir (NEVER into cwd)
 *   5. Build subprocess env (PAPERCLIP_* + wake context + user env + api keys)
 *   6. Resolve session resume gate (cwd match)
 *   7. Render prompt (instructions prefix + wake delta + handoff + template)
 *   8. Write host_config.json (provider, approval mode "yes", skills dirs)
 *   9. Spawn via wrapper, providing a ChildProcessFactory that feeds onLog
 *      raw stream chunks and calls onSpawn with the PID
 *  10. Iterate DisplayEvents — collect result text, usage, session id, errors
 *  11. On unknown-session error during resume, retry once with --fresh and
 *      set clearSession=true on the result
 *  12. Return AdapterExecutionResult
 *
 * All MCP, argv, envelope parsing, NDJSON event parsing, SIGTERM/SIGKILL,
 * timeout enforcement, and protocol version checks are owned by the wrapper.
 * The adapter owns paperclip-side concerns: workspace, env, skills delivery,
 * host_config writing, prompt rendering, session-resume gating, paperclip
 * error classification.
 */

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  type AdapterExecutionContext,
  type AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import {
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  buildInvocationEnvForLogs,
  buildPaperclipEnv,
  ensurePaperclipSkillSymlink,
  joinPromptSections,
  parseObject,
  readPaperclipRuntimeSkillEntries,
  refreshPaperclipWorkspaceEnvForExecution,
  renderPaperclipWakePrompt,
  renderTemplate,
  resolvePaperclipDesiredSkillNames,
  stringifyPaperclipWakePayload,
} from "@paperclipai/adapter-utils/server-utils";

import {
  AaaError,
  type DisplayEvent,
  type McpServerConfig,
  spawnAgent,
} from "amplifier-agent-ts";

import {
  AMPLIFIER_LOCAL_PROVIDERS,
  DEFAULT_AMPLIFIER_LOCAL_MODEL,
  type AmplifierLocalProvider,
} from "../index.js";
import {
  type AmplifierAgentHostConfig,
  resolveAmplifierLocalManagedDir,
  resolveHostConfigPath,
  resolveSkillsDir,
  writeHostConfigAtomic,
} from "./amplifier-host-config.js";
import {
  asAmplifierErrorView,
  describeAmplifierError,
  isAmplifierApprovalUnconfiguredError,
  isAmplifierBundleLoadFailedError,
  isAmplifierProtocolMismatchError,
  isAmplifierUnknownSessionError,
} from "./parse.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Internal result shapes
// ---------------------------------------------------------------------------

interface RunAttemptOk {
  kind: "ok";
  sessionId: string;
  resultText: string;
  inputTokens: number;
  outputTokens: number;
  cost: number | null;
  terminalError: ReturnType<typeof asAmplifierErrorView> | null;
  /** Tail of stderr surfaced by the wrapper on the error event. */
  stderrBuffer: string;
}

interface RunAttemptSpawnError {
  kind: "spawn_error";
  result: AdapterExecutionResult;
}

type RunAttemptResult = RunAttemptOk | RunAttemptSpawnError;

// ---------------------------------------------------------------------------
// Provider inference
// ---------------------------------------------------------------------------

/**
 * Map a model id prefix to one of the four provider modules amplifier-agent
 * ships. The user picks a model in the paperclip UI; the adapter derives the
 * provider automatically. If the user wants `azure-openai` specifically (same
 * model names as `openai`), they pass `config.provider = "azure-openai"`.
 *
 *   claude-*                          → anthropic
 *   gpt-*, o1-*, o3-*, o4-*           → openai
 *   llama*, mistral*, qwen*, deepseek*, phi* → ollama
 */
function deriveAmplifierProvider(model: string): AmplifierLocalProvider {
  const trimmed = model.trim().toLowerCase();
  if (!trimmed) return "anthropic";
  if (trimmed.startsWith("claude-")) return "anthropic";
  if (
    trimmed.startsWith("gpt-") ||
    /^o[1-9]/i.test(trimmed) ||
    trimmed.startsWith("text-davinci-")
  ) {
    return "openai";
  }
  if (
    trimmed.startsWith("llama") ||
    trimmed.startsWith("mistral") ||
    trimmed.startsWith("qwen") ||
    trimmed.startsWith("deepseek") ||
    trimmed.startsWith("phi")
  ) {
    return "ollama";
  }
  // Default to anthropic for unrecognised prefixes — the bundle's
  // default_provider is "anthropic" anyway, and operators wanting a different
  // provider can set it explicitly via config.provider.
  return "anthropic";
}

function resolveProvider(
  configProvider: string,
  model: string,
): AmplifierLocalProvider {
  const explicit = configProvider.trim().toLowerCase();
  if (explicit && (AMPLIFIER_LOCAL_PROVIDERS as readonly string[]).includes(explicit)) {
    return explicit as AmplifierLocalProvider;
  }
  return deriveAmplifierProvider(model);
}

// ---------------------------------------------------------------------------
// Skills injection — symlink paperclip skills into the managed skills dir
// ---------------------------------------------------------------------------

/**
 * Ensure each desired paperclip skill is symlinked into the adapter's managed
 * skills dir. The engine's tool-skills module discovers skills by scanning
 * directories listed in `host_config.skills.skills`. We point it at this
 * managed dir (NOT the user's cwd) so the project checkout stays clean.
 *
 * Mirrors `ensureCodexSkillsInjected` from codex-local but lives under
 * paperclip's per-company managed dir instead of `$CODEX_HOME/skills/`.
 */
async function ensureAmplifierSkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
  skillsDir: string,
  skillsEntries: Array<{ key: string; runtimeName: string; source: string }>,
  desiredSkillNames: string[],
): Promise<void> {
  const desiredSet = new Set(desiredSkillNames);
  const filtered = skillsEntries.filter((e) => desiredSet.has(e.key));
  if (filtered.length === 0) return;
  await fs.mkdir(skillsDir, { recursive: true, mode: 0o700 });
  for (const entry of filtered) {
    const target = path.join(skillsDir, entry.runtimeName);
    try {
      const result = await ensurePaperclipSkillSymlink(entry.source, target);
      if (result === "skipped") continue;
      await onLog(
        "stdout",
        `[paperclip] ${result === "repaired" ? "Repaired" : "Injected"} ` +
          `amplifier-local skill "${entry.runtimeName}" into ${skillsDir}\n`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await onLog(
        "stderr",
        `[paperclip] Failed to inject amplifier-local skill "${entry.key}" into ${skillsDir}: ${msg}\n`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Session resume gate
// ---------------------------------------------------------------------------

interface RuntimeSessionParamsView {
  sessionId: string;
  cwd: string;
  workspaceId: string;
  repoUrl: string;
  repoRef: string;
}

function parseRuntimeSessionParams(raw: unknown): RuntimeSessionParamsView {
  const obj = parseObject(raw);
  return {
    sessionId: asString(obj.sessionId, ""),
    cwd: asString(obj.cwd, ""),
    workspaceId: asString(obj.workspaceId, ""),
    repoUrl: asString(obj.repoUrl, ""),
    repoRef: asString(obj.repoRef, ""),
  };
}

// ---------------------------------------------------------------------------
// User env layering (config.env + provider API keys)
// ---------------------------------------------------------------------------

/**
 * Provider env vars that amplifier-agent looks up when the host_config /
 * argv don't override. Listed here so we can warn / pass through the
 * operator's `config.env` values without enforcing a specific shape.
 */
const PROVIDER_ENV_VARS = new Set([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "OLLAMA_HOST",
]);

function layerUserEnv(
  env: Record<string, string>,
  userEnv: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(userEnv)) {
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// Error translation
// ---------------------------------------------------------------------------

/**
 * Convert a wrapper DisplayEvent of type "error" or a thrown AaaError into
 * the paperclip-side AmplifierErrorView used by the classifier helpers in
 * parse.ts.
 */
function errorEventToView(
  event: Extract<DisplayEvent, { type: "error" }>,
): ReturnType<typeof asAmplifierErrorView> {
  return asAmplifierErrorView({
    code: event.code,
    classification: event.classification,
    message: event.message,
    stderrTail: event.stderrTail ?? "",
  });
}

function aaaErrorToView(
  err: AaaError,
): ReturnType<typeof asAmplifierErrorView> {
  return asAmplifierErrorView({
    code: err.code,
    classification: err.classification ?? "unknown",
    message: err.message,
    stderrTail: err.stderrTail ?? "",
  });
}

// ---------------------------------------------------------------------------
// ChildProcessFactory — splits the subprocess output between the wrapper
// (NDJSON parsing) and paperclip's onLog (run viewer raw text)
// ---------------------------------------------------------------------------

/**
 * Build a child-process factory that the wrapper substitutes for
 * `child_process.spawn`. We use this hook to:
 *
 *   1. Forward raw stdout/stderr chunks to paperclip's `onLog` so the run
 *      viewer shows real-time output. The wrapper attaches its own listeners
 *      to the same streams for NDJSON parsing — Node EventEmitters allow
 *      multiple listeners, so both consumers see the data.
 *   2. Call paperclip's `onSpawn` with the subprocess PID so paperclip can
 *      track the live process (for cancellation, accounting, the run UI).
 *
 * Note that we still let the wrapper do the actual `child_process.spawn` —
 * the wrapper's process-group leadership (`detached: true`), SIGTERM grace
 * window, and SIGKILL escalation continue to work as before.
 */
function buildChildProcessFactory(
  onLog: AdapterExecutionContext["onLog"],
  onSpawn: AdapterExecutionContext["onSpawn"] | undefined,
) {
  return (
    command: string,
    args: readonly string[],
    spawnOptions: SpawnOptions,
  ): ChildProcess => {
    const child = spawn(command, args as string[], spawnOptions);
    if (child.pid !== undefined && onSpawn !== undefined) {
      void onSpawn({
        pid: child.pid,
        processGroupId: spawnOptions.detached === true ? child.pid : null,
        startedAt: new Date().toISOString(),
      });
    }
    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      void onLog("stdout", text);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      void onLog("stderr", text);
    });
    return child;
  };
}

// ---------------------------------------------------------------------------
// The execute() entrypoint
// ---------------------------------------------------------------------------

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } =
    ctx;

  // ---- 1. Config extraction ----
  const promptTemplate = asString(
    config.promptTemplate,
    DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const command = asString(config.command, "amplifier-agent");
  const model = asString(config.model, DEFAULT_AMPLIFIER_LOCAL_MODEL);
  const explicitProvider = asString(config.provider, "");
  const provider = resolveProvider(explicitProvider, model);
  const configuredCwd = asString(config.cwd, "");
  const instructionsFilePath = asString(config.instructionsFilePath, "");
  const timeoutSec = asNumber(config.timeoutSec, 0); // 0 = no timeout
  const allowProtocolSkew = asBoolean(config.allowProtocolSkew, false);
  const extraArgs = asStringArray(config.extraArgs);
  const envConfig = parseObject(config.env);
  const mcpServersConfig = parseObject(config.mcpServers);

  // ---- 2. Workspace + cwd resolution ----
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");

  // If the workspace source is "agent_home" but the operator explicitly set
  // config.cwd, honour the config. Otherwise the workspace cwd wins.
  const useConfiguredInsteadOfAgentHome =
    workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();

  // ---- 3. Managed dir + paths ----
  const managedDir = resolveAmplifierLocalManagedDir(process.env, agent.companyId);
  await fs.mkdir(managedDir, { recursive: true, mode: 0o700 });
  const hostConfigPath = resolveHostConfigPath(managedDir);
  const skillsDir = resolveSkillsDir(managedDir);

  // ---- 4. Skills injection ----
  // Read paperclip skills entries (from config or filesystem discovery) and
  // resolve the desired subset, then symlink each into the managed skills
  // dir. NEVER write into the user's cwd.
  const skillsEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkillNames = resolvePaperclipDesiredSkillNames(config, skillsEntries);
  await ensureAmplifierSkillsInjected(onLog, skillsDir, skillsEntries, desiredSkillNames);

  // ---- 5. Env assembly ----
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;

  // Wake / context vars (only set when present — don't pollute env with empty
  // strings).
  const wakeTaskId = asString(context.taskId, asString(context.issueId, ""));
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  const wakeReason = asString(context.wakeReason, "");
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  const wakeCommentId = asString(context.wakeCommentId, asString(context.commentId, ""));
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  const approvalId = asString(context.approvalId, "");
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  const approvalStatus = asString(context.approvalStatus, "");
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  const linkedIssueIds = asStringArray(context.issueIds);
  if (linkedIssueIds.length > 0) {
    env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  }
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;

  // Workspace env (PAPERCLIP_WORKSPACE_*).
  refreshPaperclipWorkspaceEnvForExecution({
    env,
    envConfig,
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceSource,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
  });

  // Auth token (server-issued JWT for paperclip API). The agent's tools can
  // read PAPERCLIP_API_KEY to call paperclip endpoints.
  const hasExplicitApiKey = "PAPERCLIP_API_KEY" in envConfig;
  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  // User-supplied env overrides last. This is where provider API keys come
  // from (ANTHROPIC_API_KEY etc.).
  layerUserEnv(env, envConfig);

  // ---- 6. Session resume gate ----
  const runtimeSessionParams = parseRuntimeSessionParams(runtime.sessionParams);
  const runtimeSessionId =
    runtimeSessionParams.sessionId || asString(runtime.sessionId, "");
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionParams.cwd.length === 0 ||
      path.resolve(runtimeSessionParams.cwd) === path.resolve(cwd));

  // If we have a saved session but the cwd doesn't match, log it so the
  // operator can see why we're starting fresh.
  if (runtimeSessionId && !canResumeSession) {
    await onLog(
      "stdout",
      `[paperclip] amplifier-agent session "${runtimeSessionId}" was saved for cwd ` +
        `"${runtimeSessionParams.cwd}" and will not be resumed in "${cwd}".\n`,
    );
  }

  // ---- 7. Prompt rendering ----
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedBootstrapPrompt =
    !canResumeSession && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, {
    resumedSession: canResumeSession,
  });
  const shouldUseResumeDeltaPrompt = canResumeSession && wakePrompt.length > 0;
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();

  // Instructions prefix is suppressed on the resume-delta path so we don't
  // re-inject project instructions into an already-warm session.
  const instructionsPrefix = await readInstructionsPrefix(
    instructionsFilePath,
    shouldUseResumeDeltaPrompt,
  );
  const renderedPrompt = shouldUseResumeDeltaPrompt
    ? ""
    : renderTemplate(promptTemplate, templateData);
  const prompt = joinPromptSections([
    instructionsPrefix,
    renderedBootstrapPrompt,
    wakePrompt,
    sessionHandoffNote,
    renderedPrompt,
  ]);

  // ---- 8. host_config.json ----
  // Provider config carries model. Approval mode "yes" matches the wrapper's
  // approval: { mode: "yes" } so the engine's G3 fail-fast is satisfied
  // either way (argv beats host_config, but both agree). Skills dir is the
  // managed one we just symlinked into.
  const hostConfig: AmplifierAgentHostConfig = {
    approval: { mode: "yes" },
    provider: {
      module: provider,
      config: { model },
    },
    skills: {
      skills: [skillsDir],
    },
    ...(allowProtocolSkew ? { allowProtocolSkew: true } : {}),
  };
  await writeHostConfigAtomic(hostConfigPath, hostConfig);

  // ---- 9. onMeta — record invocation before spawning ----
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv: process.env as Record<string, string>,
    includeRuntimeKeys: ["HOME", "USER", "PATH"],
  });
  if (onMeta) {
    await onMeta({
      adapterType: "amplifier_local",
      command,
      cwd,
      commandNotes: [
        `provider=${provider}`,
        `model=${model}`,
        `session=${canResumeSession ? "resume" : "fresh"}`,
        `protocol=0.3.0`,
      ],
      commandArgs: [
        "run",
        "--session-id",
        canResumeSession ? runtimeSessionId : "<fresh>",
        canResumeSession ? "--resume" : "--fresh",
        "--cwd",
        cwd,
        "--config",
        hostConfigPath,
        "--protocol-version",
        "0.3.0",
        "-y",
        `<prompt ${prompt.length} chars>`,
      ],
      env: loggedEnv,
      prompt,
      promptMetrics: {
        promptChars: prompt.length,
        instructionsChars: instructionsPrefix.length,
        bootstrapPromptChars: renderedBootstrapPrompt.length,
        wakePromptChars: wakePrompt.length,
        sessionHandoffChars: sessionHandoffNote.length,
        heartbeatPromptChars: renderedPrompt.length,
      },
      context,
    });
  }

  // ---- 10. Spawn + iterate events ----
  const mcpServers = toMcpServersMap(mcpServersConfig);
  const runAttempt = async (
    resumeSessionIdArg: string | null,
  ): Promise<RunAttemptResult> => {
    const sessionIdForRun = resumeSessionIdArg ?? createFreshSessionId(agent.id);
    let handle;
    try {
      handle = await spawnAgent({
        lifecycle: "one-shot",
        sessionId: sessionIdForRun,
        resume: resumeSessionIdArg !== null,
        cwd,
        env: {
          allowlist: Object.keys(env),
          extra: env,
        },
        providerOverride: provider,
        approval: { mode: "yes" },
        configPath: hostConfigPath,
        allowProtocolSkew,
        timeoutMs: timeoutSec > 0 ? timeoutSec * 1000 : undefined,
        ...(mcpServers ? { mcpServers } : {}),
        runChildProcess: buildChildProcessFactory(onLog, onSpawn),
      });
    } catch (err) {
      if (err instanceof AaaError) {
        return spawnAaaErrorToResult(err, command);
      }
      throw err;
    }

    let resolvedSessionId: string = sessionIdForRun;
    let resultText = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let cost: number | null = null;
    let terminalError: ReturnType<typeof asAmplifierErrorView> | null = null;
    let stderrBuffer = ""; // accumulates only what we can see via the error event's stderrTail

    for await (const event of handle.submit(prompt)) {
      switch (event.type) {
        case "init":
          resolvedSessionId = event.sessionId || resolvedSessionId;
          break;
        case "activity":
          // 2-second keep-alive ticks — paperclip doesn't need to see them.
          break;
        case "result":
          resultText = event.text;
          break;
        case "error":
          terminalError = errorEventToView(event);
          stderrBuffer = event.stderrTail ?? "";
          break;
        case "notification": {
          // Update structured state from the 9 stderr wire events.
          // We don't need to forward these as additional onLog calls — the
          // ChildProcessFactory already feeds raw stderr to onLog, and the
          // UI's parseStdoutLine maps the lines to TranscriptEntries.
          const method = event.method;
          const params = (event.params ?? {}) as Record<string, unknown>;
          if (method === "usage") {
            inputTokens = asNumber(params.inputTokens, inputTokens);
            outputTokens = asNumber(params.outputTokens, outputTokens);
            const c = params.cost;
            if (typeof c === "number") cost = c;
          } else if (method === "result/final") {
            const text = asString(params.text, "");
            if (text) resultText = text;
          }
          break;
        }
      }
    }

    const ok: RunAttemptOk = {
      kind: "ok",
      sessionId: resolvedSessionId,
      resultText,
      inputTokens,
      outputTokens,
      cost,
      terminalError,
      stderrBuffer,
    };
    return ok;
  };

  // First attempt: with resume if we have a valid session, else fresh.
  let attempt: RunAttemptResult = await runAttempt(
    canResumeSession ? runtimeSessionId : null,
  );

  // Unknown-session retry path: if resume failed with a session-not-found
  // error, retry with --fresh and set clearSession=true on the result.
  let clearSession = false;
  if (
    canResumeSession &&
    attempt.kind === "ok" &&
    attempt.terminalError &&
    isAmplifierUnknownSessionError(attempt.terminalError, attempt.stderrBuffer)
  ) {
    await onLog(
      "stdout",
      `[paperclip] amplifier-agent resume session "${runtimeSessionId}" is unavailable; ` +
        `retrying with a fresh session.\n`,
    );
    attempt = await runAttempt(null);
    clearSession = true;
  }

  // ---- 11. Build the AdapterExecutionResult ----
  if (attempt.kind === "spawn_error") {
    return attempt.result;
  }
  return buildResult({
    attempt,
    cwd,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    model,
    provider,
    clearSession,
  });
}

// ---------------------------------------------------------------------------
// Helpers used by execute()
// ---------------------------------------------------------------------------

async function readInstructionsPrefix(
  instructionsFilePath: string,
  shouldSuppressOnResume: boolean,
): Promise<string> {
  if (shouldSuppressOnResume) return "";
  if (!instructionsFilePath) return "";
  try {
    const contents = await fs.readFile(instructionsFilePath, "utf-8");
    return contents.trim().length > 0
      ? `${contents.trim()}\n\n(instructions sourced from: ${instructionsFilePath})`
      : "";
  } catch {
    // Silently skip — instructions file is optional; missing file shouldn't
    // block the run. The agent will run with bundle + skill content only.
    return "";
  }
}

function toMcpServersMap(
  raw: Record<string, unknown>,
): Record<string, McpServerConfig> | null {
  const entries = Object.entries(raw);
  if (entries.length === 0) return null;
  const out: Record<string, McpServerConfig> = {};
  for (const [name, value] of entries) {
    if (value && typeof value === "object") {
      out[name] = value as McpServerConfig;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function createFreshSessionId(agentId: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `pc-${agentId.slice(0, 8)}-${ts}-${rand}`;
}

function spawnAaaErrorToResult(
  err: AaaError,
  command: string,
): { kind: "spawn_error"; result: AdapterExecutionResult } {
  const view = aaaErrorToView(err);
  const errorMessage = describeAmplifierError(view, "", null);
  // Map common wrapper-side codes to paperclip-style adapter result fields.
  const isProtocol = isAmplifierProtocolMismatchError(view) || err.code === "protocol_version_mismatch";
  const isBinaryMissing = err.code === "binary_not_found";
  return {
    kind: "spawn_error",
    result: {
      exitCode: null,
      signal: null,
      timedOut: false,
      errorMessage:
        isBinaryMissing
          ? `${errorMessage} (install: uv tool install git+https://github.com/microsoft/amplifier-agent)`
          : errorMessage,
      errorCode: isProtocol
        ? "amplifier_protocol_mismatch"
        : isBinaryMissing
          ? "amplifier_binary_not_found"
          : err.code || "amplifier_spawn_failed",
      resultJson: {
        command,
        wrapperError: {
          code: err.code,
          classification: err.classification ?? "unknown",
          message: err.message,
          remediation: err.remediation ?? "",
        },
      },
    },
  };
}

function buildResult(input: {
  attempt: RunAttemptOk;
  cwd: string;
  workspaceId: string;
  workspaceRepoUrl: string;
  workspaceRepoRef: string;
  model: string;
  provider: string;
  clearSession: boolean;
}): AdapterExecutionResult {
  const { attempt, cwd, workspaceId, workspaceRepoUrl, workspaceRepoRef, model, provider, clearSession } =
    input;
  const errorMessage = attempt.terminalError
    ? describeAmplifierError(attempt.terminalError, attempt.stderrBuffer, null)
    : null;

  // Map engine error codes to adapter error codes for paperclip.
  let errorCode: string | null = null;
  if (attempt.terminalError) {
    if (isAmplifierUnknownSessionError(attempt.terminalError, attempt.stderrBuffer)) {
      errorCode = "amplifier_session_unknown";
    } else if (isAmplifierProtocolMismatchError(attempt.terminalError)) {
      errorCode = "amplifier_protocol_mismatch";
    } else if (isAmplifierApprovalUnconfiguredError(attempt.terminalError)) {
      errorCode = "amplifier_approval_unconfigured";
    } else if (isAmplifierBundleLoadFailedError(attempt.terminalError)) {
      errorCode = "amplifier_bundle_load_failed";
    } else {
      errorCode = `amplifier_${attempt.terminalError.classification || "engine"}`;
    }
  }

  const sessionParams = attempt.sessionId
    ? {
        sessionId: attempt.sessionId,
        cwd,
        ...(workspaceId ? { workspaceId } : {}),
        ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
        ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
      }
    : null;

  return {
    exitCode: attempt.terminalError ? 1 : 0,
    signal: null,
    timedOut: false,
    errorMessage,
    errorCode,
    usage: {
      inputTokens: attempt.inputTokens,
      outputTokens: attempt.outputTokens,
    },
    sessionId: attempt.sessionId,
    sessionParams,
    sessionDisplayId: attempt.sessionId,
    provider,
    model,
    costUsd: attempt.cost,
    summary: attempt.resultText,
    clearSession: clearSession && !attempt.sessionId,
  };
}


