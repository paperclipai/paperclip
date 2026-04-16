import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { buildPaperclipEnv } from "@paperclipai/adapter-utils/server-utils";

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

// ---------------------------------------------------------------------------
// Ollama API types
// ---------------------------------------------------------------------------

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
}

interface OllamaToolCall {
  id?: string;
  type?: "function";
  function: {
    name: string;
    arguments: string | Record<string, unknown>;
  };
}

interface OllamaChatResponse {
  message: OllamaMessage;
  done: boolean;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

// ---------------------------------------------------------------------------
// Ollama tool definitions
// ---------------------------------------------------------------------------

const PAPERCLIP_TOOLS = [
  {
    type: "function",
    function: {
      name: "call_paperclip_api",
      description:
        "Make a Paperclip REST API call. Use this for all Paperclip operations: reading issues, posting comments, updating status, checking inbox, etc.",
      parameters: {
        type: "object",
        properties: {
          method: {
            type: "string",
            enum: ["GET", "POST", "PATCH", "PUT", "DELETE"],
            description: "HTTP method",
          },
          path: {
            type: "string",
            description:
              "API path starting with /api, e.g. /api/agents/me or /api/issues/{issueId}/comments",
          },
          body: {
            type: "object",
            description: "Request body for POST/PATCH/PUT requests (omit for GET/DELETE)",
          },
        },
        required: ["method", "path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description:
        "End this heartbeat session. Call this when you have completed all work or determined there is nothing to do.",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "Brief summary of what was done or why you are finishing",
          },
        },
        required: ["summary"],
      },
    },
  },
];

const CODING_TOOLS = [
  {
    type: "function",
    function: {
      name: "bash_exec",
      description:
        "Run a shell command. Use for git operations, running tests, installing dependencies, building projects, and any other shell tasks. Commands run in the configured working directory by default.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to run",
          },
          cwd: {
            type: "string",
            description: "Working directory for the command (optional, defaults to agent cwd)",
          },
          timeout_sec: {
            type: "number",
            description: "Timeout in seconds (optional, default 120)",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_read",
      description:
        "Read the contents of a file. Returns the file content as a string. Large files are truncated to 50000 characters.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute or relative file path to read",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_write",
      description:
        "Write content to a file, creating it and any parent directories as needed. Overwrites existing files.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute or relative file path to write",
          },
          content: {
            type: "string",
            description: "Content to write to the file",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_list",
      description:
        "List files and directories at a given path. Returns names with type indicators (file/dir).",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory path to list",
          },
        },
        required: ["path"],
      },
    },
  },
];

function buildTools(codingMode: boolean) {
  return codingMode ? [...PAPERCLIP_TOOLS, ...CODING_TOOLS] : PAPERCLIP_TOOLS;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(
  agentId: string,
  companyId: string,
  runId: string,
  apiUrl: string,
  extra: string,
  codingMode: boolean,
  defaultCwd: string,
): string {
  const codingSection = codingMode
    ? `
## Coding Tools
You have access to coding tools for file system operations and shell commands:
- **bash_exec**: Run shell commands (git, npm/pnpm/composer, tests, build, etc.)
- **file_read**: Read file contents
- **file_write**: Write/create files (directories are auto-created)
- **file_list**: List directory contents

Default working directory: ${defaultCwd}

When working on coding tasks:
1. Read the task to understand what repository and changes are needed
2. Navigate to the correct git worktree / working directory
3. Make your code changes using file_read and file_write
4. Run tests or builds with bash_exec if needed
5. Stage and commit changes with git commands (include "Co-Authored-By: Paperclip <noreply@paperclip.ing>" in commit messages)
6. Update the Paperclip issue with your results
`
    : "";

  return `You are an AI agent running inside Paperclip, an agentic work management platform.

## Your Identity
- Agent ID: ${agentId}
- Company ID: ${companyId}
- Current Run ID: ${runId}
- Paperclip API URL: ${apiUrl}

## Your Job
You wake up periodically (heartbeats) to check if there is work assigned to you and act on it.
Each heartbeat, you should:
1. Check your inbox: GET /api/agents/me/inbox-lite
2. If there is work (todo/in_progress/blocked issues), pick the highest priority task
3. Checkout the task: POST /api/issues/{issueId}/checkout with {"agentId": "${agentId}", "expectedStatuses": ["todo", "backlog", "blocked"]}
4. Read the task context: GET /api/issues/{issueId}/heartbeat-context
5. Do the work (read comments, post updates, change status, create subtasks, etc.)
6. Update the issue status and leave a comment explaining what you did
7. Call finish() when done

## Critical Rules
- ALWAYS checkout before working on a task
- NEVER retry a 409 conflict — it means someone else owns the task
- ALWAYS include "X-Paperclip-Run-Id: ${runId}" header on all mutating API calls (checkout, PATCH, POST comments)
- If a task is complex and needs a more capable AI model, leave a comment explaining what needs to be done and set status to blocked, or @-mention the appropriate agent
- If your inbox is empty, call finish() immediately
- Be concise and action-oriented. Don't overthink simple tasks.
${codingSection}
## API Notes
- All requests need: Authorization: Bearer <your-auth-token> (auto-injected)
- Mutating requests need: X-Paperclip-Run-Id: ${runId}
- Status values: backlog, todo, in_progress, in_review, done, blocked, cancelled
- Priority values: critical, high, medium, low
${extra ? `\n## Additional Instructions\n${extra}` : ""}`;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function callOllamaChat(
  baseUrl: string,
  model: string,
  messages: OllamaMessage[],
  tools: object[],
  timeoutMs: number,
): Promise<OllamaChatResponse> {
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        tools,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Ollama /api/chat returned ${res.status}: ${body}`);
    }

    return (await res.json()) as OllamaChatResponse;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function callPaperclipApi(
  apiUrl: string,
  authToken: string,
  runId: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: unknown }> {
  const isGet = method === "GET" || method === "DELETE";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${authToken}`,
  };
  if (!isGet) {
    headers["x-paperclip-run-id"] = runId;
  }

  const url = `${apiUrl}${path}`;
  const res = await fetch(url, {
    method,
    headers,
    body: !isGet && body ? JSON.stringify(body) : undefined,
  });

  let data: unknown;
  try {
    const text = await res.text();
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  return { status: res.status, data };
}

// ---------------------------------------------------------------------------
// Coding tool handlers
// ---------------------------------------------------------------------------

function handleBashExec(args: Record<string, unknown>, defaultCwd: string): string {
  const command = typeof args.command === "string" ? args.command : "";
  if (!command) return JSON.stringify({ error: "command is required" });

  const cwd =
    typeof args.cwd === "string" && args.cwd.trim() ? args.cwd.trim() : defaultCwd;
  const timeoutSec = typeof args.timeout_sec === "number" ? args.timeout_sec : 120;

  try {
    const output = execSync(command, {
      cwd,
      timeout: timeoutSec * 1000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return JSON.stringify({ stdout: output, stderr: "", exitCode: 0 });
  } catch (err) {
    const execErr = err as {
      stdout?: string;
      stderr?: string;
      status?: number;
      message?: string;
    };
    return JSON.stringify({
      stdout: execErr.stdout ?? "",
      stderr: execErr.stderr ?? execErr.message ?? String(err),
      exitCode: execErr.status ?? 1,
    });
  }
}

function handleFileRead(args: Record<string, unknown>): string {
  const path = typeof args.path === "string" ? args.path : "";
  if (!path) return JSON.stringify({ error: "path is required" });

  try {
    const content = readFileSync(path, "utf8");
    const MAX = 50_000;
    const truncated = content.length > MAX;
    return JSON.stringify({
      content: truncated ? content.slice(0, MAX) + "\n...[truncated]" : content,
      truncated,
      size: content.length,
    });
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
}

function handleFileWrite(args: Record<string, unknown>): string {
  const path = typeof args.path === "string" ? args.path : "";
  const content = typeof args.content === "string" ? args.content : "";
  if (!path) return JSON.stringify({ error: "path is required" });

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
    return JSON.stringify({ ok: true, path, bytesWritten: Buffer.byteLength(content, "utf8") });
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
}

function handleFileList(args: Record<string, unknown>): string {
  const path = typeof args.path === "string" ? args.path : "";
  if (!path) return JSON.stringify({ error: "path is required" });

  try {
    const entries = readdirSync(path).map((name) => {
      try {
        const stat = statSync(`${path}/${name}`);
        return { name, type: stat.isDirectory() ? "dir" : "file", size: stat.size };
      } catch {
        return { name, type: "unknown" };
      }
    });
    return JSON.stringify({ path, entries });
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
}

// ---------------------------------------------------------------------------
// Main execute
// ---------------------------------------------------------------------------

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, authToken } = ctx;

  const baseUrl = asString(config.baseUrl, "").replace(/\/$/, "");
  if (!baseUrl) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "ollama_local adapter requires baseUrl in adapterConfig",
    };
  }

  const model = asString(config.model, "");
  if (!model) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "ollama_local adapter requires model in adapterConfig",
    };
  }

  const maxTurns = asNumber(config.maxTurns, 20);
  const timeoutSec = asNumber(config.timeoutSec, 60);
  const timeoutMs = timeoutSec * 1000;
  const systemPromptExtra = asString(config.systemPromptExtra, "");
  const codingMode = asBoolean(config.codingMode, false);
  const defaultCwd = asString(config.cwd, process.cwd());

  // Resolve the Paperclip API URL and auth token
  const paperclipEnv = buildPaperclipEnv(agent);
  const apiUrl = paperclipEnv.PAPERCLIP_API_URL;
  const token = authToken ?? "";

  if (!token) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "ollama_local adapter: no auth token available",
    };
  }

  const tools = buildTools(codingMode);

  await onLog(
    "stderr",
    `[ollama] Starting heartbeat: model=${model} baseUrl=${baseUrl} maxTurns=${maxTurns} codingMode=${codingMode}\n`,
  );

  // Build the initial context message from wake context
  const taskId =
    (typeof context.taskId === "string" && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim()
      ? context.wakeReason.trim()
      : "timer";
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim()) ||
    null;

  let userMessage = `You have been woken up. Wake reason: ${wakeReason}.`;
  if (taskId) userMessage += ` Task ID: ${taskId}.`;
  if (wakeCommentId) userMessage += ` Wake comment ID: ${wakeCommentId}.`;
  userMessage +=
    "\n\nStart by checking your inbox with GET /api/agents/me/inbox-lite and proceed from there.";

  const systemPrompt = buildSystemPrompt(
    agent.id,
    agent.companyId,
    runId,
    apiUrl,
    systemPromptExtra,
    codingMode,
    defaultCwd,
  );

  const messages: OllamaMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let finishSummary = "";
  let timedOut = false;

  while (turns < maxTurns) {
    turns++;
    await onLog("stderr", `[ollama] Turn ${turns}/${maxTurns}\n`);

    let response: OllamaChatResponse;
    try {
      response = await callOllamaChat(baseUrl, model, messages, tools, timeoutMs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("AbortError") || msg.toLowerCase().includes("abort")) {
        timedOut = true;
        await onLog("stderr", `[ollama] Request timed out after ${timeoutSec}s\n`);
      } else {
        await onLog("stderr", `[ollama] Ollama API error: ${msg}\n`);
      }
      break;
    }

    inputTokens += response.prompt_eval_count ?? 0;
    outputTokens += response.eval_count ?? 0;

    const assistantMessage = response.message;
    messages.push(assistantMessage);

    // Log assistant text if any
    if (assistantMessage.content && assistantMessage.content.trim()) {
      await onLog("stdout", `${assistantMessage.content}\n`);
    }

    // Check for tool calls
    const toolCalls = assistantMessage.tool_calls ?? [];
    if (toolCalls.length === 0) {
      // No tool calls — model responded with text only, treat as done
      await onLog("stderr", "[ollama] No tool calls in response, finishing\n");
      finishSummary = assistantMessage.content?.trim() || "Heartbeat complete";
      break;
    }

    // Execute each tool call and collect results
    for (const toolCall of toolCalls) {
      const fnName = toolCall.function.name;
      let args: Record<string, unknown>;
      try {
        args =
          typeof toolCall.function.arguments === "string"
            ? (JSON.parse(toolCall.function.arguments) as Record<string, unknown>)
            : (toolCall.function.arguments as Record<string, unknown>);
      } catch {
        args = {};
      }

      if (fnName === "finish") {
        finishSummary = typeof args.summary === "string" ? args.summary : "Done";
        await onLog("stdout", `[finish] ${finishSummary}\n`);
        messages.push({
          role: "tool",
          content: JSON.stringify({ ok: true }),
        });
        turns = maxTurns; // signal exit
        break;
      }

      if (fnName === "call_paperclip_api") {
        const method = typeof args.method === "string" ? args.method.toUpperCase() : "GET";
        const path = typeof args.path === "string" ? args.path : "";
        const body =
          args.body && typeof args.body === "object"
            ? (args.body as Record<string, unknown>)
            : undefined;

        await onLog("stderr", `[ollama] API call: ${method} ${path}\n`);

        let toolResult: string;
        try {
          const result = await callPaperclipApi(apiUrl, token, runId, method, path, body);
          await onLog("stderr", `[ollama] API response: ${result.status}\n`);
          toolResult = JSON.stringify({ status: result.status, data: result.data });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await onLog("stderr", `[ollama] API error: ${msg}\n`);
          toolResult = JSON.stringify({ error: msg });
        }

        messages.push({
          role: "tool",
          content: toolResult,
        });
      } else if (fnName === "bash_exec" && codingMode) {
        await onLog("stderr", `[ollama] bash_exec: ${String(args.command).slice(0, 120)}\n`);
        messages.push({ role: "tool", content: handleBashExec(args, defaultCwd) });
      } else if (fnName === "file_read" && codingMode) {
        await onLog("stderr", `[ollama] file_read: ${args.path}\n`);
        messages.push({ role: "tool", content: handleFileRead(args) });
      } else if (fnName === "file_write" && codingMode) {
        await onLog("stderr", `[ollama] file_write: ${args.path}\n`);
        messages.push({ role: "tool", content: handleFileWrite(args) });
      } else if (fnName === "file_list" && codingMode) {
        await onLog("stderr", `[ollama] file_list: ${args.path}\n`);
        messages.push({ role: "tool", content: handleFileList(args) });
      } else {
        // Unknown tool — return an error result
        await onLog("stderr", `[ollama] Unknown tool: ${fnName}\n`);
        messages.push({
          role: "tool",
          content: JSON.stringify({ error: `Unknown tool: ${fnName}` }),
        });
      }
    }
  }

  if (turns >= maxTurns && !finishSummary) {
    await onLog("stderr", `[ollama] Reached max turns (${maxTurns})\n`);
    finishSummary = `Reached maximum turns (${maxTurns})`;
  }

  await onLog("stderr", `[ollama] Heartbeat complete. Summary: ${finishSummary}\n`);

  return {
    exitCode: 0,
    signal: null,
    timedOut,
    summary: finishSummary || undefined,
    provider: "ollama",
    biller: "ollama",
    model,
    billingType: "fixed",
    costUsd: 0,
    ...(inputTokens > 0 || outputTokens > 0
      ? { usage: { inputTokens, outputTokens } }
      : {}),
  };
}
