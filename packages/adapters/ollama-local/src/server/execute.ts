import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  parseObject,
  buildPaperclipEnv,
  joinPromptSections,
  renderTemplate,
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
  ensureAbsoluteDirectory,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_OLLAMA_LOCAL_MODEL } from "../index.js";

const execAsync = promisify(exec);

const MAX_ITERATIONS = 30;
const TOOL_BASH_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Ollama API types
// ---------------------------------------------------------------------------

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
}

interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface OllamaStreamChunk {
  model: string;
  created_at: string;
  message?: OllamaMessage;
  done: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
}

interface OllamaUsage {
  inputTokens: number;
  outputTokens: number;
}

// ---------------------------------------------------------------------------
// Tool definitions (sent to Ollama in the request)
// ---------------------------------------------------------------------------

const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file at the given path.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or cwd-relative path to the file." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file at the given path, creating parent directories as needed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or cwd-relative path to the file." },
          content: { type: "string", description: "Content to write." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_bash",
      description: "Execute a bash command in the working directory. Returns stdout and stderr.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Bash command to execute." },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List files and directories at the given path.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or cwd-relative path to the directory." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "paperclip_get_context",
      description: "Get the current Paperclip execution context (agent id, run id, task id, etc.).",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// HTTP helper — stream Ollama /api/chat response
// ---------------------------------------------------------------------------

async function ollamaChatStream(
  baseUrl: string,
  payload: Record<string, unknown>,
): Promise<{ text: string; toolCalls: OllamaToolCall[]; usage: OllamaUsage; done: boolean; doneReason: string }> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/chat`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ollama /api/chat returned ${res.status}: ${body.slice(0, 400)}`);
  }

  if (!res.body) {
    throw new Error("Ollama /api/chat returned no response body");
  }

  let text = "";
  const toolCalls: OllamaToolCall[] = [];
  const usage: OllamaUsage = { inputTokens: 0, outputTokens: 0 };
  let doneReason = "stop";

  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: OllamaStreamChunk;
      try {
        parsed = JSON.parse(trimmed) as OllamaStreamChunk;
      } catch {
        continue;
      }

      if (parsed.message) {
        if (parsed.message.content) {
          text += parsed.message.content;
        }
        if (parsed.message.tool_calls) {
          toolCalls.push(...parsed.message.tool_calls);
        }
      }

      if (parsed.done) {
        if (parsed.prompt_eval_count !== undefined) {
          usage.inputTokens += parsed.prompt_eval_count;
        }
        if (parsed.eval_count !== undefined) {
          usage.outputTokens += parsed.eval_count;
        }
        if (parsed.done_reason) {
          doneReason = parsed.done_reason;
        }
      }
    }
  }

  // Drain remaining buffer
  if (buffer.trim()) {
    try {
      const parsed = JSON.parse(buffer.trim()) as OllamaStreamChunk;
      if (parsed.done) {
        if (parsed.prompt_eval_count !== undefined) {
          usage.inputTokens += parsed.prompt_eval_count;
        }
        if (parsed.eval_count !== undefined) {
          usage.outputTokens += parsed.eval_count;
        }
        if (parsed.done_reason) {
          doneReason = parsed.done_reason;
        }
      }
    } catch {
      // ignore unparseable trailing data
    }
  }

  return { text: text.trim(), toolCalls, usage, done: true, doneReason };
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  cwd: string,
  paperclipContext: Record<string, string>,
): Promise<string> {
  const asStr = (v: unknown): string =>
    typeof v === "string" ? v : "";

  if (name === "read_file") {
    const filePath = asStr(args.path);
    if (!filePath) return "Error: path is required";
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
    try {
      const content = await fs.readFile(resolved, "utf8");
      return content;
    } catch (err) {
      return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (name === "write_file") {
    const filePath = asStr(args.path);
    const content = asStr(args.content);
    if (!filePath) return "Error: path is required";
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
    try {
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, content, "utf8");
      return `ok: wrote ${resolved}`;
    } catch (err) {
      return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (name === "run_bash") {
    const command = asStr(args.command);
    if (!command) return "Error: command is required";
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout: TOOL_BASH_TIMEOUT_MS,
        env: { ...process.env },
      });
      const out = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n---stderr---\n");
      return out || "(no output)";
    } catch (err) {
      if (err instanceof Error) {
        const execErr = err as Error & { stdout?: string; stderr?: string; code?: number };
        const out = [execErr.stdout?.trim(), execErr.stderr?.trim(), err.message].filter(Boolean).join("\n");
        return `Error (exit ${execErr.code ?? "?"}): ${out}`;
      }
      return `Error: ${String(err)}`;
    }
  }

  if (name === "list_directory") {
    const dirPath = asStr(args.path) || cwd;
    const resolved = path.isAbsolute(dirPath) ? dirPath : path.resolve(cwd, dirPath);
    try {
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      const lines = entries.map((e) => `${e.isDirectory() ? "d" : "f"} ${e.name}`);
      return lines.join("\n") || "(empty directory)";
    } catch (err) {
      return `Error listing directory: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (name === "paperclip_get_context") {
    return JSON.stringify(paperclipContext, null, 2);
  }

  return `Error: unknown tool "${name}"`;
}

// ---------------------------------------------------------------------------
// Main execute function
// ---------------------------------------------------------------------------

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta } = ctx;

  const baseUrl = asString(config.baseUrl, "http://localhost:11434").trim();
  const model = asString(config.model, DEFAULT_OLLAMA_LOCAL_MODEL).trim();
  const configuredCwd = asString(config.cwd, "").trim();
  const timeoutSec = asNumber(config.timeoutSec, 0);

  // Resolve cwd
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const cwd = workspaceCwd || configuredCwd || process.cwd();

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Invalid working directory: ${msg}`,
    };
  }

  // Build paperclip env context for the agent
  const paperclipEnvBase = buildPaperclipEnv(agent);
  const paperclipContext: Record<string, string> = { ...paperclipEnvBase, PAPERCLIP_RUN_ID: runId };

  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim() ? context.wakeReason.trim() : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim()) ||
    null;
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");

  if (wakeTaskId) paperclipContext.PAPERCLIP_TASK_ID = wakeTaskId;
  if (wakeReason) paperclipContext.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) paperclipContext.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (workspaceCwd) paperclipContext.PAPERCLIP_WORKSPACE_CWD = workspaceCwd;
  if (workspaceSource) paperclipContext.PAPERCLIP_WORKSPACE_SOURCE = workspaceSource;
  if (workspaceId) paperclipContext.PAPERCLIP_WORKSPACE_ID = workspaceId;
  if (workspaceRepoUrl) paperclipContext.PAPERCLIP_WORKSPACE_REPO_URL = workspaceRepoUrl;
  if (workspaceRepoRef) paperclipContext.PAPERCLIP_WORKSPACE_REPO_REF = workspaceRepoRef;

  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  if (wakePayloadJson) paperclipContext.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;

  // Merge extra env into context (string values only)
  const envConfig = parseObject(config.env);
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") paperclipContext[key] = value;
  }

  // Build system prompt
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const resolvedInstructionsFilePath = instructionsFilePath
    ? path.resolve(cwd, instructionsFilePath)
    : "";
  let instructionsPrefix = "";
  if (resolvedInstructionsFilePath) {
    try {
      const contents = await fs.readFile(resolvedInstructionsFilePath, "utf8");
      const instructionsDir = `${path.dirname(resolvedInstructionsFilePath)}/`;
      instructionsPrefix =
        `${contents}\n\n` +
        `The above agent instructions were loaded from ${resolvedInstructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsDir}.\n\n`;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stdout",
        `[paperclip] Warning: could not read agent instructions file "${resolvedInstructionsFilePath}": ${reason}\n`,
      );
    }
  }

  // Build user prompt
  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: false });
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const userPrompt = joinPromptSections([wakePrompt, sessionHandoffNote, renderedPrompt]);

  const systemPrompt = instructionsPrefix.length > 0
    ? `${instructionsPrefix}You are running in cwd: ${cwd}`
    : `You are a helpful AI agent running in cwd: ${cwd}. Use the available tools to complete the task.`;

  if (onMeta) {
    await onMeta({
      adapterType: "ollama_local",
      command: `${baseUrl}/api/chat`,
      cwd,
      commandNotes: [
        `model: ${model}`,
        `baseUrl: ${baseUrl}`,
        `max iterations: ${MAX_ITERATIONS}`,
      ],
      prompt: userPrompt,
      promptMetrics: {
        promptChars: userPrompt.length,
        instructionsChars: instructionsPrefix.length,
        wakePromptChars: wakePrompt.length,
        sessionHandoffChars: sessionHandoffNote.length,
      },
      context,
    });
  }

  // ---------------------------------------------------------------------------
  // Agentic loop
  // ---------------------------------------------------------------------------

  const sessionId = `ollama-${runId}`;
  const messages: OllamaMessage[] = [{ role: "user", content: userPrompt }];

  const totalUsage: OllamaUsage = { inputTokens: 0, outputTokens: 0 };
  const summaryLines: string[] = [];
  const errors: string[] = [];

  const startedAt = Date.now();

  let iteration = 0;
  while (iteration < MAX_ITERATIONS) {
    iteration++;

    // Check timeout
    if (timeoutSec > 0 && (Date.now() - startedAt) / 1000 > timeoutSec) {
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        sessionId,
        sessionParams: { sessionId },
        sessionDisplayId: sessionId,
        model,
        provider: "ollama",
        biller: "ollama",
        billingType: "unknown",
        usage: totalUsage,
        summary: summaryLines.join("\n\n").trim() || null,
      };
    }

    await onLog("stdout", `[paperclip] ollama iteration ${iteration}/${MAX_ITERATIONS}\n`);

    let response: Awaited<ReturnType<typeof ollamaChatStream>>;
    try {
      response = await ollamaChatStream(baseUrl, {
        model,
        messages: [{ role: "system", content: systemPrompt }, ...messages],
        stream: true,
        tools: TOOL_DEFINITIONS,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(msg);
      await onLog("stderr", `[paperclip] Ollama API error: ${msg}\n`);
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: msg,
        sessionId,
        sessionParams: { sessionId },
        sessionDisplayId: sessionId,
        model,
        provider: "ollama",
        biller: "ollama",
        billingType: "unknown",
        usage: totalUsage,
        summary: summaryLines.join("\n\n").trim() || null,
      };
    }

    totalUsage.inputTokens += response.usage.inputTokens;
    totalUsage.outputTokens += response.usage.outputTokens;

    // Append assistant response to conversation
    const assistantMsg: OllamaMessage = {
      role: "assistant",
      content: response.text,
    };
    if (response.toolCalls.length > 0) {
      assistantMsg.tool_calls = response.toolCalls;
    }
    messages.push(assistantMsg);

    if (response.text) {
      await onLog("stdout", JSON.stringify({ type: "ollama_text", text: response.text }) + "\n");
      summaryLines.push(response.text);
    }

    // If no tool calls, the agent is done
    if (response.toolCalls.length === 0) {
      await onLog("stdout", `[paperclip] ollama done (${response.doneReason})\n`);
      break;
    }

    // Execute tool calls
    for (const toolCall of response.toolCalls) {
      const toolName = toolCall.function.name;
      const toolArgs = toolCall.function.arguments ?? {};
      await onLog(
        "stdout",
        JSON.stringify({ type: "ollama_tool_call", tool: toolName, args: toolArgs }) + "\n",
      );

      const toolResult = await executeTool(toolName, toolArgs, cwd, paperclipContext);
      await onLog(
        "stdout",
        JSON.stringify({ type: "ollama_tool_result", tool: toolName, result: toolResult.slice(0, 2000) }) + "\n",
      );

      messages.push({
        role: "tool",
        content: toolResult,
      });
    }
  }

  if (iteration >= MAX_ITERATIONS) {
    await onLog("stdout", `[paperclip] ollama reached max iterations (${MAX_ITERATIONS})\n`);
  }

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: errors.length > 0 ? errors.join("\n") : null,
    sessionId,
    sessionParams: { sessionId },
    sessionDisplayId: sessionId,
    model,
    provider: "ollama",
    biller: "ollama",
    billingType: "unknown",
    usage: totalUsage,
    summary: summaryLines.join("\n\n").trim() || null,
    resultJson: {
      iterations: iteration,
      model,
      baseUrl,
    },
  };
}
