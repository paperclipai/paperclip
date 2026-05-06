import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { appendWithByteCap, asString, parseObject } from "../utils.js";
import {
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  buildPaperclipEnv,
  joinPromptSections,
  renderPaperclipWakePrompt,
  renderTemplate,
} from "@paperclipai/adapter-utils/server-utils";
import type { OllamaLocalConfig } from "./config.js";
import { parseOllamaLocalConfig } from "./config.js";
import { rememberOllamaLocalModels } from "./models.js";
import { loadOllamaSelectedSkills } from "./skills.js";
import {
  ollamaLocalSessionCodec,
  parseOllamaSessionParams,
  type OllamaSessionMessage,
  type OllamaSessionParams,
} from "./session.js";

type OllamaToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

type OllamaChatResult = {
  text: string;
  doneReason: string | null;
  usage: { inputTokens?: number; outputTokens?: number };
  toolCalls: OllamaToolCall[];
  raw: Record<string, unknown>;
};

const COMMAND_TOOL_NAME = "run_command";
const MAX_STDIO_BYTES = 128 * 1024;

function toUsageSummary(usage: OllamaChatResult["usage"]): AdapterExecutionResult["usage"] | undefined {
  const hasInput = typeof usage.inputTokens === "number";
  const hasOutput = typeof usage.outputTokens === "number";
  if (!hasInput && !hasOutput) return undefined;
  return {
    inputTokens: hasInput ? usage.inputTokens! : 0,
    outputTokens: hasOutput ? usage.outputTokens! : 0,
  };
}

function withTimeoutAbort(timeoutSec: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutSec) * 1000);
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer);
    },
  };
}

function buildSystemPrompt(config: OllamaLocalConfig, selectedSkills: Awaited<ReturnType<typeof loadOllamaSelectedSkills>>["selectedSkills"]) {
  const skillPrompt = selectedSkills.length
    ? [
        "Paperclip selected the following skills for this run. Treat them as instructions and apply them when relevant.",
        ...selectedSkills.map((skill) => `## ${skill.key}\n${skill.body ?? skill.description}`),
      ].join("\n\n")
    : null;

  const commandToolPrompt = config.enableCommandExecution
    ? [
        "You may call the run_command tool when command-line inspection or execution is genuinely necessary.",
        "Prefer small, safe, auditable commands. Return to the user with concise reasoning after each tool call.",
      ].join("\n")
    : null;

  return joinPromptSections([config.instructions, skillPrompt, commandToolPrompt]) || null;
}

function buildUserPrompt(ctx: AdapterExecutionContext, config: OllamaLocalConfig) {
  const wakePrompt = renderPaperclipWakePrompt(ctx.context.paperclipWake, {
    resumedSession: Boolean(parseOllamaSessionParams(ctx.runtime.sessionParams)?.messages.length),
  });
  const renderedTemplate = renderTemplate(
    config.promptTemplate || DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
    {
      agent: ctx.agent,
      agentId: ctx.agent.id,
      companyId: ctx.agent.companyId,
      context: ctx.context,
      contextJson: JSON.stringify(ctx.context, null, 2),
      run: { id: ctx.runId },
      runId: ctx.runId,
    },
  ).trim();

  return joinPromptSections([wakePrompt, renderedTemplate]);
}

function buildToolDefinitions(config: OllamaLocalConfig) {
  if (!config.enableCommandExecution) return undefined;
  return [
    {
      type: "function",
      function: {
        name: COMMAND_TOOL_NAME,
        description:
          "Run a local command on the Paperclip host. Use the args array instead of shell syntax whenever possible.",
        parameters: {
          type: "object",
          required: ["command"],
          properties: {
            command: { type: "string", description: "Executable name or absolute path" },
            args: {
              type: "array",
              items: { type: "string" },
              description: "Optional command arguments",
            },
            cwd: {
              type: "string",
              description: "Optional absolute working directory override",
            },
            stdin: { type: "string", description: "Optional stdin text piped to the command" },
          },
        },
      },
    },
  ];
}

function normalizeToolCalls(raw: unknown): OllamaToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => parseObject(entry))
    .map((entry) => {
      const fn = parseObject(entry.function);
      const name = asString(fn.name, "").trim();
      const argsRaw = fn.arguments;
      const args =
        typeof argsRaw === "string"
          ? (() => {
              try {
                const parsed = JSON.parse(argsRaw);
                return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
                  ? (parsed as Record<string, unknown>)
                  : {};
              } catch {
                return {};
              }
            })()
          : parseObject(argsRaw);
      if (!name) return null;
      return { name, arguments: args } satisfies OllamaToolCall;
    })
    .filter((value): value is OllamaToolCall => Boolean(value));
}

async function readStreamingChatResponse(
  response: Response,
  onLog: AdapterExecutionContext["onLog"],
): Promise<OllamaChatResult> {
  const body = response.body;
  if (!body) {
    throw new Error("OLLAMA_INVALID_RESPONSE: missing response body");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  let lastPayload: Record<string, unknown> = {};
  let toolCalls: OllamaToolCall[] = [];

  const handleLine = async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const payload = parseObject(JSON.parse(trimmed));
    lastPayload = payload;
    const message = parseObject(payload.message);
    const delta = asString(message.content, "");
    if (delta) {
      fullText += delta;
      await onLog?.("stdout", `[ollama_local:assistant] ${delta}\n`);
    }
    const parsedToolCalls = normalizeToolCalls(message.tool_calls);
    if (parsedToolCalls.length > 0) {
      toolCalls = parsedToolCalls;
    }
  };

  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      await handleLine(line);
      newlineIndex = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    await handleLine(buffer);
  }

  return {
    text: fullText.trim(),
    doneReason: asString(lastPayload.done_reason, "") || null,
    usage: {
      inputTokens:
        typeof lastPayload.prompt_eval_count === "number" ? lastPayload.prompt_eval_count : undefined,
      outputTokens: typeof lastPayload.eval_count === "number" ? lastPayload.eval_count : undefined,
    },
    toolCalls,
    raw: lastPayload,
  };
}

async function readNonStreamingChatResponse(response: Response): Promise<OllamaChatResult> {
  const payload = parseObject(await response.json());
  const message = parseObject(payload.message);
  return {
    text: asString(message.content, "").trim(),
    doneReason: asString(payload.done_reason, "") || null,
    usage: {
      inputTokens: typeof payload.prompt_eval_count === "number" ? payload.prompt_eval_count : undefined,
      outputTokens: typeof payload.eval_count === "number" ? payload.eval_count : undefined,
    },
    toolCalls: normalizeToolCalls(message.tool_calls),
    raw: payload,
  };
}

function toOllamaMessages(messages: OllamaSessionMessage[]) {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        content: message.content,
        tool_name: message.toolName ?? COMMAND_TOOL_NAME,
      };
    }
    return {
      role: message.role,
      content: message.content,
    };
  });
}

async function callOllamaChat(options: {
  config: OllamaLocalConfig;
  systemPrompt: string | null;
  messages: OllamaSessionMessage[];
  onLog: AdapterExecutionContext["onLog"];
}): Promise<OllamaChatResult> {
  const timeout = withTimeoutAbort(options.config.ollamaTimeoutSec);
  try {
    const response = await fetch(`${options.config.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: timeout.signal,
      body: JSON.stringify({
        model: options.config.model,
        stream: options.config.streaming,
        ...(options.config.think ? { think: options.config.think } : {}),
        ...(options.systemPrompt ? { messages: [{ role: "system", content: options.systemPrompt }, ...toOllamaMessages(options.messages)] } : { messages: toOllamaMessages(options.messages) }),
        ...(options.config.enableCommandExecution ? { tools: buildToolDefinitions(options.config) } : {}),
      }),
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).trim().slice(0, 500);
      throw new Error(`OLLAMA_HTTP_${response.status}: ${detail || response.statusText}`);
    }

    rememberOllamaLocalModels(options.config.baseUrl, [options.config.model]);

    return options.config.streaming
      ? readStreamingChatResponse(response, options.onLog)
      : readNonStreamingChatResponse(response);
  } finally {
    timeout.clear();
  }
}

function trimSessionMessages(messages: OllamaSessionMessage[]): OllamaSessionMessage[] {
  const capped = messages.slice(-24);
  let totalBytes = 0;
  const kept: OllamaSessionMessage[] = [];
  for (let index = capped.length - 1; index >= 0; index -= 1) {
    const message = capped[index]!;
    totalBytes += Buffer.byteLength(message.content, "utf8");
    if (totalBytes > 60_000 && kept.length > 0) continue;
    kept.unshift(message);
  }
  return kept;
}

async function runCommandTool(options: {
  ctx: AdapterExecutionContext;
  config: OllamaLocalConfig;
  call: OllamaToolCall;
}): Promise<Record<string, unknown>> {
  const args = Array.isArray(options.call.arguments.args)
    ? options.call.arguments.args.filter((value): value is string => typeof value === "string")
    : [];
  const command = asString(options.call.arguments.command, "").trim();
  const stdin = asString(options.call.arguments.stdin, "");
  const requestedCwd = asString(options.call.arguments.cwd, "").trim() || null;
  const cwd = requestedCwd || options.config.commandCwd || process.cwd();

  if (!command) {
    return { ok: false, error: "command is required" };
  }
  if (!path.isAbsolute(cwd)) {
    return { ok: false, error: `cwd must be absolute (received ${cwd})` };
  }

  await options.ctx.onLog?.(
    "stdout",
    `[ollama_local:tool] ${command}${args.length ? ` ${args.join(" ")}` : ""} (cwd=${cwd})\n`,
  );

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ...buildPaperclipEnv(options.ctx.agent),
        ...(options.ctx.authToken ? { PAPERCLIP_API_KEY: options.ctx.authToken } : {}),
        PAPERCLIP_RUN_ID: options.ctx.runId,
      },
      stdio: "pipe",
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, Math.max(1, options.config.commandTimeoutSec) * 1000);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout = appendWithByteCap(
        stdout,
        typeof chunk === "string" ? chunk : chunk.toString("utf8"),
        MAX_STDIO_BYTES,
      );
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = appendWithByteCap(
        stderr,
        typeof chunk === "string" ? chunk : chunk.toString("utf8"),
        MAX_STDIO_BYTES,
      );
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.message, stdout, stderr, timedOut });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        exitCode: code,
        signal,
        stdout,
        stderr,
        timedOut,
        command,
        args,
        cwd,
      });
    });

    if (stdin) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

function buildSessionParams(options: {
  prior: OllamaSessionParams | null;
  config: OllamaLocalConfig;
  messages: OllamaSessionMessage[];
  toolCallCount: number;
  doneReason: string | null;
}): OllamaSessionParams {
  const now = new Date().toISOString();
  return {
    sessionId: options.prior?.sessionId || `ollama-local-${randomUUID()}`,
    model: options.config.model,
    baseUrl: options.config.baseUrl,
    createdAt: options.prior?.createdAt || now,
    updatedAt: now,
    messages: trimSessionMessages(options.messages),
    toolCallCount: options.toolCallCount || options.prior?.toolCallCount || 0,
    metadata: {
      doneReason: options.doneReason,
    },
  };
}

export async function executeOllamaLocal(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  let config: OllamaLocalConfig;
  try {
    config = parseOllamaLocalConfig(ctx.config);
  } catch (error) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "CONFIG_INVALID",
      errorMessage: error instanceof Error ? error.message : "Invalid ollama_local configuration",
      summary: error instanceof Error ? error.message : "Invalid ollama_local configuration",
      provider: "ollama",
      biller: "ollama",
    };
  }

  const priorSession = parseOllamaSessionParams(
    ollamaLocalSessionCodec.deserialize(ctx.runtime.sessionParams) ?? ctx.runtime.sessionParams,
  );
  const userPrompt = buildUserPrompt(ctx, config);
  const { selectedSkills, describedSkills } = await loadOllamaSelectedSkills({
    config,
    taskText: userPrompt,
    onLog: ctx.onLog,
  });
  const systemPrompt = buildSystemPrompt(config, selectedSkills);
  const messages: OllamaSessionMessage[] = [
    ...(priorSession?.messages ?? []),
    { role: "user", content: userPrompt },
  ];

  const overallTimeout = withTimeoutAbort(config.timeoutSec);
  let toolCallCount = priorSession?.toolCallCount ?? 0;
  let finalResult: OllamaChatResult | null = null;

  await ctx.onMeta?.({
    adapterType: "ollama_local",
    command: `POST ${config.baseUrl}/api/chat`,
    commandNotes: [
      `model=${config.model}`,
      `streaming=${String(config.streaming)}`,
      `think=${String(config.think || false)}`,
      `skills=${selectedSkills.map((skill) => skill.key).join(", ") || "none"}`,
      `skillSelectionMode=${config.skillSelectionMode}`,
      `commandExecution=${String(config.enableCommandExecution)}`,
    ],
    prompt: userPrompt,
    promptMetrics: { lengthChars: userPrompt.length },
  });

  try {
    while (!overallTimeout.signal.aborted) {
      finalResult = await callOllamaChat({
        config,
        systemPrompt,
        messages,
        onLog: ctx.onLog,
      });

      if (config.logging) {
        await ctx.onLog?.(
          "stdout",
          `[ollama_local] received response doneReason=${finalResult.doneReason ?? "unknown"} toolCalls=${finalResult.toolCalls.length}\n`,
        );
      }

      if (!finalResult.toolCalls.length) {
        messages.push({ role: "assistant", content: finalResult.text || "(empty response)" });
        const sessionParams = buildSessionParams({
          prior: priorSession,
          config,
          messages,
          toolCallCount,
          doneReason: finalResult.doneReason,
        });
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          summary: finalResult.text || "Ollama completed without assistant text.",
          provider: "ollama",
          biller: "ollama",
          usage: toUsageSummary(finalResult.usage),
          sessionId: sessionParams.sessionId,
          sessionDisplayId: sessionParams.sessionId,
          sessionParams: sessionParams as Record<string, unknown>,
          resultJson: {
            ...finalResult.raw,
            selectedSkills: selectedSkills.map((skill) => skill.key),
            desiredSkills: describedSkills.map((skill) => skill.key),
            toolCallCount,
          },
        };
      }

      if (!config.enableCommandExecution) {
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorCode: "TOOL_CALLS_DISABLED",
          errorMessage: "Model attempted to call a tool but command execution is disabled for this adapter.",
          summary: "Model attempted to call a tool but command execution is disabled for this adapter.",
          provider: "ollama",
          biller: "ollama",
        };
      }

      messages.push({ role: "assistant", content: finalResult.text || "", });
      for (const call of finalResult.toolCalls) {
        toolCallCount += 1;
        if (toolCallCount > config.maxToolCalls) {
          return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            errorCode: "TOOL_CALL_LIMIT",
            errorMessage: `Ollama exceeded the configured maxToolCalls (${config.maxToolCalls}).`,
            summary: `Ollama exceeded the configured maxToolCalls (${config.maxToolCalls}).`,
            provider: "ollama",
            biller: "ollama",
          };
        }

        const toolResult =
          call.name === COMMAND_TOOL_NAME
            ? await runCommandTool({ ctx, config, call })
            : { ok: false, error: `Unsupported tool: ${call.name}` };

        messages.push({
          role: "tool",
          content: JSON.stringify(toolResult),
          toolName: call.name,
        });
      }
    }

    return {
      exitCode: null,
      signal: null,
      timedOut: true,
      errorCode: "TIMEOUT",
      errorMessage: "ollama_local exceeded the configured adapter timeout",
      summary: "ollama_local exceeded the configured adapter timeout",
      provider: "ollama",
      biller: "ollama",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: message.startsWith("TIMEOUT") ? null : 1,
      signal: null,
      timedOut: message.startsWith("TIMEOUT"),
      errorCode: message.startsWith("OLLAMA_HTTP_") ? "UPSTREAM_HTTP" : "UPSTREAM_REQUEST_FAILED",
      errorMessage: message,
      summary: message,
      provider: "ollama",
      biller: "ollama",
    };
  } finally {
    overallTimeout.clear();
  }
}
