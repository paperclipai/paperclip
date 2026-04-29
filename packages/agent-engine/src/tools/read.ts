import fs from "node:fs/promises";
import path from "node:path";
import type { TextToolResult, Tool, ToolExecutionContext } from "../types.js";

export interface ReadParams {
  /** Path to the file to read (relative or absolute). */
  path: string;
  /** Maximum number of lines to read. */
  limit?: number;
  /** Line number to start reading from (1-indexed). */
  offset?: number;
}

/**
 * Read the contents of a file. Supports text files and images (jpg, png, gif, webp).
 * Images are returned as markdown image tags. Output is truncated to 2000 lines or 50KB.
 */
export async function readFile(
  params: ReadParams,
  ctx: ToolExecutionContext,
): Promise<TextToolResult> {
  const targetPath = path.resolve(ctx.cwd, params.path);

  try {
    const stats = await fs.stat(targetPath);

    if (!stats.isFile()) {
      return {
        content: `Error: "${params.path}" is not a file.`,
        isError: true,
      };
    }

    const ext = path.extname(targetPath).toLowerCase();
    const imageExts = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

    if (imageExts.has(ext)) {
      const data = await fs.readFile(targetPath);
      const base64 = data.toString("base64");
      const mime = ext === ".png"
        ? "image/png"
        : ext === ".jpg" || ext === ".jpeg"
          ? "image/jpeg"
          : ext === ".gif"
            ? "image/gif"
            : "image/webp";
      return {
        content: `![${path.basename(targetPath)}](data:${mime};base64,${base64})`,
      };
    }

    const raw = await fs.readFile(targetPath, "utf-8");
    const lines = raw.split("\n");

    const offset = Math.max(0, (params.offset ?? 1) - 1);
    const limit = params.limit ?? lines.length;

    let selected = lines.slice(offset, offset + limit);

    const MAX_LINES = 2000;
    const MAX_BYTES = 50 * 1024;

    if (selected.length > MAX_LINES) {
      selected = selected.slice(0, MAX_LINES);
    }

    let content = selected.join("\n");
    if (content.length > MAX_BYTES) {
      content = content.slice(0, MAX_BYTES) + "\n[truncated]";
    }

    const totalLines = lines.length;
    const prefix = offset > 0 ? `[Lines ${offset + 1}–${Math.min(offset + selected.length, totalLines)} of ${totalLines}]\n` : "";

    return { content: prefix + content };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: `Error reading "${params.path}": ${message}`,
      isError: true,
    };
  }
}

export function createReadTool(): Tool<ReadParams, TextToolResult> {
  return {
    name: "read",
    displayName: "Read File",
    description:
      "Read the contents of a file. Supports text files and images (jpg, png, gif, webp). " +
      "Images are returned as markdown image tags. Output is truncated to 2000 lines or 50KB.",
    parametersSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file to read (relative or absolute).",
        },
        offset: {
          type: "number",
          description: "Line number to start reading from (1-indexed).",
        },
        limit: {
          type: "number",
          description: "Maximum number of lines to read.",
        },
      },
      required: ["path"],
    },
    execute: readFile,
  };
}
