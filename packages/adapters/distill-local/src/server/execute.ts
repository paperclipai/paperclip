import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProviderStoppedBoundary } from "@paperclipai/adapter-utils/provider-stopped-boundary";
import { withWorkspaceRestore } from "@paperclipai/adapter-utils/workspace-restore-result";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  buildInvocationEnvForLogs,
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  joinPromptSections,
  materializePaperclipSkillCopy,
  parseObject,
  readPaperclipIssueWorkModeFromContext,
  readPaperclipRuntimeSkillEntries,
  renderTemplate,
  hydrateFreshSessionHandoff,
  selectPaperclipPromptSections,
  selectInitialCommunicationGuidance,
  isPaperclipRecoveryWakePayload,
  resolveLegacyPaperclipDesiredSkillNames,
  refreshPaperclipWorkspaceEnvForExecution,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { DEFAULT_DISTILL_LOCAL_MODEL, NO_WORKER_MODEL, type as adapterType } from "../index.js";
import { isDistillUnknownSessionError, parseDistillJsonl, type ParsedDistillRun } from "./parse.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function firstNonEmptyLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true, () => false);
}

function renderPaperclipEnvNote(env: Record<string, string>): string {
  const keys = Object.keys(env).filter((key) => key.startsWith("PAPERCLIP_")).sort();
  if (keys.length === 0) return "";
  return [
    "Paperclip runtime note:",
    `The following PAPERCLIP_* environment variables are available in this run: ${keys.join(", ")}`,
    "Do not assume these variables are missing without checking your shell environment.",
    "",
    "",
  ].join("\n");
}

function renderApiAccessNote(env: Record<string, string>): string {
  if (!nonEmpty(env.PAPERCLIP_API_URL) || !nonEmpty(env.PAPERCLIP_API_KEY)) return "";
  return [
    "Paperclip API access note:",
    "Use shell commands with curl to make Paperclip API requests when needed.",
    "Include X-Paperclip-Run-Id on mutating requests.",
    "",
    "",
  ].join("\n");
}

interface StageProjectAssetsInput {
  cwd: string;
  instructionsFilePath: string;
  skillEntries: Awaited<ReturnType<typeof readPaperclipRuntimeSkillEntries>>;
  desiredSkillNames: string[];
  onLog: AdapterExecutionContext["onLog"];
}

async function stageProjectAssets({ cwd, instructionsFilePath, skillEntries, desiredSkillNames, onLog }: StageProjectAssetsInput) {
  const created: Array<{ kind: "file" | "tree" | "emptyDir"; path: string }> = [];
  let stagedInstructionsPath: string | null = null;
  let inlineInstructions = "";
  let stagedSkillsCount = 0;

  const cleanup = async () => {
    for (const entry of [...created].reverse()) {
      if (entry.kind === "emptyDir") await fs.rmdir(entry.path).catch(() => undefined);
      else await fs.rm(entry.path, { recursive: entry.kind === "tree", force: true }).catch(() => undefined);
    }
  };

  try {
    const instructionsTarget = path.join(cwd, "Agents.md");
    if (instructionsFilePath) {
      if (!(await pathExists(instructionsTarget))) {
        await fs.copyFile(instructionsFilePath, instructionsTarget);
        created.push({ kind: "file", path: instructionsTarget });
        stagedInstructionsPath = instructionsTarget;
      } else if (path.resolve(instructionsTarget) !== path.resolve(instructionsFilePath)) {
        inlineInstructions = (await fs.readFile(instructionsFilePath, "utf8")).trim();
        await onLog(
          "stdout",
          `[paperclip] Distill workspace already contains ${instructionsTarget}; including ${instructionsFilePath} in the prompt instead of overwriting it.\n`,
        );
      }
    }

    const desired = new Set(desiredSkillNames);
    const selected = skillEntries.filter((entry) => desired.has(entry.key));
    if (selected.length > 0) {
      const claudeDir = path.join(cwd, ".claude");
      const skillsRoot = path.join(claudeDir, "skills");
      if (!(await pathExists(claudeDir))) {
        await fs.mkdir(claudeDir, { recursive: true });
        created.push({ kind: "emptyDir", path: claudeDir });
      }
      if (!(await pathExists(skillsRoot))) {
        await fs.mkdir(skillsRoot, { recursive: true });
        created.push({ kind: "emptyDir", path: skillsRoot });
      }
      for (const skill of selected) {
        const target = path.join(skillsRoot, skill.runtimeName);
        if (await pathExists(target)) {
          await onLog("stdout", `[paperclip] Distill skill target already exists at ${target}; leaving it unchanged.\n`);
          continue;
        }
        created.push({ kind: "tree", path: target });
        await materializePaperclipSkillCopy(skill.source, target);
        stagedSkillsCount += 1;
      }
    }
  } catch (error) {
    await cleanup();
    throw error;
  }

  return {
    stagedInstructionsPath,
    inlineInstructions,
    stagedSkillsCount,
    cleanup,
  };
}

function wakeEnv(context: Record<string, unknown>): Record<string, string> {
  const env: Record<string, string> = {};
  const taskId = nonEmpty(context.taskId) ?? nonEmpty(context.issueId);
  const wakeReason = nonEmpty(context.wakeReason);
  const commentId = nonEmpty(context.wakeCommentId) ?? nonEmpty(context.commentId);
  const approvalId = nonEmpty(context.approvalId);
  const approvalStatus = nonEmpty(context.approvalStatus);
  const issueIds = Array.isArray(context.issueIds) ? context.issueIds.filter((value) => nonEmpty(value)) : [];
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
  if (taskId) env.PAPERCLIP_TASK_ID = taskId;
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (commentId) env.PAPERCLIP_WAKE_COMMENT_ID = commentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (issueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = issueIds.join(",");
  return env;
}

export interface DistillConfigOverlayInput {
  workerModel: string;
  workerEffort: string;
  mainVariant: string;
  workerVariant: string;
  /** GROK_CONFIG already present in the run env (for example from the agent's env config). */
  existing?: string;
}

/**
 * Builds the per-run `GROK_CONFIG` overlay for Distill settings that have no CLI flag.
 * Distill deep-merges it over `config.toml`; keys already in `existing` are kept.
 * Returns null when nothing is set so the host config applies unchanged.
 */
export function buildDistillConfigOverlay({
  workerModel,
  workerEffort,
  mainVariant,
  workerVariant,
  existing,
}: DistillConfigOverlayInput): string | null {
  const models: Record<string, string> = {};
  if (workerModel) models.worker = workerModel === NO_WORKER_MODEL ? "" : workerModel;
  if (workerEffort) models.worker_effort = workerEffort;
  if (mainVariant) models.main_variant = mainVariant;
  if (workerVariant) models.worker_variant = workerVariant;
  if (Object.keys(models).length === 0) return null;
  let base: Record<string, unknown> = {};
  if (existing) {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) base = parsed as Record<string, unknown>;
    } catch {
      // Distill ignores a malformed overlay too; replace it.
    }
  }
  return JSON.stringify({ ...base, models: { ...parseObject(base.models), ...models } });
}

export interface BuildDistillArgsInput {
  cwd: string;
  resumeSessionId: string | null;
  model: string;
  reasoningEffort: string;
  mode: string;
  maxTurns: number;
  permissionMode: string;
  alwaysApprove: boolean;
  disableWebSearch: boolean;
  extraArgs: string[];
  prompt: string;
}

export function buildDistillArgs({
  cwd,
  resumeSessionId,
  model,
  reasoningEffort,
  mode,
  maxTurns,
  permissionMode,
  alwaysApprove,
  disableWebSearch,
  extraArgs,
  prompt,
}: BuildDistillArgsInput): string[] {
  const args = ["--cwd", cwd, "--output-format", "streaming-json"];
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  args.push("--model", model || DEFAULT_DISTILL_LOCAL_MODEL);
  if (reasoningEffort) args.push("--reasoning-effort", reasoningEffort);
  if (mode) args.push("--mode", mode);
  if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
  if (permissionMode) args.push("--permission-mode", permissionMode);
  if (alwaysApprove) args.push("--always-approve");
  if (disableWebSearch) args.push("--disable-web-search");
  if (extraArgs.length > 0) args.push(...extraArgs);
  args.push("--single", prompt);
  return args;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  if (ctx.executionTarget?.kind === "remote") {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      errorCode: "adapter_target_unsupported",
      errorMessage: "The Distill adapter runs only on the Paperclip host. Use a local execution target.",
    };
  }

  const providerStop = createProviderStoppedBoundary(ctx.onProviderStopped);
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    context.conversationMode === true
      ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE
      : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const command = asString(config.command, "distill");
  const model = asString(config.model, DEFAULT_DISTILL_LOCAL_MODEL).trim() || DEFAULT_DISTILL_LOCAL_MODEL;
  const reasoningEffort = asString(config.reasoningEffort, "").trim();
  const mode = asString(config.mode, "").trim();
  const workerModel = asString(config.workerModel, "").trim();
  const workerEffort = asString(config.workerEffort, "").trim();
  const mainVariant = asString(config.mainVariant, "").trim();
  const workerVariant = asString(config.workerVariant, "").trim();
  const permissionMode = asString(config.permissionMode, "").trim();
  const maxTurns = asNumber(config.maxTurns, 0);
  const alwaysApprove = asBoolean(config.alwaysApprove, true);
  const disableWebSearch = asBoolean(config.disableWebSearch, false);
  const trustWorkspace = asBoolean(config.trustWorkspace, true);
  const extraArgs = asStringArray(config.extraArgs).length > 0 ? asStringArray(config.extraArgs) : asStringArray(config.args);

  const workspace = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspace.cwd, "");
  const workspaceSource = asString(workspace.source, "");
  const workspaceId = asString(workspace.workspaceId, "");
  const workspaceRepoUrl = asString(workspace.repoUrl, "");
  const workspaceRepoRef = asString(workspace.repoRef, "");
  const agentHome = asString(workspace.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter((value) => typeof value === "object" && value !== null)
    : [];
  const configuredCwd = asString(config.cwd, "");
  const effectiveWorkspaceCwd = workspaceSource === "agent_home" && configuredCwd ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const skillEntries = await readPaperclipRuntimeSkillEntries(config, moduleDir);
  const desiredSkillNames = resolveLegacyPaperclipDesiredSkillNames(config, skillEntries);
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const staged = await stageProjectAssets({ cwd, instructionsFilePath, skillEntries, desiredSkillNames, onLog });

  const runTurn = async () => {
    const envConfig = parseObject(config.env);
    const env = {
      ...buildPaperclipEnv(agent, ctx.agentIdentity),
      ...buildRuntimeToolsEnv(ctx.runtimeTools),
      ...wakeEnv(context),
    };
    env.PAPERCLIP_RUN_ID = runId;
    refreshPaperclipWorkspaceEnvForExecution({
      env,
      envConfig,
      workspaceCwd: effectiveWorkspaceCwd,
      workspaceSource,
      workspaceId,
      workspaceRepoUrl,
      workspaceRepoRef,
      workspaceHints,
      agentHome,
      executionTargetIsRemote: false,
      executionCwd: cwd,
    });
    if (authToken) env.PAPERCLIP_API_KEY = authToken;
    if (trustWorkspace && env.GROK_FOLDER_TRUST === undefined) env.GROK_FOLDER_TRUST = "0";
    const configOverlay = buildDistillConfigOverlay({
      workerModel,
      workerEffort,
      mainVariant,
      workerVariant,
      existing: env.GROK_CONFIG ?? process.env.GROK_CONFIG,
    });
    if (configOverlay) env.GROK_CONFIG = configOverlay;

    const timeoutSec = asNumber(config.timeoutSec, 0);
    const graceSec = asNumber(config.graceSec, 20);
    const runtimeEnv = ensurePathInEnv(
      Object.fromEntries(Object.entries({ ...process.env, ...env }).filter((entry) => typeof entry[1] === "string")),
    );
    await ensureAdapterExecutionTargetCommandResolvable(command, null, cwd, runtimeEnv, { timeoutSec });
    const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, null, cwd, runtimeEnv);
    const loggedEnv = buildInvocationEnvForLogs(env, { runtimeEnv, includeRuntimeKeys: ["HOME"], resolvedCommand });

    const sessionParams = parseObject(runtime.sessionParams);
    const savedSessionId = asString(sessionParams.sessionId, runtime.sessionId ?? "");
    const savedSessionCwd = asString(sessionParams.cwd, "");
    const canResume =
      savedSessionId.length > 0 && (savedSessionCwd.length === 0 || path.resolve(savedSessionCwd) === path.resolve(cwd));
    if (savedSessionId && !canResume) {
      await onLog(
        "stdout",
        `[paperclip] Distill session "${savedSessionId}" was saved for cwd "${savedSessionCwd}" and will not be resumed in "${cwd}".\n`,
      );
    }

    const commandNotes = ["Prompt is passed to Distill via --single in headless mode."];
    if (model === "auto") commandNotes.push("Model \"auto\" lets Distill route across its saved accounts.");
    if (alwaysApprove) commandNotes.push("Added --always-approve for unattended execution.");
    if (trustWorkspace) commandNotes.push("Set GROK_FOLDER_TRUST=0 so Distill loads workspace instructions and skills.");
    if (configOverlay) commandNotes.push(`Distill config overlay (GROK_CONFIG): ${configOverlay}`);
    if (staged.stagedInstructionsPath) commandNotes.push(`Staged project instructions at ${staged.stagedInstructionsPath}.`);
    if (staged.inlineInstructions) commandNotes.push(`Included ${instructionsFilePath} in the prompt.`);
    if (staged.stagedSkillsCount > 0) commandNotes.push(`Staged ${staged.stagedSkillsCount} Paperclip skill(s) into .claude/skills.`);

    const templateData = {
      agentId: agent.id,
      companyId: agent.companyId,
      runId,
      company: { id: agent.companyId },
      agent,
      run: { id: runId, source: "on_demand" },
      context,
    };
    const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
    const envNote = renderPaperclipEnvNote(env);
    const apiNote = renderApiAccessNote(env);

    const runAttempt = async (resumeSessionId: string | null) => {
      await hydrateFreshSessionHandoff(ctx, { resumedSession: Boolean(resumeSessionId) });
      ctx.signal?.throwIfAborted();
      const sections = selectPaperclipPromptSections(context, {
        resumedSession: Boolean(resumeSessionId),
        includeCommunicationGuidance: false,
      });
      const renderedPrompt =
        (Boolean(resumeSessionId) && sections.wakePrompt.length > 0) || isPaperclipRecoveryWakePayload(context.paperclipWake)
          ? ""
          : renderTemplate(promptTemplate, templateData);
      const instructionsSection =
        staged.inlineInstructions && !resumeSessionId
          ? `Agent instructions (from ${instructionsFilePath}):\n\n${staged.inlineInstructions}\n`
          : "";
      const prompt = joinPromptSections([
        selectInitialCommunicationGuidance(context, { resumedSession: Boolean(resumeSessionId) }),
        instructionsSection,
        sections.wakePrompt,
        sections.taskContextNote,
        sessionHandoffNote,
        envNote,
        apiNote,
        renderedPrompt,
      ]);
      const args = buildDistillArgs({
        cwd,
        resumeSessionId,
        model,
        reasoningEffort,
        mode,
        maxTurns,
        permissionMode,
        alwaysApprove,
        disableWebSearch,
        extraArgs,
        prompt,
      });
      if (onMeta) {
        await onMeta({
          adapterType,
          command: resolvedCommand,
          cwd,
          commandNotes,
          commandArgs: args.map((value, index) => (index === args.length - 1 ? `<prompt ${prompt.length} chars>` : value)),
          env: loggedEnv,
          prompt,
          promptMetrics: {
            promptChars: prompt.length,
            wakePromptChars: sections.wakePrompt.length,
            taskContextChars: sections.taskContextNote.length,
            sessionHandoffChars: sessionHandoffNote.length,
            runtimeNoteChars: envNote.length + apiNote.length,
            heartbeatPromptChars: renderedPrompt.length,
          },
          context,
        });
      }
      const proc = await runAdapterExecutionTargetProcess(runId, null, command, args, {
        onProcessStopped: providerStop.beginInvocation(),
        cwd,
        env,
        timeoutSec,
        graceSec,
        onSpawn,
        onRuntimeProgress: ctx.onRuntimeProgress,
        onLog,
      });
      return { proc, parsed: parseDistillJsonl(proc.stdout) };
    };

    const toResult = (
      attempt: { proc: Awaited<ReturnType<typeof runAdapterExecutionTargetProcess>>; parsed: ParsedDistillRun },
      { isRetry = false, clearSession = false } = {},
    ): AdapterExecutionResult => {
      const { proc, parsed } = attempt;
      const failed = proc.timedOut || (proc.exitCode ?? 0) !== 0;
      const errorMessage = proc.timedOut
        ? `Timed out after ${timeoutSec}s`
        : failed
          ? parsed.errorMessage || firstNonEmptyLine(proc.stderr) || `Distill exited with code ${proc.exitCode ?? -1}`
          : null;
      const sessionId = parsed.sessionId ?? (isRetry ? null : savedSessionId || null);
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: proc.timedOut,
        errorMessage,
        usage: {
          inputTokens: parsed.inputTokens,
          outputTokens: parsed.outputTokens,
          cachedInputTokens: parsed.cachedInputTokens,
          cacheWriteTokens: parsed.cacheWriteTokens,
        },
        usageBasis: "per_run" as const,
        sessionId,
        sessionParams: sessionId
          ? {
              sessionId,
              cwd,
              ...(workspaceId ? { workspaceId } : {}),
              ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
              ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
            }
          : null,
        sessionDisplayId: sessionId,
        provider: "distill",
        biller: "distill",
        model: parsed.primaryModel ?? model,
        billingType: "unknown",
        costUsd: parsed.costUsd,
        resultJson: {
          stopReason: parsed.stopReason,
          requestedModel: model,
          servedModel: parsed.primaryModel,
          finalResponseRecorded: Boolean(parsed.stopReason) && Boolean(parsed.summary),
          requestId: parsed.requestId,
          ...(failed ? { stderr: proc.stderr } : {}),
        },
        summary: parsed.summary,
        clearSession: clearSession && !sessionId,
      };
    };

    const initial = await runAttempt(canResume ? savedSessionId : null);
    ctx.signal?.throwIfAborted();
    if (
      canResume &&
      !initial.proc.timedOut &&
      (initial.proc.exitCode ?? 0) !== 0 &&
      isDistillUnknownSessionError(initial.proc.stdout, initial.proc.stderr)
    ) {
      await onLog("stdout", `[paperclip] Distill session "${savedSessionId}" is unavailable; retrying with a fresh session.\n`);
      return toResult(await runAttempt(null), { isRetry: true, clearSession: true });
    }
    return toResult(initial);
  };

  try {
    return await withWorkspaceRestore(
      async () => {
        let result: AdapterExecutionResult;
        let collectionFailed = false;
        try {
          result = await runTurn();
        } finally {
          try {
            await providerStop.collectBeforeRestore();
          } catch {
            collectionFailed = true;
            await onLog("stderr", "[paperclip] Instruction collection failed after provider stop.\n").catch(() => undefined);
          }
        }
        if (!collectionFailed) return result;
        const providerFailed = result.timedOut || result.signal || result.errorCode || (result.exitCode ?? 0) !== 0;
        return {
          ...result,
          ...(!providerFailed ? { errorCode: "instruction_collection_failed" } : {}),
          errorMessage: [result.errorMessage, "Instruction collection failed after provider stop."].filter(Boolean).join(" "),
          resultJson: { ...result.resultJson, instructionCollectionFailure: "collection_failed" },
        };
      },
      async () => undefined,
    );
  } finally {
    await staged.cleanup();
  }
}
