import { lstatSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { expandHomePrefix } from "./home-paths.js";

/**
 * Named phase for the source-readiness preflight.
 *
 * Every surfaced workspace operation and seed manifest carries this string so an
 * operator can tell "we never started seeding" from "the seed itself failed".
 */
export const WORKTREE_SEED_SOURCE_PREFLIGHT_PHASE = "seed_source_preflight";

export const WORKTREE_SEED_SOURCE_READINESS_REASONS = [
  "source_config_invalid",
  "source_instance_mismatch",
  "source_transient_worktree_identity",
  "source_data_dir_missing",
  "source_database_unreachable",
] as const;

export type WorktreeSeedSourceReadinessReason = (typeof WORKTREE_SEED_SOURCE_READINESS_REASONS)[number];

/**
 * One machine-readable defect, collapsed across every config key that shares it.
 *
 * `configKeys` names config *keys*, never their values, and `detail` is an enumerated
 * discriminator. Neither can carry a secret, a connection string or a private path,
 * so a finding is safe to persist in a workspace operation and render in the UI.
 */
export type WorktreeSeedSourceReadinessFinding = {
  reason: WorktreeSeedSourceReadinessReason;
  configKeys: string[];
  detail: string;
  remediation: string;
};

export type WorktreeSeedSourceDatabaseState = "reachable" | "stopped" | "unknown";

export type WorktreeSeedSourceReadiness = {
  ok: boolean;
  phase: typeof WORKTREE_SEED_SOURCE_PREFLIGHT_PHASE;
  reason: WorktreeSeedSourceReadinessReason | null;
  message: string;
  remediation: string | null;
  findings: WorktreeSeedSourceReadinessFinding[];
  /**
   * `stopped` is a healthy outcome: an embedded source with an initialized data
   * directory is startable, so a closed port must never fail the preflight.
   */
  databaseState: WorktreeSeedSourceDatabaseState;
  sourceInstanceId: string | null;
};

export type WorktreeSeedSourceProbe = (target: { host: string; port: number }) => Promise<boolean>;

export type WorktreeSeedSourceReadinessInput = {
  /** Canonical `<workspace>/.paperclip/config.json` of the registered seed source. */
  sourceConfigPath: string;
  /**
   * Managed callers set this for a registered primary/base project workspace: its
   * config must name durable host state, so a missing instance pointer or transient
   * worktree/test identity is fatal. Manual `--from-config` operator boots leave it
   * unset and stay permissive about identity, while still validating persistent state.
   */
  registeredPrimaryWorkspace?: boolean;
  /** Optional identity the caller already committed to; a disagreement is a mismatch. */
  expectedSourceInstanceId?: string | null;
  probeTcp?: WorktreeSeedSourceProbe;
  probeTimeoutMs?: number;
};

const REASON_SEVERITY: WorktreeSeedSourceReadinessReason[] = [
  "source_config_invalid",
  "source_instance_mismatch",
  "source_transient_worktree_identity",
  "source_data_dir_missing",
  "source_database_unreachable",
];

const DOCTOR_REMEDIATION =
  "Restore the registered base workspace config: run `paperclip doctor` (or `paperclip configure`) in that workspace so config.json and its adjacent .env name the live instance again, then retry.";

const SAFE_IDENTIFIER_RE = /^[A-Za-z0-9._-]{1,64}$/;

const DATA_DIR_DETAIL_COPY: Record<string, string> = {
  missing: "missing",
  not_a_directory: "not a directory",
  uninitialized: "present but was never initialized",
};

/**
 * Path segments that only a transient worktree or virtualized test run creates.
 * A registered primary workspace that points through one of these is pointing at
 * state that a `pcvt-` run is free to delete.
 *
 * The sanctioned worktree home is exactly `~/.paperclip-worktrees`, so it carries no
 * marker: a control plane that legitimately runs from a worktree stays provisionable.
 * Only a random-suffixed copy of it is test-harness scratch.
 */
const TRANSIENT_SEGMENT_MARKERS: Array<{ marker: string; test: (segment: string) => boolean }> = [
  { marker: "pcvt_test_harness", test: (segment) => /^pcvt-/.test(segment) },
  { marker: "virtualized_test_scratch", test: (segment) => /^\.p\d+$/.test(segment) },
  { marker: "ephemeral_worktree_home", test: (segment) => /^\.?paperclip-worktrees-./.test(segment) },
];

type WatchedConfigPath = { configKey: string; resolved: string };

export type PaperclipEnvPointer = {
  instanceId: string | null;
  home: string | null;
  configPath: string | null;
  present: boolean;
};

function matchEnvValue(contents: string, key: string): string | null {
  for (const rawLine of contents.split(/\r?\n/)) {
    const match = rawLine.match(
      new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s#]+))`),
    );
    const value = (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
    if (value) return value;
  }
  return null;
}

/** Read the instance pointer that sits next to a Paperclip config. */
export function readPaperclipEnvPointer(configPath: string): PaperclipEnvPointer {
  const envPath = path.join(path.dirname(configPath), ".env");
  let contents: string;
  try {
    contents = readFileSync(envPath, "utf8");
  } catch {
    return { instanceId: null, home: null, configPath: null, present: false };
  }
  return {
    instanceId: matchEnvValue(contents, "PAPERCLIP_INSTANCE_ID"),
    home: matchEnvValue(contents, "PAPERCLIP_HOME"),
    configPath: matchEnvValue(contents, "PAPERCLIP_CONFIG"),
    present: true,
  };
}

function resolveConfiguredPath(rawValue: string, configDir: string): string {
  const expanded = expandHomePrefix(rawValue.trim());
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(configDir, expanded);
}

function pathSegments(resolved: string): string[] {
  return resolved.split(path.sep).filter(Boolean);
}

/** Instance id a configured path is rooted under, i.e. the `<id>` of `.../instances/<id>/...`. */
function instanceIdFromPath(resolved: string): string | null {
  const segments = pathSegments(resolved);
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    if (segments[index] === "instances") return segments[index + 1] ?? null;
  }
  return null;
}

function transientMarkersInPath(resolved: string, ignoredSegments: ReadonlySet<string> = new Set()): string[] {
  const markers = new Set<string>();
  for (const segment of pathSegments(resolved)) {
    // The test runner and a valid workspace may themselves live below a path with a
    // transient-looking name. Only a new segment introduced by a state pointer is
    // evidence that the registered config was rewritten to another scratch tree.
    if (ignoredSegments.has(segment)) continue;
    for (const candidate of TRANSIENT_SEGMENT_MARKERS) {
      if (candidate.test(segment)) markers.add(candidate.marker);
    }
  }
  return [...markers];
}

function safeIdentifier(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return SAFE_IDENTIFIER_RE.test(trimmed) ? trimmed : null;
}

function quotedIdentifier(value: string | null): string {
  return value ? `\`${value}\`` : "an unnamed instance";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readStringField(root: Record<string, unknown>, keyPath: string): string | null {
  const parts = keyPath.split(".");
  let cursor: Record<string, unknown> | null = root;
  for (const part of parts.slice(0, -1)) {
    cursor = asRecord(cursor?.[part]);
    if (!cursor) return null;
  }
  const value = cursor?.[parts[parts.length - 1]!];
  return typeof value === "string" && value.trim() ? value : null;
}

async function defaultProbeTcp(
  target: { host: string; port: number },
  timeoutMs: number,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    const socket = net.connect({ host: target.host, port: target.port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/** Host/port only: credentials from a connection string never leave this function. */
function parseConnectionTarget(connectionString: string): { host: string; port: number } | null {
  try {
    const url = new URL(connectionString);
    const host = url.hostname || "127.0.0.1";
    const port = Number.parseInt(url.port || "5432", 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host, port };
  } catch {
    return null;
  }
}

function statKind(target: string): "missing" | "directory" | "other" {
  try {
    return lstatSync(target).isDirectory() ? "directory" : "other";
  } catch {
    return "missing";
  }
}

function fileExists(target: string): boolean {
  try {
    return lstatSync(target).isFile();
  } catch {
    return false;
  }
}

function pickReason(findings: WorktreeSeedSourceReadinessFinding[]) {
  for (const reason of REASON_SEVERITY) {
    const finding = findings.find((candidate) => candidate.reason === reason);
    if (finding) return finding;
  }
  return null;
}

function summarizeKeys(findings: WorktreeSeedSourceReadinessFinding[], reason: WorktreeSeedSourceReadinessReason) {
  const keys = [...new Set(findings.filter((finding) => finding.reason === reason).flatMap((finding) => finding.configKeys))];
  return keys.length > 0 ? keys.join(", ") : "the source config";
}

function buildMessage(input: {
  reason: WorktreeSeedSourceReadinessReason;
  findings: WorktreeSeedSourceReadinessFinding[];
  sourceInstanceId: string | null;
}): string {
  const { reason, findings } = input;
  const keys = summarizeKeys(findings, reason);
  const primary = findings.find((finding) => finding.reason === reason)!;
  switch (reason) {
    case "source_config_invalid":
      return `The registered workspace seed source config is not usable (${
        primary.configKeys[0] ? `${primary.configKeys[0]}: ${primary.detail}` : primary.detail
      }).`;
    case "source_instance_mismatch":
      return `The registered workspace seed source config is inconsistent: its adjacent .env names ${
        quotedIdentifier(input.sourceInstanceId)
      } while ${keys} resolve under a different instance.`;
    case "source_transient_worktree_identity":
      return `The registered workspace seed source carries transient worktree/test identity in ${keys}.`;
    case "source_data_dir_missing":
      return `The registered workspace seed source embedded PostgreSQL data directory is ${
        DATA_DIR_DETAIL_COPY[primary.detail] ?? primary.detail
      }.`;
    case "source_database_unreachable":
      return "The registered workspace seed source database is unreachable at its configured host and port.";
  }
}

/**
 * Validate that a registered seed source can actually be seeded from, before any
 * seed, provision or repair mutation runs.
 *
 * The checks are deliberately identity-and-existence only: a *stopped* embedded
 * source with an initialized data directory is healthy, because the seed starts it
 * from the persistent data directory. What is never healthy is a source whose
 * config points at state that no longer exists, that belongs to another instance,
 * or that a transient worktree/test run owns.
 */
export async function evaluateWorktreeSeedSourceReadiness(
  input: WorktreeSeedSourceReadinessInput,
): Promise<WorktreeSeedSourceReadiness> {
  const findings: WorktreeSeedSourceReadinessFinding[] = [];
  /** Collapse repeats: one finding per (reason, detail), listing every affected key. */
  const addFinding = (finding: {
    reason: WorktreeSeedSourceReadinessReason;
    configKey?: string | null;
    detail: string;
    remediation: string;
  }) => {
    const existing = findings.find(
      (candidate) => candidate.reason === finding.reason && candidate.detail === finding.detail,
    );
    if (!existing) {
      findings.push({
        reason: finding.reason,
        configKeys: finding.configKey ? [finding.configKey] : [],
        detail: finding.detail,
        remediation: finding.remediation,
      });
      return;
    }
    if (finding.configKey && !existing.configKeys.includes(finding.configKey)) {
      existing.configKeys.push(finding.configKey);
    }
  };
  const strictIdentity = input.registeredPrimaryWorkspace === true;
  const probeTimeoutMs = input.probeTimeoutMs ?? 750;
  const probeTcp: WorktreeSeedSourceProbe = input.probeTcp
    ?? ((target) => defaultProbeTcp(target, probeTimeoutMs));
  const sourceConfigPath = path.resolve(input.sourceConfigPath);
  const sourceConfigDir = path.dirname(sourceConfigPath);

  const configInvalid = (detail: string, sourceInstanceId: string | null = null) => finalize({
    findings: [{
      reason: "source_config_invalid",
      configKeys: [],
      detail,
      remediation: DOCTOR_REMEDIATION,
    }],
    databaseState: "unknown",
    sourceInstanceId,
  });

  let raw: string;
  try {
    raw = readFileSync(sourceConfigPath, "utf8");
  } catch {
    return configInvalid(fileExists(sourceConfigPath) ? "unreadable" : "missing");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return configInvalid("malformed_json");
  }
  const config = asRecord(parsed);
  if (!config) return configInvalid("not_an_object");

  const pointer = readPaperclipEnvPointer(sourceConfigPath);
  const sourceInstanceId = safeIdentifier(pointer.instanceId);
  // A registered workspace must carry a usable instance pointer; a manual boot from an
  // explicit config may predate one, so identity checks are simply skipped there.
  if (strictIdentity) {
    if (!pointer.present) return configInvalid("instance_pointer_missing");
    if (!pointer.instanceId) return configInvalid("instance_id_missing");
    if (!sourceInstanceId) return configInvalid("instance_id_unusable");
  }

  const database = asRecord(config.database);
  const mode = typeof database?.mode === "string" ? database.mode : null;
  if (mode !== "embedded-postgres" && mode !== "postgres") {
    return configInvalid("database_mode_unsupported", sourceInstanceId);
  }

  const watched: WatchedConfigPath[] = [];
  for (const configKey of [
    "database.embeddedPostgresDataDir",
    "database.backup.dir",
    "logging.logDir",
    "storage.localDisk.baseDir",
    "secrets.localEncrypted.keyFilePath",
  ]) {
    const rawValue = readStringField(config, configKey);
    if (!rawValue) continue;
    watched.push({ configKey, resolved: resolveConfiguredPath(rawValue, sourceConfigDir) });
  }

  const expectedInstanceId = safeIdentifier(input.expectedSourceInstanceId);
  if (input.expectedSourceInstanceId && expectedInstanceId !== sourceInstanceId) {
    addFinding({
      reason: "source_instance_mismatch",
      configKey: ".env PAPERCLIP_INSTANCE_ID",
      detail: "registered_instance_mismatch",
      remediation:
        "Re-register the base project workspace whose .env instance matches the caller, or repoint that workspace's .env at the registered instance, then retry.",
    });
  }

  const identityRemediation =
    `Re-point the flagged keys at instance ${quotedIdentifier(sourceInstanceId)} with \`paperclip configure\` in the registered base workspace (or re-register the workspace that owns the other instance), then retry.`;
  const pointerConfigPath = pointer.configPath
    ? resolveConfiguredPath(pointer.configPath, sourceConfigDir)
    : null;
  if (pointerConfigPath && sourceInstanceId) {
    const pointerInstanceId = instanceIdFromPath(pointerConfigPath);
    if (pointerInstanceId && pointerInstanceId !== sourceInstanceId) {
      addFinding({
        reason: "source_instance_mismatch",
        configKey: ".env PAPERCLIP_CONFIG",
        detail: "instance_segment_mismatch",
        remediation: identityRemediation,
      });
    }
  }

  for (const entry of sourceInstanceId ? watched : []) {
    const referenced = instanceIdFromPath(entry.resolved);
    if (referenced && referenced !== sourceInstanceId) {
      addFinding({
        reason: "source_instance_mismatch",
        configKey: entry.configKey,
        detail: "instance_segment_mismatch",
        remediation: identityRemediation,
      });
    }
  }

  if (strictIdentity) {
    const sourcePathSegments = new Set(pathSegments(path.dirname(sourceConfigPath)));
    const identityPaths: Array<{ configKey: string; resolved: string }> = [
      ...watched.map((entry) => ({ configKey: entry.configKey, resolved: entry.resolved })),
      ...(pointer.home
        ? [{ configKey: ".env PAPERCLIP_HOME", resolved: resolveConfiguredPath(pointer.home, sourceConfigDir) }]
        : []),
      ...(pointerConfigPath ? [{ configKey: ".env PAPERCLIP_CONFIG", resolved: pointerConfigPath }] : []),
    ];
    for (const entry of identityPaths) {
      const markers = transientMarkersInPath(entry.resolved, sourcePathSegments);
      if (markers.length === 0) continue;
      addFinding({
        reason: "source_transient_worktree_identity",
        configKey: entry.configKey,
        detail: markers.sort().join("+"),
        remediation:
          "A registered primary workspace must point at durable host state. Restore its config from the live instance (`paperclip doctor`) and re-run worktree or `pcvt-` tests against an isolated PAPERCLIP_HOME so they cannot rewrite the shared checkout.",
      });
    }
  }

  let databaseState: WorktreeSeedSourceDatabaseState = "unknown";
  if (mode === "embedded-postgres") {
    const dataDirRaw = readStringField(config, "database.embeddedPostgresDataDir");
    const port = typeof database?.embeddedPostgresPort === "number" ? database.embeddedPostgresPort : null;
    if (!dataDirRaw) {
      addFinding({
        reason: "source_config_invalid",
        configKey: "database.embeddedPostgresDataDir",
        detail: "missing_setting",
        remediation: DOCTOR_REMEDIATION,
      });
    } else {
      const dataDir = resolveConfiguredPath(dataDirRaw, sourceConfigDir);
      const kind = statKind(dataDir);
      const dataDirDetail = kind === "missing"
        ? "missing"
        : kind === "other"
          ? "not_a_directory"
          : fileExists(path.join(dataDir, "PG_VERSION"))
            ? null
            : "uninitialized";
      if (dataDirDetail) {
        addFinding({
          reason: "source_data_dir_missing",
          configKey: "database.embeddedPostgresDataDir",
          detail: dataDirDetail,
          remediation:
            "Re-point database.embeddedPostgresDataDir at the live instance data directory (or restore it from a backup) and retry. A stopped database is fine; a missing data directory is not.",
        });
      } else if (port) {
        // An initialized data directory is enough: a closed port only means the
        // source is stopped, and the seed can start it from that data directory.
        databaseState = await probeTcp({ host: "127.0.0.1", port }) ? "reachable" : "stopped";
      }
    }
  } else {
    const connectionString = readStringField(config, "database.connectionString");
    const target = connectionString ? parseConnectionTarget(connectionString) : null;
    if (!connectionString) {
      addFinding({
        reason: "source_config_invalid",
        configKey: "database.connectionString",
        detail: "missing_setting",
        remediation: DOCTOR_REMEDIATION,
      });
    } else if (!target) {
      addFinding({
        reason: "source_config_invalid",
        configKey: "database.connectionString",
        detail: "connection_string_unparseable",
        remediation: DOCTOR_REMEDIATION,
      });
    } else if (await probeTcp(target)) {
      databaseState = "reachable";
    } else {
      addFinding({
        reason: "source_database_unreachable",
        configKey: "database.connectionString",
        detail: "tcp_connect_failed",
        remediation:
          "Start the source database, or fix database.connectionString host and port, then retry. An external source database cannot be started by the seed.",
      });
    }
  }

  return finalize({ findings, databaseState, sourceInstanceId });
}

function finalize(input: {
  findings: WorktreeSeedSourceReadinessFinding[];
  databaseState: WorktreeSeedSourceDatabaseState;
  sourceInstanceId: string | null;
}): WorktreeSeedSourceReadiness {
  const primary = pickReason(input.findings);
  if (!primary) {
    return {
      ok: true,
      phase: WORKTREE_SEED_SOURCE_PREFLIGHT_PHASE,
      reason: null,
      message: `Workspace seed source is ready (database ${input.databaseState}).`,
      remediation: null,
      findings: [],
      databaseState: input.databaseState,
      sourceInstanceId: input.sourceInstanceId,
    };
  }
  return {
    ok: false,
    phase: WORKTREE_SEED_SOURCE_PREFLIGHT_PHASE,
    reason: primary.reason,
    message: buildMessage({
      reason: primary.reason,
      findings: input.findings,
      sourceInstanceId: input.sourceInstanceId,
    }),
    remediation: primary.remediation,
    findings: input.findings,
    databaseState: input.databaseState,
    sourceInstanceId: input.sourceInstanceId,
  };
}

/** Single-line, secret-free failure text for a workspace operation or seed manifest. */
export function formatWorktreeSeedSourceReadinessFailure(readiness: WorktreeSeedSourceReadiness): string {
  if (readiness.ok) return readiness.message;
  return `Workspace seed source preflight (${readiness.phase}) failed [${readiness.reason}]: ${readiness.message} ${
    readiness.remediation ?? ""
  }`.trim();
}

export class WorktreeSeedSourceReadinessError extends Error {
  readonly readiness: WorktreeSeedSourceReadiness;
  readonly phase = WORKTREE_SEED_SOURCE_PREFLIGHT_PHASE;
  readonly reason: WorktreeSeedSourceReadinessReason | null;

  constructor(readiness: WorktreeSeedSourceReadiness) {
    super(formatWorktreeSeedSourceReadinessFailure(readiness));
    this.name = "WorktreeSeedSourceReadinessError";
    this.readiness = readiness;
    this.reason = readiness.reason;
  }
}

export function isWorktreeSeedSourceReadinessError(value: unknown): value is WorktreeSeedSourceReadinessError {
  return value instanceof WorktreeSeedSourceReadinessError;
}

/** Evaluate and throw a redacted, machine-readable error when the source is not ready. */
export async function assertWorktreeSeedSourceReady(
  input: WorktreeSeedSourceReadinessInput,
): Promise<WorktreeSeedSourceReadiness> {
  const readiness = await evaluateWorktreeSeedSourceReadiness(input);
  if (!readiness.ok) throw new WorktreeSeedSourceReadinessError(readiness);
  return readiness;
}
