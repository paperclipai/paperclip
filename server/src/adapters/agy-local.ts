import fs from "node:fs/promises";
import path from "node:path";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestResult,
  AdapterExecutionResult,
  ProviderQuotaResult,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  buildInvocationEnvForLogs,
  buildPaperclipEnv,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  joinPromptSections,
  parseObject,
  renderPaperclipWakePrompt,
  renderTemplate,
  runChildProcess,
  stringifyPaperclipWakePayload,
} from "@paperclipai/adapter-utils/server-utils";

const AGY_MODEL = "gemini-3.5-flash";
const AGY_COMMAND = "agy";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function summarizeOutput(stdout: string, stderr: string): string {
  const text = stdout.trim() || stderr.trim();
  return text.replace(/\s+/g, " ").trim().slice(0, 2_000);
}

async function readInstructionsPrefix(instructionsFilePath: string): Promise<string> {
  if (!instructionsFilePath) return "";
  const contents = await fs.readFile(instructionsFilePath, "utf8");
  const instructionsDir = `${path.dirname(instructionsFilePath)}/`;
  return [
    contents,
    "",
    `The above agent instructions were loaded from ${instructionsFilePath}.`,
    `Resolve any relative file references from ${instructionsDir}.`,
  ].join("\n");
}

function buildAgyEnv(input: {
  agent: { id: string; companyId: string; adapterConfig: unknown };
  runId: string;
  context: Record<string, unknown>;
  authToken?: string;
}): Record<string, string> {
  const env = buildPaperclipEnv(input.agent);
  env.PAPERCLIP_RUN_ID = input.runId;

  const wakeTaskId =
    (typeof input.context.taskId === "string" && input.context.taskId.trim()) ||
    (typeof input.context.issueId === "string" && input.context.issueId.trim()) ||
    "";
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;

  const wakeReason = typeof input.context.wakeReason === "string" ? input.context.wakeReason.trim() : "";
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;

  const wakePayloadJson = stringifyPaperclipWakePayload(input.context.paperclipWake);
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;

  const config = parseObject(input.agent.adapterConfig);
  const hasExplicitApiKey =
    typeof config.PAPERCLIP_API_KEY === "string" && config.PAPERCLIP_API_KEY.trim().length > 0;
  if (!hasExplicitApiKey && input.authToken) env.PAPERCLIP_API_KEY = input.authToken;

  return env;
}

async function execute(ctx: Parameters<ServerAdapterModule["execute"]>[0]): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const command = asString(config.command, AGY_COMMAND);
  const cwd = asString(config.cwd, "") || process.cwd();
  const model = asString(config.model, AGY_MODEL).trim() || AGY_MODEL;
  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 15);
  const sandbox = asBoolean(config.sandbox, true);
  const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, true);
  const extraArgs = asStringArray(config.extraArgs);

  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const envConfig = parseObject(config.env);
  const env = {
    ...buildAgyEnv({ agent, runId, context, authToken }),
    ...Object.fromEntries(
      Object.entries(envConfig).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
  };
  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  let instructionsPrefix = "";
  const instructionsFilePath = asString(config.instructionsFilePath, "");
  if (instructionsFilePath) {
    try {
      instructionsPrefix = await readInstructionsPrefix(instructionsFilePath);
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Warning: could not read AGY instructions file "${instructionsFilePath}": ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  }

  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, {
    resumedSession: Boolean(runtime.sessionId),
  });
  const renderedPrompt = renderTemplate(
    asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE),
    templateData,
  );
  const prompt = joinPromptSections([
    instructionsPrefix,
    wakePrompt,
    asString(context.paperclipSessionHandoffMarkdown, "").trim(),
    renderedPrompt,
  ]);

  const args = ["--print"];
  if (sandbox) args.push("--sandbox");
  if (dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
  if (timeoutSec > 0) args.push("--print-timeout", `${timeoutSec}s`);
  if (extraArgs.length > 0) args.push(...extraArgs);
  args.push(prompt);

  await onMeta?.({
    adapterType: "agy_local",
    command,
    cwd,
    commandArgs: args.map((value, index) => (index === args.length - 1 ? `<prompt ${prompt.length} chars>` : value)),
    commandNotes: [
      "AGY runs through local OAuth/session state; Paperclip does not collect Google API keys.",
      "Prompt is passed to Antigravity CLI non-interactive --print mode.",
      "Quota is monitored as warn-only until AGY exposes machine-readable usage windows.",
    ],
    env: buildInvocationEnvForLogs(env, { runtimeEnv, resolvedCommand: command }),
    prompt,
    promptMetrics: {
      promptChars: prompt.length,
      instructionsChars: instructionsPrefix.length,
      wakePromptChars: wakePrompt.length,
      heartbeatPromptChars: renderedPrompt.length,
    },
    context,
  });

  const result = await runChildProcess(runId, command, args, {
    cwd,
    env,
    timeoutSec,
    graceSec,
    onLog,
    onSpawn,
  });
  const failed = result.timedOut || (result.exitCode ?? 1) !== 0;

  return {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    errorMessage: failed ? summarizeOutput(result.stdout, result.stderr) || "AGY CLI run failed" : null,
    provider: "google",
    biller: "google",
    model,
    billingType: "subscription",
    summary: summarizeOutput(result.stdout, result.stderr),
  };
}

async function testEnvironment(ctx: Parameters<ServerAdapterModule["testEnvironment"]>[0]) {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, AGY_COMMAND);
  const cwd = asString(config.cwd, "") || process.cwd();
  const model = asString(config.model, AGY_MODEL).trim() || AGY_MODEL;

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    checks.push({
      code: "agy_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "agy_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  try {
    await ensureCommandResolvable(command, cwd, ensurePathInEnv(process.env));
    checks.push({
      code: "agy_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "agy_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
      hint: "Install Antigravity CLI from https://antigravity.google/docs/cli-getting-started and ensure `agy` is on PATH.",
    });
  }

  if (model !== AGY_MODEL) {
    checks.push({
      code: "agy_model_not_certified",
      level: "error",
      message: `agy_local must use ${AGY_MODEL} for the MVP-certified Google lane.`,
      detail: model,
    });
  } else {
    checks.push({
      code: "agy_model_certified",
      level: "info",
      message: `AGY model is pinned to ${AGY_MODEL}.`,
    });
  }

  checks.push({
    code: "agy_oauth_local_session",
    level: "info",
    message: "AGY uses local Google OAuth/session state.",
    hint: "Run `agy` once if Google sign-in is required. Paperclip never stores the OAuth token.",
  });
  checks.push({
    code: "agy_quota_unknown",
    level: "warn",
    message: "Antigravity CLI does not expose machine-readable quota windows yet.",
    hint: "Paperclip will warn and continue unless a run reports quota exhaustion.",
  });

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}

async function getQuotaWindows(): Promise<ProviderQuotaResult> {
  try {
    await ensureCommandResolvable(AGY_COMMAND, process.cwd(), ensurePathInEnv(process.env));
  } catch (err) {
    return {
      provider: "google",
      adapterType: "agy_local",
      source: "agy-cli",
      authState: "missing",
      quotaState: "unknown",
      ok: false,
      error: err instanceof Error ? err.message : "AGY CLI is not available",
      action: "Install Antigravity CLI and ensure `agy` is on PATH.",
      windows: [],
    };
  }

  return {
    provider: "google",
    adapterType: "agy_local",
    source: "agy-cli",
    authState: "unknown",
    quotaState: "unknown",
    ok: false,
    error: "Antigravity CLI is available, but machine-readable quota windows are not exposed yet.",
    action: "Run `agy` once to complete Google sign-in if needed; Paperclip will warn and continue.",
    windows: [],
  };
}

export const agyLocalAdapter: ServerAdapterModule = {
  type: "agy_local",
  execute,
  testEnvironment,
  sessionManagement: {
    supportsSessionResume: false,
    nativeContextManagement: "unknown",
    defaultSessionCompaction: {
      enabled: true,
      maxSessionRuns: 0,
      maxRawInputTokens: 0,
      maxSessionAgeHours: 0,
    },
  },
  models: [{ id: AGY_MODEL, label: "Gemini 3.5 Flash" }],
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  getRuntimeCommandSpec: (config) => ({
    command: asString(config.command, AGY_COMMAND),
    detectCommand: asString(config.command, AGY_COMMAND),
    installCommand: null,
  }),
  agentConfigurationDoc: `# agy_local agent configuration

Adapter: agy_local

Use when:
- You want Paperclip to run Antigravity CLI locally through the operator's Google OAuth/session.
- You want the canonical Google local lane for new work.

Core fields:
- cwd (string, optional): working directory for AGY.
- instructionsFilePath (string, optional): absolute path to markdown instructions prepended to the prompt.
- model (string): must be ${AGY_MODEL}.
- command (string, optional): defaults to "agy".
- sandbox (boolean, optional): passes --sandbox when true.
- dangerouslySkipPermissions (boolean, optional): passes --dangerously-skip-permissions when true.
- timeoutSec (number, optional): maps to --print-timeout.
- extraArgs (string[], optional): additional AGY CLI args inserted before the prompt.

Notes:
- Paperclip does not collect GOOGLE_API_KEY or GEMINI_API_KEY for agy_local.
- AGY quota is surfaced as warn-only until the CLI exposes machine-readable quota windows.
`,
  getQuotaWindows,
};
