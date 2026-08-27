import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  overrideAdapterExecutionTargetRemoteCwd,
  prepareAdapterExecutionTargetRuntime,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetCommandForLogs,
  resolveAdapterExecutionTargetTimeoutSec,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  buildInvocationEnvForLogs,
  buildPaperclipEnv,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  isPaperclipRecoveryWakePayload,
  joinPromptSections,
  materializePaperclipSkillCopy,
  parseObject,
  readPaperclipRuntimeSkillEntries,
  refreshPaperclipWorkspaceEnvForExecution,
  renderPaperclipWakePrompt,
  renderTemplate,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_CODEBUDDY_LOCAL_MODEL } from "../index.js";
import {
  describeCodeBuddyFailure,
  detectCodeBuddyLoginRequired,
  isCodeBuddyUnknownSessionError,
  parseCodeBuddyStreamJson,
} from "./parse.js";
import { estimateCodeBuddyCostUsd } from "./pricing.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
type CleanupEntry = { kind: "file" | "dir"; path: string };

async function exists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

async function stageProjectAssets(input: {
  cwd: string;
  instructionsFilePath: string;
  skills: Array<{ key: string; runtimeName: string; source: string }>;
  desired: string[];
  onLog: AdapterExecutionContext["onLog"];
}) {
  const cleanup: CleanupEntry[] = [];
  const instructionsTarget = path.join(input.cwd, "CODEBUDDY.md");
  if (input.instructionsFilePath && !await exists(instructionsTarget)) {
    await fs.copyFile(input.instructionsFilePath, instructionsTarget);
    cleanup.push({ kind: "file", path: instructionsTarget });
  } else if (input.instructionsFilePath) {
    await input.onLog("stdout", `[paperclip] ${instructionsTarget} already exists; leaving it unchanged.\n`);
  }
  const desired = new Set(input.desired);
  const selected = input.skills.filter((skill) => desired.has(skill.key));
  let stagedSkillsCount = 0;
  if (selected.length === 0) {
    return {
      stagedSkillsCount,
      cleanup: async () => {
        for (const entry of cleanup.reverse()) {
          await fs.rm(entry.path, { recursive: entry.kind === "dir", force: true }).catch(() => undefined);
        }
      },
    };
  }
  for (const relativeRoot of [".codebuddy/skills", ".claude/skills"]) {
    const nativeRoot = path.join(input.cwd, path.dirname(relativeRoot));
    const root = path.join(input.cwd, relativeRoot);
    if (!await exists(nativeRoot)) {
      await fs.mkdir(nativeRoot, { recursive: true });
      cleanup.push({ kind: "dir", path: nativeRoot });
    }
    if (!await exists(root)) {
      await fs.mkdir(root, { recursive: true });
      cleanup.push({ kind: "dir", path: root });
    }
    for (const skill of selected) {
      const target = path.join(root, skill.runtimeName);
      if (await exists(target)) continue;
      await materializePaperclipSkillCopy(skill.source, target);
      cleanup.push({ kind: "dir", path: target });
      stagedSkillsCount += 1;
    }
  }
  return {
    stagedSkillsCount,
    cleanup: async () => {
      for (const entry of cleanup.reverse()) {
        await fs.rm(entry.path, { recursive: entry.kind === "dir", force: true }).catch(() => undefined);
      }
    },
  };
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const target = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const targetIsRemote = adapterExecutionTargetIsRemote(target);
  const workspace = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspace.cwd, "");
  const configuredCwd = asString(config.cwd, "");
  const cwd = workspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  let executionCwd = adapterExecutionTargetRemoteCwd(target, cwd);
  const skills = await readPaperclipRuntimeSkillEntries(config, moduleDir);
  const staged = await stageProjectAssets({
    cwd,
    instructionsFilePath: asString(config.instructionsFilePath, "").trim(),
    skills,
    desired: resolvePaperclipDesiredSkillNames(config, skills),
    onLog,
  });
  let restoreRemoteWorkspace: (() => Promise<void>) | null = null;

  try {
    const command = asString(config.command, "codebuddy");
    const model = asString(config.model, DEFAULT_CODEBUDDY_LOCAL_MODEL).trim();
    const effort = asString(config.effort, asString(config.thinkingEffort, "")).trim();
    const supportsEffort = asBoolean(config.supportsEffort, false);
    const maxTurns = asNumber(config.maxTurns, 0);
    let appendSystemPrompt = asString(config.appendSystemPrompt, "").trim();
    const appendSystemPromptFile = asString(config.appendSystemPromptFile, "").trim();
    if (appendSystemPromptFile) {
      const fileContents = await fs.readFile(appendSystemPromptFile, "utf8");
      appendSystemPrompt = joinPromptSections([appendSystemPrompt, fileContents]);
    }
    const env: Record<string, string> = { ...buildPaperclipEnv(agent), PAPERCLIP_RUN_ID: runId };
    Object.assign(env, Object.fromEntries(
      Object.entries(parseObject(config.env)).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ));
    if (authToken) env.PAPERCLIP_API_KEY = authToken;
    const workspaceId = asString(workspace.workspaceId, "");
    const workspaceRepoUrl = asString(workspace.repoUrl, "");
    const workspaceRepoRef = asString(workspace.repoRef, "");
    const workspaceSource = asString(workspace.source, "");
    const workspaceHints = Array.isArray(context.paperclipWorkspaces)
      ? context.paperclipWorkspaces.filter(
          (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
        )
      : [];
    const refreshEnv = () => refreshPaperclipWorkspaceEnvForExecution({
      env,
      envConfig: parseObject(config.env),
      workspaceCwd,
      workspaceSource,
      workspaceId,
      workspaceRepoUrl,
      workspaceRepoRef,
      workspaceHints,
      agentHome: asString(workspace.agentHome, ""),
      executionTargetIsRemote: targetIsRemote,
      executionCwd,
    });
    refreshEnv();
    const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(target, asNumber(config.timeoutSec, 0));
    const graceSec = asNumber(config.graceSec, 20);
    await ensureAdapterExecutionTargetRuntimeCommandInstalled({
      runId,
      target,
      installCommand: ctx.runtimeCommandSpec?.installCommand,
      detectCommand: ctx.runtimeCommandSpec?.detectCommand,
      cwd,
      env,
      timeoutSec,
      graceSec,
      onLog,
    });
    if (targetIsRemote) {
      const prepared = await prepareAdapterExecutionTargetRuntime({
        runId,
        target,
        adapterKey: "codebuddy",
        workspaceLocalDir: cwd,
        timeoutSec,
        installCommand: ctx.runtimeCommandSpec?.installCommand ?? null,
        detectCommand: ctx.runtimeCommandSpec?.detectCommand ?? command,
        onProgress: (line) => onLog("stdout", line),
        onRuntimeProgress: ctx.onRuntimeProgress,
      });
      restoreRemoteWorkspace = () => prepared.restoreWorkspace((line) => onLog("stdout", line));
      executionCwd = prepared.workspaceRemoteDir ?? executionCwd;
      refreshEnv();
    }
    const runtimeTarget = overrideAdapterExecutionTargetRemoteCwd(target, executionCwd);
    const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
    await ensureAdapterExecutionTargetCommandResolvable(command, target, cwd, runtimeEnv);
    const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(
      command,
      target,
      cwd,
      runtimeEnv,
    );
    const loggedEnv = buildInvocationEnvForLogs(env, {
      runtimeEnv,
      includeRuntimeKeys: ["HOME"],
      resolvedCommand,
    });
    const sessionParams = parseObject(runtime.sessionParams);
    const savedSessionId = asString(sessionParams.sessionId, runtime.sessionId ?? "");
    const savedCwd = asString(sessionParams.cwd, "");
    const canResume = Boolean(savedSessionId) &&
      (!savedCwd || path.resolve(savedCwd) === path.resolve(executionCwd)) &&
      adapterExecutionTargetSessionMatches(parseObject(sessionParams.remoteExecution), runtimeTarget);
    const sessionId = canResume ? savedSessionId : null;
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
      resumedSession: Boolean(sessionId),
    });
    const renderedPrompt = (sessionId && wakePrompt) || isPaperclipRecoveryWakePayload(context.paperclipWake)
      ? ""
      : renderTemplate(
          asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE),
          templateData,
        );
    const prompt = joinPromptSections([
      wakePrompt,
      asString(context.paperclipSessionHandoffMarkdown, "").trim(),
      renderedPrompt,
    ]);
    const buildArgs = (resumeId: string | null) => {
      const args = ["--print", "-", "--output-format", "stream-json", "--verbose"];
      args.push("--permission-mode", "bypassPermissions");
      args.push("--disallowedTools", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode");
      if (resumeId) args.push("--resume", resumeId);
      if (model && model !== DEFAULT_CODEBUDDY_LOCAL_MODEL) args.push("--model", model);
      if (supportsEffort && effort && ["low", "medium", "high", "xhigh"].includes(effort)) {
        args.push("--effort", effort);
      }
      if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
      const mcpConfigPath = asString(config.mcpConfigPath, "").trim();
      if (appendSystemPrompt) args.push("--append-system-prompt", appendSystemPrompt);
      if (mcpConfigPath) args.push("--mcp-config", mcpConfigPath);
      args.push(...asStringArray(config.extraArgs));
      return args;
    };
    const run = async (resumeId: string | null) => {
      const args = buildArgs(resumeId);
      await onMeta?.({
        adapterType: "codebuddy_local",
        command: resolvedCommand,
        cwd: executionCwd,
        commandArgs: args,
        commandNotes: [
          "Prompt is passed on stdin using --print -.",
          "Permission prompts and interactive planning tools are disabled.",
          `Staged ${staged.stagedSkillsCount} project skill target(s).`,
        ],
        env: loggedEnv,
        prompt,
        context,
      });
      const proc = await runAdapterExecutionTargetProcess(runId, runtimeTarget, command, args, {
        cwd,
        env,
        stdin: prompt,
        timeoutSec,
        graceSec,
        onSpawn,
        onRuntimeProgress: ctx.onRuntimeProgress,
        onLog,
      });
      return { proc, parsed: parseCodeBuddyStreamJson(proc.stdout) };
    };
    const toResult = (attempt: Awaited<ReturnType<typeof run>>, clearSession = false): AdapterExecutionResult => {
      const loginMeta = detectCodeBuddyLoginRequired({
        stdout: attempt.proc.stdout,
        stderr: attempt.proc.stderr,
      });
      const resultFailed =
        Boolean(attempt.parsed.resultJson?.is_error) ||
        asString(attempt.parsed.resultJson?.subtype, "") === "error";
      const failed =
        attempt.proc.timedOut ||
        (attempt.proc.exitCode ?? 0) !== 0 ||
        loginMeta.requiresLogin ||
        resultFailed;
      const parsedSessionId = attempt.parsed.sessionId ?? (clearSession ? null : savedSessionId || null);
      // LOCAL-ONLY: opt-out via config.estimateCostFromTokens = false to
      // restore the original subscription_included ($0) behavior.
      const estimatedCostUsd = asBoolean(config.estimateCostFromTokens, true)
        ? estimateCodeBuddyCostUsd(attempt.parsed.model || model, attempt.parsed.usage)
        : null;
      return {
        exitCode: failed && (attempt.proc.exitCode ?? 0) === 0 ? 1 : attempt.proc.exitCode,
        signal: attempt.proc.signal,
        timedOut: attempt.proc.timedOut,
        errorMessage: attempt.proc.timedOut
          ? `Timed out after ${timeoutSec}s`
          : loginMeta.requiresLogin
            ? `${loginMeta.message} Run \`codebuddy login\` on the Paperclip host, then retry.`
            : failed
              ? describeCodeBuddyFailure(attempt.parsed.resultJson) ||
                firstLine(attempt.proc.stderr) ||
                `CodeBuddy exited with code ${attempt.proc.exitCode ?? -1}`
              : null,
        ...(loginMeta.requiresLogin ? { errorCode: "codebuddy_auth_required" } : {}),
        usage: attempt.parsed.usage ?? undefined,
        usageBasis: attempt.parsed.usageBasis,
        sessionId: parsedSessionId,
        sessionParams: parsedSessionId
          ? {
              sessionId: parsedSessionId,
              cwd: executionCwd,
              ...(workspaceId ? { workspaceId } : {}),
              ...(targetIsRemote
                ? { remoteExecution: adapterExecutionTargetSessionIdentity(runtimeTarget) }
                : {}),
            }
          : null,
        sessionDisplayId: parsedSessionId,
        provider: "tencent",
        biller: "codebuddy",
        model: attempt.parsed.model || model,
        // LOCAL-ONLY: estimate cost from token usage so the Budget/Spend
        // dashboards show non-zero numbers for CodeBuddy runs. See
        // ./pricing.ts for rationale and caveats. The CLI itself reports
        // total_cost_usd as a flat 0 (subscription plan), so prefer our
        // estimate whenever it's available rather than `?? `-falling back
        // (0 is a valid number and would otherwise win over the estimate).
        // Falls back to the original subscription_included ($0) behavior
        // when there's no usage to price from.
        billingType: estimatedCostUsd !== null ? "metered_api" : "subscription_included",
        costUsd: estimatedCostUsd !== null ? estimatedCostUsd : attempt.parsed.costUsd,
        resultJson: attempt.parsed.resultJson,
        summary: attempt.parsed.summary,
        clearSession: clearSession && !parsedSessionId,
      };
    };
    const initial = await run(sessionId);
    if (sessionId && failedResume(initial)) {
      await onLog("stdout", `[paperclip] CodeBuddy session "${sessionId}" is unavailable; starting fresh.\n`);
      return toResult(await run(null), true);
    }
    return toResult(initial);
  } finally {
    await Promise.all([restoreRemoteWorkspace?.(), staged.cleanup()]);
  }
}

function failedResume(attempt: {
  proc: { exitCode: number | null; timedOut: boolean };
  parsed: ReturnType<typeof parseCodeBuddyStreamJson>;
}): boolean {
  return !attempt.proc.timedOut &&
    (attempt.proc.exitCode ?? 0) !== 0 &&
    isCodeBuddyUnknownSessionError(attempt.parsed.resultJson);
}
