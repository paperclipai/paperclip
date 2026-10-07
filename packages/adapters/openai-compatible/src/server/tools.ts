import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { ChatToolDefinition } from "./client.js";

export const MAX_TOOL_OUTPUT_CHARS = 16_000;
export const MAX_SKILL_OUTPUT_CHARS = 70_000;
const MAX_WRITE_FILE_CHARS = 1_000_000;
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export type RuntimeSkill = {
  key: string;
  runtimeName: string;
  source: string;
  description: string;
};

export type WorkspaceToolsContext = {
  cwd: string;
  /** Complete child environment; process.env is not merged in again. */
  env: NodeJS.ProcessEnv;
  shellTimeoutMs: number;
};

export type ToolExecutionContext = {
  paperclipApiUrl: string | null;
  authToken: string | null;
  runId: string;
  skills: RuntimeSkill[];
  workspace: WorkspaceToolsContext | null;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

export type ToolExecutionResult = {
  content: string;
  isError: boolean;
};

export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} characters]`;
}

export function buildToolDefinitions(input: { workspaceTools: boolean; hasSkills: boolean }): ChatToolDefinition[] {
  const tools: ChatToolDefinition[] = [
    {
      type: "function",
      function: {
        name: "paperclip_api_request",
        description:
          "Call the Paperclip REST API as this agent for the current run. Authorization and the X-Paperclip-Run-Id header are added automatically. Use this instead of curl for every Paperclip API call. Returns the HTTP status and response body.",
        parameters: {
          type: "object",
          properties: {
            method: { type: "string", enum: [...HTTP_METHODS], description: "HTTP method." },
            path: {
              type: "string",
              description: "API path starting with /api/, e.g. /api/agents/me or /api/issues/{issueId}/comments. May include a query string.",
            },
            query: {
              type: "object",
              description: "Optional query parameters merged into the path's query string.",
              additionalProperties: { type: ["string", "number", "boolean"] },
            },
            body: {
              description: "Optional JSON request body for POST/PUT/PATCH.",
            },
          },
          required: ["method", "path"],
        },
      },
    },
  ];
  if (input.hasSkills) {
    tools.push({
      type: "function",
      function: {
        name: "load_skill",
        description:
          "Load the full instructions of an available skill (its SKILL.md), or a referenced file inside that skill directory. Load a skill before following its procedure.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Skill name from the available skills list." },
            file: {
              type: "string",
              description: "Optional relative path of a file inside the skill directory, e.g. references/api-reference.md.",
            },
          },
          required: ["name"],
        },
      },
    });
  }
  if (input.workspaceTools) {
    tools.push(
      {
        type: "function",
        function: {
          name: "run_shell",
          description:
            "Run a bash command in the workspace directory and return exit code, stdout and stderr. PAPERCLIP_* environment variables are available.",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string", description: "The bash command to run." },
            },
            required: ["command"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a UTF-8 text file inside the workspace directory.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path relative to the workspace directory." },
            },
            required: ["path"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "write_file",
          description: "Create or overwrite a UTF-8 text file inside the workspace directory. Parent directories are created.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path relative to the workspace directory." },
              content: { type: "string", description: "Full file content." },
            },
            required: ["path", "content"],
          },
        },
      },
    );
  }
  return tools;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function errorResult(message: string): ToolExecutionResult {
  return { content: `Error: ${message}`, isError: true };
}

/** Resolve `relative` inside `root`, refusing paths that escape it. */
export function resolveInside(root: string, relative: string): string | null {
  const base = path.resolve(root);
  const resolved = path.resolve(base, relative);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) return null;
  return resolved;
}

/**
 * Build the Paperclip URL for a model-chosen path. Only same-origin `/api/`
 * paths are allowed so the run token can never be sent to another host.
 */
export function buildPaperclipRequestUrl(
  apiBaseUrl: string,
  rawPath: string,
  query: Record<string, unknown> | null,
): URL | null {
  const trimmed = rawPath.trim();
  if (!trimmed.startsWith("/api/") && trimmed !== "/api") return null;
  let base: URL;
  let url: URL;
  try {
    base = new URL(apiBaseUrl);
    url = new URL(trimmed, base.origin);
  } catch {
    return null;
  }
  if (url.origin !== base.origin) return null;
  if (!url.pathname.startsWith("/api/") && url.pathname !== "/api") return null;
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === null || value === undefined) continue;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url;
}

async function paperclipApiRequest(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  if (!ctx.paperclipApiUrl || !ctx.authToken) {
    return errorResult("Paperclip API credentials are not available for this run.");
  }
  const method = typeof args.method === "string" ? args.method.trim().toUpperCase() : "GET";
  if (!(HTTP_METHODS as readonly string[]).includes(method)) {
    return errorResult(`Unsupported method "${method}". Use one of ${HTTP_METHODS.join(", ")}.`);
  }
  const rawPath = typeof args.path === "string" ? args.path : "";
  const url = buildPaperclipRequestUrl(ctx.paperclipApiUrl, rawPath, asRecord(args.query));
  if (!url) {
    return errorResult('path must be a Paperclip API path starting with "/api/".');
  }
  const headers: Record<string, string> = {
    authorization: `Bearer ${ctx.authToken}`,
    accept: "application/json",
    "x-paperclip-run-id": ctx.runId,
  };
  let body: string | undefined;
  if (args.body !== undefined && args.body !== null && method !== "GET" && method !== "DELETE") {
    headers["content-type"] = "application/json";
    // Models sometimes pass the JSON body pre-serialized.
    if (typeof args.body === "string") {
      try {
        JSON.parse(args.body);
        body = args.body;
      } catch {
        body = JSON.stringify(args.body);
      }
    } else {
      body = JSON.stringify(args.body);
    }
  }
  try {
    const response = await (ctx.fetchImpl ?? fetch)(url, {
      method,
      headers,
      body,
      signal: ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
    });
    const text = await response.text();
    return {
      content: truncateText(`HTTP ${response.status}\n${text}`, MAX_TOOL_OUTPUT_CHARS),
      isError: response.status >= 400,
    };
  } catch (err) {
    return errorResult(`Paperclip API request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function findSkill(skills: RuntimeSkill[], name: string): RuntimeSkill | null {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return null;
  return (
    skills.find((skill) => skill.runtimeName.toLowerCase() === normalized) ??
    skills.find((skill) => skill.key.toLowerCase() === normalized) ??
    skills.find((skill) => skill.key.toLowerCase().endsWith(`/${normalized}`)) ??
    null
  );
}

async function loadSkill(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
  const name = typeof args.name === "string" ? args.name : "";
  const skill = findSkill(ctx.skills, name);
  if (!skill) {
    const available = ctx.skills.map((entry) => entry.runtimeName).join(", ") || "none";
    return errorResult(`Unknown skill "${name}". Available skills: ${available}.`);
  }
  const file = typeof args.file === "string" && args.file.trim() ? args.file.trim() : "SKILL.md";
  const target = resolveInside(skill.source, file);
  if (!target) return errorResult("file must stay inside the skill directory.");
  try {
    const content = await fs.readFile(target, "utf8");
    return { content: truncateText(content, MAX_SKILL_OUTPUT_CHARS), isError: false };
  } catch (err) {
    return errorResult(`Could not read ${file} from skill ${skill.runtimeName}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function runShell(args: Record<string, unknown>, ctx: WorkspaceToolsContext, signal?: AbortSignal): Promise<ToolExecutionResult> {
  const command = typeof args.command === "string" ? args.command : "";
  if (!command.trim()) return Promise.resolve(errorResult("command is required."));
  return new Promise((resolve) => {
    execFile(
      "bash",
      ["-c", command],
      {
        cwd: ctx.cwd,
        env: ctx.env,
        timeout: ctx.shellTimeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        signal,
      },
      (error, stdout, stderr) => {
        const execError = error as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
        const exitCode = execError ? (typeof execError.code === "number" ? execError.code : 1) : 0;
        const timedOut = Boolean(execError?.killed) && !signal?.aborted;
        const parts = [
          `exit_code: ${exitCode}${timedOut ? ` (timed out after ${Math.round(ctx.shellTimeoutMs / 1000)}s)` : ""}`,
          stdout ? `stdout:\n${stdout}` : "stdout: (empty)",
          stderr ? `stderr:\n${stderr}` : "",
        ].filter(Boolean);
        if (execError && typeof execError.code === "string" && execError.code !== "ABORT_ERR") {
          parts.push(`error: ${execError.message}`);
        }
        resolve({ content: truncateText(parts.join("\n"), MAX_TOOL_OUTPUT_CHARS), isError: exitCode !== 0 });
      },
    );
  });
}

async function readWorkspaceFile(args: Record<string, unknown>, ctx: WorkspaceToolsContext): Promise<ToolExecutionResult> {
  const relative = typeof args.path === "string" ? args.path : "";
  const target = relative.trim() ? resolveInside(ctx.cwd, relative.trim()) : null;
  if (!target) return errorResult("path must be a file inside the workspace directory.");
  try {
    const content = await fs.readFile(target, "utf8");
    return { content: truncateText(content, MAX_TOOL_OUTPUT_CHARS * 2), isError: false };
  } catch (err) {
    return errorResult(`Could not read ${relative}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function writeWorkspaceFile(args: Record<string, unknown>, ctx: WorkspaceToolsContext): Promise<ToolExecutionResult> {
  const relative = typeof args.path === "string" ? args.path : "";
  const content = typeof args.content === "string" ? args.content : null;
  const target = relative.trim() ? resolveInside(ctx.cwd, relative.trim()) : null;
  if (!target || target === path.resolve(ctx.cwd)) return errorResult("path must be a file inside the workspace directory.");
  if (content === null) return errorResult("content must be a string.");
  if (content.length > MAX_WRITE_FILE_CHARS) return errorResult(`content exceeds ${MAX_WRITE_FILE_CHARS} characters.`);
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
    return { content: `Wrote ${content.length} characters to ${path.relative(ctx.cwd, target)}.`, isError: false };
  } catch (err) {
    return errorResult(`Could not write ${relative}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function parseToolArguments(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

export async function executeTool(
  name: string,
  rawArguments: string,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const args = parseToolArguments(rawArguments);
  if (!args) return errorResult("tool arguments must be a JSON object.");
  switch (name) {
    case "paperclip_api_request":
      return paperclipApiRequest(args, ctx);
    case "load_skill":
      return loadSkill(args, ctx);
    case "run_shell":
      return ctx.workspace ? runShell(args, ctx.workspace, ctx.signal) : errorResult("run_shell is not enabled for this agent.");
    case "read_file":
      return ctx.workspace ? readWorkspaceFile(args, ctx.workspace) : errorResult("read_file is not enabled for this agent.");
    case "write_file":
      return ctx.workspace ? writeWorkspaceFile(args, ctx.workspace) : errorResult("write_file is not enabled for this agent.");
    default:
      return errorResult(`Unknown tool "${name}".`);
  }
}
