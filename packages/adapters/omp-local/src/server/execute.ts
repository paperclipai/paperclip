import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inferOpenAiCompatibleBiller } from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  joinPromptSections,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePaperclipSkillSymlink,
  ensurePathInEnv,
  readPaperclipRuntimeSkillEntries,
  resolveCommandForLogs,
  resolvePaperclipDesiredSkillNames,
  removeMaintainerOnlySkillSymlinks,
  renderTemplate,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { isOmpUnknownSessionError, parseOmpJsonl } from "./parse.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const OMP_SESSIONS_DIR = path.join(os.homedir(), ".omp", "paperclips");
const OMP_AGENT_SKILLS_DIR = path.join(os.homedir(), ".omp", "agent", "skills");

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function parseModelProvider(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed.includes("/")) return null;
  return trimmed.slice(0, trimmed.indexOf("/")).trim() || null;
}

function parseModelId(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed.includes("/")) return trimmed || null;
  return trimmed.slice(trimmed.indexOf("/") + 1).trim() || null;
}

async function ensureOmpSkillsInjected(
  onLog: (type: "stdout" | "stderr", data: string) => void,
  skillsEntries: Array<{ key: string; source: string; runtimeName: string }>,
  desiredSkillNames: string[] | null
): Promise<void> {
  const desiredSet = new Set(desiredSkillNames ?? skillsEntries.map((entry) => entry.key));
  const selectedEntries = skillsEntries.filter((entry) => desiredSet.has(entry.key));
  if (selectedEntries.length === 0) return;

  await fs.mkdir(OMP_AGENT_SKILLS_DIR, { recursive: true });

  const removedSkills = await removeMaintainerOnlySkillSymlinks(
    OMP_AGENT_SKILLS_DIR,
    selectedEntries.map((entry) => entry.runtimeName)
  );

  for (const skillName of removedSkills) {
    await onLog("stderr", `[paperclip] Removed maintainer-only OMP skill "${skillName}" from ${OMP_AGENT_SKILLS_DIR}\n`);
  }

  for (const entry of selectedEntries) {
    const target = path.join(OMP_AGENT_SKILLS_DIR, entry.runtimeName);
    try {
      const result = await ensurePaperclipSkillSymlink(entry.source, target);
      if (result === "skipped") continue;
      await onLog(
        "stderr",
        `[paperclip] ${result === "repaired" ? "Repaired" : "Injected"} OMP skill "${entry.runtimeName}" into ${OMP_AGENT_SKILLS_DIR}\n`
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to inject OMP skill "${entry.runtimeName}" into ${OMP_AGENT_SKILLS_DIR}: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  }
}

function resolveOmpBiller(env: Record<string, string | undefined>, provider: string | null): string {
  return inferOpenAiCompatibleBiller(env, null) ?? provider ?? "unknown";
}

async function ensureSessionsDir(): Promise<string> {
  await fs.mkdir(OMP_SESSIONS_DIR, { recursive: true });
  return OMP_SESSIONS_DIR;
}

function buildSessionPath(agentId: string, timestamp: string): string {
  const safeTimestamp = timestamp.replace(/[:.]/g, "-");
  return path.join(OMP_SESSIONS_DIR, `${safeTimestamp}-${agentId}.jsonl`);
}

interface ExecuteContext {
  runId: string;
  agent: { id: string; name: string; companyId: string };
  runtime: unknown;
  config: Record<string, unknown>;
  context: {
    paperclipWorkspace?: Record<string, unknown>;
    paperclipWorkspaces?: Array<Record<string, unknown>>;
    taskId?: string;
    issueId?: string;
    wakeReason?: string;
    wakeCommentId?: string;
    commentId?: string;
    approvalId?: string;
    approvalStatus?: string;
    issueIds?: string[];
    session?: { sessionId: string; cwd?: string } | null;
  };
  onLog: (type: "stdout" | "stderr", data: string) => void;
  onMeta: (meta: Record<string, unknown>) => void;
  onSpawn: (info: { pid: number; command: string }) => void;
  authToken: string | null;
}

export async function execute(ctx: ExecuteContext): Promise<{
  sessionId?: string | null;
  result?: string;
  error?: string;
  errorResponse?: string | null;
  unknownSession?: boolean;
  resultMeta?: { usage?: unknown };
  debugOutput?: string;
}> {
  const { runId, agent, config, context, onLog, onSpawn } = ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work."
  );
  const command = asString(config.command, "omp");
  const model = asString(config.model, "").trim();
  const thinking = asString(config.thinking, "").trim();

  // Parse model into provider and model id
  const provider = parseModelProvider(model);
  const modelId = parseModelId(model);

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext?.cwd, "");
  const workspaceSource = asString(workspaceContext?.source, "");
  const workspaceId = asString(workspaceContext?.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext?.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext?.repoRef, "");
  const agentHome = asString(workspaceContext?.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter((value): value is Record<string, unknown> =>
        typeof value === "object" && value !== null
      )
    : [];

  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();

  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  // Ensure sessions directory exists
  await ensureSessionsDir();

  // Inject skills
  const ompSkillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredOmpSkillNames = resolvePaperclipDesiredSkillNames(config, ompSkillEntries);
  await ensureOmpSkillsInjected(onLog, ompSkillEntries, desiredOmpSkillNames);

  // Build environment
  const envConfig = parseObject(config.env);

  const env: Record<string, string | undefined> = { ...buildPaperclipEnv(agent) };
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
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 &&
      context.wakeCommentId.trim()) ||
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
    ? context.issueIds.filter((value): value is string =>
        typeof value === "string" && value.trim().length > 0
      )
    : [];

  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (workspaceCwd) env.PAPERCLIP_WORKSPACE_CWD = workspaceCwd;
  if (workspaceSource) env.PAPERCLIP_WORKSPACE_SOURCE = workspaceSource;
  if (workspaceId) env.PAPERCLIP_WORKSPACE_ID = workspaceId;
  if (workspaceRepoUrl) env.PAPERCLIP_WORKSPACE_REPO_URL = workspaceRepoUrl;
  if (workspaceRepoRef) env.PAPERCLIP_WORKSPACE_REPO_REF = workspaceRepoRef;
  if (agentHome) env.AGENT_HOME = agentHome;
  if (workspaceHints.length > 0) env.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(workspaceHints);

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  // Build command arguments
  const args: string[] = [];

  // Model specification
  if (provider && modelId) {
    args.push("--provider", provider);
    args.push("--model", modelId);
  } else if (model) {
    // Try to parse as provider/model or use as direct model id
    if (provider) {
      args.push("--provider", provider);
      args.push("--model", modelId || model);
    } else {
      args.push("--model", model);
    }
  }

  // Thinking level
  if (thinking) {
    args.push("--thinking", thinking);
  }

  // Session management - use session from context if available
  const sessionData = context.session;
  if (sessionData?.sessionId) {
    args.push("--resume", sessionData.sessionId);
  } else {
    // Create a new session file for this run
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const sessionFile = buildSessionPath(agent.id, timestamp);
    await fs.writeFile(sessionFile, "", "utf-8");
    args.push("--session-dir", OMP_SESSIONS_DIR);
  }

  // Instructions file
  const instructionsFilePath = asString(config.instructionsFilePath, "");
  if (instructionsFilePath) {
    args.push("--append-system-prompt", `@${instructionsFilePath}`);
  }

  // Append system prompt with template
  const instructions = renderTemplate(promptTemplate, {
    agent,
    company: { id: agent.companyId },
    runId,
    context,
  });
  args.push("--append-system-prompt", instructions);

  // CWD
  if (cwd) {
    args.push("--allow-home");
  }

  // Output mode for JSONL parsing
  args.push("--output-format", "jsonl");

  // Print mode for non-interactive
  args.push("--print");

  // Additional args
  const extraArgs = asStringArray(config.extraArgs, []);
  args.push(...extraArgs);

  // Timeout
  const timeoutSec = asNumber(config.timeoutSec, 900);
  const graceSec = asNumber(config.graceSec, 15);

  // Build final env with PATH
  const finalEnv = ensurePathInEnv(env, command);

  await onLog("stderr", `[paperclip] Running OMP: ${command} ${args.join(" ")}\n`);
  await onLog("stderr", `[paperclip] CWD: ${cwd}\n`);

  const result = await runChildProcess({
    command,
    args,
    cwd,
    env: finalEnv,
    timeoutSec,
    graceSec,
    onLog,
    onSpawn,
  });

  // Parse JSONL output
  const parsed = parseOmpJsonl(result.stdout);

  if (parsed.error) {
    return {
      error: parsed.error,
      errorResponse: parsed.errorResponse,
    };
  }

  // Extract session ID from output if present
  let savedSessionId = sessionData?.sessionId ?? null;
  if (parsed.sessionId && !savedSessionId) {
    savedSessionId = parsed.sessionId;
  }

  // Check for unknown session error
  if (
    parsed.hasUnknownSessionError ||
    isOmpUnknownSessionError(result.stderr)
  ) {
    return {
      sessionId: savedSessionId,
      error: "unknown_session",
      errorResponse: parsed.hasUnknownSessionError
        ? parsed.errorResponse
        : result.stderr
            .split("\n")
            .find((l) =>
              l.includes("unknown session") || l.includes("session not found")
            ) ?? null,
      unknownSession: true,
    };
  }

  return {
    sessionId: savedSessionId,
    result: parsed.result,
    resultMeta: parsed.usage ? { usage: parsed.usage } : undefined,
    debugOutput: result.stderr,
  };
}
