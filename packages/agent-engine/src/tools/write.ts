import fs from "node:fs/promises";
import path from "node:path";
import type { TextToolResult, Tool, ToolExecutionContext } from "../types.js";

export interface WriteParams {
  /** Path to the file to write (relative or absolute). */
  path: string;
  /** Content to write to the file. */
  content: string;
}

/**
 * Write content to a file. Creates the file if it doesn't exist, overwrites if it does.
 * Automatically creates parent directories.
 */
export async function writeFile(
  params: WriteParams,
  ctx: ToolExecutionContext,
): Promise<TextToolResult> {
  const targetPath = path.resolve(ctx.cwd, params.path);

  try {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, params.content, "utf-8");
    return {
      content: `Wrote ${params.content.length} characters to "${params.path}".`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: `Error writing "${params.path}": ${message}`,
      isError: true,
    };
  }
}

export function createWriteTool(): Tool<WriteParams, TextToolResult> {
  return {
    name: "write",
    displayName: "Write File",
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. " +
      "Automatically creates parent directories.",
    parametersSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file to write (relative or absolute).",
        },
        content: {
          type: "string",
          description: "Content to write to the file.",
        },
      },
      required: ["path", "content"],
    },
    execute: writeFile,
  };
}
