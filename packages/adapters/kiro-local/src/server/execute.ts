import fs from "node:fs/promises";
import os from "node:os";
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
import { parseKiroOutput, isKiroUnknownSessionError } from "./parse.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** Marker file written to Paperclip-managed skill directories for safe cleanup. */
const PAPERCLIP_MANAGED_MARKER = ".paperclip-managed";

/**
 * Kiro skills home directory.
 * Kiro expects skills at ~/.kiro/skills/<skill-name>/SKILL.md
 */
function kiroSkillsHome(): string {
  return path.join(os.homedir(), ".kiro", "skills");
}

/**
 * Inject Paperclip skills into Kiro's skills directory.
 *
 * Unlike other adapters (gemini-local, cursor-local) which use symlinks,
 * Kiro requires actual SKILL.md files with YAML frontmatter:
 *
 * ```markdown
 * ---
 * name: skill-name
 * description: Skill description
 * ---
 *
 * <skill body content>
 * ```
 *
 * This function:
 * 1. Lists available Paperclip skills
 * 2. Reads each skill's markdown content
 * 3. Creates ~/.kiro/skills/<skill-name>/SKILL.md with YAML frontmatter
 * 4. Removes maintainer-only skills that are no longer available
 *
 * @param onLog - Logging callback for status messages
 */
async function ensureKiroSkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
): Promise<void> {
  const skillsEntries = await listPaperclipSkillEntries(__moduleDir);
  if (skillsEntries.length === 0) return;

  const skillsHome = kiroSkillsHome();
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
  const removedSkills = await removeMaintainerOnlySkillSymlinks(
    skillsHome,
    skillsEntries.map((entry) => entry.name),
  );
  for (const skillName of removedSkills) {
    await onLog(
      "stderr",
      `[paperclip] Removed maintainer-only Kiro skill "${skillName}" from ${skillsHome}\n`,
    );
  }

  // Inject each Paperclip skill as a SKILL.md file with YAML frontmatter
  for (const entry of skillsEntries) {
    const skillDir = path.join(skillsHome, entry.name);
    const skillFile = path.join(skillDir, "SKILL.md");
    const managedMarker = path.join(skillDir, PAPERCLIP_MANAGED_MARKER);

    try {
      // Skip if a user-owned skill already exists at this path
      const skillExists = await fs.stat(skillFile).then(() => true).catch(() => false);
      const isManaged = await fs.stat(managedMarker).then(() => true).catch(() => false);
      if (skillExists && !isManaged) {
        await onLog(
          "stderr",
          `[paperclip] Skipping Kiro skill "${entry.name}" — ${skillDir} already exists and is not Paperclip-managed\n`,
        );
        continue;
      }

      // Read the skill's markdown content
      const skillContent = await readPaperclipSkillMarkdown(__moduleDir, entry.name);
      if (!skillContent) {
        await onLog(
          "stderr",
          `[paperclip] Failed to read Kiro skill "${entry.name}": SKILL.md not found\n`,
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
      let description = entry.name;
      for (const line of lines) {
        if (line.startsWith("# ")) {
          description = line.slice(2).trim();
          break;
        }
      }
      if (description === entry.name && lines.length > 0) {
        const firstLine = lines[0].trim();
        if (firstLine.length > 0 && firstLine.length < 100) {
          description = firstLine;
        }
      }

      // Escape YAML values to handle colons, quotes, newlines
      const escapeYaml = (val: string): string => {
        if (/[:\n"'#]/.test(val) || val.startsWith(" ") || val.endsWith(" ")) {
          return `"${val.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
        }
        return val;
      };

      // Build SKILL.md with YAML frontmatter
      const kiroSkillMd = `---
name: ${escapeYaml(entry.name)}
description: ${escapeYaml(description)}
---

${skillContent}
`;

      await fs.writeFile(skillFile, kiroSkillMd, "utf8");
      await fs.writeFile(managedMarker, `${entry.name}\n`, "utf8");
      await onLog(
        "stderr",
        `[paperclip] Injected Kiro skill: ${entry.name}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to inject Kiro skill "${entry.name}": ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

/**
 * Clean up injected Kiro skills after execution.
 *
 * Removes the skill directories created by ensureKiroSkillsInjected().
 * This is called in a finally block to ensure cleanup happens even on error.
 *
 * @param onLog - Logging callback for status messages
 */
async function cleanupKiroSkills(
  onLog: AdapterExecutionContext["onLog"],
): Promise<void> {
  const skillsEntries = await listPaperclipSkillEntries(__moduleDir);
  if (skillsEntries.length === 0) return;

  const skillsHome = kiroSkillsHome();
  for (const entry of skillsEntries) {
    const skillDir = path.join(skillsHome, entry.name);
    try {
      // Only delete skills we own (have a managed marker)
      const managedMarker = path.join(skillDir, PAPERCLIP_MANAGED_MARKER);
      const isManaged = await fs.stat(managedMarker).then(() => true).catch(() => false);
      if (isManaged) {
        await fs.rm(skillDir, { recursive: true, force: true });
        await onLog(
          "stderr",
          `[paperclip] Cleaned up Kiro skill: ${entry.name}\n`,
        );
      }
    } catch {
      // Skip if we can't read/delete - not our skill or doesn't exist
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
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const configuredCwd = asString(config.cwd, "");
  const cwd = workspaceCwd || configuredCwd || process.cwd();

  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  // Inject Kiro skills before execution
  await ensureKiroSkillsInjected(onLog);

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
  if (workspaceId) env.PAPERCLIP_WORKSPACE_ID = workspaceId;
  if (workspaceRepoUrl) env.PAPERCLIP_WORKSPACE_REPO_URL = workspaceRepoUrl;
  if (workspaceRepoRef) env.PAPERCLIP_WORKSPACE_REPO_REF = workspaceRepoRef;
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
  const runtimeEnv = ensurePathInEnv(effectiveEnv);
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

    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env: runtimeEnv,
      stdin: prompt,
      timeoutSec,
      graceSec,
      onSpawn,
      onLog,
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

  try {
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
      return toResult(retry, null);
    }

    return toResult(initial, sessionId);
  } finally {
    // Clean up injected skills after execution
    await cleanupKiroSkills(onLog);
  }
}
