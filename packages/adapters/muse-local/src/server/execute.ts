import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { withWorkspaceRestore } from "@paperclipai/adapter-utils/workspace-restore-result";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  adapterExecutionTargetDuplexObservabilityRecorder,
  adapterExecutionTargetEnablesSandboxDuplexBridge,
  adapterExecutionTargetUsesPaperclipBridge,
  startAdapterExecutionTargetPaperclipBridge,
  describeAdapterExecutionTarget,
  overrideAdapterExecutionTargetRemoteCwd,
  prepareAdapterExecutionTargetRuntime,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetCommandForLogs,
  resolveAdapterExecutionTargetTimeoutSec,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import {
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
  renderPaperclipWakePrompt,
  resolveLegacyPaperclipDesiredSkillNames,
  resolvePaperclipInstanceRootForAdapter,
  refreshPaperclipWorkspaceEnvForExecution,
  selectInitialCommunicationGuidance,
  selectPaperclipTaskMarkdown,
  isPaperclipRecoveryWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_MUSE_LOCAL_MODEL } from "../index.js";
import { isMuseAuthError, parseMuseJsonl } from "./parse.js";
import { readCompanyMuseApiKey } from "./muse-home.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function hasNonEmptyEnvValue(env: Record<string, string | undefined>, key: string): boolean {
  return nonEmpty(env[key]) !== null;
}

// Muse prints informational `muse: ...` lines (workspace root, trust, skills)
// before anything else; the failure itself is the last line it prints.
function lastMeaningfulLine(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const meaningful = lines.filter((line) => !/^muse:\s/.test(line));
  return meaningful.at(-1) ?? lines.at(-1) ?? "";
}

/** The per-agent Muse data home (session store). Never the operator's ~/.local/share/muse. */
export function resolveMuseDataHome(env: NodeJS.ProcessEnv, companyId: string, agentId: string): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  return path.resolve(instanceRoot, "companies", companyId, "muse-data", agentId);
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
  if (!hasNonEmptyEnvValue(env, "PAPERCLIP_API_URL") || !hasNonEmptyEnvValue(env, "PAPERCLIP_API_KEY")) return "";
  return [
    "Paperclip API access note:",
    "Use shell commands with curl to make Paperclip API requests when needed.",
    "Include X-Paperclip-Run-Id on mutating requests.",
    "",
    "",
  ].join("\n");
}

const pathExists = (candidate: string) => fs.access(candidate).then(() => true).catch(() => false);

/** Copies desired skills into <cwd>/.agents/skills. Returns a cleanup that removes only what it created. */
async function stageMuseSkills(input: {
  cwd: string;
  skillEntries: Array<{ key: string; runtimeName: string; source: string }>;
  desiredSkillNames: string[];
  onLog: AdapterExecutionContext["onLog"];
}): Promise<{ count: number; cleanup: () => Promise<void> }> {
  const created: string[] = [];
  const desired = new Set(input.desiredSkillNames);
  const selected = input.skillEntries.filter((entry) => desired.has(entry.key));
  let count = 0;
  const cleanup = async () => {
    for (const entry of [...created].reverse()) {
      await fs.rm(entry, { recursive: true, force: true }).catch(() => undefined);
    }
  };
  try {
    if (selected.length > 0) {
      const agentsDir = path.join(input.cwd, ".agents");
      const skillsRoot = path.join(agentsDir, "skills");
      if (!(await pathExists(agentsDir))) {
        await fs.mkdir(agentsDir, { recursive: true });
        created.push(agentsDir);
      }
      if (!(await pathExists(skillsRoot))) {
        await fs.mkdir(skillsRoot, { recursive: true });
        created.push(skillsRoot);
      }
      for (const skill of selected) {
        const target = path.join(skillsRoot, skill.runtimeName);
        if (await pathExists(target)) {
          await input.onLog("stdout", `[paperclip] Muse skill target already exists at ${target}; leaving it unchanged.\n`);
          continue;
        }
        created.push(target);
        await materializePaperclipSkillCopy(skill.source, target);
        count += 1;
      }
    }
  } catch (error) {
    // Never leave partially staged skills behind: a later run would treat
    // them as user-owned and skip (and never remove) them.
    await cleanup();
    throw error;
  }
  return { count, cleanup };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);

  const promptTemplate = asString(
    config.promptTemplate,
    context.conversationMode === true ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const command = asString(config.command, "muse");
  const model = asString(config.model, DEFAULT_MUSE_LOCAL_MODEL).trim() || DEFAULT_MUSE_LOCAL_MODEL;
  const reasoningEffort = asString(config.reasoningEffort, "").trim();

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter((v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null)
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  let effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
  // The configured remote base, before the per-run workspace sync picks a
  // run-specific directory.
  const remoteBaseCwd = effectiveExecutionCwd;

  const skillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkillNames = resolveLegacyPaperclipDesiredSkillNames(config, skillEntries);
  const promptDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-muse-prompt-"));
  let stagedSkills: { count: number; cleanup: () => Promise<void> } = { count: 0, cleanup: async () => {} };

  let restoreRemoteWorkspace: (() => Promise<void>) | null = null;
  let paperclipBridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;

  const executeTurn = async (): Promise<AdapterExecutionResult> => {
    stagedSkills = await stageMuseSkills({ cwd, skillEntries, desiredSkillNames, onLog });
    const envConfig = parseObject(config.env);
    const env: Record<string, string> = { ...buildPaperclipEnv(agent), ...buildRuntimeToolsEnv(ctx.runtimeTools) };
    env.PAPERCLIP_RUN_ID = runId;
    const pick = (value: unknown) => (typeof value === "string" && value.trim().length > 0 ? value.trim() : null);
    const wakeTaskId = pick(context.taskId) ?? pick(context.issueId);
    const wakeReason = pick(context.wakeReason);
    const wakeCommentId = pick(context.wakeCommentId) ?? pick(context.commentId);
    const approvalId = pick(context.approvalId);
    const approvalStatus = pick(context.approvalStatus);
    const linkedIssueIds = Array.isArray(context.issueIds)
      ? context.issueIds.filter((v: unknown): v is string => typeof v === "string" && v.trim().length > 0)
      : [];
    const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
    if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
    if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
    if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
    if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
    if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
    if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
    if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
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
      executionTargetIsRemote,
      executionCwd: effectiveExecutionCwd,
    });
    if (authToken) env.PAPERCLIP_API_KEY = authToken;

    if (!executionTargetIsRemote) {
      const dataHome = resolveMuseDataHome(process.env, agent.companyId, agent.id);
      await fs.mkdir(dataHome, { recursive: true, mode: 0o700 });
      env.XDG_DATA_HOME = dataHome;
    }
    // Do not set TBH_CREDENTIAL_BACKEND here: forcing the file backend hides a
    // macOS keychain `muse login`. META_API_KEY needs no backend at all.
    env.MUSE_NO_AUTO_UPDATE = "1";
    // Credential precedence: a bound META_API_KEY (agent env or managed AI
    // connection) > the company key from a sandbox device login > the host's
    // own `muse login`.
    let usedCompanyKey = false;
    if (!config.managedAiConnection && !hasNonEmptyEnvValue({ ...process.env, ...env }, "META_API_KEY")) {
      const companyKey = await readCompanyMuseApiKey(process.env, agent.companyId);
      if (companyKey) {
        env.META_API_KEY = companyKey;
        usedCompanyKey = true;
      }
    }

    const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(executionTarget, asNumber(config.timeoutSec, 0));
    const graceSec = asNumber(config.graceSec, 20);
    await ensureAdapterExecutionTargetRuntimeCommandInstalled({
      runId,
      target: executionTarget,
      installCommand: ctx.runtimeCommandSpec?.installCommand,
      detectCommand: ctx.runtimeCommandSpec?.detectCommand,
      cwd,
      env,
      timeoutSec,
      graceSec,
      onLog,
    });
    let runtimeRootDir: string | undefined;
    if (executionTargetIsRemote) {
      await onLog("stdout", `[paperclip] Syncing Muse workspace to ${describeAdapterExecutionTarget(executionTarget)}.\n`);
      // No credential home is shipped: the key travels as META_API_KEY, and the
      // host's own Muse login never leaves this machine.
      const prepared = await prepareAdapterExecutionTargetRuntime({
        runId,
        target: executionTarget,
        adapterKey: "muse",
        workspaceLocalDir: cwd,
        timeoutSec,
        installCommand: ctx.runtimeCommandSpec?.installCommand ?? null,
        detectCommand: ctx.runtimeCommandSpec?.detectCommand ?? command,
        onProgress: (line) => onLog("stdout", line),
        onRuntimeProgress: ctx.onRuntimeProgress,
      });
      restoreRemoteWorkspace = () => prepared.restoreWorkspace((line) => onLog("stdout", line));
      runtimeRootDir = prepared.runtimeRootDir ?? undefined;
      effectiveExecutionCwd = prepared.workspaceRemoteDir ?? effectiveExecutionCwd;
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
        executionTargetIsRemote,
        executionCwd: effectiveExecutionCwd,
      });
      // A stable per-agent Muse session store under the configured remote base,
      // not the per-run workspace, so the next remote heartbeat can resume.
      env.XDG_DATA_HOME = path.posix.join(remoteBaseCwd, ".paperclip-muse", agent.id, "data");
    }
    const runtimeExecutionTarget = overrideAdapterExecutionTargetRemoteCwd(executionTarget, effectiveExecutionCwd);
    // A remote agent reaches the Paperclip API through the bridge (the host's
    // loopback API is not reachable from the remote), as claude_local does.
    if (executionTargetIsRemote && adapterExecutionTargetUsesPaperclipBridge(runtimeExecutionTarget)) {
      paperclipBridge = await startAdapterExecutionTargetPaperclipBridge({
        runId,
        target: runtimeExecutionTarget,
        enableSandboxDuplexBridge: adapterExecutionTargetEnablesSandboxDuplexBridge(runtimeExecutionTarget),
        duplexObservabilityRecorder: adapterExecutionTargetDuplexObservabilityRecorder(runtimeExecutionTarget),
        runtimeRootDir,
        adapterKey: "muse",
        timeoutSec,
        hostApiToken: env.PAPERCLIP_API_KEY,
        onLog,
      });
      if (paperclipBridge) Object.assign(env, paperclipBridge.env);
    }
    const effectiveEnv = Object.fromEntries(
      Object.entries({ ...process.env, ...env }).filter((e): e is [string, string] => typeof e[1] === "string"),
    );
    const runtimeEnv = ensurePathInEnv(effectiveEnv);
    await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv, {
      installCommand: ctx.runtimeCommandSpec?.installCommand ?? null,
      timeoutSec,
    });
    const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, executionTarget, cwd, runtimeEnv);
    const loggedEnv = buildInvocationEnvForLogs(env, { runtimeEnv, includeRuntimeKeys: ["HOME"], resolvedCommand });
    // A managed AI connection injects META_API_KEY for both of its methods, so
    // its own method decides billing; otherwise a bound key means API billing.
    const managedMethod = asString(parseObject(config.managedAiConnection).method, "");
    const billingType: "api" | "subscription" = managedMethod
      ? (managedMethod === "api_key" ? "api" : "subscription")
      : usedCompanyKey ? "subscription"
        : hasNonEmptyEnvValue(effectiveEnv, "META_API_KEY") ? "api" : "subscription";

    const runtimeSessionParams = parseObject(runtime.sessionParams);
    const storedSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
    const storedSessionCwd = asString(runtimeSessionParams.cwd, "");
    const canResume =
      storedSessionId.length > 0 &&
      (storedSessionCwd.length === 0 || path.resolve(storedSessionCwd) === path.resolve(effectiveExecutionCwd)) &&
      adapterExecutionTargetSessionMatches(parseObject(runtimeSessionParams.remoteExecution), runtimeExecutionTarget);
    if (storedSessionId && !canResume) {
      await onLog(
        "stdout",
        `[paperclip] Muse session "${storedSessionId}" was saved for cwd "${storedSessionCwd}" and will not be resumed in "${effectiveExecutionCwd}".\n`,
      );
    }
    const sessionId = canResume ? storedSessionId : randomUUID();

    const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
    let instructionsPrefix = "";
    if (instructionsFilePath) {
      try {
        const contents = await fs.readFile(instructionsFilePath, "utf8");
        const instructionsDir = `${path.dirname(instructionsFilePath)}/`;
        instructionsPrefix =
          `${contents}\n\n` +
          `The above agent instructions were loaded from ${instructionsFilePath}. ` +
          `Resolve any relative file references from ${instructionsDir}.\n\n`;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await onLog("stdout", `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`);
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
    const taskContextNote = context.conversationMode === true
      ? selectPaperclipTaskMarkdown(context, { resumedSession: canResume, includeCommunicationGuidance: false })
      : "";
    const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, {
      conversationMode: context.conversationMode === true,
      resumedSession: canResume,
      suppressIssueDescription: taskContextNote.length > 0,
    });
    const renderedPrompt = (canResume && wakePrompt.length > 0) || isPaperclipRecoveryWakePayload(context.paperclipWake)
      ? ""
      : renderTemplate(promptTemplate, templateData);
    const prompt = joinPromptSections([
      instructionsPrefix,
      selectInitialCommunicationGuidance(context, { resumedSession: canResume }),
      wakePrompt,
      taskContextNote,
      asString(context.paperclipSessionHandoffMarkdown, "").trim(),
      renderPaperclipEnvNote(env),
      renderApiAccessNote(env),
      renderedPrompt,
    ]);
    // Local runs read the prompt from a private file. Remote runs cannot see
    // that file, so the prompt goes as the positional argument (as grok does).
    const promptFile = path.join(promptDir, "prompt.md");
    if (!executionTargetIsRemote) await fs.writeFile(promptFile, prompt, { mode: 0o600 });

    const extraArgs = (() => {
      const fromExtra = asStringArray(config.extraArgs);
      return fromExtra.length > 0 ? fromExtra : asStringArray(config.args);
    })();
    const args = [
      "exec", "--json",
      "--model", model,
      ...(reasoningEffort ? ["--reasoning-effort", reasoningEffort] : []),
      "--approval-mode", "never",
      "--trust-workspace",
      "--workspace", effectiveExecutionCwd,
      "--session-id", sessionId,
      ...(executionTargetIsRemote ? [] : ["--prompt-file", promptFile]),
      ...extraArgs,
      ...(executionTargetIsRemote ? [prompt] : []),
    ];

    if (onMeta) {
      await onMeta({
        adapterType: "muse_local",
        command: resolvedCommand,
        cwd: effectiveExecutionCwd,
        commandNotes: [
          executionTargetIsRemote
            ? "Prompt is passed to Muse as the positional argument on the remote target."
            : "Prompt is passed to Muse via --prompt-file in headless mode.",
          "Added --approval-mode never and --trust-workspace for unattended execution (Muse sandbox stays on).",
          ...(instructionsPrefix ? [`Prepended agent instructions from ${instructionsFilePath}.`] : []),
          ...(stagedSkills.count > 0 ? [`Staged ${stagedSkills.count} Paperclip skill(s) into .agents/skills.`] : []),
        ],
        commandArgs: executionTargetIsRemote
          ? args.map((value, index) => (index === args.length - 1 ? `<prompt ${prompt.length} chars>` : value))
          : args,
        env: loggedEnv,
        prompt,
        promptMetrics: { promptChars: prompt.length },
        context,
      });
    }

    const proc = await runAdapterExecutionTargetProcess(runId, runtimeExecutionTarget, command, args, {
      cwd,
      env,
      timeoutSec,
      graceSec,
      onSpawn,
      onRuntimeProgress: ctx.onRuntimeProgress,
      onLog,
      runLogTail: paperclipBridge?.runLogTail,
      settleRunDisposition: paperclipBridge?.settleRunDisposition,
    });
    const parsed = parseMuseJsonl(proc.stdout);
    // A clean exit without a run.terminal.* record means the output was cut
    // short, so its partial text must not become the final summary.
    const missingTerminal = parsed.terminal === null && !proc.timedOut && (proc.exitCode ?? 0) === 0;
    const failed = proc.timedOut || (proc.exitCode ?? 0) !== 0 || missingTerminal || (parsed.terminal !== null && parsed.terminal !== "completed");
    const rawError = missingTerminal
      ? "Muse run ended without a final result (no run.terminal record in the output)."
      : parsed.reason || lastMeaningfulLine(proc.stderr) || `Muse exited with code ${proc.exitCode ?? -1}`;
    const authFailure = failed && !proc.timedOut && isMuseAuthError(`${rawError}\n${proc.stderr}`);
    const errorMessage = proc.timedOut
      ? `Timed out after ${timeoutSec}s`
      : !failed
        ? null
        : authFailure
          ? `Muse Code is not authenticated: ${rawError}. Run \`muse login\` on this host or bind META_API_KEY in the agent env.`
          : rawError;
    const resolvedSessionId = parsed.sessionId ?? sessionId;

    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: proc.timedOut,
      errorMessage,
      ...(authFailure ? { errorCode: "muse_auth_required" } : {}),
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      usageBasis: "per_run",
      sessionId: resolvedSessionId,
      sessionParams: {
        sessionId: resolvedSessionId,
        cwd: effectiveExecutionCwd,
        ...(executionTargetIsRemote ? { remoteExecution: adapterExecutionTargetSessionIdentity(runtimeExecutionTarget) } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
        ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
      },
      sessionDisplayId: resolvedSessionId,
      provider: "meta",
      biller: "muse",
      model: parsed.model ?? model,
      billingType,
      costUsd: null,
      resultJson: {
        terminal: parsed.terminal,
        toolResultCount: parsed.toolResultCount,
        ...(failed ? { stderr: proc.stderr } : {}),
      },
      summary: parsed.summary,
    };
  };

  try {
    return await withWorkspaceRestore(executeTurn, async () => { await restoreRemoteWorkspace?.(); });
  } finally {
    const bridge = paperclipBridge as Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>>;
    if (bridge) await bridge.stop().catch(() => undefined);
    await fs.rm(promptDir, { recursive: true, force: true }).catch(() => undefined);
    await stagedSkills.cleanup();
  }
}
