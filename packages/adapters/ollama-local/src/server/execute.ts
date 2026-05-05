import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";
import {
  DEFAULT_OLLAMA_MAX_ITERATIONS,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_TIMEOUT_SEC,
} from "../index.js";
import { isOllamaCloudHost, resolveOllamaApiKey, resolveOllamaHost } from "./models.js";

interface OllamaToolCall {
  function?: {
    name?: string;
    arguments?: Record<string, unknown> | string;
  };
}

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

interface OllamaChatResponse {
  message?: OllamaMessage;
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
}

const TOOL_DEFINITIONS = [
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file and return its contents.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path, absolute or relative to cwd." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "write_file",
      description: "Write (or overwrite) a UTF-8 text file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path, absolute or relative to cwd." },
          content: { type: "string", description: "Full file contents." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_dir",
      description: "List entries in a directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path, absolute or relative to cwd. Defaults to cwd." },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "run_bash",
      description: "Run a shell command in cwd. Output is truncated at 64 KB.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run." },
        },
        required: ["command"],
      },
    },
  },
];

const DEFAULT_SYSTEM_PROMPT = `You are an autonomous coding agent running inside Paperclip.
You can read files, write files, list directories, and run shell commands using the
provided tools. Make meaningful progress on the task before stopping. When the task
is complete, reply with a short final message and do not call any more tools.`;

const TOOL_OUTPUT_TRUNCATE_BYTES = 64 * 1024;

function truncate(text: string, max = TOOL_OUTPUT_TRUNCATE_BYTES): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n…[truncated ${text.length - max} bytes]`;
}

function resolveWithinCwd(cwd: string, target: string): string {
  if (!target) return cwd;
  return path.isAbsolute(target) ? target : path.resolve(cwd, target);
}

async function execReadFile(cwd: string, args: Record<string, unknown>): Promise<string> {
  const target = asString(args.path, "");
  if (!target) return "Error: missing 'path' argument.";
  const resolved = resolveWithinCwd(cwd, target);
  try {
    const data = await fs.readFile(resolved, "utf8");
    return truncate(data);
  } catch (err) {
    return `Error reading ${resolved}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function execWriteFile(cwd: string, args: Record<string, unknown>): Promise<string> {
  const target = asString(args.path, "");
  const content = asString(args.content, "");
  if (!target) return "Error: missing 'path' argument.";
  const resolved = resolveWithinCwd(cwd, target);
  try {
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, "utf8");
    return `Wrote ${content.length} bytes to ${resolved}`;
  } catch (err) {
    return `Error writing ${resolved}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function execListDir(cwd: string, args: Record<string, unknown>): Promise<string> {
  const target = asString(args.path, "");
  const resolved = target ? resolveWithinCwd(cwd, target) : cwd;
  try {
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    const lines = entries
      .map((e) => `${e.isDirectory() ? "d" : "-"} ${e.name}`)
      .sort();
    return truncate([`# ${resolved}`, ...lines].join("\n"));
  } catch (err) {
    return `Error listing ${resolved}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function execRunBash(
  cwd: string,
  env: Record<string, string>,
  args: Record<string, unknown>,
  graceSec: number,
): Promise<string> {
  const command = asString(args.command, "");
  if (!command) return Promise.resolve("Error: missing 'command' argument.");
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      env: { ...process.env, ...env },
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const grace = Math.max(5, graceSec);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), grace * 1000);
    }, 5 * 60 * 1000);
    child.stdout.on("data", (b) => {
      stdout += b.toString("utf8");
    });
    child.stderr.on("data", (b) => {
      stderr += b.toString("utf8");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const lines = [
        `exit_code=${code ?? -1}${timedOut ? " (timed_out)" : ""}`,
        stdout ? `--- stdout ---\n${stdout}` : "",
        stderr ? `--- stderr ---\n${stderr}` : "",
      ].filter(Boolean);
      resolve(truncate(lines.join("\n")));
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve(`Error spawning shell: ${err.message}`);
    });
  });
}

async function dispatchToolCall(
  name: string,
  args: Record<string, unknown>,
  ctx: { cwd: string; env: Record<string, string>; graceSec: number },
): Promise<string> {
  switch (name) {
    case "read_file":
      return execReadFile(ctx.cwd, args);
    case "write_file":
      return execWriteFile(ctx.cwd, args);
    case "list_dir":
      return execListDir(ctx.cwd, args);
    case "run_bash":
      return execRunBash(ctx.cwd, ctx.env, args, ctx.graceSec);
    default:
      return `Error: unknown tool "${name}".`;
  }
}

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* fall through */
    }
  }
  return {};
}

async function postOllamaChat(
  host: string,
  model: string,
  messages: OllamaMessage[],
  signal: AbortSignal,
  apiKey: string | null,
): Promise<OllamaChatResponse> {
  const url = `${host.replace(/\/+$/, "")}/api/chat`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages,
      tools: TOOL_DEFINITIONS,
      stream: false,
    }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ollama /api/chat returned ${res.status}: ${body.slice(0, 500)}`);
  }
  return (await res.json()) as OllamaChatResponse;
}

async function readInstructions(cwd: string, instructionsFilePath: string): Promise<string> {
  if (!instructionsFilePath) return "";
  const resolved = path.isAbsolute(instructionsFilePath)
    ? instructionsFilePath
    : path.resolve(cwd, instructionsFilePath);
  try {
    return await fs.readFile(resolved, "utf8");
  } catch {
    return "";
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, config, context, onLog, onMeta } = ctx;
  const model = asString(config.model, DEFAULT_OLLAMA_MODEL).trim();
  const host = resolveOllamaHost(asString(config.host, ""));
  const apiKey = resolveOllamaApiKey(asString(config.apiKey, ""));
  if (isOllamaCloudHost(host) && !apiKey) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage:
        "Ollama Cloud host requires OLLAMA_API_KEY (https://ollama.com/settings/keys) or apiKey adapter field.",
      provider: "ollama",
      biller: "ollama_cloud",
      model,
    };
  }
  const cwd = asString(config.cwd, "").trim() || process.cwd();
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const promptTemplate = asString(config.promptTemplate, "").trim();
  const maxIterations = Math.max(
    1,
    Math.floor(asNumber(config.maxIterations, DEFAULT_OLLAMA_MAX_ITERATIONS)),
  );
  const timeoutSec = Math.max(1, Math.floor(asNumber(config.timeoutSec, DEFAULT_OLLAMA_TIMEOUT_SEC)));
  const graceSec = Math.max(1, Math.floor(asNumber(config.graceSec, 20)));

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(envConfig)) {
    if (typeof v === "string") env[k] = v;
  }

  await fs.mkdir(cwd, { recursive: true }).catch(() => undefined);

  const instructions = await readInstructions(cwd, instructionsFilePath);
  const systemPrompt = instructions
    ? `${instructions}\n\n---\n\n${DEFAULT_SYSTEM_PROMPT}`
    : DEFAULT_SYSTEM_PROMPT;

  const userPromptParts: string[] = [];
  if (promptTemplate) userPromptParts.push(promptTemplate);
  const wakeReason = asString(context.wakeReason, "").trim();
  if (wakeReason) userPromptParts.push(`Wake reason: ${wakeReason}`);
  const userPrompt = userPromptParts.join("\n\n").trim() || "Begin work on the configured task.";

  const messages: OllamaMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  if (onMeta) {
    await onMeta({
      adapterType: "ollama_local",
      command: `ollama:${host}`,
      cwd,
      commandArgs: [model],
      env: Object.fromEntries(Object.entries(env).map(([k]) => [k, "***"])),
      prompt: userPrompt,
      promptMetrics: {
        systemPromptChars: systemPrompt.length,
        promptChars: userPrompt.length,
      },
      context,
    });
  }

  await onLog(
    "stdout",
    `[paperclip] Starting ollama_local run ${runId} on ${host} with model "${model}".\n`,
  );

  const abort = new AbortController();
  const timeoutHandle = setTimeout(() => abort.abort(), timeoutSec * 1000);

  let inputTokens = 0;
  let outputTokens = 0;
  let finalMessage: string | null = null;
  let iterations = 0;
  let timedOut = false;
  let errorMessage: string | null = null;

  try {
    while (iterations < maxIterations) {
      iterations += 1;
      let response: OllamaChatResponse;
      try {
        response = await postOllamaChat(host, model, messages, abort.signal, apiKey);
      } catch (err) {
        if (abort.signal.aborted) {
          timedOut = true;
          errorMessage = `Timed out after ${timeoutSec}s`;
          break;
        }
        errorMessage = err instanceof Error ? err.message : String(err);
        await onLog("stderr", `[paperclip] Ollama call failed: ${errorMessage}\n`);
        break;
      }

      inputTokens += response.prompt_eval_count ?? 0;
      outputTokens += response.eval_count ?? 0;

      const assistant = response.message;
      if (!assistant) {
        errorMessage = "Ollama returned no message.";
        break;
      }
      messages.push(assistant);

      const assistantText = (assistant.content ?? "").trim();
      if (assistantText) {
        await onLog("stdout", `[assistant] ${assistantText}\n`);
        finalMessage = assistantText;
      }

      const toolCalls = assistant.tool_calls ?? [];
      if (toolCalls.length === 0) {
        // Model is done (or model doesn't support tools — stop either way).
        break;
      }

      for (const call of toolCalls) {
        const name = call.function?.name?.trim() ?? "";
        const args = parseToolArguments(call.function?.arguments);
        await onLog(
          "stdout",
          `[tool] ${name} ${JSON.stringify(args).slice(0, 500)}\n`,
        );
        const output = await dispatchToolCall(name, args, { cwd, env, graceSec });
        await onLog("stdout", `[tool:${name}] ${output.split("\n", 1)[0].slice(0, 300)}\n`);
        messages.push({
          role: "tool",
          content: output,
          tool_name: name,
        });
      }
    }

    if (!errorMessage && iterations >= maxIterations) {
      errorMessage = `Reached maxIterations=${maxIterations} without a final answer.`;
      await onLog("stderr", `[paperclip] ${errorMessage}\n`);
    }
  } finally {
    clearTimeout(timeoutHandle);
  }

  const exitCode = timedOut ? 124 : errorMessage ? 1 : 0;

  return {
    exitCode,
    signal: null,
    timedOut,
    errorMessage: errorMessage ?? null,
    usage: {
      inputTokens,
      outputTokens,
    },
    sessionId: null,
    sessionParams: null,
    sessionDisplayId: null,
    provider: "ollama",
    biller: isOllamaCloudHost(host) ? "ollama_cloud" : "ollama",
    model,
    billingType: isOllamaCloudHost(host) ? "subscription" : "fixed",
    costUsd: 0,
    resultJson: {
      iterations,
      host,
      cloud: isOllamaCloudHost(host),
    },
    summary: finalMessage ?? null,
  };
}
