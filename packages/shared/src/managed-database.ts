import { z } from "zod";

/**
 * Cross-repository contract for a Paperclip Cloud stack whose database is a
 * managed embedded PostgreSQL cluster on the stack's own volume.
 *
 * The Cloud harness writes `PAPERCLIP_MANAGED_DATABASE` (a JSON
 * `ManagedDatabaseConfig`) and `PAPERCLIP_MANAGED_DATABASE_CONTROL_KEY` on the
 * stack service. The image's supervisor (`server/dist/managed-database/main.js`)
 * validates them, runs PostgreSQL under a separate OS identity, and starts the
 * tenant app with a restricted local connection. The harness drives
 * maintenance through signed, stack-bound, lease-fenced commands.
 *
 * This module is pure (no Node built-ins) so the Cloud repository and the
 * server can share one definition. Signing lives in
 * `managed-database-server.ts`.
 */

export const MANAGED_DATABASE_CONTRACT_VERSION = 1 as const;
export const MANAGED_DATABASE_SUPPORTED_CONTRACT_VERSIONS = [1] as const;
/** PostgreSQL majors this release can run as a managed embedded engine. */
export const MANAGED_DATABASE_SUPPORTED_ENGINE_MAJORS = [18] as const;

export const MANAGED_DATABASE_ENV = {
  /** Harness → supervisor: JSON ManagedDatabaseConfig. */
  config: "PAPERCLIP_MANAGED_DATABASE",
  /** Harness → supervisor: base64 HMAC key (≥ 32 bytes). Never reaches the app. */
  controlKey: "PAPERCLIP_MANAGED_DATABASE_CONTROL_KEY",
  /** Supervisor → app. */
  provider: "PAPERCLIP_DATABASE_PROVIDER",
  pluginMigrationUrl: "PAPERCLIP_PLUGIN_MIGRATION_DATABASE_URL",
  readinessFile: "PAPERCLIP_MANAGED_DATABASE_READINESS_FILE",
  controlSocket: "PAPERCLIP_MANAGED_DATABASE_CONTROL_SOCKET",
  stackId: "PAPERCLIP_MANAGED_DATABASE_STACK_ID",
  configGeneration: "PAPERCLIP_MANAGED_DATABASE_CONFIG_GENERATION",
} as const;

/** Value of PAPERCLIP_DATABASE_PROVIDER for an app launched by the supervisor. */
export const MANAGED_EMBEDDED_DATABASE_PROVIDER = "managed-embedded" as const;

export const MANAGED_DATABASE_HTTP = {
  prefix: "/__paperclip/managed-database/v1",
  command: "/__paperclip/managed-database/v1/command",
  archive: "/__paperclip/managed-database/v1/archive",
  health: "/__paperclip/managed-database/v1/health",
  signatureHeader: "x-paperclip-managed-database-signature",
  /** GET archive only: the signed `snapshot.download` command, base64url JSON. */
  commandHeader: "x-paperclip-managed-database-command",
  archiveSha256Header: "x-paperclip-archive-sha256",
} as const;

/** Largest accepted command: a POST body or an upload preamble. */
export const MANAGED_DATABASE_MAX_COMMAND_BYTES = 256 * 1024;

/**
 * Start of a PUT archive body. The signed `snapshot.upload` command is one
 * line of JSON, then the archive bytes follow. It is not a header because its
 * receipt lists every table, which can exceed HTTP header limits.
 */
export function managedDatabaseUploadPreamble(command: unknown): string {
  return `${JSON.stringify(command)}\n`;
}

/** Maximum |now - issuedAt| accepted for a command. */
export const MANAGED_DATABASE_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const MANAGED_DATABASE_MAX_LEASE_TTL_SECONDS = 60 * 60;

/** Logical archive produced by `pg_dump --format=custom` of the tenant database. */
export const MANAGED_DATABASE_SNAPSHOT_FORMAT = "paperclip-pgdump-custom-v1" as const;

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const absolutePath = z.string().regex(/^\/[^\0]*$/).refine(
  (value) => value === "/" || (!value.endsWith("/") && !value.slice(1).split("/").some((part) => part === "" || part === "." || part === "..")),
  { message: "path must be absolute and normalized (no '.', '..', '//' or trailing '/')" },
);

export const managedDatabaseModeSchema = z.enum(["serving", "maintenance"]);
export type ManagedDatabaseMode = z.infer<typeof managedDatabaseModeSchema>;

export const managedDatabaseClusterSchema = z.discriminatedUnion("state", [
  z.object({
    /** Authorizes exactly one first initialization bound to initializationId. */
    state: z.literal("initialize"),
    initializationId: identifier,
  }).strict(),
  z.object({
    /** An established cluster. A missing cluster is a hard failure. */
    state: z.literal("existing"),
    initializationId: identifier,
    systemIdentifier: z.string().regex(/^[0-9]{1,20}$/),
  }).strict(),
]);
export type ManagedDatabaseCluster = z.infer<typeof managedDatabaseClusterSchema>;

export const managedDatabaseConfigSchema = z.object({
  v: z.literal(MANAGED_DATABASE_CONTRACT_VERSION),
  provider: z.literal("embedded"),
  stackId: identifier,
  configGeneration: z.number().int().positive(),
  engineMajor: z.number().int().positive(),
  mode: managedDatabaseModeSchema,
  volume: z.object({
    id: identifier,
    mountPath: absolutePath,
    /** Optional platform variable that must equal `id` (e.g. RAILWAY_VOLUME_ID). */
    idEnvVar: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).optional(),
  }).strict(),
  cluster: managedDatabaseClusterSchema,
  /** Supervisor-owned directory on the volume. Must be inside volume.mountPath. */
  root: absolutePath,
}).strict().superRefine((config, ctx) => {
  const mount = config.volume.mountPath.replace(/\/+$/, "");
  if (!config.root.startsWith(`${mount}/`)) {
    ctx.addIssue({ code: "custom", path: ["root"], message: "root must be inside volume.mountPath" });
  }
});
export type ManagedDatabaseConfig = z.infer<typeof managedDatabaseConfigSchema>;

export const managedDatabaseReleaseSchema = z.object({
  /** sha256 over the ordered bundled migration files and journal. */
  migrationsDigest: sha256Hex,
  latestMigration: z.string().min(1),
  migrationCount: z.number().int().nonnegative(),
  version: z.string().min(1),
  commit: z.string().nullable(),
}).strict();
export type ManagedDatabaseRelease = z.infer<typeof managedDatabaseReleaseSchema>;

export const managedDatabaseCapabilitySchema = z.object({
  contractVersions: z.array(z.number().int().positive()),
  engineMajors: z.array(z.number().int().positive()),
  engineVersion: z.string(),
  snapshotFormats: z.array(z.string()),
  release: managedDatabaseReleaseSchema,
}).strict();
export type ManagedDatabaseCapability = z.infer<typeof managedDatabaseCapabilitySchema>;

export const managedDatabaseLeaseRefSchema = z.object({
  id: identifier,
  epoch: z.number().int().positive(),
}).strict();
export type ManagedDatabaseLeaseRef = z.infer<typeof managedDatabaseLeaseRefSchema>;

const commandBase = {
  v: z.literal(MANAGED_DATABASE_CONTRACT_VERSION),
  stackId: identifier,
  configGeneration: z.number().int().positive(),
  commandId: identifier,
  issuedAt: z.string().datetime({ offset: true }),
};
const leased = { ...commandBase, lease: managedDatabaseLeaseRefSchema };

export const managedDatabaseCommandSchema = z.discriminatedUnion("kind", [
  z.object({ ...commandBase, kind: z.literal("status"), args: z.object({}).strict().default({}) }).strict(),
  z.object({
    ...commandBase,
    /**
     * Reconcile an earlier command whose response was lost. Read-only and
     * never stored. Unlike replaying the original command, it works after the
     * replay window has passed or the configuration generation has changed.
     */
    kind: z.literal("receipt.get"),
    args: z.object({
      commandId: identifier,
      /** sha256 of canonicalJson(original command); binds the answer to that exact request. */
      requestSha256: sha256Hex,
    }).strict(),
  }).strict(),
  z.object({
    ...commandBase,
    kind: z.literal("lease.acquire"),
    args: z.object({
      holder: z.string().min(1).max(200),
      ttlSeconds: z.number().int().min(10).max(MANAGED_DATABASE_MAX_LEASE_TTL_SECONDS),
    }).strict(),
  }).strict(),
  z.object({
    ...leased,
    kind: z.literal("lease.renew"),
    args: z.object({ ttlSeconds: z.number().int().min(10).max(MANAGED_DATABASE_MAX_LEASE_TTL_SECONDS) }).strict(),
  }).strict(),
  z.object({ ...leased, kind: z.literal("lease.release"), args: z.object({}).strict().default({}) }).strict(),
  z.object({ ...leased, kind: z.literal("snapshot.create"), args: z.object({}).strict().default({}) }).strict(),
  z.object({ ...leased, kind: z.literal("snapshot.download"), args: z.object({ snapshotId: identifier }).strict() }).strict(),
  z.object({
    ...leased,
    kind: z.literal("snapshot.upload"),
    args: z.object({ receipt: z.unknown() }).strict(),
  }).strict(),
  z.object({ ...leased, kind: z.literal("snapshot.delete"), args: z.object({ snapshotId: identifier }).strict() }).strict(),
  z.object({ ...leased, kind: z.literal("snapshot.restore"), args: z.object({ snapshotId: identifier }).strict() }).strict(),
  z.object({ ...leased, kind: z.literal("restore.discard"), args: z.object({ database: z.string().regex(/^paperclip_pre_restore_[a-z0-9_]{1,40}$/) }).strict() }).strict(),
  z.object({
    ...leased,
    kind: z.literal("schema.migrate"),
    args: z.object({
      snapshotId: identifier,
      release: managedDatabaseReleaseSchema,
    }).strict(),
  }).strict(),
]);
export type ManagedDatabaseCommand = z.infer<typeof managedDatabaseCommandSchema>;
export type ManagedDatabaseCommandKind = ManagedDatabaseCommand["kind"];

/**
 * `details` of a succeeded `receipt.get` receipt.
 * - `found`: `receipt` is the original command's signed receipt (succeeded or failed).
 * - `running`: the command is executing now; look it up again later.
 * - `unknown`: no receipt was recorded. The command was never accepted, or the
 *   container stopped before it finished; `hold` names an interrupted migration
 *   or restore. Never treat `unknown` as permission to resend a stale command.
 */
export type ManagedDatabaseReceiptLookup =
  | { state: "found"; commandId: string; receipt: ManagedDatabaseReceipt; hold: ManagedDatabaseHold | null }
  | { state: "running" | "unknown"; commandId: string; receipt: null; hold: ManagedDatabaseHold | null };

/** Commands that change database, lease, or archive state. */
export const MANAGED_DATABASE_MUTATING_KINDS: readonly ManagedDatabaseCommandKind[] = [
  "snapshot.create",
  "snapshot.upload",
  "snapshot.delete",
  "snapshot.restore",
  "restore.discard",
  "schema.migrate",
];
/** Commands accepted only while the stack runs in maintenance mode. */
export const MANAGED_DATABASE_MAINTENANCE_ONLY_KINDS: readonly ManagedDatabaseCommandKind[] = [
  "snapshot.upload",
  "snapshot.restore",
  "restore.discard",
  "schema.migrate",
];

export const MANAGED_DATABASE_REJECTION_CODES = [
  "bad_signature",
  "invalid_command",
  "wrong_stack",
  "stale_generation",
  "clock_skew",
  "lease_stale",
  "lease_conflict",
  "busy",
  "mode_forbidden",
  "command_id_conflict",
  "not_found",
  "precondition_failed",
  "recovery_hold",
  "unsupported",
] as const;
export type ManagedDatabaseRejectionCode = (typeof MANAGED_DATABASE_REJECTION_CODES)[number];

export const managedDatabaseSchemaStateSchema = z.enum(["current", "pending", "ahead", "empty", "unknown"]);
export type ManagedDatabaseSchemaState = z.infer<typeof managedDatabaseSchemaStateSchema>;

export const managedDatabaseHoldSchema = z.object({
  reason: z.enum(["migration_failed", "migration_interrupted", "restore_interrupted", "engine_recovery_exhausted"]),
  commandId: z.string().nullable(),
  since: z.string(),
  detail: z.string().nullable(),
}).strict();
export type ManagedDatabaseHold = z.infer<typeof managedDatabaseHoldSchema>;

/** Readiness identity: what the running container actually serves. */
export const managedDatabaseReadinessSchema = z.object({
  v: z.literal(MANAGED_DATABASE_CONTRACT_VERSION),
  stackId: identifier,
  configGeneration: z.number().int().positive(),
  mode: managedDatabaseModeSchema,
  status: z.enum(["starting", "maintenance", "serving", "recovery"]),
  volumeId: identifier,
  initializationId: identifier,
  systemIdentifier: z.string().nullable(),
  engineVersion: z.string().nullable(),
  engineMajor: z.number().int().positive(),
  release: managedDatabaseReleaseSchema,
  schema: z.object({
    state: managedDatabaseSchemaStateSchema,
    appliedCount: z.number().int().nonnegative(),
    latestApplied: z.string().nullable(),
  }).strict(),
  hold: managedDatabaseHoldSchema.nullable(),
  appRunning: z.boolean(),
  updatedAt: z.string(),
}).strict();
export type ManagedDatabaseReadiness = z.infer<typeof managedDatabaseReadinessSchema>;

export const managedDatabaseSnapshotReceiptDetailsSchema = z.object({
  snapshotId: identifier,
  format: z.literal(MANAGED_DATABASE_SNAPSHOT_FORMAT),
  consistency: z.enum(["quiesced", "online"]),
  sha256: sha256Hex,
  sizeBytes: z.number().int().nonnegative(),
  stackId: identifier,
  volumeId: identifier,
  systemIdentifier: z.string(),
  engineVersion: z.string(),
  engineMajor: z.number().int().positive(),
  database: z.string(),
  /** Migration journal fingerprint inside the archive, independent of any image's bundle. */
  journal: z.object({
    entries: z.number().int().nonnegative(),
    digest: sha256Hex,
    latestApplied: z.string().nullable(),
  }).strict(),
  /** Exact per-table row counts taken in the dump's own snapshot. */
  tableRowCounts: z.record(z.string(), z.number().int().nonnegative()),
  createdAt: z.string(),
}).strict();
export type ManagedDatabaseSnapshotReceiptDetails = z.infer<typeof managedDatabaseSnapshotReceiptDetailsSchema>;

export const managedDatabaseReceiptSchema = z.object({
  v: z.literal(MANAGED_DATABASE_CONTRACT_VERSION),
  commandId: identifier,
  kind: z.string(),
  stackId: identifier,
  configGeneration: z.number().int().positive(),
  lease: managedDatabaseLeaseRefSchema.nullable(),
  outcome: z.enum(["succeeded", "failed", "rejected"]),
  code: z.string().nullable(),
  error: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
  requestSha256: sha256Hex,
  startedAt: z.string(),
  finishedAt: z.string(),
  /** HMAC-SHA256 (purpose "receipt") over canonicalJson of every other field. */
  signature: z.string().regex(/^v1=[0-9a-f]{64}$/),
}).strict();
export type ManagedDatabaseReceipt = z.infer<typeof managedDatabaseReceiptSchema>;
export type UnsignedManagedDatabaseReceipt = Omit<ManagedDatabaseReceipt, "signature">;

/**
 * Deterministic JSON: object keys sorted, no whitespace, `undefined` members
 * dropped. Both signer and verifier must use this exact encoding.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("canonicalJson: non-finite number");
    }
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("canonicalJson: unsupported value");
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export type ManagedDatabaseConfigParseResult =
  | { status: "absent" }
  | { status: "invalid"; error: string }
  | { status: "valid"; config: ManagedDatabaseConfig };

/** Parse PAPERCLIP_MANAGED_DATABASE. Blank or malformed is invalid, never absent. */
export function parseManagedDatabaseConfig(raw: string | undefined): ManagedDatabaseConfigParseResult {
  if (raw === undefined) return { status: "absent" };
  if (raw.trim().length === 0) return { status: "invalid", error: `${MANAGED_DATABASE_ENV.config} is blank` };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { status: "invalid", error: `${MANAGED_DATABASE_ENV.config} is not valid JSON` };
  }
  const parsed = managedDatabaseConfigSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { status: "invalid", error: `${MANAGED_DATABASE_ENV.config} is invalid: ${issues}` };
  }
  return { status: "valid", config: parsed.data };
}
