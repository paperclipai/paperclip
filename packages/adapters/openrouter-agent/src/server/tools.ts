import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type OpenAI from "openai";
import type { PaperclipApi } from "./paperclip-api.js";

export interface ToolContext {
  cwd: string;
  runCommandTimeoutSec: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
  // Populated only when Paperclip API tools are enabled:
  paperclipApi?: PaperclipApi;
  agentId?: string;
  companyId?: string;
  currentIssueId?: string | null;
  autoApprove?: boolean;
}

export interface ToolHandler {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

export interface ToolDispatchOutcome {
  content: unknown;
  isError: boolean;
}

/**
 * Recursively remove structural noise from API response objects so the model
 * receives compact, signal-only data:
 *   - null values → absent
 *   - empty arrays (after pruning children) → absent
 *   - empty objects (after pruning children) → absent
 *   - "vacuous summary" objects where every value is 0 or "none" → absent
 *     (catches blockerAttention and similar all-zero count structs)
 * Non-null falsy scalars (false, "") are preserved.
 */
export function pruneEmpty(value: unknown): unknown {
  if (value === null) return undefined;
  if (Array.isArray(value)) {
    const pruned = value.map(pruneEmpty).filter((v) => v !== undefined);
    return pruned.length === 0 ? undefined : pruned;
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const pruned = pruneEmpty(v);
      if (pruned !== undefined) result[k] = pruned;
    }
    const vals = Object.values(result);
    if (vals.length === 0) return undefined;
    if (vals.every((v) => v === 0 || v === "none")) return undefined;
    return result;
  }
  return value;
}

/**
 * Serialize tool result content for the OpenAI messages array.
 * Objects are pruned of null/empty fields then pretty-printed so the model
 * receives readable structured data. Strings pass through with truncation only.
 */
export function serializeForModel(content: unknown): string {
  const str = typeof content === "string"
    ? content
    : JSON.stringify(pruneEmpty(content), null, 2) ?? "";
  return truncateForModel(str);
}

const MAX_OUTPUT_BYTES = 256 * 1024;

function truncateForModel(value: string | undefined): string {
  if (!value) return "";
  const buf = Buffer.from(value, "utf-8");
  if (buf.byteLength <= MAX_OUTPUT_BYTES) return value;
  const head = buf.subarray(0, MAX_OUTPUT_BYTES).toString("utf-8");
  return `${head}\n…[truncated ${buf.byteLength - MAX_OUTPUT_BYTES} bytes]`;
}

function resolveWithinCwd(rawPath: unknown, cwd: string): string {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    throw new Error("path must be a non-empty string");
  }
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  return value;
}

function asPositiveNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  return fallback;
}

interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runShellCommand(
  command: string,
  cwd: string,
  timeoutSec: number,
  extraEnv?: Record<string, string>,
  signal?: AbortSignal,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-lc", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...extraEnv, PAPERCLIP_TOOL_CWD: cwd },
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 1000).unref();
      } catch {
        // ignore
      }
    }, Math.max(1, Math.floor(timeoutSec * 1000)));

    const onAbort = () => {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
    };
    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes <= MAX_OUTPUT_BYTES) stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= MAX_OUTPUT_BYTES) stderr += chunk.toString("utf-8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code, childSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode: code,
        signal: childSignal,
        stdout: truncateForModel(stdout),
        stderr: truncateForModel(stderr),
        timedOut,
      });
    });
  });
}

export const READ_FILE_TOOL: ToolHandler = {
  name: "read_file",
  description: "Read a UTF-8 text file from the workspace.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path relative to cwd (or absolute).",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const target = resolveWithinCwd(args.path, ctx.cwd);
    const buf = await fs.readFile(target);
    return truncateForModel(buf.toString("utf-8"));
  },
};

export const WRITE_FILE_TOOL: ToolHandler = {
  name: "write_file",
  description:
    "Write a UTF-8 text file to the workspace, creating parent directories as needed. Overwrites existing files.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path relative to cwd (or absolute).",
      },
      content: {
        type: "string",
        description: "Full file contents to write.",
      },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const target = resolveWithinCwd(args.path, ctx.cwd);
    const content = asString(args.content, "content");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf-8");
    return `wrote ${Buffer.byteLength(content, "utf-8")} bytes to ${target}`;
  },
};

export const LIST_DIRECTORY_TOOL: ToolHandler = {
  name: "list_directory",
  description: "List entries in a workspace directory (non-recursive).",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory path relative to cwd (or absolute).",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const target = resolveWithinCwd(args.path, ctx.cwd);
    const entries = await fs.readdir(target, { withFileTypes: true });
    const lines = entries
      .map((e) => `${e.isDirectory() ? "d" : "f"} ${e.name}`)
      .sort();
    return lines.join("\n");
  },
};

export const RUN_COMMAND_TOOL: ToolHandler = {
  name: "run_command",
  description:
    "Run a shell command via 'bash -lc' inside the workspace cwd. Returns exit code, stdout, and stderr.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Shell command to execute.",
      },
      timeoutSec: {
        type: "number",
        description: "Per-call timeout in seconds (default 120, capped by adapter config).",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const command = asString(args.command, "command");
    const requested = asPositiveNumber(args.timeoutSec, ctx.runCommandTimeoutSec);
    const effective = Math.min(requested, ctx.runCommandTimeoutSec);
    const result = await runShellCommand(command, ctx.cwd, effective, ctx.env, ctx.signal);
    const header = result.timedOut
      ? `[timed out after ${effective}s, signal=${result.signal ?? "SIGTERM"}]`
      : `[exitCode=${result.exitCode}${result.signal ? ` signal=${result.signal}` : ""}]`;
    return [header, "--- stdout ---", result.stdout, "--- stderr ---", result.stderr].join("\n");
  },
};

export const APPLY_PATCH_TOOL: ToolHandler = {
  name: "apply_patch",
  description: "Apply a unified diff to the workspace using 'git apply'.",
  parameters: {
    type: "object",
    properties: {
      patch: {
        type: "string",
        description: "Unified diff body. Must include 'diff --git' headers.",
      },
    },
    required: ["patch"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const patch = asString(args.patch, "patch");
    return await new Promise<string>((resolve, reject) => {
      const child = spawn("git", ["apply", "--whitespace=nowarn", "-"], {
        cwd: ctx.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (c: Buffer) => (stdout += c.toString("utf-8")));
      child.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf-8")));
      child.on("error", reject);
      child.on("close", (code) => {
        const summary = `[git apply exitCode=${code}]\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`;
        resolve(summary);
      });
      child.stdin?.write(patch);
      if (!patch.endsWith("\n")) child.stdin?.write("\n");
      child.stdin?.end();
    });
  },
};

export const DEFAULT_TOOLS: ToolHandler[] = [
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
  LIST_DIRECTORY_TOOL,
  RUN_COMMAND_TOOL,
  APPLY_PATCH_TOOL,
];

export function buildToolMap(tools: ToolHandler[]): Map<string, ToolHandler> {
  return new Map(tools.map((t) => [t.name, t]));
}

export function toOpenAiTools(
  tools: ToolHandler[],
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw || raw === "null") return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new Error("tool arguments must be a JSON object");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to parse tool arguments: ${message}`);
  }
}

export async function dispatchToolCall(
  call: OpenAI.Chat.Completions.ChatCompletionMessageToolCall,
  tools: Map<string, ToolHandler>,
  ctx: ToolContext,
): Promise<ToolDispatchOutcome> {
  if (call.type !== "function") {
    return { content: `unsupported tool call type: ${call.type}`, isError: true };
  }
  const handler = tools.get(call.function.name);
  if (!handler) {
    return {
      content: `unknown tool: ${call.function.name}`,
      isError: true,
    };
  }
  try {
    const args = parseToolArguments(call.function.arguments ?? "");
    const result = await handler.execute(args, ctx);
    // Strings (shell output) get truncated in place; objects stay raw so the
    // caller can embed them as structured JSON in the transcript.
    const content = typeof result === "string" ? truncateForModel(result) : result;
    return { content, isError: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: `error: ${message}`, isError: true };
  }
}
