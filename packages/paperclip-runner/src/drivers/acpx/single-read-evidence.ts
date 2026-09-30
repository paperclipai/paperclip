import { createHash } from "node:crypto";
import { safeAcpxLocations } from "./safe-locations.js";

export interface SingleReadEvidence { targetSha256?: string }
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const scalarOptions = new Set(["offset", "limit", "startLine", "endLine"]);
function safePath(value: unknown, cwd: string): string | undefined {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > 4096 || /[\u0000-\u001f\u007f\\]/u.test(value)) return;
  const locations = safeAcpxLocations([{ path: value }], cwd, "read");
  const path = locations[0]?.path;
  return locations.length === 1 && typeof path === "string" && !path.includes(":") ? path : undefined;
}
function locationsAgree(value: unknown, cwd: string, expected: string): boolean {
  return value === undefined || (Array.isArray(value) && value.length <= 1 && value.every(entry => {
    const location = record(entry); return location !== undefined && safePath(location.path, cwd) === expected;
  }));
}
function singleInputPath(value: unknown, cwd: string): string | undefined {
  const input = record(value); if (!input) return;
  const keys = Object.keys(input), paths = keys.filter(key => key === "path" || key === "fileName");
  if (paths.length !== 1 || keys.length > 5 || keys.some(key => key !== "path" && key !== "fileName"
    && (!scalarOptions.has(key) || typeof input[key] !== "number" || !Number.isSafeInteger(input[key]) || (input[key] as number) < 0))) return;
  return safePath(input[paths[0]!], cwd);
}

/** Passive attestation of the pinned single-file read input, never permission or
 * filesystem authority. Multi-path tools and shell-output reads remain visible
 * but cannot acquire this proof. Only the actual origin may establish a digest;
 * absent update fields retain it, while changed or ambiguous fields invalidate
 * evidence without changing the provider's response or execution. */
export function updateSingleReadEvidence(state: SingleReadEvidence | undefined, call: Record<string, unknown>, cwd: string): SingleReadEvidence {
  if (!state) {
    const path = call.tag === "tool_call" ? singleInputPath(call.rawInput, cwd) : undefined;
    return path && locationsAgree(call.locations, cwd, path) ? { targetSha256: digest(path) } : {};
  }
  if (!state.targetSha256) return state; // A later delta cannot create an origin.
  if (call.rawInput !== undefined) {
    const path = singleInputPath(call.rawInput, cwd);
    if (!path || digest(path) !== state.targetSha256 || !locationsAgree(call.locations, cwd, path)) throw new Error("Changed single-read evidence input");
  } else if (call.locations !== undefined) {
    if (!Array.isArray(call.locations) || call.locations.length > 1 || call.locations.some(location => {
      const path = safePath(record(location)?.path, cwd); return !path || digest(path) !== state.targetSha256;
    })) throw new Error("Changed single-read evidence locations");
  }
  return state;
}
