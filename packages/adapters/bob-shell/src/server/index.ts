/**
 * Server-side adapter module exports for IBM Bob Shell.
 */

export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export { parseBobStreamOutput, isBobLimitError, resolveBobCommand } from "./execute.js";

import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/**
 * Session codec for IBM Bob Shell.
 *
 * Bob Shell uses task IDs for session resumption via `bob run --resume <task-id>`.
 * The codec also stores the cwd to prevent cross-directory session contamination.
 */
export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      return null;
    const record = raw as Record<string, unknown>;
    const taskId =
      readNonEmptyString(record.taskId) ??
      readNonEmptyString(record.task_id);
    if (!taskId) return null;
    return {
      taskId,
      cwd: readNonEmptyString(record.cwd) ?? "",
    };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const taskId =
      readNonEmptyString(params.taskId) ?? readNonEmptyString(params.task_id);
    if (!taskId) return null;
    return {
      taskId,
      cwd: readNonEmptyString(params.cwd) ?? "",
    };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return (
      readNonEmptyString(params.taskId) ?? readNonEmptyString(params.task_id)
    );
  },
};
