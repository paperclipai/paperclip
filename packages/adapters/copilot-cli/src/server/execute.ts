import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
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
  readPaperclipSkillMarkdown,
} from "@paperclipai/adapter-utils/server-utils";
import {
  parseCopilotJsonl,
  describeCopilotFailure,
  detectCopilotLoginRequired,
  detectCopilotRateLimit,
  isCopilotMaxTurnsResult,
  isCopilotUnknownSessionError,
  stripSkillFrontmatter,
} from "./parse.js";
import { createJsonlLogInterceptor } from "./jsonl-interceptor.js";
import { modelEffortSupport } from "../index.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the Paperclip "paperclip" skill, strip its YAML frontmatter, write
 * the result to a fresh tmpdir as AGENTS.md, and return the tmpdir path.
 * Returns null if the skill is not found or is empty after stripping.
 */
async function buildCopilotInstructionsTmpDir(): Promise<string | null> {
  const raw = await readPaperclipSkillMarkdown(__moduleDir, "paperclip");
  if (!raw) return null;
  const stripped = stripSkillFrontmatter(raw);
  if (!stripped) return null;
  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-copilot-instructions-"));
  await fs.writeFile(path.join(tmpdir, "AGENTS.md"), stripped, "utf-8");
  return tmpdir;
}

interface CopilotExecutionInput {
  runId: string;
  agent: AdapterExecutionContext["agent"];
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  authToken?: string;
}

interface CopilotRuntimeConfig {
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

async function buildCopilotRuntimeConfig(input: CopilotExecutionInput): Promise<CopilotRuntimeConfig> {
  const { runId, agent, config, context, authToken } = input;

  const command = asString(config.command, "copilot");
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceStrategy = asString(workspaceContext.strategy, "");
  const workspaceId = asString(workspaceContext.workspaceId, "") || null;
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "") || null;
  const workspaceRepoRef = asString(workspaceContext.repoRef, "") || null;
  const workspaceBranch = asString(workspaceContext.branchName, "") || null;
  const workspaceWorktreePath = asString(workspaceContext.worktreePath, "") || null;
  const agentHome = asString(workspaceContext.agentHome, "") || null;
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
  if (workspaceStrategy) env.PAPERCLIP_WORKSPACE_STRATEGY = workspaceStrategy;
  if (workspaceId) env.PAPERCLIP_WORKSPACE_ID = workspaceId;
  if (workspaceRepoUrl) env.PAPERCLIP_WORKSPACE_REPO_URL = workspaceRepoUrl;
  if (workspaceRepoRef) env.PAPERCLIP_WORKSPACE_REPO_REF = workspaceRepoRef;
  if (workspaceBranch) env.PAPERCLIP_WORKSPACE_BRANCH = workspaceBranch;
  if (workspaceWorktreePath) env.PAPERCLIP_WORKSPACE_WORKTREE_PATH = workspaceWorktreePath;
  if (agentHome) env.AGENT_HOME = agentHome;
  if (workspaceHints.length > 0) env.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(workspaceHints);
  if (runtimeServiceIntents.length > 0) {
    env.PAPERCLIP_RUNTIME_SERVICE_INTENTS_JSON = JSON.stringify(runtimeServiceIntents);
  }
  if (runtimeServices.length > 0) {
    env.PAPERCLIP_RUNTIME_SERVICES_JSON = JSON.stringify(runtimeServices);
  }
  if (runtimePrimaryUrl) env.PAPERCLIP_RUNTIME_PRIMARY_URL = runtimePrimaryUrl;

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  if (authToken && !env.COPILOT_GITHUB_TOKEN && !env.GH_TOKEN && !env.GITHUB_TOKEN) {
    env.COPILOT_GITHUB_TOKEN = authToken;
  }

  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

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

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const model = asString(config.model, "");
  const reasoningEffort = asString(config.reasoningEffort, asString(config.effort, ""));
  const modelSupportsEffort = !model || model in modelEffortSupport;
  const allowAll = asBoolean(config.allowAll, true);
  const maxAutopilotContinues = asNumber(config.maxAutopilotContinues, 0);
  const noCustomInstructions = asBoolean(config.noCustomInstructions, false);
  const mcpConfig = asString(config.mcpConfig, "").trim();
  const agentName = asString(config.agent, "").trim();
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const allowTool = asStringArray(config.allowTool);
  const denyTool = asStringArray(config.denyTool);

  const skillsEnabled = asBoolean(config.skillsEnabled, true);
  const sessionPolicy = asString(config.sessionPolicy, "resume");
  const skipSkills = asBoolean(config.skipSkills, false);

  const runtimeConfig = await buildCopilotRuntimeConfig({ runId, agent, config, context, authToken });
  const {
    command,
    cwd,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    env,
    timeoutSec,
    graceSec,
    extraArgs,
  } = runtimeConfig;

  const instructionsTmpDir = skillsEnabled && !skipSkills ? await buildCopilotInstructionsTmpDir() : null;
  if (instructionsTmpDir) {
    const existing = env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS ?? "";
    env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS = existing
      ? `${existing}:${instructionsTmpDir}`
      : instructionsTmpDir;
    await onLog("stdout", `[paperclip] Injected Paperclip skill instructions from ${instructionsTmpDir}/AGENTS.md\n`);
  } else if (skillsEnabled && !skipSkills) {
    await onLog("stdout", `[paperclip] Warning: Could not resolve Paperclip skill instructions (moduleDir: ${__moduleDir})\n`);
  }

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const alwaysFresh = sessionPolicy === "always_fresh";
  const canResumeSession =
    !alwaysFresh &&
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
  const sessionId = canResumeSession ? runtimeSessionId : null;
  if (runtimeSessionId && !canResumeSession && !alwaysFresh) {
    await onLog(
      "stdout",
      `[paperclip] Copilot session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }

  // Read agent instructions file if configured
  let instructionsContent = "";
  if (instructionsFilePath) {
    try {
      instructionsContent = await fs.readFile(instructionsFilePath, "utf-8");
      const instructionsFileDir = `${path.dirname(instructionsFilePath)}/`;
      instructionsContent += `\nThe above agent instructions were loaded from ${instructionsFilePath}. Resolve any relative file references from ${instructionsFileDir}.`;
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Warning: Could not read instructions file ${instructionsFilePath}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  // Build Paperclip context block from available runtime data
  const wakeReason = asString(context.wakeReason, "");
  const ctxTaskId = asString(context.taskId, "") || asString(context.issueId, "");
  const ctxTaskKey = asString(context.taskKey, "");
  const ctxCommentId = asString(context.wakeCommentId, "") || asString(context.commentId, "");
  const ctxWakeSource = asString(context.wakeSource, "");

  const contextLines: string[] = [
    `[Paperclip Agent Context]`,
    `Agent: ${agent.name} (ID: ${agent.id})`,
    `Company: ${agent.companyId}`,
    `Run: ${runId}`,
    `Working directory: ${cwd}`,
  ];
  if (wakeReason) contextLines.push(`Wake reason: ${wakeReason}`);
  if (ctxTaskId) contextLines.push(`Assigned task: ${ctxTaskId}${ctxTaskKey ? ` (${ctxTaskKey})` : ""}`);
  if (ctxCommentId) contextLines.push(`Triggered by comment: ${ctxCommentId}`);
  if (ctxWakeSource) contextLines.push(`Wake source: ${ctxWakeSource}`);

  // Inject last-run failure summary so the agent knows what happened before it woke up
  const lastRunSummary = context.paperclipLastRunSummary;
  if (lastRunSummary && typeof lastRunSummary === "object" && !Array.isArray(lastRunSummary)) {
    const s = lastRunSummary as Record<string, unknown>;
    contextLines.push(``);
    contextLines.push(`[Previous Run Failed]`);
    if (s.errorCode) contextLines.push(`Error code: ${s.errorCode}`);
    if (s.error) contextLines.push(`Error: ${s.error}`);
    if (typeof s.durationMs === "number") contextLines.push(`Duration: ${Math.round(s.durationMs / 1000)}s`);
    if (s.issueId) contextLines.push(`Was working on issue: ${s.issueId}`);
    const lastEvents = Array.isArray(s.lastEvents) ? s.lastEvents : [];
    if (lastEvents.length > 0) {
      contextLines.push(`Last events:`);
      for (const ev of lastEvents) {
        const e = ev as Record<string, unknown>;
        if (e.message) contextLines.push(`  - ${e.message}`);
      }
    }
  }
  contextLines.push(
    ``,
    `Environment variables injected: PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_AGENT_ID, PAPERCLIP_COMPANY_ID, PAPERCLIP_RUN_ID${ctxTaskId ? ", PAPERCLIP_TASK_ID" : ""}`,
    ``,
    `[Paperclip API Usage]`,
    `You are running natively inside the Paperclip runtime. Use the Paperclip REST API via curl with the injected environment variables. Do NOT use pcli — that is an emulation tool for local development only.`,
    ``,
    `API pattern:`,
    `  curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" "$PAPERCLIP_API_URL/<endpoint>"`,
    ``,
    `Common endpoints:`,
    `  GET  /api/agents/me                                          — your identity`,
    `  GET  /api/agents/me/inbox-lite                               — assigned tasks feed (todo, in_progress, blocked)`,
    `  GET  /api/companies/{companyId}/dashboard                    — company health overview`,
    `  GET  /api/companies/{companyId}/issues?status=<s>&limit=50   — list issues`,
    `  GET  /api/issues/{id}                                        — issue detail`,
    `  GET  /api/issues/{id}/comments?order=asc                     — issue comments`,
    `  POST /api/issues/{id}/comments  {"body":"..."}               — post comment`,
    `  POST /api/issues/{id}/checkout                               — claim a task`,
    `  PATCH /api/issues/{id}  {"status":"...","comment":"..."}     — update issue`,
    `  POST /api/companies/{companyId}/issues  {...}                — create issue`,
    ``,
    `Use $PAPERCLIP_COMPANY_ID for {companyId}. Always include X-Paperclip-Run-Id on mutating calls.`,
  );
  const paperclipContextBlock = contextLines.join("\n");

  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const renderedBootstrapPrompt =
    !sessionId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";

  // Assemble final prompt: instructions (optional) + bootstrap (fresh sessions only) + Paperclip context + user prompt
  const promptParts: string[] = [];
  if (instructionsContent) promptParts.push(instructionsContent);
  if (renderedBootstrapPrompt) promptParts.push(renderedBootstrapPrompt);
  promptParts.push(paperclipContextBlock);
  promptParts.push(renderedPrompt);
  const prompt = promptParts.join("\n\n---\n\n");

  const buildCopilotArgs = (resumeSessionId: string | null) => {
    const args = ["-p", prompt, "--output-format", "json", "--silent", "--no-ask-user", "--no-auto-update"];
    if (resumeSessionId) args.push(`--resume=${resumeSessionId}`);
    if (allowAll) args.push("--yolo");
    if (model) args.push("--model", model);
    if (reasoningEffort && modelSupportsEffort) args.push("--reasoning-effort", reasoningEffort);
    if (maxAutopilotContinues > 0) {
      args.push("--autopilot", "--max-autopilot-continues", String(maxAutopilotContinues));
    }
    if (noCustomInstructions) args.push("--no-custom-instructions");
    if (mcpConfig) args.push("--additional-mcp-config", mcpConfig);
    if (agentName) args.push("--agent", agentName);
    if (allowTool.length > 0) args.push(`--allow-tool=${allowTool.join(",")}`);
    if (denyTool.length > 0) args.push(`--deny-tool=${denyTool.join(",")}`);
    if (extraArgs.length > 0) args.push(...extraArgs);
    return args;
  };

  const parseFallbackErrorMessage = (proc: RunProcessResult) => {
    const stderrLine =
      proc.stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? "";

    if ((proc.exitCode ?? 0) === 0) {
      return "Failed to parse Copilot JSONL output";
    }

    return stderrLine
      ? `Copilot exited with code ${proc.exitCode ?? -1}: ${stderrLine}`
      : `Copilot exited with code ${proc.exitCode ?? -1}`;
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildCopilotArgs(resumeSessionId);
    if (onMeta) {
      await onMeta({
        adapterType: "copilot_cli",
        command,
        cwd,
        commandArgs: args,
        env: redactEnvForLogs(env),
        prompt,
        context,
      });
    }

    const interceptor = createJsonlLogInterceptor(onLog);

    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env,
      timeoutSec,
      graceSec,
      onSpawn,
      onLog: interceptor.onChunk,
    });

    await interceptor.flush();

    const parsedStream = parseCopilotJsonl(proc.stdout);
    return { proc, parsedStream };
  };

  const toAdapterResult = (
    attempt: {
      proc: RunProcessResult;
      parsedStream: ReturnType<typeof parseCopilotJsonl>;
    },
    opts: { fallbackSessionId: string | null },
  ): AdapterExecutionResult => {
    const { proc, parsedStream } = attempt;
    const loginMeta = detectCopilotLoginRequired({
      stdout: proc.stdout,
      stderr: proc.stderr,
    });
    const rateLimitMeta = detectCopilotRateLimit({
      stdout: proc.stdout,
      stderr: proc.stderr,
      latestError: parsedStream.latestError ?? null,
    });

    if (proc.timedOut) {
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: "timeout",
        clearSession: alwaysFresh,
      };
    }

    if (!parsedStream.resultJson) {
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: false,
        errorMessage: rateLimitMeta.message ?? parseFallbackErrorMessage(proc),
        errorCode: loginMeta.requiresLogin ? "copilot_auth_required" : rateLimitMeta.isRateLimited ? "rate_limit" : null,
        resultJson: {
          stdout: proc.stdout,
          stderr: proc.stderr,
        },
      };
    }

    const resolvedSessionId =
      parsedStream.sessionId ?? opts.fallbackSessionId;
    const resolvedSessionParams = resolvedSessionId
      ? ({
          sessionId: resolvedSessionId,
          cwd,
          ...(workspaceId ? { workspaceId } : {}),
          ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
          ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
        } as Record<string, unknown>)
      : null;
    const clearSessionForMaxTurns = isCopilotMaxTurnsResult(parsedStream.resultJson);
    const hasSuccessfulFinalResult =
      describeCopilotFailure(parsedStream.resultJson, {
        rateLimitMessage: rateLimitMeta.isRateLimited ? rateLimitMeta.message : null,
      }) == null;
    const requiresLogin = loginMeta.requiresLogin && !hasSuccessfulFinalResult;

    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage:
        requiresLogin || (proc.exitCode ?? 0) !== 0
          ? describeCopilotFailure(parsedStream.resultJson, {
              rateLimitMessage: rateLimitMeta.isRateLimited ? rateLimitMeta.message : null,
            }) ??
            `Copilot exited with code ${proc.exitCode ?? -1}`
          : null,
      errorCode:
        requiresLogin ? "copilot_auth_required" : rateLimitMeta.isRateLimited ? "rate_limit" : null,
      usage: parsedStream.usage ?? undefined,
      premiumRequests: parsedStream.premiumRequests,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: "github",
      biller: "github",
      model: parsedStream.model || model,
      billingType: "subscription",
      costUsd: parsedStream.costUsd ?? 0,
      resultJson: parsedStream.resultJson,
      summary: parsedStream.summary,
      clearSession: alwaysFresh || clearSessionForMaxTurns,
    };
  };

  try {
    const initial = await runAttempt(sessionId ?? null);
    if (
      initial.parsedStream.resultJson &&
      isCopilotUnknownSessionError(initial.parsedStream.resultJson)
    ) {
      await onLog(
        "stdout",
        `[paperclip] Copilot session "${runtimeSessionId}" not found, retrying without session.\n`,
      );
      const retry = await runAttempt(null);
      const retryResult = toAdapterResult(retry, { fallbackSessionId: null });
      retryResult.clearSession = true;
      return retryResult;
    }
    return toAdapterResult(initial, {
      fallbackSessionId: runtimeSessionId || runtime.sessionId,
    });
  } finally {
    if (instructionsTmpDir) {
      fs.rm(instructionsTmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
