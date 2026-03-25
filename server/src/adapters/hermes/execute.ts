import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterSkill,
} from "@paperclipai/adapter-utils";
import { formatSelfContextBlock } from "@paperclipai/adapter-utils/self-context";
import {
  parseMcpServers,
  expandMcpEnv,
  type McpServersMap,
} from "@paperclipai/adapter-utils/mcp";
import {
  asString,
  asNumber,
  asBoolean,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  buildExecutionEnv,
  redactEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  renderTemplate,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";

const HERMES_CLI = "hermes";
const DEFAULT_MODEL = "anthropic/claude-sonnet-4";
/** 0 = no Paperclip wall-clock kill (matches other local adapters). */
const DEFAULT_TIMEOUT_SEC = 0;
const DEFAULT_GRACE_SEC = 10;

/**
 * adapter_config may store numbers as strings after import/API merges.
 * asNumber("0", 300) incorrectly returned 300 — that looked like "0 in UI" but still timed out.
 */
function adapterTimeoutSec(value: unknown, whenMissing: number): number {
  if (value === undefined || value === null) return whenMissing;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === "string") {
    const t = value.trim();
    if (t === "") return whenMissing;
    const n = Number(t);
    if (Number.isFinite(n)) return Math.max(0, Math.floor(n));
  }
  return whenMissing;
}
const VALID_PROVIDERS = [
  "auto", "openrouter", "nous", "openai-codex", "copilot-acp",
  "copilot", "anthropic", "zai", "kimi-coding", "minimax", "minimax-cn",
  "kilocode",
];

function hermesHome(): string {
  return process.env.HERMES_HOME ?? path.join(os.homedir(), ".hermes");
}

// ---------------------------------------------------------------------------
// Skills → ~/.hermes/skills/paperclip/<name>/
// ---------------------------------------------------------------------------
// Hermes loads skills by name from ~/.hermes/skills/ via the `-s` flag.
// We symlink Paperclip-resolved skills into a `paperclip` category dir,
// then pass their names with `-s`.
// ---------------------------------------------------------------------------

const PAPERCLIP_SKILL_CATEGORY = "paperclip";

async function syncSkillsToHermes(skills: AdapterSkill[]): Promise<string[]> {
  if (!skills || skills.length === 0) return [];

  const synced: string[] = [];
  const paperclipSkills: AdapterSkill[] = [];

  for (const skill of skills) {
    if (skill.name.startsWith("hermes/")) {
      // Hermes-native skill — already on disk under ~/.hermes/skills/.
      // Just pass the native name (strip the hermes/ prefix) so Hermes loads it.
      synced.push(skill.name.slice("hermes/".length));
    } else {
      paperclipSkills.push(skill);
    }
  }

  if (paperclipSkills.length > 0) {
    const targetDir = path.join(hermesHome(), "skills", PAPERCLIP_SKILL_CATEGORY);
    await fs.mkdir(targetDir, { recursive: true });

    for (const skill of paperclipSkills) {
      const stat = await fs.stat(skill.path).catch(() => null);
      if (!stat?.isDirectory()) continue;

      const linkPath = path.join(targetDir, skill.name);
      const existing = await fs.lstat(linkPath).catch(() => null);

      if (existing) {
        if (existing.isSymbolicLink()) {
          const currentTarget = await fs.readlink(linkPath);
          if (currentTarget === skill.path) {
            synced.push(`${PAPERCLIP_SKILL_CATEGORY}/${skill.name}`);
            continue;
          }
          await fs.unlink(linkPath);
        } else {
          synced.push(`${PAPERCLIP_SKILL_CATEGORY}/${skill.name}`);
          continue;
        }
      }

      await fs.symlink(skill.path, linkPath);
      synced.push(`${PAPERCLIP_SKILL_CATEGORY}/${skill.name}`);
    }
  }

  return synced;
}

// ---------------------------------------------------------------------------
// MCP → ~/.hermes/config.yaml  mcp_servers section
// ---------------------------------------------------------------------------
// Hermes reads MCP servers from its config.yaml. We merge Paperclip-configured
// MCP servers into that file, prefixed with "paperclip_" to avoid collisions
// with user-configured servers. We do not overwrite Hermes's own run limits
// (e.g. terminal.timeout, code_execution.timeout); users tune those in yaml.
// ---------------------------------------------------------------------------

async function syncMcpToHermesConfig(
  servers: McpServersMap,
  runtimeEnv: Record<string, string>,
): Promise<string[]> {
  const expanded = expandMcpEnv(servers, runtimeEnv);
  const configPath = path.join(hermesHome(), "config.yaml");

  let existingConfig: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    existingConfig = (yaml.load(raw) as Record<string, unknown>) ?? {};
  } catch {
    // config doesn't exist yet
  }

  const existingMcp = (existingConfig.mcp_servers as Record<string, unknown>) ?? {};
  const merged = { ...existingMcp };
  const synced: string[] = [];

  for (const [name, srv] of Object.entries(expanded)) {
    const hermesKey = `paperclip_${name}`;
    const hermesSrv: Record<string, unknown> = { enabled: true };

    if (srv.transport === "stdio") {
      hermesSrv.command = srv.command ?? "";
      if (srv.args && srv.args.length > 0) hermesSrv.args = srv.args;
      if (srv.env && Object.keys(srv.env).length > 0) hermesSrv.env = srv.env;
    } else {
      hermesSrv.url = srv.url ?? "";
      if (srv.headers && Object.keys(srv.headers).length > 0) hermesSrv.headers = srv.headers;
      if (srv.env && Object.keys(srv.env).length > 0) hermesSrv.env = srv.env;
    }

    merged[hermesKey] = hermesSrv;
    synced.push(hermesKey);
  }

  existingConfig.mcp_servers = merged;
  await fs.writeFile(configPath, yaml.dump(existingConfig, { lineWidth: -1 }), "utf-8");

  return synced;
}

// ---------------------------------------------------------------------------
// Instructions file → AGENTS.md in cwd
// ---------------------------------------------------------------------------
// Hermes auto-loads AGENTS.md from the working directory. If the configured
// instructionsFilePath points elsewhere, we symlink it into the cwd as
// AGENTS.md so Hermes picks it up natively.
// ---------------------------------------------------------------------------

async function ensureInstructionsInCwd(
  instructionsFilePath: string,
  cwd: string,
): Promise<void> {
  if (!instructionsFilePath) return;

  const agentsMdPath = path.join(cwd, "AGENTS.md");
  const existingAgentsMd = await fs.lstat(agentsMdPath).catch(() => null);

  // If AGENTS.md already exists (real file or symlink), check if it already
  // points to our instructions. If it's a different file, don't overwrite.
  if (existingAgentsMd) {
    if (existingAgentsMd.isSymbolicLink()) {
      const target = await fs.readlink(agentsMdPath);
      if (path.resolve(target) === path.resolve(instructionsFilePath)) return;
    }
    // Already exists as a real file or different symlink — don't overwrite.
    // Hermes will pick up the existing one.
    return;
  }

  // Verify the source exists before linking
  const sourceStat = await fs.stat(instructionsFilePath).catch(() => null);
  if (!sourceStat?.isFile()) return;

  await fs.symlink(instructionsFilePath, agentsMdPath);
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

const SESSION_ID_REGEX = /^session_id:\s*(\S+)/m;
const SESSION_ID_REGEX_LEGACY = /session[_ ](?:id|saved)[:\s]+([a-zA-Z0-9_-]+)/i;
const TOKEN_USAGE_REGEX = /tokens?[:\s]+(\d+)\s*(?:input|in)\b.*?(\d+)\s*(?:output|out)\b/i;
const COST_REGEX = /(?:cost|spent)[:\s]*\$?([\d.]+)/i;

function parseHermesOutput(stdout: string, stderr: string) {
  const combined = stdout + "\n" + stderr;
  const result: Record<string, unknown> = {};

  const sessionMatch = stdout.match(SESSION_ID_REGEX);
  if (sessionMatch?.[1]) {
    result.sessionId = sessionMatch[1];
    const sessionLineIdx = stdout.lastIndexOf("\nsession_id:");
    if (sessionLineIdx > 0) {
      result.response = stdout.slice(0, sessionLineIdx).trim();
    }
  } else {
    const legacyMatch = combined.match(SESSION_ID_REGEX_LEGACY);
    if (legacyMatch?.[1]) {
      result.sessionId = legacyMatch[1];
    }
  }

  const usageMatch = combined.match(TOKEN_USAGE_REGEX);
  if (usageMatch) {
    result.usage = {
      inputTokens: parseInt(usageMatch[1], 10) || 0,
      outputTokens: parseInt(usageMatch[2], 10) || 0,
    };
  }

  const costMatch = combined.match(COST_REGEX);
  if (costMatch?.[1]) {
    result.costUsd = parseFloat(costMatch[1]);
  }

  if (stderr.trim()) {
    const errorLines = stderr
      .split("\n")
      .filter((line) => /error|exception|traceback|failed/i.test(line))
      .filter((line) => !/INFO|DEBUG|warn/i.test(line));
    if (errorLines.length > 0) {
      result.errorMessage = errorLines.slice(0, 5).join("\n");
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Runtime config builder (env vars, cwd, workspace context)
// ---------------------------------------------------------------------------

interface HermesRuntimeConfig {
  command: string;
  cwd: string;
  workspaceId: string | null;
  workspaceRepoUrl: string | null;
  workspaceRepoRef: string | null;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
  extraArgs: string[];
}

async function buildHermesRuntimeConfig(input: {
  runId: string;
  agent: AdapterExecutionContext["agent"];
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  authToken?: string;
}): Promise<HermesRuntimeConfig> {
  const { runId, agent, config, context, authToken } = input;

  const command = asString(config.hermesCommand, HERMES_CLI);

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceStrategy = asString(workspaceContext.strategy, "");
  const workspaceId = asString(workspaceContext.workspaceId, "") || null;
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "") || null;
  const workspaceRepoRef = asString(workspaceContext.repoRef, "") || null;
  const workspaceBranch = asString(workspaceContext.branchName, "") || null;
  const workspaceWorktreePath = asString(workspaceContext.worktreePath, "") || null;
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimeServiceIntents = Array.isArray(context.paperclipRuntimeServiceIntents)
    ? context.paperclipRuntimeServiceIntents.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimeServices = Array.isArray(context.paperclipRuntimeServices)
    ? context.paperclipRuntimeServices.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimePrimaryUrl = asString(context.paperclipRuntimePrimaryUrl, "");

  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const injectedEnv: Record<string, string> = { ...buildPaperclipEnv(agent) };
  injectedEnv.PAPERCLIP_RUN_ID = runId;
  injectedEnv.AGENT_HOME = cwd;

  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeEventType =
    typeof context.eventType === "string" && context.eventType.trim().length > 0
      ? context.eventType.trim()
      : null;
  const wakeEventPayload = parseObject(context.eventPayload);
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const chatMessageId =
    typeof context.chatMessageId === "string" && context.chatMessageId.trim().length > 0
      ? context.chatMessageId.trim()
      : null;
  const chatSessionId =
    typeof context.chatSessionId === "string" && context.chatSessionId.trim().length > 0
      ? context.chatSessionId.trim()
      : null;
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

  if (wakeTaskId) injectedEnv.PAPERCLIP_TASK_ID = wakeTaskId;
  if (wakeReason) injectedEnv.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) injectedEnv.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (wakeEventType) injectedEnv.PAPERCLIP_EVENT_TYPE = wakeEventType;
  if (wakeEventPayload) injectedEnv.PAPERCLIP_EVENT_PAYLOAD = JSON.stringify(wakeEventPayload);
  if (chatMessageId) injectedEnv.PAPERCLIP_CHAT_MESSAGE_ID = chatMessageId;
  if (chatSessionId) injectedEnv.PAPERCLIP_CHAT_SESSION_ID = chatSessionId;
  if (approvalId) injectedEnv.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) injectedEnv.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) injectedEnv.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (effectiveWorkspaceCwd) injectedEnv.PAPERCLIP_WORKSPACE_CWD = effectiveWorkspaceCwd;
  if (workspaceSource) injectedEnv.PAPERCLIP_WORKSPACE_SOURCE = workspaceSource;
  if (workspaceStrategy) injectedEnv.PAPERCLIP_WORKSPACE_STRATEGY = workspaceStrategy;
  if (workspaceId) injectedEnv.PAPERCLIP_WORKSPACE_ID = workspaceId;
  if (workspaceRepoUrl) injectedEnv.PAPERCLIP_WORKSPACE_REPO_URL = workspaceRepoUrl;
  if (workspaceRepoRef) injectedEnv.PAPERCLIP_WORKSPACE_REPO_REF = workspaceRepoRef;
  if (workspaceBranch) injectedEnv.PAPERCLIP_WORKSPACE_BRANCH = workspaceBranch;
  if (workspaceWorktreePath) injectedEnv.PAPERCLIP_WORKSPACE_WORKTREE_PATH = workspaceWorktreePath;
  if (workspaceHints.length > 0) injectedEnv.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(workspaceHints);
  if (runtimeServiceIntents.length > 0) injectedEnv.PAPERCLIP_RUNTIME_SERVICE_INTENTS_JSON = JSON.stringify(runtimeServiceIntents);
  if (runtimeServices.length > 0) injectedEnv.PAPERCLIP_RUNTIME_SERVICES_JSON = JSON.stringify(runtimeServices);
  if (runtimePrimaryUrl) injectedEnv.PAPERCLIP_RUNTIME_PRIMARY_URL = runtimePrimaryUrl;

  const env = await buildExecutionEnv({
    globalEnvFile: asString(context.paperclipGlobalEnvFile, ""),
    configEnv: config.env,
    injectedEnv,
    authToken,
  });

  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  const timeoutSec = adapterTimeoutSec(config.timeoutSec, DEFAULT_TIMEOUT_SEC);
  const graceSec = asNumber(config.graceSec, DEFAULT_GRACE_SEC);
  const extraArgs = asStringArray(config.extraArgs);

  return {
    command,
    cwd,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    env,
    timeoutSec,
    graceSec,
    extraArgs,
  };
}

// ---------------------------------------------------------------------------
// Main execute
// ---------------------------------------------------------------------------

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, authToken } = ctx;

  const model = asString(config.model, DEFAULT_MODEL);
  const provider = asString(config.provider, "");
  const toolsets = asString(config.toolsets, "");
  const persistSession = asBoolean(config.persistSession, true);
  const worktreeMode = asBoolean(config.worktreeMode, false);
  const checkpoints = asBoolean(config.checkpoints, false);
  const useQuiet = asBoolean(config.quiet, true);
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );

  const runtimeConfig = await buildHermesRuntimeConfig({
    runId,
    agent,
    config,
    context,
    authToken,
  });
  const { command, cwd, workspaceId, workspaceRepoUrl, workspaceRepoRef, env, timeoutSec, graceSec, extraArgs } = runtimeConfig;

  // Sync Paperclip skills into ~/.hermes/skills/paperclip/ so Hermes can load
  // them natively via the -s flag.
  const syncedSkills = await syncSkillsToHermes(ctx.skills ?? []);

  // Sync MCP servers from agent config into ~/.hermes/config.yaml
  const mcpServers = parseMcpServers(config);
  let syncedMcp: string[] = [];
  if (mcpServers) {
    syncedMcp = await syncMcpToHermesConfig(mcpServers, { ...process.env as Record<string, string>, ...env });
  }

  // If instructionsFilePath is set and there's no AGENTS.md in the cwd,
  // symlink it so Hermes auto-loads it from the working directory.
  await ensureInstructionsInCwd(instructionsFilePath, cwd);

  const prompt = renderTemplate(promptTemplate, {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  });

  const paperclipChat = parseObject(context.paperclipChat);
  const chatMode = asString(paperclipChat.mode, "");
  const chatPrompt = asString(paperclipChat.promptText, "").trim();

  const selfContextBlock = formatSelfContextBlock(ctx.selfContext);
  const effectivePrompt =
    selfContextBlock +
    (chatMode === "interactive_chat" && chatPrompt ? chatPrompt : prompt);

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const prevSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const canResume = persistSession && prevSessionId.length > 0;

  const args = ["chat", "-q", effectivePrompt];
  if (useQuiet) args.push("-Q");
  args.push("-m", model);
  if (provider && VALID_PROVIDERS.includes(provider)) {
    args.push("--provider", provider);
  }
  if (toolsets) args.push("-t", toolsets);
  if (worktreeMode) args.push("-w");
  if (checkpoints) args.push("--checkpoints");
  if (asBoolean(config.verbose, false)) args.push("-v");
  if (canResume) args.push("--resume", prevSessionId);
  // --yolo bypasses tool approval prompts (required for non-interactive use)
  args.push("--yolo");
  // Load synced Paperclip skills via Hermes's native -s flag
  if (syncedSkills.length > 0) {
    args.push("-s", syncedSkills.join(","));
  }
  if (extraArgs.length > 0) args.push(...extraArgs);

  if (onMeta) {
    await onMeta({
      adapterType: "hermes_local",
      command,
      cwd,
      commandArgs: args,
      env: redactEnvForLogs(env),
      prompt: effectivePrompt,
      context,
      skillsInjected: syncedSkills,
      mcpServers: syncedMcp.length > 0 ? Object.fromEntries(syncedMcp.map(k => [k, true])) : undefined,
    });
  }

  const result = await runChildProcess(runId, command, args, {
    cwd,
    env,
    timeoutSec,
    graceSec,
    onLog,
  });

  const parsed = parseHermesOutput(result.stdout || "", result.stderr || "");

  const executionResult: AdapterExecutionResult = {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    provider: provider || null,
    model,
  };

  if (result.timedOut) {
    executionResult.errorMessage = `Timed out after ${timeoutSec}s`;
    executionResult.errorCode = "timeout";
  }

  if (parsed.errorMessage) {
    executionResult.errorMessage = parsed.errorMessage as string;
  }

  if (parsed.usage) {
    executionResult.usage = parsed.usage as { inputTokens: number; outputTokens: number };
  }

  if (parsed.costUsd !== undefined) {
    executionResult.costUsd = parsed.costUsd as number;
  }

  if (parsed.response) {
    executionResult.summary = (parsed.response as string).slice(0, 2000);
  }

  const sessionId = parsed.sessionId as string | undefined;
  if (persistSession && sessionId) {
    executionResult.sessionId = sessionId;
    executionResult.sessionParams = {
      sessionId,
      cwd,
      ...(workspaceId ? { workspaceId } : {}),
      ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
      ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
    };
    executionResult.sessionDisplayId = sessionId.slice(0, 16);
  }

  return executionResult;
}
