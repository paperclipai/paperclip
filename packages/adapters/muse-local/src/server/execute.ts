import { withWorkspaceRestore } from "@paperclipai/adapter-utils/workspace-restore-result";
import {
  runAdapterExecutionTargetProcess,
  readAdapterExecutionTarget,
  prepareAdapterExecutionTargetRuntime,
  resolveAdapterExecutionTargetCommandForLogs,
} from "@paperclipai/adapter-utils/execution-target";
import { fileURLToPath } from "node:url";
import {
  asString,
  asNumber,
  asStringArray,
  materializePaperclipSkillCopy,
  isPaperclipSkillSourceMissing,
  readPaperclipRuntimeSkillEntries,
  resolveLegacyPaperclipDesiredSkillNames as resolveMuseDesiredSkillNames,
  parseObject,
  renderTemplate,
  hydrateFreshSessionHandoff,
  selectInitialCommunicationGuidance,
  selectPaperclipPromptSections,
  isPaperclipRecoveryWakePayload,
  joinPromptSections,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE,
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
  buildInvocationEnvForLogs,
  ensurePathInEnv,
  readPaperclipIssueWorkModeFromContext,
} from "@paperclipai/adapter-utils/server-utils";
import { buildSkillLibraryManifestMarkdown } from "@paperclipai/adapter-utils/skill-library-manifest";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const {
    runId,
    agent,
    runtime,
    config = {},
    context = {},
    executionTarget: rawExecutionTarget,
    onLog,
    onMeta,
    onSpawn,
    authToken,
  } = ctx;

  const executionTarget = readAdapterExecutionTarget({
    executionTarget: rawExecutionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = executionTarget?.kind === "remote";

  const configuredCommand = asString(config.command, "muse");
  const fallbackPath = path.join(os.homedir(), ".local/bin/muse");
  const command =
    !executionTargetIsRemote &&
    configuredCommand === "muse" &&
    (await fs.access(fallbackPath).then(() => true).catch(() => false))
      ? fallbackPath
      : configuredCommand;

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const configuredCwd = asString(config.cwd, "");
  const cwd = workspaceCwd || configuredCwd || process.cwd();

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {
    ...buildPaperclipEnv(agent, ctx.agentIdentity),
    ...buildRuntimeToolsEnv(ctx.runtimeTools),
    ...(envConfig as Record<string, string>),
    MUSE_NO_AUTO_UPDATE: "1",
    PAPERCLIP_RUN_ID: runId,
  };
  if (authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

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
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");

  // Dedicated per-run directory to isolate credentials and runtime files
  const originalXdgConfig = env.XDG_CONFIG_HOME || process.env.XDG_CONFIG_HOME;
  const runTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `paperclip-muse-${runId}-`));
  env.XDG_CONFIG_HOME = runTmpDir;

  const stagedSkillDirs: string[] = [];
  const createdParentDirs: string[] = [];

  try {
    const targetAuth = path.join(runTmpDir, "muse", "auth.json");
  const sourceCandidates = [
    env.MUSE_AUTH_PATH,
    originalXdgConfig ? path.join(originalXdgConfig, "muse", "auth.json") : null,
    path.join(process.env.HOME || os.homedir(), ".config/muse/auth.json"),
  ].filter(Boolean) as string[];

  for (const src of sourceCandidates) {
    if (src && src !== targetAuth && (await fs.access(src).then(() => true).catch(() => false))) {
      try {
        const data = await fs.readFile(src, "utf8");
        await fs.mkdir(path.join(runTmpDir, "muse"), { recursive: true, mode: 0o700 });
        await fs.writeFile(targetAuth, data, { mode: 0o600 });
        break;
      } catch {}
    }
  }

  // Session resolution
  const runtimeSessionParams = parseObject(runtime?.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime?.sessionId ?? "");
  const canResumeSession = runtimeSessionId.length > 0;
  const resumeSessionId = canResumeSession ? runtimeSessionId : null;

  // Skills resolution and staging
  const museSkillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkillNames = new Set(resolveMuseDesiredSkillNames(config, museSkillEntries));
  const selectedSkills = museSkillEntries.filter(
    (entry) => desiredSkillNames.has(entry.key) && !isPaperclipSkillSourceMissing(entry),
  );

  for (const entry of museSkillEntries.filter((e) => desiredSkillNames.has(e.key))) {
    if (isPaperclipSkillSourceMissing(entry) && onLog) {
      await onLog(
        "stderr",
        `[paperclip] Warning: skill "${entry.key}" is enabled for this agent but its files are unavailable and it was not mounted${
          entry.missingDetail ? `: ${entry.missingDetail}` : "."
        }\n`,
      );
    }
  }

  const skillManifest = buildSkillLibraryManifestMarkdown({
    entries: museSkillEntries,
    desiredSkillKeys: desiredSkillNames,
  });

  if (selectedSkills.length > 0) {
    const stagingRoots = [
      { dir: path.join(cwd, ".agents"), skillsDir: path.join(cwd, ".agents", "skills") },
      { dir: path.join(cwd, ".muse"), skillsDir: path.join(cwd, ".muse", "skills") },
    ];

    for (const { dir, skillsDir } of stagingRoots) {
      const dirExisted = await fs.access(dir).then(() => true).catch(() => false);
      if (!dirExisted) {
        await fs.mkdir(dir, { recursive: true });
        createdParentDirs.push(dir);
      }
      const skillsDirExisted = await fs.access(skillsDir).then(() => true).catch(() => false);
      if (!skillsDirExisted) {
        await fs.mkdir(skillsDir, { recursive: true });
        createdParentDirs.push(skillsDir);
      }
      for (const skill of selectedSkills) {
        const target = path.join(skillsDir, skill.runtimeName);
        const targetExists = await fs.access(target).then(() => true).catch(() => false);
        if (targetExists) {
          if (onLog) {
            await onLog("stdout", `[paperclip] Muse skill target already exists at ${target}; leaving it unchanged.\n`);
          }
          continue;
        }
        try {
          await materializePaperclipSkillCopy(skill.source, target);
          stagedSkillDirs.push(target);
        } catch (err: unknown) {
          if (onLog) {
            await onLog(
              "stderr",
              `[paperclip] Failed to stage skill "${skill.key}" to ${target}: ${
                err instanceof Error ? err.message : String(err)
              }\n`,
            );
          }
        }
      }
    }
  }

  // Instructions
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  let instructionsPrefix = "";
  if (instructionsFilePath) {
    try {
      const instructionsContents = await fs.readFile(instructionsFilePath, "utf8");
      instructionsPrefix =
        `${instructionsContents}\n\n` +
        `The above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsDir}.\n\n`;
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      if (onLog) {
        await onLog("stdout", `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`);
      }
    }
  }

  const promptTemplate = asString(
    config.promptTemplate,
    context.conversationMode === true
      ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE
      : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };

  await hydrateFreshSessionHandoff(ctx, { resumedSession: Boolean(resumeSessionId) });
  const renderedBootstrapPrompt =
    !resumeSessionId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const { taskContextNote, wakePrompt } = selectPaperclipPromptSections(context, {
    resumedSession: Boolean(resumeSessionId),
    includeCommunicationGuidance: false,
  });
  const shouldUseResumeDeltaPrompt = Boolean(resumeSessionId) && wakePrompt.length > 0;
  const promptInstructionsPrefix = shouldUseResumeDeltaPrompt ? "" : instructionsPrefix;
  const renderedPrompt =
    shouldUseResumeDeltaPrompt || isPaperclipRecoveryWakePayload(context.paperclipWake)
      ? ""
      : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();

  let prompt = joinPromptSections([
    promptInstructionsPrefix,
    skillManifest ? `${skillManifest}\n\n` : "",
    renderedBootstrapPrompt,
    selectInitialCommunicationGuidance(context, { resumedSession: Boolean(resumeSessionId) }),
    wakePrompt,
    sessionHandoffNote,
    taskContextNote,
    renderedPrompt,
  ]);

  if (!prompt || !prompt.trim()) {
    prompt = "Please proceed with your assigned tasks.";
  }

  const localPromptPath = path.join(runTmpDir, "prompt.txt");
  await fs.writeFile(localPromptPath, prompt, { encoding: "utf8", mode: 0o600 });

  let restoreRemoteWorkspace: (() => Promise<void>) | null = null;
  let effectiveExecutionCwd = cwd;
  let effectivePromptPath = localPromptPath;

  if (executionTarget?.kind === "remote") {
    const preparedExecutionTargetRuntime = await prepareAdapterExecutionTargetRuntime({
      runId,
      target: executionTarget,
      adapterKey: "muse",
      timeoutSec: asNumber(config.timeoutSec, 600),
      workspaceLocalDir: cwd,
      installCommand: null,
      detectCommand: command,
      onProgress: (line) => onLog?.("stdout", line),
      onRuntimeProgress: ctx.onRuntimeProgress,
      assets: [
        {
          key: "runConfig",
          localDir: runTmpDir,
          restore: async () => {},
        },
      ],
    });
    restoreRemoteWorkspace = () =>
      preparedExecutionTargetRuntime.restoreWorkspace((line) => onLog?.("stdout", line));
    effectiveExecutionCwd = preparedExecutionTargetRuntime.workspaceRemoteDir ?? effectiveExecutionCwd;
    const remoteConfigDir = preparedExecutionTargetRuntime.assetDirs.runConfig;
    if (remoteConfigDir) {
      env.XDG_CONFIG_HOME = remoteConfigDir;
      effectivePromptPath = path.posix.join(remoteConfigDir, "prompt.txt");
    }
  }

  const args = [
    "exec",
    "--json",
    "--yolo",
    "--workspace",
    effectiveExecutionCwd,
    "--prompt-file",
    effectivePromptPath,
  ];

  if (resumeSessionId) {
    args.push("--session-id", resumeSessionId);
  }

  const model = asString(config.model, "muse-wonder-1.0");
  args.push("--model", model);

  const effort = config.reasoningEffort || config.effort || config.modelReasoningEffort;
  if (effort && effort !== "auto") {
    args.push("--reasoning-effort", String(effort));
  }
  const extraArgs = (() => {
    const fromExtra = asStringArray(config.extraArgs);
    if (fromExtra.length > 0) return fromExtra;
    return asStringArray(config.args);
  })();
  if (extraArgs.length > 0) {
    args.push(...extraArgs);
  }

  const effectiveEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const runtimeEnv = ensurePathInEnv(effectiveEnv);
  const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(
    command,
    executionTarget,
    effectiveExecutionCwd,
    runtimeEnv,
  );
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME", "XDG_CONFIG_HOME"],
    resolvedCommand,
  });

  if (onMeta) {
    await onMeta({
      adapterType: "muse_local",
      command,
      cwd: effectiveExecutionCwd,
      commandArgs: args,
      env: loggedEnv,
      prompt,
      context,
    });
  }

  let stdout = "";
  let stderr = "";
  let resolvedSessionId = resumeSessionId;
  let summary = "";
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
  };

  return await withWorkspaceRestore(
      async () => {
        const proc = await runAdapterExecutionTargetProcess(runId, executionTarget, command, args, {
          cwd: effectiveExecutionCwd,
          env: !executionTargetIsRemote ? effectiveEnv : env,
          timeoutSec: asNumber(config.timeoutSec, 600),
          graceSec: asNumber(config.graceSec, 15),
          onSpawn,
          onRuntimeProgress: ctx.onRuntimeProgress,
          onLog: async (stream, chunk) => {
            if (onLog) {
              await onLog(stream, chunk);
            }
            if (stream === "stdout") {
              stdout += chunk;
            } else {
              stderr += chunk;
            }
          },
        });

        // Parse events from stdout
        const lines = stdout.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obj = JSON.parse(trimmed) as {
              stream?: { kind?: string; id?: string };
              payload_type?: string;
              payload?: { text?: string; models?: Array<{ input_tokens?: number; output_tokens?: number; cached_tokens?: number }> };
            };
            if (obj.stream?.kind === "session" && obj.stream?.id) {
              resolvedSessionId = obj.stream.id;
            }
            if (obj.payload_type === "run.terminal.completed" && obj.payload?.text) {
              summary = obj.payload.text;
            }
            if (obj.payload_type === "run.usage" && Array.isArray(obj.payload?.models)) {
              for (const m of obj.payload.models) {
                usage.inputTokens += asNumber(m.input_tokens, 0);
                usage.outputTokens += asNumber(m.output_tokens, 0);
                usage.cachedInputTokens += asNumber(m.cached_tokens, 0);
              }
            }
          } catch {}
        }

        const failed = (proc.exitCode ?? 0) !== 0;
        const errorMessage = failed
          ? (proc.stderr?.trim() || `Muse exited with code ${proc.exitCode ?? -1}`)
          : null;

        return {
          exitCode: proc.exitCode,
          signal: proc.signal,
          timedOut: proc.timedOut,
          errorMessage,
          errorCode: failed ? "muse_failed" : null,
          errorFamily: null,
          retryNotBefore: null,
          usage,
          usageBasis: "per_run",
          sessionId: resolvedSessionId,
          sessionParams: resolvedSessionId ? { sessionId: resolvedSessionId, cwd: effectiveExecutionCwd } : null,
          sessionDisplayId: resolvedSessionId,
          provider: "muse",
          biller: "meta",
          model,
          billingType: "subscription",
          costUsd: null,
          resultJson: {
            stdout: proc.stdout,
            stderr: proc.stderr,
          },
          summary: summary || (failed ? "" : "Task completed."),
          clearSession: false,
        };
      },
      async () => {
        await restoreRemoteWorkspace?.();
      },
    );
  } finally {
    for (const target of stagedSkillDirs) {
      await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
    }
    for (const dir of [...createdParentDirs].reverse()) {
      try {
        const entries = await fs.readdir(dir);
        if (entries.length === 0) {
          await fs.rmdir(dir);
        }
      } catch {}
    }
    await fs.rm(runTmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
