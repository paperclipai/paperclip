import fs from "node:fs/promises";
import path from "node:path";
import type { TextToolResult, Tool, ToolExecutionContext } from "../types.js";

export interface LsParams {
  /** Directory to list (default: current directory). */
  path?: string;
  /** Maximum number of entries to return (default: 500). */
  limit?: number;
}

/**
 * List directory contents. Returns entries sorted alphabetically,
 * with '/' suffix for directories. Includes dotfiles.
 * Output is truncated to 500 entries or 50KB.
 */
export async function listDirectory(
  params: LsParams,
  ctx: ToolExecutionContext,
): Promise<TextToolResult> {
  const targetPath = path.resolve(ctx.cwd, params.path ?? ".");

  try {
    const entries = await fs.readdir(targetPath, { withFileTypes: true });
    const sorted = entries.sort((a, b) => a.name.localeCompare(b.name));

    const limit = params.limit ?? 500;
    const MAX_BYTES = 50 * 1024;

    const lines: string[] = [];
    for (let i = 0; i < Math.min(sorted.length, limit); i++) {
      const entry = sorted[i]!;
      lines.push(entry.isDirectory() ? `${entry.name}/` : entry.name);
    }

    let output = lines.join("\n");
    if (sorted.length > limit) {
      output += `\n[truncated: ${sorted.length - limit} more entries]`;
    }

    if (output.length > MAX_BYTES) {
      output = output.slice(0, MAX_BYTES);
      output += "\n[truncated to 50KB]";
    }

    return {
      content: output || "(empty directory)",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: `Error listing "${params.path ?? "."}": ${message}`,
      isError: true,
    };
  }
}

export function createLsTool(): Tool<LsParams, TextToolResult> {
  return {
    name: "ls",
    displayName: "List Directory",
    description:
      "List directory contents. Returns entries sorted alphabetically, " +
      "with '/' suffix for directories. Includes dotfiles. " +
      "Output is truncated to 500 entries or 50KB.",
    parametersSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory to list (default: current directory).",
        },
        limit: {
          type: "number",
          description: "Maximum number of entries to return (default: 500).",
        },
      },
      required: [],
    },
    execute: listDirectory,
  };
}
