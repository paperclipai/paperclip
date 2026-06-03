import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  AdapterAgent,
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterInvocationMeta,
} from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  asStringArray,
  buildInvocationEnvForLogs,
  buildPaperclipEnv,
  DEFAULT_BIZBOX_AGENT_PROMPT_TEMPLATE,
  ensureCommandResolvable,
  ensurePathInEnv,
  joinPromptSections,
  renderPaperclipWakePrompt,
  renderTemplate,
  resolveCommandForLogs,
  runChildProcess,
  stringifyPaperclipWakePayload,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_GOOGLE_ADK_COMMAND, DEFAULT_GOOGLE_ADK_MODEL } from "../index.js";
import { parseGoogleAdkJsonl } from "./parse.js";

function paperclipHome(): string {
  const configured = process.env.BIZBOX_HOME?.trim();
  return configured && configured.length > 0 ? configured : path.join(os.homedir(), ".paperclip");
}

function sqliteUri(filePath: string): string {
  return `sqlite:///${path.resolve(filePath).replaceAll("\\", "/")}`;
}

function artifactUri(dirPath: string): string {
  return pathToFileURL(path.resolve(dirPath)).toString();
}

async function readInstructionsPrefix(
  instructionsFilePath: string,
  onLog: AdapterExecutionContext["onLog"],
): Promise<string> {
  if (!instructionsFilePath) return "";
  try {
    const contents = await fs.readFile(instructionsFilePath, "utf8");
    const instructionsDir = `${path.dirname(instructionsFilePath)}/`;
    return (
      `${contents}\n\n` +
      `The above agent instructions were loaded from ${instructionsFilePath}. ` +
      `Resolve any relative file references from ${instructionsDir}.\n`
    );
  } catch (err) {
    await onLog(
      "stdout",
      `[paperclip] Warning: could not read ADK instructions file "${instructionsFilePath}": ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return "";
  }
}

export interface InvokeGoogleAdkInput {
  runId: string;
  agent: AdapterAgent;
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  onLog: AdapterExecutionContext["onLog"];
  onMeta?: (meta: AdapterInvocationMeta) => Promise<void>;
  onSpawn?: AdapterExecutionContext["onSpawn"];
  authToken?: string;
  queryOverride?: string;
  runtimeRootOverride?: string;
}

export async function invokeGoogleAdk(input: InvokeGoogleAdkInput): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, onMeta, onSpawn, authToken, queryOverride, runtimeRootOverride } = input;
  const command = asString(config.command, DEFAULT_GOOGLE_ADK_COMMAND);
  const agentPath = asString(config.agentPath, "").trim();
  if (!agentPath) {
    throw new Error("google_adk adapter requires adapterConfig.agentPath");
  }

  const resolvedAgentPath = path.resolve(agentPath);
  const stat = await fs.stat(resolvedAgentPath).catch(() => null);
  if (!stat) {
    throw new Error(`google_adk agentPath does not exist: ${resolvedAgentPath}`);
  }

  const configuredCwd = asString(config.cwd, "").trim();
  const cwd = configuredCwd || (stat.isDirectory() ? resolvedAgentPath : path.dirname(resolvedAgentPath));
  const promptTemplate = asString(config.promptTemplate, DEFAULT_BIZBOX_AGENT_PROMPT_TEMPLATE);
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsPrefix = await readInstructionsPrefix(instructionsFilePath, onLog);
  const renderedPrompt = renderTemplate(promptTemplate, {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  });
  const wakePrompt = renderPaperclipWakePrompt((context as { paperclipWake?: unknown }).paperclipWake, { resumedSession: false });
  const sessionHandoffNote = asString((context as { paperclipSessionHandoffMarkdown?: unknown }).paperclipSessionHandoffMarkdown, "").trim();
  const query = queryOverride ?? joinPromptSections([instructionsPrefix, wakePrompt, sessionHandoffNote, renderedPrompt]);

  const envConfig = typeof config.env === "object" && config.env !== null ? (config.env as Record<string, unknown>) : {};
  const hasExplicitApiKey =
    typeof envConfig.BIZBOX_API_KEY === "string" && envConfig.BIZBOX_API_KEY.trim().length > 0;
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.BIZBOX_RUN_ID = runId;
  const wakeTaskId =
    ((context as { taskId?: string }).taskId?.trim()) ||
    ((context as { issueId?: string }).issueId?.trim()) ||
    null;
  const wakeReason = typeof (context as { wakeReason?: unknown }).wakeReason === "string"
    ? (context as { wakeReason: string }).wakeReason.trim() || null
    : null;
  const wakeCommentId =
    ((context as { wakeCommentId?: string }).wakeCommentId?.trim()) ||
    ((context as { commentId?: string }).commentId?.trim()) ||
    null;
  const wakePayloadJson = stringifyPaperclipWakePayload((context as { paperclipWake?: unknown }).paperclipWake);
  if (wakeTaskId) env.BIZBOX_TASK_ID = wakeTaskId;
  if (wakeReason) env.BIZBOX_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.BIZBOX_WAKE_COMMENT_ID = wakeCommentId;
  if (wakePayloadJson) env.BIZBOX_WAKE_PAYLOAD_JSON = wakePayloadJson;

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  if (!hasExplicitApiKey && authToken) {
    env.BIZBOX_API_KEY = authToken;
  }

  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  await ensureCommandResolvable(command, cwd, runtimeEnv);
  const resolvedCommand = await resolveCommandForLogs(command, cwd, runtimeEnv);

  const timeoutSec = Math.max(1, asNumber(config.timeoutSec, 1800));
  const graceSec = Math.max(1, asNumber(config.graceSec, 15));
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();
  const model = asString(config.model, DEFAULT_GOOGLE_ADK_MODEL).trim();

  const adkRoot = runtimeRootOverride
    ? path.resolve(runtimeRootOverride)
    : path.join(paperclipHome(), "adk", "companies", agent.companyId, "agents", agent.id);
  const sessionDbPath = path.join(adkRoot, "sessions.sqlite");
  const artifactDir = path.join(adkRoot, "artifacts");
  await fs.mkdir(path.dirname(sessionDbPath), { recursive: true });
  await fs.mkdir(artifactDir, { recursive: true });

  const args = [
    "run",
    "--jsonl",
    "--session_service_uri",
    sqliteUri(sessionDbPath),
    "--artifact_service_uri",
    artifactUri(artifactDir),
    "--timeout",
    `${timeoutSec}s`,
  ];
  if (model) {
    args.push("--default_llm_model", model);
  }
  if (extraArgs.length > 0) {
    args.push(...extraArgs);
  }
  args.push(resolvedAgentPath, query);

  if (onMeta) {
    await onMeta({
      adapterType: "google_adk",
      command: resolvedCommand,
      cwd,
      commandArgs: args,
      env: buildInvocationEnvForLogs(env, {
        runtimeEnv,
        includeRuntimeKeys: ["HOME", "PYTHONPATH"],
        resolvedCommand,
      }),
    });
  }

  const proc = await runChildProcess(runId, command, args, {
    cwd,
    env,
    timeoutSec: timeoutSec + 5,
    graceSec,
    onLog,
    onSpawn,
  });

  const parsed = parseGoogleAdkJsonl(proc.stdout);
  if (proc.timedOut) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: true,
      errorMessage: `Timed out after ${timeoutSec}s`,
      summary: parsed.summary || null,
      usage: parsed.usage,
      resultJson: {
        stdout: proc.stdout,
        stderr: proc.stderr,
        toolCalls: parsed.toolCalls,
        toolResults: parsed.toolResults,
      },
    };
  }

  if ((proc.exitCode ?? 0) !== 0 || parsed.errorMessage) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage: parsed.errorMessage ?? `google_adk exited with code ${proc.exitCode ?? -1}`,
      summary: parsed.summary || null,
      usage: parsed.usage,
      model: model || null,
      provider: "google_adk",
      resultJson: {
        stdout: proc.stdout,
        stderr: proc.stderr,
        toolCalls: parsed.toolCalls,
        toolResults: parsed.toolResults,
      },
    };
  }

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: false,
    summary: parsed.summary || null,
    usage: parsed.usage,
    model: model || null,
    provider: "google_adk",
    resultJson: {
      stdout: proc.stdout,
      stderr: proc.stderr,
      toolCalls: parsed.toolCalls,
      toolResults: parsed.toolResults,
    },
  };
}
