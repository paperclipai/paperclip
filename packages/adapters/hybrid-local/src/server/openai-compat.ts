import type { UsageSummary } from "@paperclipai/adapter-utils";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1";
const MAX_TOOL_TURNS = 30;
const BASH_TIMEOUT_MS = 120_000;

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

async function runBash(
  command: string,
  cwd: string,
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>,
): Promise<string> {
  await onLog("stdout", `[hybrid] bash $ ${command}\n`);
  try {
    const { stdout, stderr } = await execFileAsync("bash", ["-c", command], {
      cwd,
      timeout: BASH_TIMEOUT_MS,
      maxBuffer: 1024 * 1024, // 1MB
      env: { ...process.env, TERM: "dumb" },
    });
    const output = [stdout, stderr].filter(Boolean).join("\n").trim();
    if (output) await onLog("stdout", `${output}\n`);
    return output || "(no output)";
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string; message?: string };
    const output = [error.stdout, error.stderr, error.message].filter(Boolean).join("\n").trim();
    await onLog("stderr", `[hybrid] bash error: ${output}\n`);
    return `ERROR: ${output}`;
  }
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
  cwd: string;
  enableTools: boolean;
  timeoutMs: number;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}): Promise<OpenAICompatResult> {
  const { baseUrl, model, prompt, cwd, enableTools, timeoutMs, onLog } = opts;
  const url = `${baseUrl}/chat/completions`;
  const deadline = Date.now() + timeoutMs;

  const messages: Message[] = [{ role: "user", content: prompt }];
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

    const body = (await response.json()) as ChatCompletionResponse;
    totalUsage = accumulateUsage(totalUsage, body.usage);
    responseModel = body.model || model;

    const choice = body.choices?.[0];
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

    // Append assistant message with tool calls
    messages.push({
      role: "assistant",
      content: assistantMessage?.content ?? null,
      tool_calls: toolCalls,
    });

    // Execute each tool call and collect results
    const toolResults: ToolResultMessage[] = [];
    for (const toolCall of toolCalls) {
      let result: string;
      if (toolCall.function.name === "bash") {
        let args: { command?: string } = {};
        try {
          args = JSON.parse(toolCall.function.arguments) as { command?: string };
        } catch {
          args = {};
        }
        const command = typeof args.command === "string" ? args.command : "";
        result = command ? await runBash(command, cwd, onLog) : "ERROR: no command provided";
      } else {
        result = `ERROR: unknown tool "${toolCall.function.name}"`;
      }

      toolResults.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
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
