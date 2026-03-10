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

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const PAPERCLIP_SKILLS_CANDIDATES = [
  path.resolve(__moduleDir, "../../../../../skills"),
  path.resolve(__moduleDir, "../../../../../../skills"),
];
const ANSI_RE = /\x1B\[[0-9;?]*[ -/]*[@-~]/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function readNonEmptyString(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

function hermesHomeDir(): string {
  const fromEnv = process.env.HERMES_HOME;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv.trim();
  return path.join(os.homedir(), ".hermes");
}

async function resolvePaperclipSkillsDir(): Promise<string | null> {
  for (const candidate of PAPERCLIP_SKILLS_CANDIDATES) {
    const isDir = await fs.stat(candidate).then((s) => s.isDirectory()).catch(() => false);
    if (isDir) return candidate;
  }
  return null;
}

async function ensureHermesSkillsInjected(onLog: AdapterExecutionContext["onLog"]) {
  const skillsDir = await resolvePaperclipSkillsDir();
  if (!skillsDir) return;

  const skillsHome = path.join(hermesHomeDir(), "skills");
  await fs.mkdir(skillsHome, { recursive: true });
  for (const name of ["paperclip", "paperclip-create-agent"]) {
    const source = path.join(skillsDir, name);
    const sourceExists = await fs.stat(source).then((s) => s.isDirectory()).catch(() => false);
    if (!sourceExists) continue;
    const target = path.join(skillsHome, name);
    const existing = await fs.lstat(target).catch(() => null);
    if (existing) continue;
    try {
      await fs.symlink(source, target);
      await onLog("stderr", `[paperclip] Injected Hermes skill \"${name}\" into ${skillsHome}\n`);
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to inject Hermes skill \"${name}\" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

function renderPaperclipEnvNote(env: Record<string, string>): string {
  const paperclipKeys = Object.keys(env)
    .filter((key) => key.startsWith("PAPERCLIP_"))
    .sort();
  if (paperclipKeys.length === 0) return "";
  return [
    "Paperclip runtime note:",
    `The following PAPERCLIP_* environment variables are available in this run: ${paperclipKeys.join(", ")}`,
    "Use the Paperclip skills directly instead of improvising the API.",
    "",
    "",
  ].join("\n");
}

function renderTaskFirstPromptNote(input: {
  env: Record<string, string>;
  context: Record<string, unknown>;
  runtimeTaskKey: string | null;
}): string {
  const taskId = readNonEmptyString(input.env.PAPERCLIP_TASK_ID);
  const contextTaskKey = readNonEmptyString(input.context.taskKey);
  const runtimeTaskKey = readNonEmptyString(input.runtimeTaskKey);
  const activeTaskKey = taskId || contextTaskKey || runtimeTaskKey;
  const wakeReason = readNonEmptyString(input.env.PAPERCLIP_WAKE_REASON);
  const isIssueWake = wakeReason === "issue_assigned" || wakeReason === "issue_checked_out";
  if (!activeTaskKey && !isIssueWake) return "";

  return [
    "Paperclip task-first note:",
    activeTaskKey
      ? `This run has an active Paperclip issue/task context: ${activeTaskKey}.`
      : "This run was woken for an active Paperclip issue/task.",
    "Prioritize the active Paperclip issue now.",
    "Do not spend this run on generic setup, banner chatter, or side quests.",
    "This run must not exit without either completing the issue or blocking it with a real reason.",
    "",
    "",
  ].join("\n");
}

export function extractHermesSessionId(output: string): string | null {
  const clean = stripAnsi(output);
  const match = clean.match(/^Session:\s+([^\s]+)$/m);
  return match?.[1] ?? null;
}

export function extractHermesSummary(output: string): string | null {
  const clean = stripAnsi(output).replace(/\r/g, "");
  const blockRe = /╭─[^\n]*Hermes[^\n]*╮\n([\s\S]*?)\n╰─/g;
  let lastMatch: RegExpExecArray | null = null;
  while (true) {
    const match = blockRe.exec(clean);
    if (!match) break;
    lastMatch = match;
  }
  if (lastMatch?.[1]) {
    return lastMatch[1].trim();
  }

  const filtered = clean
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (line.startsWith("Session:")) return false;
      if (line.startsWith("Duration:")) return false;
      if (line.startsWith("Messages:")) return false;
      if (line.startsWith("Resume this session")) return false;
      if (line.startsWith("Query:")) return false;
      if (/^[╭╰│─]+/.test(line)) return false;
      if (/ruminating/.test(line)) return false;
      return true;
    });

  return filtered.length > 0 ? filtered.slice(-8).join("\n") : null;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, authToken } = ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const command = asString(config.command, "hermes");
  const model = asString(config.model, "").trim();
  const provider = asString(config.provider, "").trim();
  const toolsets = config.toolsets;
  const verbose = asBoolean(config.verbose, false);

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const configuredCwd = asString(config.cwd, "");
  const cwd = workspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  await ensureHermesSkillsInjected(onLog);

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
  if (workspaceCwd) env.PAPERCLIP_WORKSPACE_CWD = workspaceCwd;

  for (const [k, v] of Object.entries(envConfig)) {
    if (typeof v === "string") env[k] = v;
  }
  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const sessionId = readNonEmptyString(runtime.sessionParams?.sessionId ?? runtime.sessionId ?? "");
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const resolvedInstructionsFilePath = instructionsFilePath
    ? path.resolve(cwd, instructionsFilePath)
    : "";
  let injectedInstructions = "";
  if (resolvedInstructionsFilePath) {
    try {
      const instructionsContents = await fs.readFile(resolvedInstructionsFilePath, "utf8");
      const instructionsDir = `${path.dirname(resolvedInstructionsFilePath)}/`;
      injectedInstructions =
        `${instructionsContents.trim()}\n\n` +
        `The above agent instructions were loaded from ${resolvedInstructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsDir}.\n\n`;
      await onLog("stderr", `[paperclip] Loaded agent instructions file: ${resolvedInstructionsFilePath}\n`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stderr",
        `[paperclip] Warning: could not read agent instructions file "${resolvedInstructionsFilePath}": ${reason}\n`,
      );
    }
  }
  const extraArgs = asStringArray(config.extraArgs)
    .map((value) => value.trim())
    .filter(Boolean);
  const query = renderTemplate(promptTemplate, {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  });

  const fullPrompt =
    injectedInstructions +
    renderPaperclipEnvNote(env) +
    renderTaskFirstPromptNote({ env, context, runtimeTaskKey: runtime.taskKey }) +
    query;

  const args = ["chat"];
  if (extraArgs.length > 0) args.push(...extraArgs);
  if (model) args.push("-m", model);
  if (provider) args.push("--provider", provider);
  if (toolsets) {
    const renderedToolsets = Array.isArray(toolsets) ? toolsets.join(",") : String(toolsets);
    if (renderedToolsets.trim()) args.push("-t", renderedToolsets.trim());
  }
  if (verbose) args.push("-v");
  if (sessionId) args.push("--resume", sessionId);
  args.push("-q", fullPrompt);

  await onMeta?.({
    adapterType: "hermes_local",
    command,
    cwd,
    commandArgs: args,
    env: redactEnvForLogs(env),
    prompt: fullPrompt,
    context,
  });

  const proc = await runChildProcess(runId, command, args, {
    cwd,
    env,
    timeoutSec,
    graceSec,
    onLog,
  });

  const summary = extractHermesSummary(proc.stdout);
  const parsedSessionId = extractHermesSessionId(proc.stdout) ?? sessionId;

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: proc.timedOut,
    summary,
    sessionParams: parsedSessionId
      ? {
          sessionId: parsedSessionId,
          cwd,
        }
      : null,
    sessionDisplayId: parsedSessionId,
    billingType: "subscription",
    provider: provider || null,
    model: model || null,
    errorMessage:
      proc.exitCode === 0 && !proc.timedOut
        ? null
        : firstNonEmptyLine(stripAnsi(proc.stderr)) || firstNonEmptyLine(stripAnsi(proc.stdout)) || null,
  };
}
