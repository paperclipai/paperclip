import { readConnectionFailure, type GitConnectionFailure } from "@paperclipai/adapter-utils/connection-failure";

/** Observations only: none of these outcomes proves that a ref is absent. */
export interface WorkspaceBaseRefDiagnostic {
  schemaVersion: 1;
  remoteLookup: "not_attempted" | "failed" | "empty" | "resolved";
  authLookup: "not_requested" | "failed" | "unavailable" | "resolved";
  fetch: "not_attempted" | "failed" | "succeeded";
  fetchExitCode?: number;
  fetchFailureKind?: GitConnectionFailure["reason"] | "remote_ref_not_found" | "unknown";
  refResolution?: "failed" | "succeeded" | "spawn_failed";
  refExitCode?: number;
}

function read(value: unknown, key: string): unknown {
  try {
    if (!value || typeof value !== "object") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
}

/** Persist and export only closed values, never arguments, output or credentials. */
export function readWorkspaceBaseRefDiagnostic(value: unknown): WorkspaceBaseRefDiagnostic | null {
  if (read(value, "schemaVersion") !== 1) return null;
  const remoteLookup = read(value, "remoteLookup"), authLookup = read(value, "authLookup"), fetch = read(value, "fetch");
  if (remoteLookup !== "not_attempted" && remoteLookup !== "failed" && remoteLookup !== "empty" && remoteLookup !== "resolved") return null;
  if (authLookup !== "not_requested" && authLookup !== "failed" && authLookup !== "unavailable" && authLookup !== "resolved") return null;
  if (fetch !== "not_attempted" && fetch !== "failed" && fetch !== "succeeded") return null;
  const result: WorkspaceBaseRefDiagnostic = { schemaVersion: 1, remoteLookup, authLookup, fetch };
  const resolution = read(value, "refResolution");
  if (resolution === "failed" || resolution === "succeeded" || resolution === "spawn_failed") result.refResolution = resolution;
  for (const key of ["fetchExitCode", "refExitCode"] as const) {
    if (key === "fetchExitCode" && fetch === "not_attempted") continue;
    if (key === "refExitCode" && resolution !== "failed" && resolution !== "succeeded") continue;
    const code = read(value, key);
    if (typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 255) result[key] = code;
  }
  const kind = read(value, "fetchFailureKind");
  const transport = readConnectionFailure({ schemaVersion: 1, provider: "git", operation: "clone", reason: kind });
  if (fetch === "failed") {
    if (kind === "remote_ref_not_found" || kind === "unknown") result.fetchFailureKind = kind;
    else if (transport?.provider === "git") result.fetchFailureKind = transport.reason;
  }
  return result;
}
