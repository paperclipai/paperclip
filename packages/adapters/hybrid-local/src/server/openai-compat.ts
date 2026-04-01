import type { UsageSummary } from "@paperclipai/adapter-utils";
import { asNumber } from "@paperclipai/adapter-utils/server-utils";
import { spawn } from "node:child_process";
const DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1";
const MAX_TOOL_TURNS = 30;
const MAX_TOOLS_PER_TURN = 5;
const MAX_MESSAGE_HISTORY = 1000;
const DEFAULT_MAX_TOTAL_TOKENS = 300_000; // Cap across all 30 turns unless overridden in adapter config
const BASH_TIMEOUT_MS = 120_000;
const BASH_MAX_OUTPUT_CHARS = 1024 * 1024; // Mirror prior execFile maxBuffer to avoid runaway memory use
const MAX_TOOL_OUTPUT_CHARS = 8_000; // ~2k tokens — prevents context overflow from large ls/cat outputs
const BASH_KILL_GRACE_MS = 2_000;

// Commands that are too dangerous to execute via local model
const DANGEROUS_PATTERNS = [
  /\brm\s+-rf\b/, // recursive delete
  /\bsudo\b/, // privilege escalation
  /\bdd\b/, // disk dumping
  /\bfdisk\b/, // partition manipulation
  /\bformat\b\s+[A-Za-z]:/, // Windows drive format: "format C:"
  /\bshutdown\b/, // shutdown/reboot
  /\breboot\b/, // reboot system
  /\bhalt\b/, // halt system
  /\bpoweroff\b/, // power off
  /\bpkill\b/, // kill processes by name
  /\bkill\s+-9\b/, // forcefully kill processes
];

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some(pattern => pattern.test(command));
}

export interface OpenAICompatResult {
  summary: string;
  model: string;
  usage: UsageSummary;
  finishReason: string | null;
}

// OpenAI chat completion types
interface TextMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface AssistantToolCallMessage {
  role: "assistant";
  content: string | null;
  tool_calls: ToolCall[];
}

interface ToolResultMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

type Message = TextMessage | AssistantToolCallMessage | ToolResultMessage;

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatCompletionChoice {
  index: number;
  message: {
    role: string;
    content: string | null;
    tool_calls?: ToolCall[];
  };
  finish_reason: string | null;
}

interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: ChatCompletionUsage;
}

interface OpenAICompatModel {
  id: string;
  object: string;
  owned_by?: string;
}

interface OpenAICompatModelsResponse {
  data: OpenAICompatModel[];
}

// --- Tool definitions passed to the model ---

const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "bash",
      description:
        "Execute a bash command in the agent working directory. Use this for reading files (cat, grep, ls), writing files (tee, heredoc), running tests (pnpm test), git operations (git status, git add, git commit, git push), and GitHub CLI (gh issue, gh pr). Always prefer small focused commands.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The bash command to execute",
          },
          description: {
            type: "string",
            description: "One-line description of what this command does",
          },
        },
        required: ["command"],
      },
    },
  },
];

// --- Helpers ---

export function resolveBaseUrl(configBaseUrl: unknown): string {
  if (typeof configBaseUrl === "string" && configBaseUrl.trim().length > 0) {
    return configBaseUrl.trim().replace(/\/+$/, "");
  }
  return DEFAULT_BASE_URL;
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function terminateCommandProcess(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 0) return;

  try {
    process.kill(pid, signal);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ESRCH") throw error;
  }

  if (process.platform === "win32") return;

  try {
    process.kill(-pid, signal);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ESRCH") throw error;
  }
}

function appendWithCap(current: string, chunk: string, maxChars: number): string {
  if (current.length >= maxChars) return current;
  const remaining = maxChars - current.length;
  if (chunk.length <= remaining) return current + chunk;
  return current + chunk.slice(0, remaining);
}

async function runBash(
  command: string,
  cwd: string,
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>,
): Promise<string> {
  await onLog("stdout", `[hybrid] bash $ ${command}\n`);
  return new Promise<string>((resolve) => {
    const child = spawn("bash", ["-lc", command], {
      cwd,
      detached: process.platform !== "win32",
      env: { ...process.env, TERM: "dumb" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = async (result: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const timeout = setTimeout(() => {
      if (typeof child.pid === "number") {
        terminateCommandProcess(child.pid, "SIGTERM");
        setTimeout(() => {
          if (child.exitCode == null && child.signalCode == null) {
            terminateCommandProcess(child.pid!, "SIGKILL");
          }
        }, BASH_KILL_GRACE_MS);
      }
    }, BASH_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout = appendWithCap(stdout, String(chunk), BASH_MAX_OUTPUT_CHARS);
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = appendWithCap(stderr, String(chunk), BASH_MAX_OUTPUT_CHARS);
    });

    child.on("error", async (error) => {
      const output = [stdout, stderr, error.message].filter(Boolean).join("\n").trim();
      await onLog("stderr", `[hybrid] bash error: ${output}\n`);
      await finish(`ERROR: ${output}`);
    });

    child.on("close", async (code, signal) => {
      const output = [stdout, stderr].filter(Boolean).join("\n").trim();
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        const message = output || `Command timed out after ${BASH_TIMEOUT_MS}ms`;
        await onLog("stderr", `[hybrid] bash error: ${message}\n`);
        await finish(`ERROR: ${message}`);
        return;
      }

      if ((code ?? 0) !== 0) {
        const message = output || `Command failed with exit code ${code}`;
        await onLog("stderr", `[hybrid] bash error: ${message}\n`);
        await finish(`ERROR: ${message}`);
        return;
      }

      if (output) await onLog("stdout", `${output}\n`);
      await finish(output || "(no output)");
    });
  });
}

function accumulateUsage(acc: UsageSummary, usage: ChatCompletionUsage | undefined): UsageSummary {
  return {
    inputTokens: acc.inputTokens + (usage?.prompt_tokens ?? 0),
    outputTokens: acc.outputTokens + (usage?.completion_tokens ?? 0),
    cachedInputTokens: acc.cachedInputTokens,
  };
}

// --- Main execution ---

export async function executeLocalModel(opts: {
  baseUrl: string;
  model: string;
  prompt: string;
  systemPrompt?: string;
  cwd: string;
  enableTools: boolean;
  timeoutMs: number;
  maxTotalTokens?: number;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}): Promise<OpenAICompatResult> {
  const { baseUrl, model, prompt, systemPrompt, cwd, enableTools, timeoutMs, onLog } = opts;
  const maxTotalTokens = asNumber(opts.maxTotalTokens, DEFAULT_MAX_TOTAL_TOKENS);
  const url = `${baseUrl}/chat/completions`;
  const deadline = Date.now() + timeoutMs;

  const messages: Message[] = [
    ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
    { role: "user" as const, content: prompt },
  ];
  let totalUsage: UsageSummary = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  let responseModel = model;
  let lastContent = "";
  let turn = 0;

  await onLog("stdout", `[hybrid] Local: POST ${url} model=${model}${enableTools ? " (tool-use)" : ""}\n`);

  // Single-shot mode: no tools, one request, return immediately
  if (!enableTools) {
    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          temperature: 0.1,
          keep_alive: 0,
        }),
      },
      timeoutMs,
    );
    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(`OpenAI-compatible endpoint returned ${response.status}: ${errorBody || response.statusText}`);
    }
    const body = (await response.json()) as ChatCompletionResponse;
    const content = body.choices?.[0]?.message?.content ?? "";
    const usage: UsageSummary = {
      inputTokens: body.usage?.prompt_tokens ?? 0,
      outputTokens: body.usage?.completion_tokens ?? 0,
      cachedInputTokens: 0,
    };
    await onLog("stdout", `[hybrid] Local: completed (${usage.inputTokens} in / ${usage.outputTokens} out)\n`);
    return { summary: content, model: body.model || model, usage, finishReason: body.choices?.[0]?.finish_reason ?? null };
  }

  while (turn < MAX_TOOL_TURNS) {
    // Guard: check token accumulation across all turns
    if (totalUsage.inputTokens + totalUsage.outputTokens >= maxTotalTokens) {
      await onLog("stderr", `[hybrid] Local: token limit reached (${totalUsage.inputTokens + totalUsage.outputTokens}/${maxTotalTokens})\n`);
      break;
    }

    // Guard: check message history size
    if (messages.length >= MAX_MESSAGE_HISTORY) {
      await onLog("stderr", "[hybrid] Local: message history too large, exiting\n");
      break;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      await onLog("stderr", "[hybrid] Local: timeout reached\n");
      break;
    }

    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          tools: AGENT_TOOLS,
          tool_choice: "auto",
          stream: false,
          temperature: 0.1,
          keep_alive: 0,
        }),
      },
      Math.min(remainingMs, BASH_TIMEOUT_MS + 30_000),
    );

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(`OpenAI-compatible endpoint returned ${response.status}: ${errorBody || response.statusText}`);
    }

    let body: ChatCompletionResponse;
    try {
      body = (await response.json()) as ChatCompletionResponse;
    } catch (err) {
      throw new Error(`Failed to parse endpoint response: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Guard: validate response structure
    if (!Array.isArray(body.choices) || body.choices.length === 0) {
      throw new Error("Invalid response: missing or empty choices array");
    }

    totalUsage = accumulateUsage(totalUsage, body.usage);
    responseModel = body.model || model;

    const choice = body.choices[0];
    const finishReason = choice?.finish_reason ?? null;
    const assistantMessage = choice?.message;
    const toolCalls = assistantMessage?.tool_calls;

    if (assistantMessage?.content) {
      lastContent = assistantMessage.content;
    }

    // No tool calls — model is done
    if (!toolCalls || toolCalls.length === 0 || finishReason === "stop") {
      await onLog(
        "stdout",
        `[hybrid] Local: completed (${totalUsage.inputTokens} in / ${totalUsage.outputTokens} out, ${turn} tool turn${turn === 1 ? "" : "s"})\n`,
      );
      return {
        summary: lastContent,
        model: responseModel,
        usage: totalUsage,
        finishReason,
      };
    }

    // Guard: limit tool calls per turn to prevent runaway execution
    const safeToolCalls = toolCalls.slice(0, MAX_TOOLS_PER_TURN);
    const truncatedToolCalls = toolCalls.slice(MAX_TOOLS_PER_TURN);

    // Append assistant message with only the tool calls we will actually
    // service. This keeps conversation state valid for strict providers.
    messages.push({
      role: "assistant",
      content: assistantMessage?.content ?? null,
      tool_calls: safeToolCalls,
    });

    if (toolCalls.length > MAX_TOOLS_PER_TURN) {
      await onLog("stdout", `[hybrid] Local: truncating ${toolCalls.length} tool calls to ${MAX_TOOLS_PER_TURN}\n`);
    }

    // Execute each tool call and collect results
    const toolResults: ToolResultMessage[] = [];
    for (const toolCall of safeToolCalls) {
      let result: string;
      if (toolCall.function.name === "bash") {
        // Guard: validate tool call has arguments
        if (!toolCall.function.arguments) {
          result = "ERROR: bash tool call missing arguments";
        } else {
          let args: { command?: string } = {};
          try {
            args = JSON.parse(toolCall.function.arguments) as { command?: string };
          } catch (err) {
            result = `ERROR: failed to parse bash arguments: ${err instanceof Error ? err.message : String(err)}`;
            toolResults.push({ role: "tool", tool_call_id: toolCall.id, content: result });
            continue;
          }

          const command = typeof args.command === "string" ? args.command : "";

          if (!command) {
            result = "ERROR: no command provided";
          } else if (isDangerousCommand(command)) {
            // Guard: block dangerous commands
            result = `ERROR: dangerous command blocked: ${command}`;
            await onLog("stderr", `[hybrid] Blocked dangerous command: ${command}\n`);
          } else {
            result = await runBash(command, cwd, onLog);
          }
        }
      } else {
        result = `ERROR: unknown tool "${toolCall.function.name}"`;
      }

      // Guard: truncate large outputs to prevent context window overflow
      const truncatedResult = result.length > MAX_TOOL_OUTPUT_CHARS
        ? result.slice(0, MAX_TOOL_OUTPUT_CHARS) + `\n[output truncated: ${result.length} chars total]`
        : result;

      toolResults.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: truncatedResult,
      });
    }

    // Guard: if we truncated tool calls, add synthetic results for the
    // skipped calls so tool_call_ids are always matched in history.
    if (truncatedToolCalls.length > 0) {
      for (const toolCall of truncatedToolCalls) {
        toolResults.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: `Tool call skipped: system limit of ${MAX_TOOLS_PER_TURN} tool calls per turn. Try fewer calls next turn.`,
        });
      }
    } else if (toolCalls.length > MAX_TOOLS_PER_TURN) {
      // Defensive fallback: should not happen because truncatedToolCalls
      // length is derived directly above.
      toolResults.push({
        role: "tool",
        tool_call_id: safeToolCalls[0]?.id ?? "unknown",
        content: `System: truncated to first ${MAX_TOOLS_PER_TURN} tools. Try fewer tool calls next turn.`,
      });
    }

    messages.push(...toolResults);
    turn++;
  }

  // Hit turn limit
  await onLog(
    "stdout",
    `[hybrid] Local: completed (${totalUsage.inputTokens} in / ${totalUsage.outputTokens} out, ${turn} tool turns, hit limit)\n`,
  );
  return {
    summary: lastContent,
    model: responseModel,
    usage: totalUsage,
    finishReason: "max_turns",
  };
}

export async function testOpenAICompatAvailability(baseUrl: string): Promise<{
  available: boolean;
  models: string[];
  error: string | null;
}> {
  try {
    const response = await fetchWithTimeout(
      `${baseUrl}/models`,
      { method: "GET" },
      5000,
    );

    if (!response.ok) {
      return {
        available: false,
        models: [],
        error: `OpenAI-compatible endpoint returned ${response.status}`,
      };
    }

    const body = (await response.json()) as OpenAICompatModelsResponse;
    const modelIds = (body.data ?? []).map((m) => m.id);

    return {
      available: true,
      models: modelIds,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      available: false,
      models: [],
      error: message.includes("ECONNREFUSED")
        ? `OpenAI-compatible endpoint not running at ${baseUrl}`
        : `OpenAI-compatible endpoint check failed: ${message}`,
    };
  }
}

export async function listOpenAICompatModels(baseUrl: string): Promise<Array<{ id: string; label: string }>> {
  const result = await testOpenAICompatAvailability(baseUrl);
  if (!result.available) return [];
  return result.models.map((id) => ({ id, label: `${id} (Local)` }));
}
