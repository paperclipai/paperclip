/**
 * Server-side adapter module exports.
 */

export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export { detectModel, parseModelFromConfig, resolveProvider, inferProviderFromModel } from "./detect-model.js";
export { getConfigSchema } from "./config-schema.js";
export {
  listHermesSkills as listSkills,
  syncHermesSkills as syncSkills,
  resolveHermesDesiredSkillNames as resolveDesiredSkillNames,
} from "./skills.js";

import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Session codec for structured validation and migration of session parameters.
 *
 * Hermes Agent uses a single `sessionId` for cross-heartbeat session continuity
 * via the `--resume` CLI flag. The codec validates and normalizes this field.
 */
/**
 * TSMC-21482: read the workspace cwd under any spelling the CLI may use.
 *
 * The codec used to return `{ sessionId }` and drop everything else. That single
 * omission disabled the TSMC-21089 convergence guard for hermes and only for
 * hermes: `resolveRuntimeSessionParamsForWorkspace` rotates a saved session away
 * when a project workspace appears, and converges via
 * `previousCwd && previousCwd === projectCwd`. With no cwd persisted,
 * `previousCwd` was always undefined, the guard could never fire, and the
 * "rotate once" rotated on every run forever.
 *
 * Measured live 2026-08-24, before the fix: session rows carrying a cwd were
 * codex 145/145, claude 34/34, antigravity 26/26 and hermes **0/17**; hermes
 * resumed a saved session on **0 of 433 runs** in 24h despite 207 of them being
 * repeat visits to a card the lane had already worked. Every one of those repeats
 * recorded `taskSessionAvailable=true` alongside
 * `resetReasons: ["project_workspace_migration_from_fallback"]` — the session was
 * found and discarded, run after run, each time re-paying a ~32.8K cold-start
 * prefix.
 *
 * Mirrors the codex codec, which reads the same three spellings.
 */
function readSessionCwd(record: Record<string, unknown>) {
  return (
    readNonEmptyString(record.cwd) ??
    readNonEmptyString(record.workdir) ??
    readNonEmptyString(record.folder)
  );
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId =
      readNonEmptyString(record.sessionId) ??
      readNonEmptyString(record.session_id);
    if (!sessionId) return null;
    const cwd = readSessionCwd(record);
    // Spread conditionally: an always-present `cwd: undefined` would change the
    // serialized shape for sessions that legitimately have no workspace, and the
    // session config fingerprint hashes this object.
    return { sessionId, ...(cwd ? { cwd } : {}) };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId =
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id);
    if (!sessionId) return null;
    const cwd = readSessionCwd(params);
    return { sessionId, ...(cwd ? { cwd } : {}) };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
  },
};
