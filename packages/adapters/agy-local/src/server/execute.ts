import fs from "node:fs/promises";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  joinPromptSections,
  hydrateFreshSessionHandoff,
  isPaperclipRecoveryWakePayload,
  selectInitialCommunicationGuidance,
  selectPaperclipPromptSections,
  parseObject,
  redactEnvForLogs,
  renderTemplate,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_AGY_LOCAL_MODEL } from "../index.js";
import { detectAgyAuthRequired, parseAgyStreamJson, shouldRetryFreshConversation } from "./parse.js";

function renderEnvNote(env: Record<string, string>): string {
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

function renderApiNote(env: Record<string, string>): string {
  if (!env.PAPERCLIP_API_URL?.trim() || !env.PAPERCLIP_API_KEY?.trim()) return "";
  return [
    "Paperclip API access note:",
    "Use shell commands with curl to make Paperclip API requests when needed.",
    "Include X-Paperclip-Run-Id on mutating requests.",
    "",
    "",
  ].join("\n");
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const promptTemplate = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const command = asString(config.command, "agy");
  const model = asString(config.model, DEFAULT_AGY_LOCAL_MODEL).trim();
  const effort = asString(config.effort, "").trim();
  const mode = asString(config.mode, "").trim();
  const sandbox = asBoolean(config.sandbox, false);
  const skipPermissions = asBoolean(config.dangerouslySkipPermissions, false);
  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const extraArgs = asStringArray(config.extraArgs);

  const workspace = parseObject(context.paperclipWorkspace);
  const workspaceCwd = nonEmpty(workspace.cwd);
  const configuredCwd = nonEmpty(config.cwd);
  const useConfigured = workspace.source === "agent_home" && configuredCwd !== null;
  const cwd = (useConfigured ? null : workspaceCwd) ?? configuredCwd ?? process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {
    ...buildPaperclipEnv(agent, ctx.agentIdentity),
    ...buildRuntimeToolsEnv(ctx.runtimeTools),
  };
  env.PAPERCLIP_RUN_ID = runId;
  const taskId = nonEmpty(context.taskId) ?? nonEmpty(context.issueId);
  if (taskId) env.PAPERCLIP_TASK_ID = taskId;
  const wakeReason = nonEmpty(context.wakeReason);
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  if (authToken && !env.PAPERCLIP_API_KEY) env.PAPERCLIP_API_KEY = authToken;
  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  let instructions = "";
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  if (instructionsFilePath) {
    instructions = await fs.readFile(instructionsFilePath, "utf8").catch(async (error) => {
      await onLog("stderr", `[paperclip] Could not read instructions file ${instructionsFilePath}: ${error instanceof Error ? error.message : String(error)}\n`);
      return "";
    });
  }

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const savedSessionId = nonEmpty(runtimeSessionParams.sessionId) ?? nonEmpty(runtime.sessionId);
  const savedCwd = nonEmpty(runtimeSessionParams.cwd);
  const canResume = savedSessionId !== null && (savedCwd === null || savedCwd === cwd);
  if (savedSessionId && !canResume) {
    await onLog("stdout", `[paperclip] agy conversation ${savedSessionId} was saved for ${savedCwd}, not ${cwd}; starting fresh.\n`);
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
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const envNote = renderEnvNote(env);
  const apiNote = renderApiNote(env);

  const buildArgs = (resumeId: string | null, withInstructions: boolean, sections: ReturnType<typeof selectPaperclipPromptSections>) => {
    const bootstrap = !resumeId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
    const rendered = (Boolean(resumeId) && sections.wakePrompt.length > 0) || isPaperclipRecoveryWakePayload(context.paperclipWake)
      ? ""
      : renderTemplate(promptTemplate, templateData);
    const prompt = joinPromptSections([
      selectInitialCommunicationGuidance(context, { resumedSession: Boolean(resumeId) }),
      withInstructions ? instructions : "",
      bootstrap,
      sections.wakePrompt,
      sections.taskContextNote,
      sessionHandoffNote,
      envNote,
      apiNote,
      rendered,
    ]);
    const args = ["-p", prompt, "--output-format", "stream-json"];
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    if (mode) args.push("--mode", mode);
    if (skipPermissions) args.push("--dangerously-skip-permissions");
    if (sandbox) args.push("--sandbox");
    if (resumeId) args.push("--conversation", resumeId);
    if (extraArgs.length > 0) args.push(...extraArgs);
    return { args, prompt };
  };

  const runOnce = async (resumeId: string | null) => {
    await hydrateFreshSessionHandoff(ctx, { resumedSession: Boolean(resumeId) });
    const sections = selectPaperclipPromptSections(context, {
      resumedSession: Boolean(resumeId),
      includeCommunicationGuidance: false,
    });
    const { args, prompt } = buildArgs(resumeId, resumeId === null, sections);
    if (onMeta) {
      await onMeta({
        adapterType: "agy_local",
        command,
        cwd,
        commandArgs: args.map((arg) => (arg === prompt ? `<prompt ${prompt.length} chars>` : arg)),
        env: redactEnvForLogs(env),
        prompt,
        promptMetrics: { promptChars: prompt.length },
        context,
      });
    }
    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env: runtimeEnv,
      timeoutSec,
      graceSec,
      onLog,
      onSpawn,
    });
    return { proc, parsed: parseAgyStreamJson(proc.stdout) };
  };

  let attempt = await runOnce(canResume ? savedSessionId : null);
  let retriedFresh = false;
  if (
    canResume &&
    shouldRetryFreshConversation(attempt.parsed, attempt.proc.stdout, attempt.proc.stderr)
  ) {
    await onLog("stdout", `[paperclip] agy conversation ${savedSessionId} not found; retrying with a fresh session.\n`);
    attempt = await runOnce(null);
    retriedFresh = true;
  }

  const { proc, parsed } = attempt;
  if (proc.timedOut) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: true,
      errorMessage: `Timed out after ${timeoutSec}s`,
      clearSession: false,
    };
  }

  const authRequired = detectAgyAuthRequired(proc.stdout, proc.stderr) && !parsed.summary;
  const failed = (proc.exitCode ?? 0) !== 0 || (parsed.status !== null && parsed.status !== "SUCCESS");
  const stderrLine = proc.stderr.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  const errorMessage = failed || authRequired
    ? authRequired
      ? "agy is not signed in. Run `agy` once in a terminal to log in."
      : parsed.errorMessage ?? (stderrLine || `agy exited with code ${proc.exitCode ?? -1}`)
    : null;

  const sessionId = parsed.conversationId ?? (retriedFresh ? null : savedSessionId);
  const sessionParams = sessionId ? { sessionId, cwd } : null;

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: false,
    errorMessage,
    errorCode: authRequired ? "agy_auth_required" : null,
    usage: parsed.usage ?? undefined,
    sessionId,
    sessionParams,
    sessionDisplayId: sessionId,
    provider: "antigravity",
    biller: "antigravity",
    model: parsed.model ?? model,
    billingType: "subscription",
    costUsd: 0,
    resultJson: { status: parsed.status, conversationId: parsed.conversationId },
    summary: parsed.summary || null,
    clearSession: Boolean(retriedFresh && !sessionId),
  };
}
