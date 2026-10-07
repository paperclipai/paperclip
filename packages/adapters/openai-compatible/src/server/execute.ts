import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterInvocationMeta,
} from "@paperclipai/adapter-utils";
import { adapterExecutionTargetIsRemote } from "@paperclipai/adapter-utils/execution-target";
import {
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE,
  asBoolean,
  asNumber,
  asString,
  buildPaperclipEnv,
  ensurePathInEnv,
  hydrateFreshSessionHandoff,
  isPaperclipRecoveryWakePayload,
  joinPromptSections,
  parseObject,
  readPaperclipIssueWorkModeFromContext,
  renderTemplate,
  sanitizeInheritedPaperclipEnv,
  selectInitialCommunicationGuidance,
  selectPaperclipPromptSections,
} from "@paperclipai/adapter-utils/server-utils";
import {
  DEFAULT_OPENAI_COMPATIBLE_MAX_HISTORY_CHARS,
  DEFAULT_OPENAI_COMPATIBLE_MAX_TURNS,
  DEFAULT_OPENAI_COMPATIBLE_REQUEST_TIMEOUT_SEC,
  DEFAULT_OPENAI_COMPATIBLE_SHELL_TIMEOUT_SEC,
  OPENAI_COMPATIBLE_API_KEY_ENV,
  normalizeOpenAiCompatibleApiUrl,
  type as ADAPTER_TYPE,
} from "../index.js";
import {
  createChatCompletion,
  isContextLengthError,
  OpenAiCompatibleRequestError,
  type ChatMessage,
  type ChatCompletionUsage,
} from "./client.js";
import { readSession, trimSessionMessages, type OpenAiCompatibleSession } from "./session.js";
import { loadRuntimeSkills } from "./skills.js";
import {
  buildToolDefinitions,
  executeTool,
  type RuntimeSkill,
  type ToolExecutionContext,
  type WorkspaceToolsContext,
} from "./tools.js";

export type OpenAiCompatibleEvent =
  | { type: "openai_compatible.init"; sessionId: string; model: string; apiHost: string; resumed: boolean }
  | { type: "openai_compatible.assistant"; text: string }
  | { type: "openai_compatible.thinking"; text: string }
  | { type: "openai_compatible.tool_call"; id: string; name: string; input: unknown }
  | { type: "openai_compatible.tool_result"; id: string; name: string; content: string; isError: boolean }
  | {
      type: "openai_compatible.result";
      status: "completed" | "error" | "max_turns" | "cancelled";
      text: string;
      usage: ChatCompletionUsage;
      error?: string;
    };

function eventLine(event: OpenAiCompatibleEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/** Resolved env values arrive as strings; tolerate `{ type: "plain" }` bindings. */
export function asStringEnvMap(value: unknown): Record<string, string> {
  const parsed = parseObject(value);
  const env: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry === "string") {
      env[key] = entry;
    } else if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      if (record.type === "plain" && typeof record.value === "string") env[key] = record.value;
    }
  }
  return env;
}

export function readExtraHeaders(value: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parseObject(value))) {
    const name = key.trim();
    // Authorization is owned by the adapter; never let config override it.
    if (!name || name.toLowerCase() === "authorization") continue;
    if (typeof entry === "string") headers[name] = entry;
  }
  return headers;
}

function trimNullable(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function optionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = asNumber(value, fallback);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function billerForApiUrl(apiUrl: string): string {
  try {
    const host = new URL(apiUrl).hostname.toLowerCase();
    if (host.endsWith("openrouter.ai")) return "openrouter";
    if (host.endsWith("openai.com")) return "openai";
    return host;
  } catch {
    return "unknown";
  }
}

function apiHost(apiUrl: string): string {
  try {
    return new URL(apiUrl).host;
  } catch {
    return apiUrl;
  }
}

function firstNonEmptyLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function buildRunEnv(ctx: AdapterExecutionContext): Record<string, string> {
  const { runId, agent, context } = ctx;
  const env: Record<string, string> = { ...buildPaperclipEnv(agent), PAPERCLIP_RUN_ID: runId };
  const values: Array<[string, string | null]> = [
    ["PAPERCLIP_TASK_ID", trimNullable(context.taskId) ?? trimNullable(context.issueId)],
    ["PAPERCLIP_WAKE_REASON", trimNullable(context.wakeReason)],
    ["PAPERCLIP_WAKE_COMMENT_ID", trimNullable(context.wakeCommentId) ?? trimNullable(context.commentId)],
    ["PAPERCLIP_APPROVAL_ID", trimNullable(context.approvalId)],
    ["PAPERCLIP_APPROVAL_STATUS", trimNullable(context.approvalStatus)],
    ["PAPERCLIP_ISSUE_WORK_MODE", readPaperclipIssueWorkModeFromContext(context) ?? null],
  ];
  if (Array.isArray(context.issueIds)) {
    const ids = context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    if (ids.length > 0) values.push(["PAPERCLIP_LINKED_ISSUE_IDS", ids.join(",")]);
  }
  for (const [key, value] of values) if (value) env[key] = value;
  return env;
}

async function readInstructions(
  config: Record<string, unknown>,
  onLog: AdapterExecutionContext["onLog"],
): Promise<{ text: string; notes: string[] }> {
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  if (!instructionsFilePath) return { text: "", notes: [] };
  try {
    const contents = await fs.readFile(instructionsFilePath, "utf8");
    const dir = `${path.dirname(instructionsFilePath)}/`;
    return {
      text: `${contents.trim()}\n\nThe above agent instructions were loaded from ${instructionsFilePath}. Resolve any relative file references from ${dir}.`,
      notes: [`Loaded agent instructions from ${instructionsFilePath}`],
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await onLog("stderr", `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`);
    return { text: "", notes: [`Could not read instructionsFilePath ${instructionsFilePath}; continuing without it.`] };
  }
}

async function resolveWorkspaceDir(ctx: AdapterExecutionContext): Promise<string | null> {
  const workspace = parseObject(ctx.context.paperclipWorkspace);
  const candidate = trimNullable(workspace.cwd) ?? trimNullable(ctx.config.cwd);
  if (!candidate || !path.isAbsolute(candidate)) return null;
  try {
    const stat = await fs.stat(candidate);
    return stat.isDirectory() ? candidate : null;
  } catch {
    return null;
  }
}

export function buildSystemPrompt(input: {
  agentName: string;
  runEnv: Record<string, string>;
  skills: RuntimeSkill[];
  workspaceCwd: string | null;
  instructions: string;
}): string {
  const runtimeValues = Object.entries(input.runEnv)
    .filter(([key]) => key.startsWith("PAPERCLIP_") && key !== "PAPERCLIP_API_URL")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `- ${key} = ${value}`)
    .join("\n");
  const toolNotes = [
    "You act only through the tools provided in this conversation.",
    "- paperclip_api_request: every Paperclip API call. Authorization and X-Paperclip-Run-Id are added for you; never ask for or print API keys.",
    "  When a skill shows `curl ... $PAPERCLIP_API_URL/api/...`, call paperclip_api_request with the same method, /api/... path, and JSON body instead.",
    input.skills.length > 0
      ? "- load_skill: load a skill's full instructions before following it. Load the `paperclip` skill at the start of a fresh session before doing task work."
      : "",
    input.workspaceCwd
      ? `- run_shell, read_file, write_file: operate inside the workspace directory ${input.workspaceCwd}.`
      : "- You have no shell or filesystem access in this runtime. Deliver work through Paperclip comments, documents, and issues.",
  ].filter(Boolean);
  const skillList = input.skills.length > 0
    ? [
        "Available skills (load with load_skill when relevant):",
        ...input.skills.map((skill) => `- ${skill.runtimeName}${skill.description ? `: ${skill.description}` : ""}`),
      ].join("\n")
    : "";
  return joinPromptSections([
    `You are ${input.agentName}, an AI agent working inside Paperclip, a control plane for AI-agent companies. You run through an OpenAI-compatible API with a tool-calling loop. When you have finished this heartbeat's work, reply with a short plain-text summary and no tool calls.`,
    toolNotes.join("\n"),
    runtimeValues ? `Runtime values for this run (the same values a shell agent sees as environment variables):\n${runtimeValues}` : "",
    skillList,
    input.instructions,
  ]);
}

function summarizeUsage(total: ChatCompletionUsage, next: ChatCompletionUsage): ChatCompletionUsage {
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    cachedInputTokens: total.cachedInputTokens + next.cachedInputTokens,
  };
}

function parseToolInput(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

type LoopOutcome = {
  status: "completed" | "max_turns" | "cancelled" | "error";
  finalText: string;
  usage: ChatCompletionUsage;
  model: string | null;
  turns: number;
  history: ChatMessage[];
  error: OpenAiCompatibleRequestError | Error | null;
};

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta } = ctx;
  const envConfig = asStringEnvMap(config.env);
  const apiUrl = normalizeOpenAiCompatibleApiUrl(config.apiUrl);
  const model = asString(config.model, "").trim();
  const apiKey = asString(envConfig[OPENAI_COMPATIBLE_API_KEY_ENV], "").trim();
  const baseResult = {
    signal: null,
    timedOut: false,
    provider: ADAPTER_TYPE,
    biller: apiUrl ? billerForApiUrl(apiUrl) : "unknown",
    billingType: "api" as const,
    costUsd: null,
  };

  if (!apiUrl || !model) {
    return {
      ...baseResult,
      exitCode: 1,
      errorCode: "configuration_invalid",
      errorMessage: !apiUrl
        ? "openai_compatible requires apiUrl to be an http(s) URL, e.g. https://openrouter.ai/api/v1."
        : "openai_compatible requires a model id.",
      clearSession: false,
    };
  }

  const maxTurns = positiveInt(config.maxTurns, DEFAULT_OPENAI_COMPATIBLE_MAX_TURNS);
  const requestTimeoutMs = positiveInt(config.requestTimeoutSec, DEFAULT_OPENAI_COMPATIBLE_REQUEST_TIMEOUT_SEC) * 1000;
  const maxHistoryChars = positiveInt(config.maxHistoryChars, DEFAULT_OPENAI_COMPATIBLE_MAX_HISTORY_CHARS);
  const temperature = optionalNumber(config.temperature);
  const maxTokens = optionalNumber(config.maxTokens);
  const extraHeaders = readExtraHeaders(config.extraHeaders);

  const runEnv = buildRunEnv(ctx);
  const skills = await loadRuntimeSkills(config);
  const instructions = await readInstructions(config, onLog);

  const workspaceToolsRequested = asBoolean(config.enableWorkspaceTools, false);
  const remoteTarget = adapterExecutionTargetIsRemote(ctx.executionTarget ?? null);
  const workspaceDir = workspaceToolsRequested && !remoteTarget ? await resolveWorkspaceDir(ctx) : null;
  const workspace: WorkspaceToolsContext | null = workspaceDir
    ? {
        cwd: workspaceDir,
        env: ensurePathInEnv({
          ...sanitizeInheritedPaperclipEnv(process.env),
          ...envConfig,
          ...runEnv,
          ...(ctx.authToken ? { PAPERCLIP_API_KEY: ctx.authToken } : {}),
        }),
        shellTimeoutMs: positiveInt(config.shellTimeoutSec, DEFAULT_OPENAI_COMPATIBLE_SHELL_TIMEOUT_SEC) * 1000,
      }
    : null;
  if (workspace) delete workspace.env[OPENAI_COMPATIBLE_API_KEY_ENV];

  const commandNotes = [...instructions.notes];
  if (workspaceToolsRequested && !workspace) {
    commandNotes.push(
      remoteTarget
        ? "Workspace tools are disabled: this adapter runs in the Paperclip server and cannot reach a remote environment."
        : "Workspace tools are disabled: no absolute workspace directory is available for this run.",
    );
  }
  if (!apiKey) commandNotes.push(`No ${OPENAI_COMPATIBLE_API_KEY_ENV} configured; calling the provider without Authorization.`);

  const tools = buildToolDefinitions({ workspaceTools: Boolean(workspace), hasSkills: skills.length > 0 });
  const toolCtx: ToolExecutionContext = {
    paperclipApiUrl: runEnv.PAPERCLIP_API_URL ?? null,
    authToken: ctx.authToken ?? null,
    runId,
    skills,
    workspace,
    signal: ctx.signal,
  };
  const systemPrompt = buildSystemPrompt({
    agentName: agent.name,
    runEnv,
    skills,
    workspaceCwd: workspace?.cwd ?? null,
    instructions: instructions.text,
  });

  const storedSession = readSession(runtime.sessionParams);
  const canResume = Boolean(storedSession && storedSession.apiUrl === apiUrl && storedSession.messages.length > 0);
  const promptTemplate = asString(
    config.promptTemplate,
    context.conversationMode === true ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
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

  async function buildUserPrompt(resumed: boolean): Promise<string> {
    await hydrateFreshSessionHandoff(ctx, { resumedSession: resumed });
    const { taskContextNote, wakePrompt } = selectPaperclipPromptSections(context, {
      resumedSession: resumed,
      includeCommunicationGuidance: false,
    });
    const bootstrap = !resumed && bootstrapPromptTemplate.trim()
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
    const heartbeat =
      (resumed && wakePrompt.length > 0) || isPaperclipRecoveryWakePayload(context.paperclipWake)
        ? ""
        : renderTemplate(promptTemplate, templateData).trim();
    return joinPromptSections([
      selectInitialCommunicationGuidance(context, { resumedSession: resumed }),
      bootstrap,
      wakePrompt,
      taskContextNote,
      heartbeat,
      asString(context.paperclipSessionHandoffMarkdown, "").trim(),
    ]);
  }

  async function runLoop(history: ChatMessage[]): Promise<LoopOutcome> {
    let usage: ChatCompletionUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    let lastModel: string | null = null;
    let finalText = "";
    for (let turn = 1; turn <= maxTurns; turn++) {
      if (ctx.signal?.aborted) {
        return { status: "cancelled", finalText, usage, model: lastModel, turns: turn - 1, history, error: null };
      }
      let response;
      try {
        response = await createChatCompletion({
          apiUrl: apiUrl!,
          apiKey,
          model,
          messages: [{ role: "system", content: systemPrompt }, ...history],
          tools,
          temperature,
          maxTokens,
          extraHeaders,
          timeoutMs: requestTimeoutMs,
          signal: ctx.signal,
        });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        const cancelled = err instanceof OpenAiCompatibleRequestError && err.aborted;
        return { status: cancelled ? "cancelled" : "error", finalText, usage, model: lastModel, turns: turn, history, error };
      }
      usage = summarizeUsage(usage, response.usage);
      lastModel = response.model ?? lastModel;
      if (response.reasoning.trim()) {
        await onLog("stdout", eventLine({ type: "openai_compatible.thinking", text: response.reasoning.trim() }));
      }
      if (response.content.trim()) {
        finalText = response.content.trim();
        await onLog("stdout", eventLine({ type: "openai_compatible.assistant", text: finalText }));
      }
      // Reasoning text is not replayed: several providers reject it as input.
      if (response.toolCalls.length === 0) {
        history.push({ role: "assistant", content: response.content });
        return { status: "completed", finalText, usage, model: lastModel, turns: turn, history, error: null };
      }
      history.push({ role: "assistant", content: response.content, tool_calls: response.toolCalls });
      for (const call of response.toolCalls) {
        await onLog("stdout", eventLine({
          type: "openai_compatible.tool_call",
          id: call.id,
          name: call.function.name,
          input: parseToolInput(call.function.arguments),
        }));
        const result = await executeTool(call.function.name, call.function.arguments, toolCtx);
        await onLog("stdout", eventLine({
          type: "openai_compatible.tool_result",
          id: call.id,
          name: call.function.name,
          content: result.content,
          isError: result.isError,
        }));
        history.push({ role: "tool", tool_call_id: call.id, content: result.content });
      }
    }
    return { status: "max_turns", finalText, usage, model: lastModel, turns: maxTurns, history, error: null };
  }

  let resumed = canResume;
  let sessionId = resumed && storedSession ? storedSession.sessionId : randomUUID();
  let userPrompt = await buildUserPrompt(resumed);

  if (onMeta) {
    const meta: AdapterInvocationMeta = {
      adapterType: ADAPTER_TYPE,
      command: `POST ${apiUrl}/chat/completions`,
      commandNotes: [
        ...commandNotes,
        resumed ? `Resuming conversation ${sessionId} (${storedSession?.messages.length ?? 0} stored messages)` : "Starting a new conversation",
        `Model: ${model}`,
        `Tools: ${tools.map((tool) => tool.function.name).join(", ")}`,
      ],
      prompt: joinPromptSections([systemPrompt, userPrompt]),
      promptMetrics: {
        systemPromptChars: systemPrompt.length,
        userPromptChars: userPrompt.length,
        resumedMessages: resumed ? storedSession?.messages.length ?? 0 : 0,
      },
      context: { openaiCompatible: { apiHost: apiHost(apiUrl), model, maxTurns, workspaceTools: Boolean(workspace) } },
    };
    await onMeta(meta);
  }

  await ctx.onCancellationReady?.();
  ctx.onDispatch?.();
  await onLog("stdout", eventLine({ type: "openai_compatible.init", sessionId, model, apiHost: apiHost(apiUrl), resumed }));

  const initialHistory = (): ChatMessage[] => [
    ...(resumed && storedSession ? storedSession.messages : []),
    { role: "user", content: userPrompt || "Continue your Paperclip work for this heartbeat." },
  ];
  let outcome = await runLoop(initialHistory());
  let clearSession = false;
  if (outcome.status === "error" && resumed && isContextLengthError(outcome.error)) {
    await onLog("stderr", "[paperclip] Stored conversation exceeds the provider context window; retrying with a fresh session.\n");
    resumed = false;
    clearSession = true;
    sessionId = randomUUID();
    userPrompt = await buildUserPrompt(false);
    const retryUsage = outcome.usage;
    outcome = await runLoop(initialHistory());
    outcome.usage = summarizeUsage(retryUsage, outcome.usage);
  }

  const errorText = outcome.error?.message ?? null;
  await onLog("stdout", eventLine({
    type: "openai_compatible.result",
    status: outcome.status,
    // The final reply was already streamed as an assistant event.
    text: "",
    usage: outcome.usage,
    ...(errorText ? { error: errorText } : outcome.status === "max_turns" ? { error: `Reached maxTurns (${maxTurns})` } : {}),
  }));

  const nextSession: OpenAiCompatibleSession = {
    sessionId,
    apiUrl,
    model,
    messages: trimSessionMessages(outcome.history, maxHistoryChars),
  };
  const timedOut = outcome.error instanceof OpenAiCompatibleRequestError && outcome.error.timedOut;
  const failed = outcome.status !== "completed";
  return {
    ...baseResult,
    exitCode: failed ? 1 : 0,
    timedOut,
    errorCode:
      outcome.status === "cancelled"
        ? "cancelled"
        : outcome.status === "max_turns"
          ? "max_turns_reached"
          : outcome.status === "error"
            ? timedOut ? "timeout" : "provider_error"
            : null,
    errorMessage:
      outcome.status === "max_turns"
        ? `Reached maxTurns (${maxTurns}) before the model finished. The conversation is saved and resumes on the next wake.`
        : outcome.status === "cancelled"
          ? "openai_compatible run was cancelled."
          : errorText,
    usage: outcome.usage,
    usageBasis: "per_run",
    model: outcome.model ?? model,
    sessionId,
    sessionDisplayId: sessionId,
    sessionParams: nextSession,
    clearSession,
    summary: outcome.finalText ? firstNonEmptyLine(outcome.finalText) : null,
    resultJson: {
      status: outcome.status,
      turns: outcome.turns,
      apiHost: apiHost(apiUrl),
      model: outcome.model ?? model,
      ...(outcome.finalText ? { result: outcome.finalText } : {}),
      ...(errorText ? { error: errorText } : {}),
      ...(outcome.error instanceof OpenAiCompatibleRequestError && outcome.error.status !== null
        ? { providerStatus: outcome.error.status }
        : {}),
    },
  };
}
