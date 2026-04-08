/**
 * Ollama Agent Adapter for Paperclip
 *
 * Calls Ollama in a tool-call loop so the model can:
 *   - list / checkout / complete Paperclip tasks
 *   - post comments
 *   - read/write local files
 *
 * Works with any Ollama model that supports tool calling:
 * qwen3, qwen3.5, llama3.3, mistral-nemo, etc.
 */
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import { promises as fs } from "node:fs";
import path from "node:path";

// ── Constants ─────────────────────────────────────────────────────────────────

const ADAPTER_TYPE = "ollama_agent";
const DEFAULT_BASE_URL = "http://10.0.0.185:11434";
const DEFAULT_MODEL = "qwen3.5:35B";
const DEFAULT_TIMEOUT_SEC = 600;
const MAX_TOOL_ITERATIONS = 20;

// ── Types ─────────────────────────────────────────────────────────────────────

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  name?: string;
}

interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  };
}

interface OllamaChatResponse {
  model: string;
  message: OllamaMessage;
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface ToolDeps {
  paperclipApiUrl: string;
  agentId: string;
  companyId: string;
  runId: string;
  taskId?: string;
  authToken?: string;
}

// ── Config helpers ────────────────────────────────────────────────────────────

function cfgStr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function cfgNum(v: unknown, def: number): number {
  return typeof v === "number" ? v : def;
}
function cfgBool(v: unknown, def: boolean): boolean {
  return typeof v === "boolean" ? v : def;
}
function cfgObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function apiGet(url: string, authToken?: string): Promise<unknown> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
  });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}

async function apiPost(
  url: string,
  body: Record<string, unknown>,
  runId: string,
  authToken?: string,
): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: {
      "Content-Type": "application/json",
      "X-Paperclip-Run-Id": runId,
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${url} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function apiPatch(
  url: string,
  body: Record<string, unknown>,
  runId: string,
  authToken?: string,
): Promise<unknown> {
  const res = await fetch(url, {
    method: "PATCH",
    signal: AbortSignal.timeout(15_000),
    headers: {
      "Content-Type": "application/json",
      "X-Paperclip-Run-Id": runId,
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${url} → ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Tool registry ─────────────────────────────────────────────────────────────

const TOOL_SCHEMAS: OllamaTool[] = [
  {
    type: "function",
    function: {
      name: "paperclip_list_tasks",
      description: "List Paperclip issues assigned to this agent.",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            description: "'todo', 'backlog', 'in_progress', or 'all'. Default: todo.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "paperclip_get_task",
      description: "Get full details of a Paperclip issue (description, comments, context).",
      parameters: {
        type: "object",
        properties: { taskId: { type: "string", description: "Issue ID (UUID)." } },
        required: ["taskId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "paperclip_checkout_task",
      description: "Claim a task (moves it to in_progress). Call before starting work.",
      parameters: {
        type: "object",
        properties: { taskId: { type: "string" } },
        required: ["taskId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "paperclip_complete_task",
      description: "Mark a task as done and post a completion comment.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          summary: { type: "string", description: "Brief summary of what was done." },
        },
        required: ["taskId", "summary"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "paperclip_post_comment",
      description: "Post a comment on a Paperclip issue without changing its status.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          comment: { type: "string", description: "Comment text (Markdown supported)." },
        },
        required: ["taskId", "comment"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a local file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute or relative file path." } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a local file (creates parent directories if needed).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List files and directories at a given path.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
];

async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  deps: ToolDeps,
): Promise<string> {
  try {
    switch (name) {
      case "paperclip_list_tasks": {
        const status = cfgStr(args.status) ?? "todo";
        const url =
          status === "all"
            ? `${deps.paperclipApiUrl}/companies/${deps.companyId}/issues?assigneeAgentId=${deps.agentId}`
            : `${deps.paperclipApiUrl}/companies/${deps.companyId}/issues?assigneeAgentId=${deps.agentId}&status=${status}`;
        const issues = (await apiGet(url, deps.authToken)) as Array<Record<string, unknown>>;
        if (!issues.length) return "No tasks found.";
        return JSON.stringify(
          issues.map((i) => ({ id: i.id, identifier: i.identifier, title: i.title, status: i.status })),
          null,
          2,
        );
      }
      case "paperclip_get_task": {
        const data = await apiGet(
          `${deps.paperclipApiUrl}/issues/${args.taskId as string}/heartbeat-context`,
          deps.authToken,
        );
        return JSON.stringify(data, null, 2);
      }
      case "paperclip_checkout_task": {
        await apiPost(
          `${deps.paperclipApiUrl}/issues/${args.taskId as string}/checkout`,
          { agentId: deps.agentId, expectedStatuses: ["todo", "in_progress", "blocked", "backlog"] },
          deps.runId,
          deps.authToken,
        );
        return `Task ${args.taskId as string} checked out.`;
      }
      case "paperclip_complete_task": {
        await apiPatch(
          `${deps.paperclipApiUrl}/issues/${args.taskId as string}`,
          { status: "done", comment: args.summary as string },
          deps.runId,
          deps.authToken,
        );
        return `Task ${args.taskId as string} marked as done.`;
      }
      case "paperclip_post_comment": {
        await apiPost(
          `${deps.paperclipApiUrl}/issues/${args.taskId as string}/comments`,
          { body: args.comment as string, authorAgentId: deps.agentId },
          deps.runId,
          deps.authToken,
        );
        return `Comment posted on ${args.taskId as string}.`;
      }
      case "read_file": {
        const content = await fs.readFile(args.path as string, "utf-8");
        return content;
      }
      case "write_file": {
        await fs.mkdir(path.dirname(args.path as string), { recursive: true });
        await fs.writeFile(args.path as string, args.content as string, "utf-8");
        return `Written: ${args.path as string}`;
      }
      case "list_directory": {
        const entries = await fs.readdir(args.path as string, { withFileTypes: true });
        return entries.map((e) => `${e.isDirectory() ? "d" : "f"} ${e.name}`).join("\n");
      }
      default:
        return `Error: unknown tool "${name}"`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ __toolError: true, tool: name, message: msg });
  }
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildPrompt(ctx: AdapterExecutionContext, paperclipApiUrl: string): string {
  const taskId = cfgStr(ctx.config?.taskId) ?? cfgStr((ctx.context as Record<string, unknown>)?.taskId as unknown);
  const taskTitle = cfgStr(ctx.config?.taskTitle) ?? "";
  const taskBody = cfgStr(ctx.config?.taskBody) ?? "";

  if (taskId) {
    return `You are "${ctx.agent.name || "Ollama Agent"}", an AI agent in a Paperclip-managed company.

Your identity:
  Agent ID:   ${ctx.agent.id}
  Company ID: ${ctx.agent.companyId}
  API Base:   ${paperclipApiUrl}

## Assigned Task

Issue ID: ${taskId}
Title:    ${taskTitle}
${taskBody ? `\n${taskBody}\n` : ""}
## Workflow

1. Use \`paperclip_get_task\` to read full issue details.
2. Check out the task with \`paperclip_checkout_task\`.
3. Do the work. Use \`read_file\` / \`write_file\` if you need to read or produce files.
4. When done, call \`paperclip_complete_task\` with a summary of what you did.`;
  }

  return `You are "${ctx.agent.name || "Ollama Agent"}", an AI agent in a Paperclip-managed company.

Your identity:
  Agent ID:   ${ctx.agent.id}
  Company ID: ${ctx.agent.companyId}
  API Base:   ${paperclipApiUrl}

## Heartbeat — Check for Work

1. Call \`paperclip_list_tasks\` to list issues assigned to you.
2. Pick the highest-priority one and check it out with \`paperclip_checkout_task\`.
3. Read its details with \`paperclip_get_task\` and work on it.
4. Call \`paperclip_complete_task\` with a summary when done.
5. If there is nothing to do, say so briefly.`;
}

// ── Ollama chat call ──────────────────────────────────────────────────────────

async function ollamaChat(
  baseUrl: string,
  model: string,
  messages: OllamaMessage[],
  tools: OllamaTool[],
  extraOptions: Record<string, unknown>,
  timeoutMs: number,
): Promise<OllamaChatResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        stream: false,
        ...(Object.keys(extraOptions).length > 0 ? { options: extraOptions } : {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Ollama → HTTP ${res.status}: ${body}`);
    }
    return (await res.json()) as OllamaChatResponse;
  } finally {
    clearTimeout(timer);
  }
}

// ── Main adapter ──────────────────────────────────────────────────────────────

export const ollamaAdapter: ServerAdapterModule = {
  type: ADAPTER_TYPE,

  async execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
    const c = cfgObj(ctx.agent.adapterConfig);

    let paperclipApiUrl = cfgStr(c.paperclipApiUrl) ?? process.env.PAPERCLIP_API_URL ?? "http://127.0.0.1:3100/api";
    if (!paperclipApiUrl.endsWith("/api")) {
      paperclipApiUrl = paperclipApiUrl.replace(/\/+$/, "") + "/api";
    }

    const baseUrl = cfgStr(c.baseUrl) ?? DEFAULT_BASE_URL;
    const model = cfgStr(c.model) ?? DEFAULT_MODEL;
    const timeoutSec = cfgNum(c.timeoutSec, DEFAULT_TIMEOUT_SEC);
    const useTools = cfgBool(c.useTools, true);
    const extraOptions = cfgObj(c.options);

    await ctx.onLog("stdout", `[ollama] model=${model} base=${baseUrl} timeout=${timeoutSec}s tools=${useTools}\n`);

    const prompt = buildPrompt(ctx, paperclipApiUrl);
    const messages: OllamaMessage[] = [{ role: "user", content: prompt }];

    const toolDeps: ToolDeps = {
      paperclipApiUrl,
      agentId: ctx.agent.id,
      companyId: ctx.agent.companyId,
      runId: ctx.runId,
      taskId: cfgStr(ctx.config?.taskId) ?? cfgStr((ctx.context as Record<string, unknown>)?.taskId as unknown),
      authToken: ctx.authToken,
    };

    let totalInput = 0;
    let totalOutput = 0;
    let finalText = "";
    let iterations = 0;

    while (iterations < MAX_TOOL_ITERATIONS) {
      iterations++;
      await ctx.onLog("stdout", `[ollama] turn ${iterations}...\n`);

      let resp: OllamaChatResponse;
      try {
        resp = await ollamaChat(
          baseUrl,
          model,
          messages,
          useTools ? TOOL_SCHEMAS : [],
          extraOptions,
          timeoutSec * 1000,
        );
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return {
            exitCode: null, signal: null, timedOut: true,
            errorMessage: `Timed out after ${timeoutSec}s`, errorCode: "timeout",
            usage: { inputTokens: totalInput, outputTokens: totalOutput },
          };
        }
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.onLog("stderr", `[ollama] error: ${msg}\n`);
        return {
          exitCode: 1, signal: null, timedOut: false,
          errorMessage: msg, errorCode: "request_failed",
          usage: { inputTokens: totalInput, outputTokens: totalOutput },
        };
      }

      totalInput += resp.prompt_eval_count ?? 0;
      totalOutput += resp.eval_count ?? 0;

      const assistantMsg = resp.message;
      messages.push(assistantMsg);

      if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
        await ctx.onLog("stdout", `[ollama] ${assistantMsg.tool_calls.length} tool call(s)\n`);
        for (const call of assistantMsg.tool_calls) {
          const name = call.function.name;
          const args = call.function.arguments ?? {};
          await ctx.onLog("stdout", `[ollama]  → ${name}(${JSON.stringify(args).slice(0, 120)})\n`);
          const result = await dispatchTool(name, args, toolDeps);
          await ctx.onLog("stdout", `[ollama]  ← ${result.slice(0, 200)}\n`);
          messages.push({ role: "tool", name, content: result });
        }
        continue;
      }

      finalText = assistantMsg.content ?? "";
      await ctx.onLog("stdout", `[ollama] done after ${iterations} turn(s)\n`);
      break;
    }

    if (iterations >= MAX_TOOL_ITERATIONS) {
      await ctx.onLog("stderr", `[ollama] hit max iterations (${MAX_TOOL_ITERATIONS})\n`);
    }

    return {
      exitCode: 0, signal: null, timedOut: false,
      provider: "ollama", model,
      usage: { inputTokens: totalInput, outputTokens: totalOutput },
      summary: finalText.slice(0, 2000),
      resultJson: { response: finalText, iterations },
    };
  },

  async testEnvironment(ctx) {
    const c = cfgObj(ctx.config);
    const baseUrl = cfgStr(c.baseUrl) ?? DEFAULT_BASE_URL;
    const model = cfgStr(c.model) ?? DEFAULT_MODEL;
    const checks: Array<{ code: string; level: "info" | "warn" | "error"; message: string; hint?: string }> = [];

    try {
      const res = await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) {
        const json = (await res.json()) as { version?: string };
        checks.push({ code: "ollama_reachable", level: "info", message: `Ollama reachable at ${baseUrl} (v${json.version ?? "?"})` });
      } else {
        checks.push({ code: "ollama_http_error", level: "warn", message: `Ollama returned HTTP ${res.status}`, hint: `Is Ollama running at ${baseUrl}?` });
      }
    } catch {
      checks.push({ code: "ollama_unreachable", level: "error", message: `Cannot reach Ollama at ${baseUrl}`, hint: "Run: ollama serve" });
      return { adapterType: ADAPTER_TYPE, status: "fail", checks, testedAt: new Date().toISOString() };
    }

    try {
      const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) {
        const json = (await res.json()) as { models: Array<{ name: string }> };
        const found = json.models.some((m) => m.name === model || m.name.startsWith(`${model}:`));
        if (found) {
          checks.push({ code: "model_available", level: "info", message: `Model "${model}" is available` });
        } else {
          const avail = json.models.slice(0, 5).map((m) => m.name).join(", ");
          checks.push({ code: "model_missing", level: "warn", message: `Model "${model}" not found`, hint: `ollama pull ${model} — available: ${avail}` });
        }
      }
    } catch {
      checks.push({ code: "model_list_failed", level: "warn", message: "Could not list Ollama models" });
    }

    const hasErrors = checks.some((c) => c.level === "error");
    const hasWarnings = checks.some((c) => c.level === "warn");
    return { adapterType: ADAPTER_TYPE, status: hasErrors ? "fail" : hasWarnings ? "warn" : "pass", checks, testedAt: new Date().toISOString() };
  },

  models: [
    { id: "qwen3.5:122B", label: "Qwen 3.5 122B (best quality)" },
    { id: "qwen3.5:35B", label: "Qwen 3.5 35B (recommended)" },
    { id: "qwen3:32b", label: "Qwen 3 32B" },
    { id: "llama3.3:70b", label: "Llama 3.3 70B" },
    { id: "mistral-nemo", label: "Mistral Nemo" },
    { id: "deepseek-r1:70b", label: "DeepSeek R1 70B" },
  ],

  agentConfigurationDoc: `# Ollama Agent Adapter

Adapter type: \`ollama_agent\`

Connects any Ollama-hosted model to Paperclip via a tool-call loop.
The model can list/checkout/complete tasks and read/write local files — no external API keys required.

## Prerequisites
- Ollama running: \`ollama serve\`
- Tool-capable model pulled: \`ollama pull qwen3.5:35B\`

## Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| baseUrl | string | http://10.0.0.185:11434 | Ollama base URL |
| model | string | qwen3.5:35B | Model name (must be pulled) |
| timeoutSec | number | 600 | Total timeout in seconds |
| useTools | boolean | true | Enable tool-call loop |
| paperclipApiUrl | string | http://127.0.0.1:3100/api | Paperclip API URL |
| options | object | {} | Extra Ollama options (temperature, num_ctx, etc.) |

## Available Tools
- \`paperclip_list_tasks\` / \`paperclip_get_task\` / \`paperclip_checkout_task\`
- \`paperclip_complete_task\` / \`paperclip_post_comment\`
- \`read_file\` / \`write_file\` / \`list_directory\`
`,
};
