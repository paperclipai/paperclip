import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asString,
  asStringArray,
  asNumber,
  asBoolean,
  parseObject,
  buildPaperclipEnv,
  redactEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  renderTemplate,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { parsePiJsonl } from "./parse.js";

const PI_AUTH_REQUIRED_RE =
  /(?:api[_\s-]?key|missing\s+credentials|authentication\s+required|unauthorized|forbidden|invalid\s+api\s+key|provider\s+requires\s+an\s+api\s+key|set\s+[A-Z0-9_]+_API_KEY)/i;

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const PAPERCLIP_SKILLS_CANDIDATES = [
  path.resolve(__moduleDir, "../../skills"), // published: <pkg>/dist/server -> <pkg>/skills
  path.resolve(__moduleDir, "../../../../../skills"), // dev: src/server -> repo root/skills
];

async function resolvePaperclipSkillsDir(): Promise<string | null> {
  for (const candidate of PAPERCLIP_SKILLS_CANDIDATES) {
    const isDir = await fs.stat(candidate).then((s) => s.isDirectory()).catch(() => false);
    if (isDir) return candidate;
  }
  return null;
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function resolvePiBillingType(env: Record<string, string>): "api" | "unknown" {
  const apiKeyNames = [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GROQ_API_KEY",
    "CEREBRAS_API_KEY",
    "XAI_API_KEY",
    "OPENROUTER_API_KEY",
    "AI_GATEWAY_API_KEY",
    "ZAI_API_KEY",
    "MISTRAL_API_KEY",
    "MINIMAX_API_KEY",
    "OPENCODE_API_KEY",
    "KIMI_API_KEY",
  ];
  return apiKeyNames.some((name) => typeof env[name] === "string" && env[name]!.trim().length > 0)
    ? "api"
    : "unknown";
}

function sanitizeForFilename(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, "");
  return sanitized.length > 0 ? sanitized : `${Date.now()}`;
}

const SENSITIVE_ARG_FLAG_RE = /^(?:--?(?:api[-_]?key|token|secret|password)|-k)$/i;

function redactCommandArgsForMeta(args: string[], promptLength: number): string[] {
  let redactNext = false;
  return args.map((value, idx) => {
    if (idx === args.length - 1) return `<prompt ${promptLength} chars>`;

    if (redactNext) {
      redactNext = false;
      return "<redacted>";
    }

    const eqMatch = value.match(/^(-{1,2}[A-Za-z0-9][A-Za-z0-9_-]*)=(.*)$/);
    if (eqMatch && SENSITIVE_ARG_FLAG_RE.test(eqMatch[1])) {
      return `${eqMatch[1]}=<redacted>`;
    }

    if (SENSITIVE_ARG_FLAG_RE.test(value)) {
      redactNext = true;
      return value;
    }

    return value;
  });
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, authToken } = ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const command = asString(config.command, "pi");
  const provider = asString(config.provider, "").trim();
  const model = asString(config.model, "").trim();
  const thinking = asString(config.thinking, "").trim();

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;

  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];

  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (effectiveWorkspaceCwd) env.PAPERCLIP_WORKSPACE_CWD = effectiveWorkspaceCwd;
  if (workspaceSource) env.PAPERCLIP_WORKSPACE_SOURCE = workspaceSource;
  if (workspaceId) env.PAPERCLIP_WORKSPACE_ID = workspaceId;
  if (workspaceRepoUrl) env.PAPERCLIP_WORKSPACE_REPO_URL = workspaceRepoUrl;
  if (workspaceRepoRef) env.PAPERCLIP_WORKSPACE_REPO_REF = workspaceRepoRef;
  if (workspaceHints.length > 0) env.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(workspaceHints);

  for (const [k, v] of Object.entries(envConfig)) {
    if (typeof v === "string") env[k] = v;
  }
  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  const executionEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(runtimeEnv)) {
    if (typeof value === "string") executionEnv[key] = value;
  }
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionFile = asString(
    runtimeSessionParams.sessionFile,
    asString(runtimeSessionParams.sessionPath, ""),
  );
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const canResumeSession =
    runtimeSessionFile.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));

  let sessionFile = canResumeSession ? runtimeSessionFile : "";
  if (runtimeSessionFile && !canResumeSession) {
    await onLog(
      "stderr",
      `[paperclip] Pi session file "${runtimeSessionFile}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }

  if (!sessionFile) {
    const configuredSessionDir = asString(config.sessionDir, "").trim();
    const sessionDir = configuredSessionDir
      ? path.isAbsolute(configuredSessionDir)
        ? configuredSessionDir
        : path.resolve(cwd, configuredSessionDir)
      : path.join(cwd, ".paperclip", "pi-sessions");
    await fs.mkdir(sessionDir, { recursive: true });
    const suffix = sanitizeForFilename(runId);
    sessionFile = path.join(sessionDir, `${sanitizeForFilename(agent.id)}-${suffix}.jsonl`);
  }

  const rawInstructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsFilePath = rawInstructionsFilePath
    ? path.isAbsolute(rawInstructionsFilePath)
      ? rawInstructionsFilePath
      : path.resolve(cwd, rawInstructionsFilePath)
    : "";
  let instructionsPrefix = "";
  if (instructionsFilePath) {
    try {
      const instructionsContents = await fs.readFile(instructionsFilePath, "utf8");
      const instructionsPathForPrompt = (() => {
        if (!path.isAbsolute(instructionsFilePath)) return instructionsFilePath;
        const rel = path.relative(cwd, instructionsFilePath);
        if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
          return path.basename(instructionsFilePath);
        }
        return rel;
      })();
      instructionsPrefix =
        `${instructionsContents}\n\n` +
        `The above agent instructions were loaded from ${instructionsPathForPrompt}. ` +
        "Resolve any relative file references from the same directory as that file.\n\n";
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

  const args = ["--mode", "json", "--print", "--session", sessionFile];
  const skillsDir = await resolvePaperclipSkillsDir();
  if (skillsDir) args.push("--skill", skillsDir);
  if (provider) args.push("--provider", provider);
  if (model) args.push("--model", model);
  if (thinking) args.push("--thinking", thinking);
  if (asBoolean(config.noTools, false)) {
    args.push("--no-tools");
  } else {
    const tools = asStringArray(config.tools);
    if (tools.length > 0) args.push("--tools", tools.join(","));
  }
  if (extraArgs.length > 0) args.push(...extraArgs);
  args.push(prompt);

  if (onMeta) {
    await onMeta({
      adapterType: "pi_local",
      command,
      cwd,
      commandArgs: redactCommandArgsForMeta(args, prompt.length),
      env: redactEnvForLogs(env),
      prompt,
      context,
    });
  }

  const proc = await runChildProcess(runId, command, args, {
    cwd,
    env: executionEnv,
    timeoutSec,
    graceSec,
    onLog,
  });

  const parsed = parsePiJsonl(proc.stdout);

  if (proc.timedOut) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: true,
      errorMessage: `Timed out after ${timeoutSec}s`,
    };
  }

  const previousSessionId =
    canResumeSession ? runtimeSessionId || runtime.sessionId || null : null;
  const resolvedSessionId = parsed.sessionId ?? previousSessionId;
  const resolvedSessionParams = {
    ...(resolvedSessionId ? { sessionId: resolvedSessionId } : {}),
    sessionFile,
    cwd,
    ...(workspaceId ? { workspaceId } : {}),
    ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
    ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
  } as Record<string, unknown>;

  const parsedError = typeof parsed.errorMessage === "string" ? parsed.errorMessage.trim() : "";
  const stderrLine = firstNonEmptyLine(proc.stderr);
  const fallbackErrorMessage = parsedError || stderrLine || `Pi exited with code ${proc.exitCode ?? -1}`;
  const authEvidence = `${parsedError}\n${proc.stdout}\n${proc.stderr}`;

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: false,
    errorMessage: (proc.exitCode ?? 0) === 0 ? null : fallbackErrorMessage,
    errorCode:
      (proc.exitCode ?? 0) !== 0 && PI_AUTH_REQUIRED_RE.test(authEvidence)
        ? "pi_auth_required"
        : null,
    usage: parsed.usage,
    sessionId: resolvedSessionId,
    sessionParams: resolvedSessionParams,
    sessionDisplayId: resolvedSessionId,
    provider: parsed.provider,
    model: parsed.model ?? model,
    billingType: resolvePiBillingType(executionEnv),
    costUsd: parsed.costUsd,
    resultJson: {
      stdout: proc.stdout,
      stderr: proc.stderr,
    },
    summary: parsed.summary,
  };
}
