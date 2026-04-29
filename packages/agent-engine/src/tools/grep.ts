import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { TextToolResult, Tool, ToolExecutionContext } from "../types.js";

const execFile = promisify(execFileCallback);

export interface GrepParams {
  /** Search pattern (regex or literal string). */
  pattern: string;
  /** Directory or file to search (default: current directory). */
  path?: string;
  /** Number of lines to show before and after each match (default: 0). */
  context?: number;
  /** Maximum number of matches to return (default: 100). */
  limit?: number;
  /** Case-insensitive search (default: false). */
  ignoreCase?: boolean;
  /** Treat pattern as literal string instead of regex (default: false). */
  literal?: boolean;
  /** Filter files by glob pattern, e.g. '*.ts'. */
  glob?: string;
}

/**
 * Search file contents for a pattern. Returns matching lines with file paths
 * and line numbers. Respects .gitignore. Output is truncated to 100 matches or 50KB.
 */
export async function grepFiles(
  params: GrepParams,
  ctx: ToolExecutionContext,
): Promise<TextToolResult> {
  const searchPath = params.path ? path.resolve(ctx.cwd, params.path) : ctx.cwd;

  try {
    const args: string[] = [];

    if (params.ignoreCase) args.push("-i");
    if (params.literal) args.push("-F");
    if (params.context && params.context > 0) args.push("-C", String(params.context));
    if (params.limit) args.push("-m", String(params.limit));
    if (params.glob) args.push("--include", params.glob);

    args.push("-n", "-r", params.pattern, searchPath);

    const { stdout } = await execFile("grep", args, {
      cwd: ctx.cwd,
      env: { ...process.env, ...ctx.env },
      timeout: 30_000,
    });

    const MAX_MATCHES = 100;
    const MAX_BYTES = 50 * 1024;

    let output = stdout;

    const lines = output.split("\n");
    if (lines.length > MAX_MATCHES) {
      output = lines.slice(0, MAX_MATCHES).join("\n");
      output += "\n[truncated to first 100 matches]";
    }

    if (output.length > MAX_BYTES) {
      output = output.slice(0, MAX_BYTES);
      output += "\n[truncated to 50KB]";
    }

    return {
      content: output || "No matches found.",
    };
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 1) {
      return { content: "No matches found." };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: `Error: ${message}`,
      isError: true,
    };
  }
}

export function createGrepTool(): Tool<GrepParams, TextToolResult> {
  return {
    name: "grep",
    displayName: "Grep",
    description:
      "Search file contents for a pattern. Returns matching lines with file paths " +
      "and line numbers. Respects .gitignore. Output is truncated to 100 matches or 50KB.",
    parametersSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Search pattern (regex or literal string).",
        },
        path: {
          type: "string",
          description: "Directory or file to search (default: current directory).",
        },
        context: {
          type: "number",
          description: "Number of lines to show before and after each match (default: 0).",
        },
        limit: {
          type: "number",
          description: "Maximum number of matches to return (default: 100).",
        },
        ignoreCase: {
          type: "boolean",
          description: "Case-insensitive search (default: false).",
        },
        literal: {
          type: "boolean",
          description: "Treat pattern as literal string instead of regex (default: false).",
        },
        glob: {
          type: "string",
          description: "Filter files by glob pattern, e.g. '*.ts'.",
        },
      },
      required: ["pattern"],
    },
    execute: grepFiles,
  };
}
