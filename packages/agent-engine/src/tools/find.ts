import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { TextToolResult, Tool, ToolExecutionContext } from "../types.js";

const execFile = promisify(execFileCallback);

export interface FindParams {
  /** Glob pattern to match files, e.g. '*.ts' or 'src/**//*.spec.ts'. */
  pattern: string;
  /** Directory to search in (default: current directory). */
  path?: string;
  /** Maximum number of results (default: 1000). */
  limit?: number;
}

/**
 * Search for files by glob pattern. Returns matching file paths relative to the
 * search directory. Respects .gitignore. Output is truncated to 1000 results or 50KB.
 */
export async function findFiles(
  params: FindParams,
  ctx: ToolExecutionContext,
): Promise<TextToolResult> {
  const searchPath = params.path ? path.resolve(ctx.cwd, params.path) : ctx.cwd;

  try {
    // Use find as a fallback; ideally we'd use a proper glob library
    const { stdout } = await execFile(
      "find",
      [searchPath, "-type", "f", "-name", params.pattern],
      {
        cwd: ctx.cwd,
        env: { ...process.env, ...ctx.env },
        timeout: 30_000,
      },
    );

    let lines = stdout.split("\n").filter(Boolean);
    const limit = params.limit ?? 1000;
    const MAX_BYTES = 50 * 1024;

    let output = lines.join("\n");
    if (lines.length > limit) {
      output = lines.slice(0, limit).join("\n");
      output += "\n[truncated to 1000 results]";
    }

    if (output.length > MAX_BYTES) {
      output = output.slice(0, MAX_BYTES);
      output += "\n[truncated to 50KB]";
    }

    return {
      content: output || "No matches found.",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: `Error: ${message}`,
      isError: true,
    };
  }
}

export function createFindTool(): Tool<FindParams, TextToolResult> {
  return {
    name: "find",
    displayName: "Find Files",
    description:
      "Search for files by glob pattern. Returns matching file paths relative to the " +
      "search directory. Respects .gitignore. Output is truncated to 1000 results or 50KB.",
    parametersSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern to match files, e.g. '*.ts' or 'src/**/*.spec.ts'.",
        },
        path: {
          type: "string",
          description: "Directory to search in (default: current directory).",
        },
        limit: {
          type: "number",
          description: "Maximum number of results (default: 1000).",
        },
      },
      required: ["pattern"],
    },
    execute: findFiles,
  };
}
