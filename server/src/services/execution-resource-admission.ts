import { execFile } from "node:child_process";
import { and, asc, eq, ne, or, sql } from "drizzle-orm";
import { agents, heartbeatRuns, type Db } from "@paperclipai/db";
import { redactSensitiveText } from "../redaction.js";

/** Repository transaction pattern: the handle a `db.transaction` callback gets. */
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbLike = Pick<Db, "select">;

interface ResourceDemand {
  pool: string;
  cpu: number;
  memoryMb: number;
  provider: string;
}

interface ResourceCapacity {
  cpu: number;
  memoryMb: number;
  providers: Record<string, number>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function readExecutionResourceRequest(config: unknown): ResourceDemand | null {
  if (!record(config) || config.executionResources === undefined) return null;
  const value = config.executionResources;
  if (!record(value) || typeof value.pool !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.pool)
    || typeof value.provider !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.provider)
    || !positive(value.cpu) || !positive(value.memoryMb) || !Number.isSafeInteger(value.memoryMb)) {
    throw new Error("Invalid executionResources: expected pool, provider, positive cpu and integer memoryMb");
  }
  return { pool: value.pool, provider: value.provider, cpu: value.cpu, memoryMb: value.memoryMb };
}

function poolCapacity(env: Record<string, string | undefined>, pool: string): ResourceCapacity {
  let pools: unknown;
  try { pools = JSON.parse(env.PAPERCLIP_EXECUTION_RESOURCE_POOLS ?? "{}"); }
  catch { throw new Error("PAPERCLIP_EXECUTION_RESOURCE_POOLS must be a JSON object"); }
  const value = record(pools) && Object.hasOwn(pools, pool) ? pools[pool] : null;
  if (!record(value) || !positive(value.cpu) || !positive(value.memoryMb)
    || !Number.isSafeInteger(value.memoryMb) || !record(value.providers)
    || Object.values(value.providers).some((limit) => !positive(limit) || !Number.isSafeInteger(limit))) {
    throw new Error(`Missing or invalid operator capacity for execution resource pool ${pool}`);
  }
  return { cpu: value.cpu, memoryMb: value.memoryMb, providers: value.providers as Record<string, number> };
}

// ---------------------------------------------------------------------------
// Runner-reported resource waits
// ---------------------------------------------------------------------------
//
// A contained runner (the delivery framework's launcher, reached through the
// legacy `process` adapter) can stop before any model starts because another
// live writer already owns the same canonical writer root — either at
// pre-dispatch name admission or on the in-container canonical target lease
// that re-checks the admitted revision. Both are contention, not failure: no
// model ran, no execution or repair attempt was consumed, and the run must be
// re-admitted once the owner finishes.
//
// The runner reports that outcome as a structured envelope, and native maps it
// onto its own workspace-busy deferral, so native and framework contention
// share one no-budget resource wait instead of two different failure shapes.
//
// The envelope is never authority by itself. Native accepts it only when the
// child exited with the reserved resource-wait code, the envelope names a
// known reason code, it records that no model started, and the run identity
// matches. A worker that prints the same JSON, or a genuinely failing run that
// merely exits 95, stays a failure.

export const RUNNER_RESOURCE_WAIT_ENVELOPE_SCHEMA_VERSION = 1;
export const RUNNER_RESOURCE_WAIT_ADMISSION_KIND = "run_admission";
export const RUNNER_RESOURCE_WAIT_ADMISSION_STATUS = "deferred";
export const RUNNER_TIMEOUT_ENVELOPE_KIND = "run_timeout";
/** Reserved launcher exit code for a refused (never-dispatched) run. */
export const RUNNER_RESOURCE_WAIT_EXIT_CODE = 95;
/** Container supervisor timeout code (unchanged; classified, never a wait). */
export const RUNNER_TIMEOUT_EXIT_CODE = 124;
/** Native error code recorded for a deferred run (`WORKSPACE_BUSY_ERROR_CODE`). */
export const RUNNER_RESOURCE_WAIT_ERROR_CODE = "workspace_busy";

export const RUNNER_RESOURCE_WAIT_REASON_CODES = {
  writerRootBusy: "writer_root_busy",
  canonicalTargetConflict: "canonical_target_conflict",
} as const;

export type RunnerResourceWaitReasonCode =
  (typeof RUNNER_RESOURCE_WAIT_REASON_CODES)[keyof typeof RUNNER_RESOURCE_WAIT_REASON_CODES];

const RUNNER_RESOURCE_WAIT_REASON_CODE_SET: Record<string, true> = {
  [RUNNER_RESOURCE_WAIT_REASON_CODES.writerRootBusy]: true,
  [RUNNER_RESOURCE_WAIT_REASON_CODES.canonicalTargetConflict]: true,
};

export type RunnerResourceWait = {
  reasonCode: RunnerResourceWaitReasonCode;
  detail: string | null;
  owner: string | null;
  nextAction: string | null;
  retryCondition: string | null;
  containerName: string | null;
};

/** Wait evidence the deferral carries: a contained runner's refusal, or native
 * admission refusing a canonical writer root held by another live run. */
export type WriterRootWaitEvidence = RunnerResourceWait | {
  reasonCode: typeof NATIVE_WRITER_ROOT_BUSY_REASON_CODE;
  detail: string;
  owner: string | null;
  nextAction: string;
  retryCondition: string;
  containerName: null;
  holderRunId: string;
  holderIssueId: string | null;
};

export type RunnerTimeoutEvidence = {
  sessionId: string | null;
  modelStarted: boolean;
  resumable: boolean;
  progress: {
    requests: number;
    denials: number;
    lastRequestAt: string | null;
  } | null;
};

// The launcher prints its run summary as the last stdout line and the adapter
// prints its durable admission record after that, so the envelope is always at
// the tail. The scan bound keeps a chatty worker from making this walk the
// whole (4 MiB-capped) capture.
const RUNNER_ENVELOPE_SCAN_LINES = 64;

function readTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function parseEnvelopeLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return record(parsed) ? parsed : null;
}

function readRunnerEnvelope(input: {
  stdout: string | null | undefined;
  kind: string;
  runId: string;
}): Record<string, unknown> | null {
  const lines = (input.stdout ?? "").split("\n");
  let scanned = 0;
  for (let index = lines.length - 1; index >= 0 && scanned < RUNNER_ENVELOPE_SCAN_LINES; index -= 1) {
    scanned += 1;
    const envelope = parseEnvelopeLine(lines[index] ?? "");
    if (!envelope) continue;
    if (envelope.schemaVersion !== RUNNER_RESOURCE_WAIT_ENVELOPE_SCHEMA_VERSION) continue;
    if (envelope.kind !== input.kind) continue;
    if (readTrimmedString(envelope.runId) !== input.runId) continue;
    return envelope;
  }
  return null;
}

/** Reads a refused-before-model run reported by the contained runner. */
export function readRunnerResourceWait(input: {
  exitCode: number | null | undefined;
  stdout: string | null | undefined;
  runId: string;
}): RunnerResourceWait | null {
  if (input.exitCode !== RUNNER_RESOURCE_WAIT_EXIT_CODE) return null;
  const envelope = readRunnerEnvelope({
    stdout: input.stdout,
    kind: RUNNER_RESOURCE_WAIT_ADMISSION_KIND,
    runId: input.runId,
  });
  if (!envelope) return null;
  if (envelope.status !== RUNNER_RESOURCE_WAIT_ADMISSION_STATUS) return null;
  if (envelope.modelStarted !== false) return null;
  const reasonCode = readTrimmedString(envelope.reasonCode);
  if (!reasonCode || RUNNER_RESOURCE_WAIT_REASON_CODE_SET[reasonCode] !== true) return null;
  return {
    reasonCode: reasonCode as RunnerResourceWaitReasonCode,
    detail: readTrimmedString(envelope.detail),
    owner: readTrimmedString(envelope.owner),
    nextAction: readTrimmedString(envelope.nextAction),
    retryCondition: readTrimmedString(envelope.retryCondition),
    containerName: readTrimmedString(envelope.containerName),
  };
}

const RUNNER_ADMISSION_REJECTIONS: Readonly<Record<number, string>> = {
  96: "image_prerequisite_missing",
  97: "host_pi_unavailable",
  98: "broker_unavailable",
  99: "containment_unavailable",
};

/** Failure evidence only: these refusals never authorize a resource-wait retry. */
export function readRunnerAdmissionRejection(input: {
  exitCode: number | null | undefined;
  stdout: string | null | undefined;
  runId: string;
}) {
  const reasonCode = RUNNER_ADMISSION_REJECTIONS[input.exitCode ?? -1];
  if (!reasonCode) return null;
  const envelope = readRunnerEnvelope({
    stdout: input.stdout,
    kind: RUNNER_RESOURCE_WAIT_ADMISSION_KIND,
    runId: input.runId,
  });
  if (
    !envelope
    || envelope.status !== "rejected"
    || envelope.modelStarted !== false
    || envelope.exitCode !== input.exitCode
    || envelope.reasonCode !== reasonCode
  ) return null;
  return {
    reasonCode,
    modelStarted: false,
    phase: readTrimmedString(envelope.phase),
    nextAction: readTrimmedString(envelope.nextAction),
  };
}

/**
 * Reads the resumable evidence a timed-out contained run reports. A timeout is
 * still a timeout; this only tells native whether the run reached the model and
 * how much work it did, so the bounded continuation can resume the same worker
 * session from its checkpoint instead of restarting the task from scratch.
 */
export function readRunnerTimeoutEvidence(input: {
  exitCode: number | null | undefined;
  stdout: string | null | undefined;
  runId: string;
}): RunnerTimeoutEvidence | null {
  if (input.exitCode !== RUNNER_TIMEOUT_EXIT_CODE) return null;
  const envelope = readRunnerEnvelope({
    stdout: input.stdout,
    kind: RUNNER_TIMEOUT_ENVELOPE_KIND,
    runId: input.runId,
  });
  if (!envelope) return null;
  if (envelope.modelStarted !== true) return null;
  const progressRecord = record(envelope.progress) ? envelope.progress : null;
  return {
    sessionId: readTrimmedString(envelope.sessionId),
    modelStarted: true,
    resumable: envelope.resumable === true,
    progress: progressRecord
      ? {
          requests: readCount(progressRecord.requests),
          denials: readCount(progressRecord.denials),
          lastRequestAt: readTrimmedString(progressRecord.lastRequestAt),
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Canonical writer-root admission (operator-configured resolver)
// ---------------------------------------------------------------------------
//
// The framework resolves the canonical writable lane a run may mutate and
// reports it as a receipt: `isolated` (no writer), `read_only`, or `exclusive`
// with a `writerRootKey`. Native consumes that receipt BEFORE dispatch so two
// runs that share one physical writer root are serialized by native scheduling
// instead of colliding inside the VM.
//
// The resolver is explicit operator provisioning on the agent's adapter
// config; nothing else selects it, and no model, task or wake value can supply
// a command, path or argument. An adapter without it keeps the previous
// behaviour unchanged.
//
// Every admitted access mode carries the canonical physical identity of the lane
// it will touch, and native reserves that root before dispatch:
//
// - exclusive conflicts with ANY live holder of the root;
// - read_only coexists with other readers and is refused only by a live writer;
// - isolated touches no canonical lane and reserves nothing.
//
// The receipt's `configIdentity` is a decision identity, never a physical one:
// two runs on one root with different access share the root key and differ in
// decision identity. Reservation is a cross-company advisory lock plus the run's
// own persisted context, so it covers every company sharing the physical host,
// and it is released when the run leaves `running` — authoritative lifecycle,
// never age: a quiet live writer still owns its root. The in-container
// hierarchical canonical leases remain the race backstop for overlaps this gate
// cannot see.

export const EXECUTION_WRITER_RESOURCE_RECEIPT_KIND = "paperclip_execution_writer_resource";
export const EXECUTION_WRITER_RESOURCE_SCHEMA_VERSION = 1;
export const EXECUTION_WRITER_RESOURCE_ACCESS = {
  isolated: "isolated",
  readOnly: "read_only",
  exclusive: "exclusive",
} as const;
const EXECUTION_WRITER_ROOT_KEY_RE = /^writer-root-v1:[0-9a-f]{64}$/;
const EXECUTION_WRITER_CONFIG_IDENTITY_RE = /^writer-config-v1:[0-9a-f]{64}$/;
const RESOLVER_TIMEOUT_DEFAULT_MS = 15_000;
const RESOLVER_TIMEOUT_MIN_MS = 1_000;
const RESOLVER_TIMEOUT_MAX_MS = 60_000;
/** Native-side reason for a run deferred by its own writer-root admission. The
 * framework's own refusal reasons are separate; this one never appears in a
 * runner envelope. */
export const NATIVE_WRITER_ROOT_BUSY_REASON_CODE = "canonical_writer_root_busy";

export type ExecutionResourceResolverConfig = {
  command: string;
  entry: string;
  template: string;
  timeoutMs: number;
};

export type ExecutionWriterResourceReceipt = {
  access: (typeof EXECUTION_WRITER_RESOURCE_ACCESS)[keyof typeof EXECUTION_WRITER_RESOURCE_ACCESS];
  writerRootKey: string | null;
  configIdentity: string;
};

export type ExecutionWriterRootHolder = {
  runId: string;
  agentId: string;
  issueId: string | null;
  issueIdentifier: string | null;
};

function absolutePath(value: unknown): string | null {
  return typeof value === "string" && value.startsWith("/") && value.length > 1 && !value.includes("\0")
    ? value
    : null;
}

/** Validates the operator-owned resolver provisioning. A partially specified or
 * relative configuration is refused rather than silently ignored: provisioning
 * exists to be enforced, not to be best-effort. */
export function readExecutionResourceResolverConfig(value: unknown): ExecutionResourceResolverConfig | null {
  if (value === null || value === undefined) return null;
  if (!record(value)) {
    throw new Error("executionResourceResolver must be an object with absolute command, entry and template paths");
  }
  const command = absolutePath(value.command);
  const entry = absolutePath(value.entry);
  const template = absolutePath(value.template);
  if (!command || !entry || !template) {
    throw new Error("executionResourceResolver requires absolute command, entry and template paths");
  }
  const timeoutMs = value.timeoutMs === undefined || value.timeoutMs === null
    ? RESOLVER_TIMEOUT_DEFAULT_MS
    : value.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < RESOLVER_TIMEOUT_MIN_MS || timeoutMs > RESOLVER_TIMEOUT_MAX_MS) {
    throw new Error(
      `executionResourceResolver.timeoutMs must be an integer between ${RESOLVER_TIMEOUT_MIN_MS} and ${RESOLVER_TIMEOUT_MAX_MS}`,
    );
  }
  return { command, entry, template, timeoutMs };
}

/** Parses the resolver's stdout receipt. The receipt is the only accepted
 * shape: an unreadable or unexpected report fails closed. */
export function parseExecutionWriterResourceReceipt(stdout: string): ExecutionWriterResourceReceipt | null {
  const lines = stdout.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? "").trim();
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record(parsed)) continue;
    if (parsed.schemaVersion !== EXECUTION_WRITER_RESOURCE_SCHEMA_VERSION) continue;
    if (parsed.kind !== EXECUTION_WRITER_RESOURCE_RECEIPT_KIND) continue;
    const access = parsed.access;
    if (access !== EXECUTION_WRITER_RESOURCE_ACCESS.isolated
      && access !== EXECUTION_WRITER_RESOURCE_ACCESS.readOnly
      && access !== EXECUTION_WRITER_RESOURCE_ACCESS.exclusive) continue;
    const configIdentity = typeof parsed.configIdentity === "string" ? parsed.configIdentity : null;
    if (!configIdentity || !EXECUTION_WRITER_CONFIG_IDENTITY_RE.test(configIdentity)) continue;
    const rawWriterRootKey = parsed.writerRootKey;
    if (access === EXECUTION_WRITER_RESOURCE_ACCESS.isolated) {
      // An isolated run touches no canonical lane; a key here would contradict
      // the access the resolver reported.
      if (rawWriterRootKey !== null && rawWriterRootKey !== undefined) continue;
      return { access, writerRootKey: null, configIdentity };
    }
    // Both read_only and exclusive carry the canonical physical identity, which
    // is what native serializes read/write overlap on. A receipt without it is
    // unusable: native must never admit a run whose lane it cannot identify.
    if (typeof rawWriterRootKey !== "string" || !EXECUTION_WRITER_ROOT_KEY_RE.test(rawWriterRootKey)) continue;
    return { access, writerRootKey: rawWriterRootKey, configIdentity };
  }
  return null;
}

/**
 * Live holders of one canonical writer root, oldest first.
 *
 * Read/write compatibility is the whole point: `exclusive` conflicts with ANY
 * live holder of the root, while `read_only` coexists with other readers and is
 * refused by a live writer. A holder whose persisted receipt carries no
 * canonical root — a reservation written before the receipt named the physical
 * lane — is conservatively treated as touching this root, and a holder of THIS
 * root whose access cannot be read is treated as a writer. Overlap is never
 * assumed safe because a holder is unidentified.
 *
 * A holder is released by the authoritative run lifecycle, never by its age:
 * the reservation stops counting when the run leaves `running`. A quiet-but-live
 * run is NOT an available root — a silent writer is still a writer, so waiting
 * is the only safe answer.
 */
async function selectCanonicalWriterRootHolders(
  dbOrTx: DbLike,
  input: { writerRootKey: string; excludeRunId?: string | null },
) {
  return await dbOrTx
    .select({
      runId: heartbeatRuns.id,
      agentId: heartbeatRuns.agentId,
      issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`,
      holderAccess: sql<string | null>`${heartbeatRuns.contextSnapshot} -> 'executionWriterResource' ->> 'access'`,
      sameRoot: sql<boolean>`${heartbeatRuns.contextSnapshot} -> 'executionWriterResource' ->> 'writerRootKey' = ${input.writerRootKey}`,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.status, "running"),
        input.excludeRunId ? ne(heartbeatRuns.id, input.excludeRunId) : sql`true`,
        or(
          sql`${heartbeatRuns.contextSnapshot} -> 'executionWriterResource' ->> 'writerRootKey' = ${input.writerRootKey}`,
          // Unidentified live holder of an admitted lane: conservatively
          // blocking, because it may be touching this same root.
          and(
            sql`${heartbeatRuns.contextSnapshot} -> 'executionWriterResource' ->> 'access' in ('read_only', 'exclusive')`,
            sql`coalesce(${heartbeatRuns.contextSnapshot} -> 'executionWriterResource' ->> 'writerRootKey', '') = ''`,
          ),
        ),
      ),
    )
    .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id));
}

/** True when a string is a canonical writer-root key. Callers that persist or
 * parse a wait key use this instead of re-deriving the receipt key format. */
export function isWriterRootWaitKey(value: unknown): value is string {
  return typeof value === "string" && EXECUTION_WRITER_ROOT_KEY_RE.test(value);
}

/**
 * Whether a live holder conflicts with a new reservation for `requestedAccess`.
 * The single predicate both admission and the queued-wait probe use:
 *
 * - a holder whose persisted receipt names no canonical root is conservatively
 *   treated as touching this root,
 * - `exclusive` (and an unreadable request) conflicts with ANY live holder,
 * - `read_only` conflicts only with a holder that is not a verified reader, so
 *   readers wait behind writers but never behind each other.
 */
function holderConflictsWithRequest(
  holder: { sameRoot: boolean | null; holderAccess: string | null },
  requestedAccess: ExecutionWriterResourceReceipt["access"],
) {
  if (holder.sameRoot !== true) return true;
  if (requestedAccess !== EXECUTION_WRITER_RESOURCE_ACCESS.readOnly) return true;
  return holder.holderAccess !== EXECUTION_WRITER_RESOURCE_ACCESS.readOnly;
}

/** The live holder a queued wait must keep waiting for, if any. Callers use this
 * outside the admission transaction to decide between claiming and re-arming the
 * same waiting run; the in-transaction admission below stays authoritative and
 * applies the same conflict predicate, so a read-only waiter is not parked behind
 * readers the admission would have admitted alongside.
 * The lookup is intentionally not company-scoped: a canonical writer root is one
 * physical host resource, so another company's live holder still owns it. */
export async function findCanonicalWriterRootHolder(
  db: DbLike,
  input: {
    writerRootKey: string;
    requestedAccess: ExecutionWriterResourceReceipt["access"];
    excludeRunId?: string | null;
  },
): Promise<ExecutionWriterRootHolder | null> {
  const holders = await selectCanonicalWriterRootHolders(db, input);
  const holder = holders.find((candidate) =>
    holderConflictsWithRequest(candidate, input.requestedAccess),
  ) ?? null;
  return holder
    ? {
        runId: holder.runId,
        agentId: holder.agentId,
        issueId: holder.issueId,
        issueIdentifier: null,
      }
    : null;
}

/**
 * Atomically reserve one canonical writer root for this run.
 *
 * Read/write compatibility is the whole point: `exclusive` conflicts with ANY
 * live holder of the root, while `read_only` coexists with other readers and is
 * refused by a live writer. Because the reservation is the run's own persisted
 * context, both modes must take it: a reader that did not record itself could not
 * be seen by a writer arriving later.
 *
 * The advisory lock spans companies because a canonical root is a physical host
 * resource, so two companies sharing one host serialize against each other too.
 *
 * A holder is released by the authoritative run lifecycle, never by its age: the
 * reservation stops counting when the run leaves `running` (terminal
 * disposition), and a quiet-but-live run is NOT an available root — a silent
 * writer is still a writer, so waiting is the only safe answer. The in-container
 * canonical leases remain the backstop for anything this gate cannot see.
 *
 * A live holder whose persisted receipt carries no canonical root — a
 * reservation written before the receipt named the physical lane — is treated as
 * touching this root, and a holder of THIS root whose access cannot be read is
 * treated as a writer. Overlap is never assumed safe because a holder is
 * unidentified.
 */
export async function admitCanonicalWriterRoot(
  tx: DbTransaction,
  input: {
    companyId: string;
    runId: string;
    receipt: ExecutionWriterResourceReceipt;
  },
): Promise<{ admitted: true } | { admitted: false; holder: ExecutionWriterRootHolder }> {
  const writerRootKey = input.receipt.writerRootKey;
  if (!writerRootKey) {
    throw new Error("canonical writer-root admission requires a writerRootKey");
  }
  const exclusive = input.receipt.access === EXECUTION_WRITER_RESOURCE_ACCESS.exclusive;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`canonical-writer-root:${writerRootKey}`}, 0))`);
  const holders = await selectCanonicalWriterRootHolders(tx as unknown as DbLike, {
    writerRootKey,
    excludeRunId: input.runId,
  });
  // A holder of the same root conflicts unless it is a VERIFIED reader and we are
  // a reader too; the shared predicate owns that rule for both this admission and
  // the queued-wait probe, so the two can never disagree.
  const conflict = holders.find((holder) =>
    holderConflictsWithRequest(
      holder,
      exclusive
        ? EXECUTION_WRITER_RESOURCE_ACCESS.exclusive
        : EXECUTION_WRITER_RESOURCE_ACCESS.readOnly,
    ),
  );
  if (conflict) {
    return {
      admitted: false,
      holder: {
        runId: conflict.runId,
        agentId: conflict.agentId,
        issueId: conflict.issueId,
        issueIdentifier: null,
      },
    };
  }
  await tx
    .update(heartbeatRuns)
    .set({
      contextSnapshot: sql`jsonb_set(
        coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb),
        '{executionWriterResource}',
        ${JSON.stringify(input.receipt)}::jsonb,
        true
      )`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.companyId, input.companyId),
      ),
    );
  return { admitted: true };
}

/** Stable prefix for a resolver subprocess failure. The message class is
 * technical: the run must not dispatch, but it is not a missing setting. */
export const EXECUTION_RESOURCE_RESOLVER_FAILED_PREFIX = "execution resource resolver failed";

export type ExecutionResourceResolverFailureReason =
  | "nonzero_exit"
  | "timeout"
  | "spawn_failed"
  | "invalid_receipt";

/** The stable failure contract for a resolver that could not prove a lane.
 * Consumers classify on `reason` and on the error's own type, never on text. */
export type ExecutionResourceResolverFailureInfo = {
  reason: ExecutionResourceResolverFailureReason;
  exitCode: number | null;
  signal: string | null;
  stderrExcerpt: string | null;
};

/** Thrown when the operator-configured resolver cannot produce a valid receipt.
 * It is deliberately a typed failure with a stable reason: the run stays
 * fail-closed, and recovery consumes the class instead of guessing from text. */
export class ExecutionResourceResolverError extends Error {
  readonly info: ExecutionResourceResolverFailureInfo;

  constructor(message: string, info: ExecutionResourceResolverFailureInfo) {
    super(message);
    this.name = "ExecutionResourceResolverError";
    this.info = info;
  }
}

/** Bounded, redacted stderr excerpt for diagnosis.
 *
 * The historical cause of the resolver exit-1 incidents is unreachable because
 * the stderr was discarded; this keeps the tail without dumping arbitrary text
 * or secrets: non-empty lines only, last five, single line, redacted, capped. */
export function readExecutionResourceResolverStderrExcerpt(
  stderr: string | null | undefined,
): string | null {
  const lines = (stderr ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return null;
  const redacted = redactSensitiveText(lines.slice(-5).join(" | ")).trim();
  if (!redacted) return null;
  return redacted.length > 400 ? `${redacted.slice(0, 399)}…` : redacted;
}

/**
 * Invoke the operator-configured resolver for one run scope.
 *
 * argv is fixed by this function — executable, entry, template, subcommand and
 * the JSON scope — and the scope carries only native identities. There is no
 * shell, so no value can become an option or a command. Any nonzero exit,
 * timeout, missing receipt or malformed report throws: once an operator opts an
 * adapter into writer-root admission, a run that cannot prove its writer
 * identity must not start.
 *
 * The throw is a technical execution failure, not a configuration verdict: the
 * caller keeps the run fail-closed and lets the existing setup-failure recovery
 * own it. Only the operator's own missing scope (no project identity) is a
 * configuration gate for a human owner.
 */
export async function resolveExecutionWriterResourceReceipt(input: {
  resolver: ExecutionResourceResolverConfig;
  scope: { companyId: string; projectId: string; workMode: string | null };
}): Promise<ExecutionWriterResourceReceipt> {
  const scope = {
    companyId: input.scope.companyId,
    projectId: input.scope.projectId,
    workMode: input.scope.workMode,
  };
  const stdout = await new Promise<string>((resolvePromise, rejectPromise) => {
    execFile(
      input.resolver.command,
      [
        input.resolver.entry,
        input.resolver.template,
        "--resolve-execution-resource",
        JSON.stringify(scope),
      ],
      { timeout: input.resolver.timeoutMs, maxBuffer: 1_048_576 },
      (error, out, err) => {
        if (error) {
          const failure = error;
          const timedOut = failure.killed === true || failure.signal === "SIGTERM";
          const reason: ExecutionResourceResolverFailureReason = timedOut
            ? "timeout"
            : typeof failure.code === "number"
              ? "nonzero_exit"
              : "spawn_failed";
          const stderrExcerpt = readExecutionResourceResolverStderrExcerpt(err);
          rejectPromise(
            new ExecutionResourceResolverError(
              `${EXECUTION_RESOURCE_RESOLVER_FAILED_PREFIX}: ${failure.code ?? failure.message}` +
                (stderrExcerpt ? ` - stderr: ${stderrExcerpt}` : ""),
              {
                reason,
                exitCode: typeof failure.code === "number" ? failure.code : null,
                signal: typeof failure.signal === "string" ? failure.signal : null,
                stderrExcerpt,
              },
            ),
          );
          return;
        }
        resolvePromise(out);
      },
    );
  });
  const receipt = parseExecutionWriterResourceReceipt(stdout);
  if (!receipt) {
    // The report is unreadable; do not echo it, because the resolver's stdout
    // may itself carry operator data. Classify and stay fail-closed.
    throw new ExecutionResourceResolverError(
      `${EXECUTION_RESOURCE_RESOLVER_FAILED_PREFIX}: invalid_receipt`,
      { reason: "invalid_receipt", exitCode: 0, signal: null, stderrExcerpt: null },
    );
  }
  return receipt;
}

/** Must run in the same transaction as queued -> running. Capacity is reserved by
 * the running row, released by terminal disposition, and recovered by native run
 * reconciliation. A physical-pool lock also accounts for other companies. */
export async function canAdmitExecutionResources(
  tx: Db,
  agent: typeof agents.$inferSelect,
  env: Record<string, string | undefined>,
): Promise<boolean> {
  const demand = readExecutionResourceRequest(agent.runtimeConfig);
  if (!demand) return true;
  const capacity = poolCapacity(env, demand.pool);
  if (!Object.hasOwn(capacity.providers, demand.provider)) {
    throw new Error(`No operator provider limit for ${demand.provider} in ${demand.pool}`);
  }
  // Pools model a physical execution host, so the lock and accounting span
  // companies sharing that host. This helper never acquires a company lock.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`execution-resources:${demand.pool}`}, 0))`);
  const active = await tx.select({ runtimeConfig: agents.runtimeConfig, context: heartbeatRuns.contextSnapshot })
    .from(heartbeatRuns)
    .innerJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, heartbeatRuns.companyId)))
    .where(and(
      eq(heartbeatRuns.status, "running"),
      sql`coalesce(${heartbeatRuns.contextSnapshot}->'executionResourceReservation'->>'pool', ${agents.runtimeConfig}->'executionResources'->>'pool') = ${demand.pool}`,
    ));
  let cpu = demand.cpu;
  let memoryMb = demand.memoryMb;
  let providerRuns = 1;
  for (const run of active) {
    const reserved = record(run.context) && Object.hasOwn(run.context, "executionResourceReservation")
      ? run.context.executionResourceReservation === null ? null
        : readExecutionResourceRequest({ executionResources: run.context.executionResourceReservation })
      : readExecutionResourceRequest(run.runtimeConfig);
    if (!reserved || reserved.pool !== demand.pool) continue;
    cpu += reserved.cpu;
    memoryMb += reserved.memoryMb;
    if (reserved.provider === demand.provider) providerRuns++;
  }
  return cpu <= capacity.cpu && memoryMb <= capacity.memoryMb
    && providerRuns <= capacity.providers[demand.provider]!;
}
