import fs from "node:fs/promises";
import path from "node:path";
import type { TextToolResult, Tool, ToolExecutionContext } from "../types.js";

export interface EditParams {
  /** Path to the file to edit (relative or absolute). */
  path: string;
  /** The exact text to replace. Must match a unique, non-overlapping region. */
  oldText: string;
  /** The replacement text. */
  newText: string;
}

/**
 * Edit a single file using exact text replacement.
 *
 * Rules:
 * - oldText must match a unique, non-overlapping region of the original file.
 * - If two changes affect the same block, merge them into one edit.
 * - Do not include large unchanged regions just to connect distant changes.
 */
export async function editFile(
  params: EditParams,
  ctx: ToolExecutionContext,
): Promise<TextToolResult> {
  const targetPath = path.resolve(ctx.cwd, params.path);

  try {
    const original = await fs.readFile(targetPath, "utf-8");

    const occurrences = original.split(params.oldText).length - 1;
    if (occurrences === 0) {
      return {
        content: `Error: oldText not found in "${params.path}".`,
        isError: true,
      };
    }
    if (occurrences > 1) {
      return {
        content: `Error: oldText is not unique in "${params.path}" (${occurrences} matches). Use a larger, unique block.`,
        isError: true,
      };
    }

    const updated = original.replace(params.oldText, params.newText);
    await fs.writeFile(targetPath, updated, "utf-8");

    const lines = updated.split("\n");
    const oldLines = params.oldText.split("\n").length;
    const newLines = params.newText.split("\n").length;

    return {
      content: `Edited "${params.path}" (${oldLines} lines → ${newLines} lines). File is now ${lines.length} lines.`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: `Error editing "${params.path}": ${message}`,
      isError: true,
    };
  }
}

export function createEditTool(): Tool<EditParams, TextToolResult> {
  return {
    name: "edit",
    displayName: "Edit File",
    description:
      "Edit a single file using exact text replacement. oldText must match a unique, " +
      "non-overlapping region of the original file. If two changes affect the same block, " +
      "merge them into one edit instead of emitting overlapping edits.",
    parametersSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file to edit (relative or absolute).",
        },
        oldText: {
          type: "string",
          description:
            "The exact text to replace. Must match a unique, non-overlapping region.",
        },
        newText: {
          type: "string",
          description: "The replacement text.",
        },
      },
      required: ["path", "oldText", "newText"],
    },
    execute: editFile,
  };
}
