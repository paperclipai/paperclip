import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  buildPaperclipEnv,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  joinPromptSections,
  ensurePathInEnv,
  listPaperclipSkillEntries,
  readPaperclipSkillMarkdown,
  removeMaintainerOnlySkillSymlinks,
  parseObject,
  redactEnvForLogs,
  renderTemplate,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_KIRO_LOCAL_MODEL } from "../index.js";
import { kiroSkillsHome } from "./paths.js";
import { parseKiroOutput, isKiroUnknownSessionError, stripAnsi } from "./parse.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** Options for Kiro skill injection and cleanup. */
export type KiroSkillsOptions = { skillsHome?: string; moduleDir?: string; companyPrefix?: string };

/** Marker file written to Paperclip-managed skill directories for safe cleanup. */
const PAPERCLIP_MANAGED_MARKER = ".paperclip-managed";

/** Log a warning when skills are using the unsafe global default. */
async function warnIfGlobalSkillsHome(
  onLog: AdapterExecutionContext["onLog"],
  companyPrefix: string,
  skillsHome: string | undefined,
): Promise<void> {
  if (!companyPrefix && !skillsHome) {
    await onLog(
      "stdout",
      `[paperclip] Warning: no companyPrefix configured for kiro-local adapter. ` +
        `Skills default to the global ~/.kiro/skills/ directory, which is shared state. ` +
        `Set companyPrefix in adapterConfig to isolate skills per company.\n`,
    );
  }
}

/**
 * Ensure Paperclip skills are injected into Kiro's skills directory.
 *
 * Skills persist between runs. On each heartbeat this function:
 * 1. Lists available Paperclip skills
 * 2. Removes stale maintainer-only symlinks
 * 3. Prunes managed skill directories no longer in the current skill set
 * 4. Skips user-owned skills (no `.paperclip-managed` marker)
 * 5. Content-diffs managed skills and skips unchanged ones
 * 6. Writes new/updated skills as SKILL.md files with YAML frontmatter
 *
 * @param onLog - Logging callback for status messages
 */
export async function ensureKiroSkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
  options?: KiroSkillsOptions,
): Promise<void> {
  const moduleDir = options?.moduleDir ?? __moduleDir;
  const skillsEntries = await listPaperclipSkillEntries(moduleDir);
  const companyPrefix = options?.companyPrefix ?? "";
  const skillsHome = options?.skillsHome ?? kiroSkillsHome();
  const skillDirName = (runtimeName: string): string =>
    companyPrefix ? `${companyPrefix}--${runtimeName}` : runtimeName;
  try {
    await fs.mkdir(skillsHome, { recursive: true });
  } catch (err) {
    await onLog(
      "stderr",
      `[paperclip] Failed to prepare Kiro skills directory ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return;
  }

  // Clean up maintainer-only skills (symlinks pointing to .agents/skills)
  const currentSkillDirNames = new Set(skillsEntries.map((entry) => skillDirName(entry.runtimeName)));
  const removedSkills = await removeMaintainerOnlySkillSymlinks(
    skillsHome,
    [...currentSkillDirNames],
  );
  for (const skillName of removedSkills) {
    await onLog(
      "stdout",
      `[paperclip] Removed maintainer-only Kiro skill "${skillName}" from ${skillsHome}\n`,
    );
  }

  // Prune stale managed skill directories no longer in the current skill set.
  // Only prune directories matching the current company prefix to avoid
  // deleting another company's managed skills from the same skillsHome.
  try {
    const entries = await fs.readdir(skillsHome, { withFileTypes: true });
    for (const dirEntry of entries) {
      if (!dirEntry.isDirectory()) continue;
      if (currentSkillDirNames.has(dirEntry.name)) continue;
      // Skip directories that don't match the current company prefix
      if (companyPrefix && !dirEntry.name.startsWith(`${companyPrefix}--`)) continue;
      if (!companyPrefix && dirEntry.name.includes("--")) continue;
      const markerPath = path.join(skillsHome, dirEntry.name, PAPERCLIP_MANAGED_MARKER);
      const isManaged = await fs.stat(markerPath).then(() => true).catch(() => false);
      if (isManaged) {
        await fs.rm(path.join(skillsHome, dirEntry.name), { recursive: true, force: true });
        await onLog(
          "stdout",
          `[paperclip] Pruned stale Kiro skill "${dirEntry.name}" from ${skillsHome}\n`,
        );
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      await onLog(
        "stderr",
        `[paperclip] Failed to prune stale Kiro skills in ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  if (skillsEntries.length === 0) return;

  // Inject each Paperclip skill as a SKILL.md file with YAML frontmatter
  for (const entry of skillsEntries) {
    const skillDir = path.join(skillsHome, skillDirName(entry.runtimeName));
    const skillFile = path.join(skillDir, "SKILL.md");
    const managedMarker = path.join(skillDir, PAPERCLIP_MANAGED_MARKER);

    try {
      // Skip if a user-owned skill already exists at this path
      const skillExists = await fs.stat(skillFile).then(() => true).catch(() => false);
      const isManaged = await fs.stat(managedMarker).then(() => true).catch(() => false);
      if (skillExists && !isManaged) {
        await onLog(
          "stdout",
          `[paperclip] Skipping Kiro skill "${entry.runtimeName}" — ${skillDir} already exists and is not Paperclip-managed\n`,
        );
        continue;
      }

      // Read the skill's markdown content
      const skillContent = await readPaperclipSkillMarkdown(moduleDir, entry.key);
      if (!skillContent) {
        await onLog(
          "stderr",
          `[paperclip] Failed to read Kiro skill "${entry.runtimeName}": SKILL.md not found\n`,
        );
        continue;
      }

      // Check if we need to update the file
      if (isManaged) {
        try {
          const existing = await fs.readFile(skillFile, "utf8");
          const bodyMatch = existing.match(/^---\s*\n[\s\S]*?\n---\s*\n([\s\S]*)$/);
          const existingBody = bodyMatch ? bodyMatch[1].trim() : "";
          if (existingBody === skillContent.trim()) continue;
        } catch {
          // Can't read — rewrite
        }
      }

      // Create the skill directory
      await fs.mkdir(skillDir, { recursive: true });

      // Extract a description from the skill content for YAML frontmatter
      const lines = skillContent.split("\n").filter((line) => line.trim());
      let description = entry.runtimeName;
      for (const line of lines) {
        if (line.startsWith("# ")) {
          description = line.slice(2).trim();
          break;
        }
      }
      if (description === entry.runtimeName && lines.length > 0) {
        const firstLine = lines[0].trim();
        if (firstLine.length > 0 && firstLine.length < 100) {
          description = firstLine;
        }
      }

      // Escape YAML values to handle colons, quotes, newlines
      const escapeYaml = (val: string): string => {
        if (/[:\n"'#|>\[{&*!?%@`]/.test(val) || val.startsWith(" ") || val.endsWith(" ")) {
          return `"${val.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
        }
        return val;
      };

      // Build SKILL.md with YAML frontmatter
      const kiroSkillMd = `---
name: ${escapeYaml(entry.runtimeName)}
description: ${escapeYaml(description)}
---

${skillContent}
`;

      await fs.writeFile(skillFile, kiroSkillMd, "utf8");
      await fs.writeFile(managedMarker, `${entry.runtimeName}\n`, "utf8");
      await onLog(
        "stdout",
        `[paperclip] Injected Kiro skill: ${entry.runtimeName}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to inject Kiro skill "${entry.runtimeName}": ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const command = asString(config.command, "kiro-cli");
  const model = asString(config.model, DEFAULT_KIRO_LOCAL_MODEL).trim();

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
  const configuredCwd = asString(config.cwd, "");
  const cwd = workspaceCwd || configuredCwd || process.cwd();

  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  // Warn about session bleed risk when no workspace strategy is configured.
  // Kiro resumes sessions by CWD, so concurrent tasks targeting the same agent+CWD
  // will share a Kiro session unless each task gets its own worktree.
  if (!workspaceStrategy) {
    await onLog(
      "stdout",
      `[paperclip] Warning: no workspaceStrategy configured for kiro-local adapter. ` +
        `Concurrent tasks targeting the same CWD will share a Kiro session, ` +
        `risking data leaks between tasks. Configure workspaceStrategy: { type: "git_worktree" } ` +
        `in the agent's adapterConfig to enable per-task isolation.\n`,
    );
  }

  // Inject Kiro skills before execution
  const configCompanyPrefix = asString(config.companyPrefix, "").trim().toLowerCase();
  const configSkillsHome = asString(config.skillsHome, "").trim();
  await warnIfGlobalSkillsHome(onLog, configCompanyPrefix, configSkillsHome || undefined);
  await ensureKiroSkillsInjected(onLog, {
    ...(configCompanyPrefix ? { companyPrefix: configCompanyPrefix } : {}),
    ...(configSkillsHome ? { skillsHome: configSkillsHome } : {}),
  });

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
  if (workspaceSource) env.PAPERCLIP_WORKSPACE_SOURCE = workspaceSource;
  if (workspaceStrategy) env.PAPERCLIP_WORKSPACE_STRATEGY = workspaceStrategy;
  if (workspaceId) env.PAPERCLIP_WORKSPACE_ID = workspaceId;
  if (workspaceRepoUrl) env.PAPERCLIP_WORKSPACE_REPO_URL = workspaceRepoUrl;
  if (workspaceRepoRef) env.PAPERCLIP_WORKSPACE_REPO_REF = workspaceRepoRef;
  if (workspaceBranch) env.PAPERCLIP_WORKSPACE_BRANCH = workspaceBranch;
  if (workspaceWorktreePath) env.PAPERCLIP_WORKSPACE_WORKTREE_PATH = workspaceWorktreePath;
  if (agentHome) env.AGENT_HOME = agentHome;

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }
  const effectiveEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const runtimeEnv = ensurePathInEnv(effectiveEnv) as Record<string, string>;
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 15);
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
  const sessionId = canResumeSession ? runtimeSessionId : null;
  if (runtimeSessionId && !canResumeSession) {
    await onLog(
      "stdout",
      `[paperclip] Kiro session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }

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
      await onLog(
        "stdout",
        `[paperclip] Loaded agent instructions file: ${instructionsFilePath}\n`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stdout",
        `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }

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
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const renderedBootstrapPrompt =
    !sessionId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const prompt = joinPromptSections([
    instructionsPrefix,
    renderedBootstrapPrompt,
    sessionHandoffNote,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    instructionsChars: instructionsPrefix.length,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  const buildArgs = (resumeSessionId: string | null) => {
    const args = ["chat", "--no-interactive", "--trust-all-tools", "--wrap", "never"];
    if (model && model !== DEFAULT_KIRO_LOCAL_MODEL) args.push("--model", model);
    // kiro-cli matches the session by cwd; no explicit session ID argument is needed
    if (resumeSessionId) args.push("--resume");
    if (extraArgs.length > 0) args.push(...extraArgs);
    return args;
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildArgs(resumeSessionId);
    if (onMeta) {
      await onMeta({
        adapterType: "kiro_local",
        command,
        cwd,
        commandNotes: [
          "Prompt is passed to kiro-cli via stdin.",
          "Added --no-interactive --trust-all-tools --wrap never for headless execution.",
        ],
        commandArgs: args,
        env: redactEnvForLogs(env),
        prompt,
        promptMetrics,
        context,
      });
    }

    const strippedOnLog: typeof onLog = async (stream, data) =>
      onLog(stream, stream === "stderr" ? stripAnsi(data) : data);

    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env: runtimeEnv,
      stdin: prompt,
      timeoutSec,
      graceSec,
      onSpawn,
      onLog: strippedOnLog,
    });
    return { proc };
  };

  const toResult = (
    attempt: { proc: { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string } },
    activeSessionId: string | null,
  ): AdapterExecutionResult => {
    if (attempt.proc.timedOut) {
      return {
        exitCode: attempt.proc.exitCode,
        signal: attempt.proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
      };
    }

    // For fresh runs that succeed, generate a session ID so subsequent runs can resume.
    // Kiro resumes by cwd match, so the ID is just a handle for Paperclip's session tracking.
    const resolvedSessionId =
      activeSessionId ?? ((attempt.proc.exitCode ?? 0) === 0 ? runId : null);
    const resolvedSessionParams = resolvedSessionId
      ? ({
          sessionId: resolvedSessionId,
          cwd,
          ...(workspaceId ? { workspaceId } : {}),
          ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
          ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
          ...(workspaceWorktreePath ? { worktreePath: workspaceWorktreePath } : {}),
          ...(workspaceBranch ? { branchName: workspaceBranch } : {}),
        } as Record<string, unknown>)
      : null;

    const parsed = parseKiroOutput(attempt.proc.stdout, attempt.proc.stderr);

    return {
      exitCode: attempt.proc.exitCode,
      signal: attempt.proc.signal,
      timedOut: false,
      errorMessage: (attempt.proc.exitCode ?? 0) === 0 ? null : attempt.proc.stderr || `Kiro exited with code ${attempt.proc.exitCode ?? -1}`,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: "kiro",
      biller: "kiro",
      billingType: "credits",
      model,
      costUsd: parsed.costUsd,
      resultJson: {
        stdout: attempt.proc.stdout,
        stderr: attempt.proc.stderr,
      },
      summary: parsed.summary,
    };
  };

  const initial = await runAttempt(sessionId);

  // If session resume failed with unknown session error, retry without --resume
  if (
    sessionId &&
    (initial.proc.exitCode ?? 0) !== 0 &&
    isKiroUnknownSessionError(initial.proc.stdout, initial.proc.stderr)
  ) {
    await onLog(
      "stdout",
      `[paperclip] Kiro session "${sessionId}" is stale or unknown, retrying with a fresh session.\n`,
    );
    const retry = await runAttempt(null);
    const result = toResult(retry, null);
    // Set clearSession to true so the broken session is cleared
    result.clearSession = true;
    return result;
  }

  return toResult(initial, sessionId);
}
