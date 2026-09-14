import { existsSync, readFileSync } from "node:fs";

const WORKTREE_SEED_MODES = new Set(["minimal", "full"]);

type SeedDiagnostic = {
  phase?: unknown;
  status?: unknown;
  at?: unknown;
};

/**
 * A manifest is readiness evidence only when the complete validation phase was
 * durably recorded. A bare `state: verified` is deliberately insufficient so
 * truncated or hand-edited files cannot start a partially restored workspace.
 */
export function isVerifiedWorktreeSeedManifest(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Record<string, unknown>;
  const source = manifest.source as Record<string, unknown> | null;
  const diagnostics = manifest.diagnostics as SeedDiagnostic[] | null;
  return manifest.version === 2
    && manifest.state === "verified"
    && manifest.phase === "complete"
    && typeof source?.instanceId === "string"
    && source.instanceId.length > 0
    && typeof source.configPath === "string"
    && source.configPath.length > 0
    && WORKTREE_SEED_MODES.has(String(manifest.seedMode ?? ""))
    && typeof manifest.snapshotAt === "string"
    && manifest.snapshotAt.length > 0
    && typeof manifest.migrationRevision === "string"
    && manifest.migrationRevision.length > 0
    && typeof manifest.targetInstanceId === "string"
    && manifest.targetInstanceId.length > 0
    && typeof manifest.attemptId === "string"
    && manifest.attemptId.length > 0
    && typeof manifest.startedAt === "string"
    && typeof manifest.finishedAt === "string"
    && Array.isArray(diagnostics)
    && diagnostics.some((diagnostic) => (
      diagnostic?.phase === "complete"
      && diagnostic.status === "succeeded"
      && typeof diagnostic.at === "string"
    ));
}

export function hasVerifiedWorktreeSeedManifest(manifestPath: string): boolean {
  if (!existsSync(manifestPath)) return false;
  try {
    return isVerifiedWorktreeSeedManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  } catch {
    return false;
  }
}
