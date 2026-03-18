import fs from "node:fs/promises";
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
import { parseKiroOutput, stripAnsi } from "./parse.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** Remove the API key from output before persisting to DB/logs. */
function scrubCredentials(text: string, env: Record<string, string>): string {
  const key = env.PAPERCLIP_API_KEY;
  return key ? text.replaceAll(key, "***REDACTED***") : text;
}

/** Patterns in stripped stderr that are Kiro CLI chrome noise. */
const STDERR_NOISE_RE =
  /^$|^\s*$|^All tools are now trusted|^Agents can sometimes do unexpected|^Learn more at|^\s*▸\s*Time:|^\s*▸\s*Cost:/;

/** Wrap onLog to strip ANSI and filter Kiro CLI chrome from stderr. */
function wrapOnLog(
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>,
): (stream: "stdout" | "stderr", chunk: string) => Promise<void> {
  return async (stream, chunk) => {
    if (stream === "stderr") {
      const cleaned = stripAnsi(chunk);
      // Drop lines that are pure ANSI control / Kiro chrome
      const meaningful = cleaned
        .split(/\r?\n/)
        .filter((line) => !STDERR_NOISE_RE.test(line.trim()))
        .join("\n")
        .trim();
      if (!meaningful) return;
      return onLog(stream, meaningful + "\n");
    }
    return onLog(stream, chunk);
  };
}

const SKILLS_CANDIDATES = [
  path.resolve(__moduleDir, "../../skills"),
  path.resolve(__moduleDir, "../../../../../skills"),
];

async function findSkillsDir(): Promise<string | null> {
  for (const c of SKILLS_CANDIDATES) {
    if (await fs.stat(c).then((s) => s.isDirectory()).catch(() => false)) return c;
  }
  return null;
}

/** Read the Paperclip skill markdown files and concatenate them. */
async function loadSkillContent(): Promise<string> {
  const dir = await findSkillsDir();
  if (!dir) return "";
  const parts: string[] = [];
  const skillMd = path.join(dir, "paperclip", "SKILL.md");
  const refMd = path.join(dir, "paperclip", "references", "api-reference.md");
  for (const f of [skillMd, refMd]) {
    try {
      parts.push(await fs.readFile(f, "utf-8"));
    } catch { /* skip */ }
  }
  return parts.join("\n\n---\n\n");
}

/**
 * Write `.kiro/steering/paperclip.md` in the workspace so Kiro treats
 * the Paperclip skill as trusted project context (equivalent to Claude's
 * `--add-dir` skill injection).
 */
async function writeSteeringFile(cwd: string, env: Record<string, string>): Promise<void> {
  const skillContent = await loadSkillContent();

  // Embed the actual env var values so Kiro doesn't need to read env vars
  const envBlock = [
    "## Your Paperclip Identity (this heartbeat)",
    "",
    "Use these values directly in API calls — do not attempt to read environment variables.",
    "",
    `- **API URL:** \`${env.PAPERCLIP_API_URL ?? ""}\``,
    `- **API Key:** \`${env.PAPERCLIP_API_KEY ?? ""}\``,
    `- **Agent ID:** \`${env.PAPERCLIP_AGENT_ID ?? ""}\``,
    `- **Company ID:** \`${env.PAPERCLIP_COMPANY_ID ?? ""}\``,
    `- **Run ID:** \`${env.PAPERCLIP_RUN_ID ?? ""}\``,
  ];
  if (env.PAPERCLIP_TASK_ID) envBlock.push(`- **Task ID:** \`${env.PAPERCLIP_TASK_ID}\``);
  if (env.PAPERCLIP_WAKE_REASON) envBlock.push(`- **Wake Reason:** \`${env.PAPERCLIP_WAKE_REASON}\``);
  if (env.PAPERCLIP_WAKE_COMMENT_ID) envBlock.push(`- **Wake Comment ID:** \`${env.PAPERCLIP_WAKE_COMMENT_ID}\``);
  if (env.PAPERCLIP_APPROVAL_ID) envBlock.push(`- **Approval ID:** \`${env.PAPERCLIP_APPROVAL_ID}\``);
  if (env.PAPERCLIP_APPROVAL_STATUS) envBlock.push(`- **Approval Status:** \`${env.PAPERCLIP_APPROVAL_STATUS}\``);
  if (env.PAPERCLIP_LINKED_ISSUE_IDS) envBlock.push(`- **Linked Issue IDs:** \`${env.PAPERCLIP_LINKED_ISSUE_IDS}\``);

  const parts = [
    envBlock.join("\n"),
    "",
    "## Constraints",
    "- You are running headless (non-interactive). Never run commands that require human input (e.g. `aws sso login`, browser-based OAuth flows, interactive prompts). If credentials are expired or missing, report the issue in a task comment and move on.",
  ];
  if (skillContent) parts.push("", "---", "", skillContent);
  const steeringContent = parts.join("\n");

  const steeringDir = path.join(cwd, ".kiro", "steering");
  await fs.mkdir(steeringDir, { recursive: true });
  await fs.writeFile(path.join(steeringDir, "paperclip.md"), steeringContent, { encoding: "utf-8", mode: 0o600 });
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, authToken } = ctx;

  const command = asString(config.command, "kiro-cli");
  const trustAllTools = asBoolean(config.trustAllTools, true);

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "") || null;
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "") || null;
  const workspaceRepoRef = asString(workspaceContext.repoRef, "") || null;
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  // Build environment
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

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  // Write Paperclip skill as a Kiro steering file (trusted project context)
  const steeringFilePath = path.join(cwd, ".kiro", "steering", "paperclip.md");
  let steeringFileWritten = false;
  try {
    await writeSteeringFile(cwd, env);
    steeringFileWritten = true;
  } catch (err) {
    await onLog("stderr", `[paperclip] Failed to write steering file: ${err}\n`);
  }

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

  // Session handling: Kiro CLI --resume is directory-based
  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const hasSession = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "").length > 0;
  const canResumeSession =
    hasSession &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));

  if (hasSession && !canResumeSession) {
    await onLog(
      "stderr",
      `[paperclip] Kiro session was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }

  // Build prompt
  const promptTemplate = asString(config.promptTemplate, "");
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };

  let prompt: string;
  if (promptTemplate) {
    prompt = renderTemplate(promptTemplate, templateData);
  } else {
    prompt = "Follow the Paperclip heartbeat procedure described in the steering files. "
      + "Use curl to call the Paperclip API. "
      + "Check your assignments, pick a task, do the work, update status, and leave a comment.";
  }

  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  if (instructionsFilePath) {
    try {
      const instructions = await fs.readFile(instructionsFilePath, "utf-8");
      prompt = instructions.trim() + "\n\n" + prompt;
    } catch (err) {
      await onLog("stderr", `[paperclip] Could not read instructions file "${instructionsFilePath}": ${err}\n`);
    }
  }

  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  if (sessionHandoffNote) {
    prompt = sessionHandoffNote + "\n\n" + prompt;
  }

  // Build args
  const args = ["chat", "--no-interactive"];
  if (trustAllTools) args.push("--trust-all-tools");
  if (canResumeSession) args.push("--resume");
  if (extraArgs.length > 0) args.push(...extraArgs);
  args.push(prompt);

  if (onMeta) {
    await onMeta({
      adapterType: "kiro_local",
      command,
      cwd,
      commandArgs: args,
      env: redactEnvForLogs(env),
      prompt,
      context,
    });
  }

  let proc;
  try {
    proc = await runChildProcess(runId, command, args, {
      cwd,
      env,
      timeoutSec,
      graceSec,
      onLog: wrapOnLog(onLog),
    });
  } finally {
    if (steeringFileWritten) {
      await fs.unlink(steeringFilePath).catch((err) => {
        onLog("stderr", `[paperclip] Warning: failed to delete credential steering file: ${err}\n`).catch(() => {});
      });
    }
  }

  if (proc.timedOut) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: true,
      errorMessage: `Timed out after ${timeoutSec}s`,
      errorCode: "timeout",
    };
  }

  const parsed = parseKiroOutput(proc.stdout);
  const sessionId = `kiro-session-${cwd}`;
  const sessionParams = { sessionId, cwd };

  const stderrLine = proc.stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean) ?? "";

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: false,
    errorMessage:
      (proc.exitCode ?? 0) === 0
        ? null
        : scrubCredentials(stderrLine, env) || `Kiro CLI exited with code ${proc.exitCode ?? -1}`,
    // Kiro CLI reports credits, not tokens — omit usage/costUsd since we can't map to tokens or USD
    usage: undefined,
    costUsd: undefined,
    sessionId,
    sessionParams,
    sessionDisplayId: cwd,
    provider: "kiro",
    model: "auto",
    billingType: "subscription_included",
    resultJson: { stdout: scrubCredentials(proc.stdout, env), stderr: scrubCredentials(proc.stderr, env), creditsUsed: parsed.creditsUsed },
    summary: scrubCredentials(parsed.summary, env),
  };
}
