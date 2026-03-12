import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  asBoolean,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  redactEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  renderTemplate,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import {
  detectCodexAuthRequired,
  parseCodexJsonl,
  isCodexUnknownSessionError
} from "./parse.js";
import {
  hasNonEmptyEnvValue,
  loginCodexWithApiKey,
  resolveCodexApiKeyHome,
  resolveCodexAuthMode,
} from "./auth.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const PAPERCLIP_SKILLS_CANDIDATES = [
  path.resolve(__moduleDir, "../../skills"),         // published: <pkg>/dist/server/ -> <pkg>/skills/
  path.resolve(__moduleDir, "../../../../../skills"), // dev: src/server/ -> repo root/skills/
];
const CODEX_ROLLOUT_NOISE_RE =
  /^\d{4}-\d{2}-\d{2}T[^\s]+\s+ERROR\s+codex_core::rollout::list:\s+state db missing rollout path for thread\s+[a-z0-9-]+$/i;

function stripCodexRolloutNoise(text: string): string {
  const parts = text.split(/\r?\n/);
  const kept: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      kept.push(part);
      continue;
    }
    if (CODEX_ROLLOUT_NOISE_RE.test(trimmed)) continue;
    kept.push(part);
  }
  return kept.join("\n");
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function readEnvBindingValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.type === "plain" && typeof record.value === "string") {
    return record.value;
  }
  return null;
}

function resolveCodexBillingType(env: Record<string, string>): "api" | "subscription" {
  // Codex uses API-key auth when OPENAI_API_KEY is present; otherwise rely on local login/session auth.
  return hasNonEmptyEnvValue(env, "OPENAI_API_KEY") ? "api" : "subscription";
}

function codexHomeDir(): string {
  const fromEnv = process.env.CODEX_HOME;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv.trim();
  return path.join(os.homedir(), ".codex");
}

async function resolvePaperclipSkillsDir(): Promise<string | null> {
  for (const candidate of PAPERCLIP_SKILLS_CANDIDATES) {
    const isDir = await fs.stat(candidate).then((s) => s.isDirectory()).catch(() => false);
    if (isDir) return candidate;
  }
  return null;
}

async function ensureCodexSkillsInjected(onLog: AdapterExecutionContext["onLog"], homeDir?: string) {
  const skillsDir = await resolvePaperclipSkillsDir();
  if (!skillsDir) return;

  const skillsHome = path.join(homeDir ?? codexHomeDir(), "skills");
  await fs.mkdir(skillsHome, { recursive: true });
  const entries = await fs.readdir(skillsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const source = path.join(skillsDir, entry.name);
    const target = path.join(skillsHome, entry.name);
    const existing = await fs.lstat(target).catch(() => null);
    if (existing) continue;

    try {
      await fs.symlink(source, target);
      await onLog(
        "stderr",
        `[paperclip] Injected Codex skill "${entry.name}" into ${skillsHome}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to inject Codex skill "${entry.name}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

async function isReadableFile(filePath: string): Promise<boolean> {
  return fs.stat(filePath).then((s) => s.isFile()).catch(() => false);
}

async function isReadableDirectory(dirPath: string): Promise<boolean> {
  return fs.stat(dirPath).then((s) => s.isDirectory()).catch(() => false);
}

async function resolveRuntimeInstructionsFilePath(
  configuredPath: string,
  env: Record<string, string>,
): Promise<string> {
  const trimmed = configuredPath.trim();
  if (!trimmed) return "";
  if (await isReadableFile(trimmed)) return trimmed;

  const agentHome = env.AGENT_HOME?.trim();
  if (!agentHome) return trimmed;
  const fallbackPath = path.join(agentHome, "AGENTS.md");
  if (await isReadableFile(fallbackPath)) return fallbackPath;
  return trimmed;
}

type CodexExecutionInput = Pick<
  AdapterExecutionContext,
  "runId" | "agent" | "config" | "context" | "authToken" | "onLog"
>;

type CodexRuntimeConfig = {
  command: string;
  model: string;
  modelReasoningEffort: string;
  search: boolean;
  bypass: boolean;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
  extraArgs: string[];
  workspaceId: string;
  workspaceSource: string;
  workspaceRepoUrl: string;
  workspaceRepoRef: string;
  runtimeSessionId: string;
  runtimeSessionCwd: string;
  billingType: "api" | "subscription";
};

async function buildCodexRuntimeConfig(
  input: CodexExecutionInput
): Promise<CodexRuntimeConfig> {
  const { runId, agent, config, context, authToken, onLog } = input;

  const command = asString(config.command, "codex");
  const model = asString(config.model, "");
  const modelReasoningEffort = asString(
    config.modelReasoningEffort,
    asString(config.reasoningEffort, "")
  );
  const search = asBoolean(config.search, false);
  const bypass = asBoolean(
    config.dangerouslyBypassApprovalsAndSandbox,
    asBoolean(config.dangerouslyBypassSandbox, false)
  );

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> =>
          typeof value === "object" && value !== null
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const configuredCwdReadable =
    configuredCwd.length > 0 ? await isReadableDirectory(configuredCwd) : false;
  const cwd =
    workspaceSource === "agent_home"
      ? (configuredCwdReadable ? configuredCwd : workspaceCwd || process.cwd())
      : (workspaceCwd || configuredCwd || process.cwd());
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof readEnvBindingValue(envConfig.PAPERCLIP_API_KEY) === "string" &&
    readEnvBindingValue(envConfig.PAPERCLIP_API_KEY)!.trim().length > 0;
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;

  const wakeTaskId =
    (typeof context.taskId === "string" &&
      context.taskId.trim().length > 0 &&
      context.taskId.trim()) ||
    (typeof context.issueId === "string" &&
      context.issueId.trim().length > 0 &&
      context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" &&
      context.wakeCommentId.trim().length > 0 &&
      context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" &&
      context.commentId.trim().length > 0 &&
      context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" &&
    context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0
      )
    : [];
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) {
    env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  }
  if (workspaceCwd) env.PAPERCLIP_WORKSPACE_CWD = workspaceCwd;
  if (workspaceSource) env.PAPERCLIP_WORKSPACE_SOURCE = workspaceSource;
  if (workspaceId) env.PAPERCLIP_WORKSPACE_ID = workspaceId;
  if (workspaceRepoUrl) env.PAPERCLIP_WORKSPACE_REPO_URL = workspaceRepoUrl;
  if (workspaceRepoRef) env.PAPERCLIP_WORKSPACE_REPO_REF = workspaceRepoRef;
  if (workspaceHints.length > 0) {
    env.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(workspaceHints);
  }
  for (const [k, v] of Object.entries(envConfig)) {
    const resolved = readEnvBindingValue(v);
    if (typeof resolved === "string") env[k] = resolved;
  }
  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  const agentRuntimeBaseDir = process.env.PAPERCLIP_AGENT_RUNTIME_DIR;
  if (agentRuntimeBaseDir && !hasNonEmptyEnvValue(env, "AGENT_HOME")) {
    const instructionsPathForHome = asString(config.instructionsFilePath, "").trim();
    const slug = instructionsPathForHome
      ? path.basename(path.dirname(instructionsPathForHome))
      : agent.id;
    const agentHome = path.join(agentRuntimeBaseDir, slug);
    env.AGENT_HOME = agentHome;
    await fs.mkdir(agentHome, { recursive: true }).catch(() => {});
  }

  const authModeSetting =
    typeof config.paperclipAuthMode === "string" ? config.paperclipAuthMode.trim() : "";
  if (!Object.prototype.hasOwnProperty.call(env, "OPENAI_API_KEY")) {
    const globalKey = process.env.OPENAI_API_KEY?.trim();
    if (authModeSetting === "instance_api_key") {
      env.OPENAI_API_KEY = globalKey ?? "";
    } else if (globalKey) {
      env.OPENAI_API_KEY = globalKey;
    }
  }

  const authMode = resolveCodexAuthMode(config, env);
  if (authMode === "api_key") {
    const codexHome = resolveCodexApiKeyHome(env);
    env.CODEX_HOME = codexHome;
    env.HOME = codexHome;
    await fs.mkdir(codexHome, { recursive: true }).catch(() => {});
  } else if (!hasNonEmptyEnvValue(env, "CODEX_HOME") && env.AGENT_HOME) {
    const codexHome = path.join(env.AGENT_HOME, ".codex");
    env.CODEX_HOME = codexHome;
    await fs.mkdir(codexHome, { recursive: true }).catch(() => {});
  }
  await ensureCodexSkillsInjected(onLog, env.CODEX_HOME);

  const billingType =
    authMode === "api_key" ? "api" : resolveCodexBillingType(env);
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

  const runtimeSessionParams = parseObject((input as AdapterExecutionContext).runtime?.sessionParams);
  const runtimeSessionId = asString(
    runtimeSessionParams.sessionId,
    (input as AdapterExecutionContext).runtime?.sessionId ?? ""
  );
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");

  return {
    command,
    model,
    modelReasoningEffort,
    search,
    bypass,
    cwd,
    env,
    timeoutSec,
    graceSec,
    extraArgs,
    workspaceId,
    workspaceSource,
    workspaceRepoUrl,
    workspaceRepoRef,
    runtimeSessionId,
    runtimeSessionCwd,
    billingType
  };
}

function buildLoginResult(proc: {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}) {
  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: proc.timedOut,
    loginUrl: null,
    stdout: proc.stdout,
    stderr: proc.stderr
  };
}

export async function runCodexLogin(input: {
  runId: string;
  agent: AdapterExecutionContext["agent"];
  config: Record<string, unknown>;
  context?: Record<string, unknown>;
  authToken?: string;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}) {
  const onLog = input.onLog ?? (async () => {});
  const runtime = await buildCodexRuntimeConfig({
    runId: input.runId,
    agent: input.agent,
    config: input.config,
    context: input.context ?? {},
    authToken: input.authToken,
    onLog,
  } as CodexExecutionInput);

  const proc = await runChildProcess(input.runId, runtime.command, ["login"], {
    cwd: runtime.cwd,
    env: runtime.env,
    timeoutSec: runtime.timeoutSec,
    graceSec: runtime.graceSec,
    onLog,
  });

  return buildLoginResult({
    ...proc,
    stderr: stripCodexRolloutNoise(proc.stderr),
  });
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, authToken } = ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const runtimeConfig = await buildCodexRuntimeConfig(ctx);
  const {
    command,
    model,
    modelReasoningEffort,
    search,
    bypass,
    cwd,
    env,
    timeoutSec,
    graceSec,
    extraArgs,
    workspaceId,
    workspaceSource,
    workspaceRepoUrl,
    workspaceRepoRef,
    runtimeSessionId,
    runtimeSessionCwd,
    billingType,
  } = runtimeConfig;
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
  const sessionId = canResumeSession ? runtimeSessionId : null;
  if (runtimeSessionId && !canResumeSession) {
    await onLog(
      "stderr",
      `[paperclip] Codex session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }
  const configuredInstructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsFilePath = await resolveRuntimeInstructionsFilePath(
    configuredInstructionsFilePath,
    env,
  );
  const instructionsDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  if (
    configuredInstructionsFilePath &&
    configuredInstructionsFilePath !== instructionsFilePath
  ) {
    await onLog(
      "stderr",
      `[paperclip] Configured instructionsFilePath "${configuredInstructionsFilePath}" was not readable; using "${instructionsFilePath}" instead.\n`,
    );
  }
  let instructionsPrefix = "";
  if (instructionsFilePath) {
    try {
      const instructionsContents = await fs.readFile(instructionsFilePath, "utf8");
      instructionsPrefix =
        `${instructionsContents}\n\n` +
        `The above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsDir}.\n\n`;
      await onLog(
        "stderr",
        `[paperclip] Loaded agent instructions file: ${instructionsFilePath}\n`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stderr",
        `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }
  const commandNotes = (() => {
    if (!instructionsFilePath) return [] as string[];
    if (instructionsPrefix.length > 0) {
      return [
        `Loaded agent instructions from ${instructionsFilePath}`,
        `Prepended instructions + path directive to stdin prompt (relative references from ${instructionsDir}).`,
      ];
    }
    return [
      `Configured instructionsFilePath ${instructionsFilePath}, but file could not be read; continuing without injected instructions.`,
    ];
  })();
  const renderedPrompt = renderTemplate(promptTemplate, {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  });
  const prompt = `${instructionsPrefix}${renderedPrompt}`;

  const buildArgs = (resumeSessionId: string | null) => {
    const args = ["exec", "--json"];
    if (search) args.unshift("--search");
    if (bypass) args.push("--dangerously-bypass-approvals-and-sandbox");
    if (model) args.push("--model", model);
    if (modelReasoningEffort) args.push("-c", `model_reasoning_effort=${JSON.stringify(modelReasoningEffort)}`);
    if (extraArgs.length > 0) args.push(...extraArgs);
    if (resumeSessionId) args.push("resume", resumeSessionId, "-");
    else args.push("-");
    return args;
  };

  if (billingType === "api") {
    const apiKey = env.OPENAI_API_KEY?.trim() ?? "";
    if (!apiKey) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "OPENAI_API_KEY is required for Codex API-key auth mode.",
        errorCode: "codex_auth_required",
        provider: "openai",
        model,
        billingType,
        costUsd: null,
        resultJson: {
          stdout: "",
          stderr: "",
        },
        summary: null,
      };
    }

    const login = await loginCodexWithApiKey({
      runId: `${runId}-codex-api-key-login`,
      command,
      cwd,
      env,
      apiKey,
      timeoutSec: Math.max(20, timeoutSec || 0),
      graceSec,
      onLog: async (stream, chunk) => {
        if (stream === "stderr") {
          await onLog(stream, chunk);
        }
      },
    });
    if (login.timedOut || (login.exitCode ?? 1) !== 0) {
      return {
        exitCode: login.exitCode,
        signal: login.signal,
        timedOut: login.timedOut,
        errorMessage:
          firstNonEmptyLine(login.stderr) ||
          firstNonEmptyLine(login.stdout) ||
          "Codex API-key login failed.",
        errorCode: "codex_auth_required",
        provider: "openai",
        model,
        billingType,
        costUsd: null,
        resultJson: {
          stdout: login.stdout,
          stderr: login.stderr,
        },
        summary: null,
      };
    }
  }

  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildArgs(resumeSessionId);
    if (onMeta) {
      await onMeta({
        adapterType: "codex_local",
        command,
        cwd,
        commandNotes,
        commandArgs: args.map((value, idx) => {
          if (idx === args.length - 1 && value !== "-") return `<prompt ${prompt.length} chars>`;
          return value;
        }),
        env: redactEnvForLogs(env),
        prompt,
        context,
      });
    }

    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env,
      stdin: prompt,
      timeoutSec,
      graceSec,
      onLog: async (stream, chunk) => {
        if (stream !== "stderr") {
          await onLog(stream, chunk);
          return;
        }
        const cleaned = stripCodexRolloutNoise(chunk);
        if (!cleaned.trim()) return;
        await onLog(stream, cleaned);
      },
    });
    const cleanedStderr = stripCodexRolloutNoise(proc.stderr);
    return {
      proc: {
        ...proc,
        stderr: cleanedStderr,
      },
      rawStderr: proc.stderr,
      parsed: parseCodexJsonl(proc.stdout),
    };
  };

  const toResult = (
    attempt: { proc: { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string }; rawStderr: string; parsed: ReturnType<typeof parseCodexJsonl> },
    clearSessionOnMissingSession = false,
  ): AdapterExecutionResult => {
    if (attempt.proc.timedOut) {
      return {
        exitCode: attempt.proc.exitCode,
        signal: attempt.proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        clearSession: clearSessionOnMissingSession,
      };
    }

    const resolvedSessionId = attempt.parsed.sessionId ?? runtimeSessionId ?? runtime.sessionId ?? null;
    const resolvedSessionParams = resolvedSessionId
      ? ({
        sessionId: resolvedSessionId,
        ...(workspaceSource !== "agent_home" ? { cwd } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
        ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
      } as Record<string, unknown>)
      : null;
    const parsedError = typeof attempt.parsed.errorMessage === "string" ? attempt.parsed.errorMessage.trim() : "";
    const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
    const fallbackErrorMessage =
      parsedError ||
      stderrLine ||
      `Codex exited with code ${attempt.proc.exitCode ?? -1}`;
    const authRequired = detectCodexAuthRequired({
      stdout: attempt.proc.stdout,
      stderr: `${attempt.proc.stderr}\n${attempt.rawStderr}`,
      errorMessage: parsedError || null,
    });

    return {
      exitCode: attempt.proc.exitCode,
      signal: attempt.proc.signal,
      timedOut: false,
      errorMessage:
        (attempt.proc.exitCode ?? 0) === 0
          ? null
          : fallbackErrorMessage,
      errorCode:
        (attempt.proc.exitCode ?? 0) === 0
          ? null
          : authRequired
            ? "codex_auth_required"
            : null,
      usage: attempt.parsed.usage,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: "openai",
      model,
      billingType,
      costUsd: null,
      resultJson: {
        stdout: attempt.proc.stdout,
        stderr: attempt.proc.stderr,
      },
      summary: attempt.parsed.summary,
      clearSession: Boolean(clearSessionOnMissingSession && !resolvedSessionId),
    };
  };

  const initial = await runAttempt(sessionId);
  if (
    sessionId &&
    !initial.proc.timedOut &&
    (initial.proc.exitCode ?? 0) !== 0 &&
    isCodexUnknownSessionError(initial.proc.stdout, initial.rawStderr)
  ) {
    await onLog(
      "stderr",
      `[paperclip] Codex resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
    );
    const retry = await runAttempt(null);
    return toResult(retry, true);
  }

  return toResult(initial);
}
