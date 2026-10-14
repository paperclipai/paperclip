import { redactPaperclipSemanticValue } from "../../semantic-tools/redaction.js";
import { safeAcpxLocations } from "./safe-locations.js";

export const COPILOT_PERMISSION_CONTEXT_CONTRACT = "copilot-edit-permission-context-v1";
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Display context only; this does not authorize filesystem access. */
export function safeCopilotEditTarget(value: unknown, workingDirectory: string | undefined): string | undefined {
  const call = record(value);
  if (call.kind !== "edit" || !workingDirectory) return;
  const input = record(call.rawInput);
  if (call.locations !== undefined && !Array.isArray(call.locations)) return;
  if (Array.isArray(call.locations) && (call.locations.length > 16 || call.locations.some(x => typeof record(x).path !== "string"))) return;
  const paths = [input.path, input.fileName, ...(Array.isArray(call.locations) ? call.locations.map(x => record(x).path) : [])].filter(x => x !== undefined);
  if (!paths.length || paths.some(x => typeof x !== "string" || !x || x.trim() !== x || x.length > 2048 || /[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(x))) return;
  const safe = paths.flatMap(path => safeAcpxLocations([{ path }], workingDirectory, call.kind, call.title));
  const names = safe.map(x => x.path).filter((x): x is string => typeof x === "string" && x.length <= 1024 && x.trim() === x && !x.includes(":"));
  if (names.length !== paths.length || new Set(names).size !== 1) return;
  const target = names[0];
  return target && redactPaperclipSemanticValue(target) === target ? target : undefined;
}
