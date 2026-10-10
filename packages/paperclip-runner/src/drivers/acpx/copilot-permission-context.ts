import { redactPaperclipSemanticValue } from "../../semantic-tools/redaction.js";
import { safeAcpxLocations } from "./safe-locations.js";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

export const COPILOT_PERMISSION_CONTEXT_CONTRACT = "copilot-edit-permission-context-v1";
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Native providers can spell an absolute workspace path through a host alias
 * (macOS /tmp and /private/tmp). Attest the real entry, or its existing parent
 * for a new file, before converting it to a display target. */
function aliasedLocation(path: string, cwd: string): string | undefined {
  if (!isAbsolute(path)) return;
  try {
    const canonicalCwd = realpathSync(cwd);
    let canonicalPath: string;
    try {
      lstatSync(path);
      canonicalPath = realpathSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
      // A dangling symlink must not become an apparently safe create target.
      try { lstatSync(path); return; } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code !== "ENOENT") return;
      }
      canonicalPath = join(realpathSync(dirname(path)), basename(path));
    }
    return safeAcpxLocations([{ path: canonicalPath }], canonicalCwd, "edit")[0]?.path as string | undefined;
  } catch { return; }
}

/** Display context only; this does not authorize filesystem access. */
export function safeCopilotEditTarget(value: unknown, workingDirectory: string | undefined): string | undefined {
  const call = record(value);
  if (call.kind !== "edit" || !workingDirectory) return;
  const input = record(call.rawInput);
  if (call.locations !== undefined && !Array.isArray(call.locations)) return;
  if (Array.isArray(call.locations) && (call.locations.length > 16 || call.locations.some(x => typeof record(x).path !== "string"))) return;
  const paths = [input.path, input.fileName, ...(Array.isArray(call.locations) ? call.locations.map(x => record(x).path) : [])].filter(x => x !== undefined);
  if (!paths.length || paths.some(x => typeof x !== "string" || !x || x.trim() !== x || x.length > 2048 || /[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(x))) return;
  const safe = paths.flatMap(path => {
    const locations = safeAcpxLocations([{ path }], workingDirectory, call.kind, call.title);
    if (locations.length) return locations;
    const aliased = aliasedLocation(path as string, workingDirectory);
    return aliased ? [{ path: aliased }] : [];
  });
  const names = safe.map(x => x.path).filter((x): x is string => typeof x === "string" && x.length <= 1024 && x.trim() === x && !x.includes(":"));
  if (names.length !== paths.length || new Set(names).size !== 1) return;
  const target = names[0];
  return target && redactPaperclipSemanticValue(target) === target ? target : undefined;
}
