import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import {
  companies,
  costEvents,
  executionReceipts,
  heartbeatRuns,
  issues,
  toolInvocations,
  type Db,
  type ExecutionReceiptToolInvoked,
} from "@paperclipai/db";
import { sanitizeRecord } from "../redaction.js";
import { sha256Digest } from "./canonical-hash.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISSUE_ID_FK_CONSTRAINT = "execution_receipts_issue_id_issues_id_fk";

function isPostgresForeignKeyViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: unknown; constraint_name?: unknown; cause?: unknown };
  if (record.code === "23503" && record.constraint_name === constraint) return true;
  return record.cause ? isPostgresForeignKeyViolation(record.cause, constraint) : false;
}

export type ExecutionReceiptRow = typeof executionReceipts.$inferSelect;
export type SkillRiskTier = 0 | 1 | 2 | null;

/**
 * Accessor stub for the skill-level risk classifier that SAG-7615 owns.
 * Until that lands there is no risk-tier data anywhere in the system, so this
 * always returns `null` — which `resolveReceiptRiskTier`'s fail-safe treats as
 * mandatory (Tier-2) emission. Swapping this implementation is the only change
 * SAG-7615 needs to make to turn on real tiering; callers here don't change.
 */
export async function getSkillRiskTier(_skillId: string | null): Promise<SkillRiskTier> {
  return null;
}

async function resolveReceiptRiskTier(skillId: string | null): Promise<SkillRiskTier> {
  return getSkillRiskTier(skillId);
}

/**
 * Tier-2 (or unresolved/null, fail-safe) is always mandatory; Tier 0/1 only
 * emits when the company has opted in. Pulled out as a pure function so the
 * gate can be unit-tested without needing a DB-backed heartbeat run.
 */
export function shouldEmitExecutionReceipt(
  riskTier: SkillRiskTier,
  companyOptedIntoTier01Receipts: boolean,
): boolean {
  const mandatory = riskTier === 2 || riskTier === null;
  return mandatory || companyOptedIntoTier01Receipts;
}

type ResolvedSkillRef = {
  skillId: string | null;
  pluginId: string | null;
  skillName: string | null;
  skillVersionHash: string | null;
};

/**
 * Best-effort resolution of "which skill was primarily active in this run."
 * `heartbeatRuns` carries no reliable skill/plugin attribution today (only
 * `contextSnapshot.issueId`), so this intentionally resolves to all-null —
 * per SAG-7632 plan §7 risk #4, query-by-skill-version coverage depends on a
 * future signal, but the receipt still fires and the chain still holds.
 */
function resolvePrimarySkillForRun(_run: typeof heartbeatRuns.$inferSelect): ResolvedSkillRef {
  return { skillId: null, pluginId: null, skillName: null, skillVersionHash: null };
}

function readContextIssueId(contextSnapshot: unknown): string | null {
  if (!contextSnapshot || typeof contextSnapshot !== "object") return null;
  const issueId = (contextSnapshot as Record<string, unknown>).issueId;
  return typeof issueId === "string" && UUID_RE.test(issueId) ? issueId : null;
}

function mapRunStatusToOutcome(status: string): "succeeded" | "failed" | "error" {
  if (status === "succeeded") return "succeeded";
  if (status === "failed" || status === "timed_out") return "failed";
  return "error";
}

type ReceiptHashInput = {
  companyId: string;
  agentId: string;
  runId: string;
  issueId: string | null;
  skillId: string | null;
  pluginId: string | null;
  skillName: string | null;
  skillVersionHash: string | null;
  riskTier: SkillRiskTier;
  riskTierSource: "classifier" | "fail_safe_default";
  inputsRedacted: Record<string, unknown>;
  toolsInvoked: ExecutionReceiptToolInvoked[];
  gateDecisions: Record<string, unknown>;
  evalScores: Record<string, unknown>;
  outcome: "succeeded" | "failed" | "error";
  costCents: number;
  prevReceiptHash: string | null;
  chainSeq: number;
};

/** Every column on `execution_receipts` except `id`/`contentHash`/`createdAt` — see SAG-7632 plan §2. */
function computeReceiptContentHash(input: ReceiptHashInput): string {
  return sha256Digest(input);
}

function receiptHashInputFromRow(row: ExecutionReceiptRow): ReceiptHashInput {
  return {
    companyId: row.companyId,
    agentId: row.agentId,
    runId: row.runId,
    issueId: row.issueId,
    skillId: row.skillId,
    pluginId: row.pluginId,
    skillName: row.skillName,
    skillVersionHash: row.skillVersionHash,
    riskTier: row.riskTier as SkillRiskTier,
    riskTierSource: row.riskTierSource as "classifier" | "fail_safe_default",
    inputsRedacted: row.inputsRedacted,
    toolsInvoked: row.toolsInvoked,
    gateDecisions: row.gateDecisions,
    evalScores: row.evalScores,
    outcome: row.outcome as "succeeded" | "failed" | "error",
    costCents: row.costCents,
    prevReceiptHash: row.prevReceiptHash,
    chainSeq: row.chainSeq,
  };
}

/**
 * Emits (at most) one execution receipt for a `heartbeatRuns` row that has
 * just reached a terminal status. Safe to call more than once for the same
 * `runId` — the unique index on `runId` plus `onConflictDoNothing` make a
 * second call a no-op rather than a thrown error, so it can never crash the
 * heartbeat run-finalization path that invokes it (see SAG-7632 plan §4/§6).
 */
export async function emitExecutionReceipt(db: Db, runId: string): Promise<ExecutionReceiptRow | null> {
  const run = await db
    .select()
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .then((rows) => rows[0] ?? null);
  if (!run) return null;

  const company = await db
    .select({ receiptsTier01Enabled: companies.receiptsTier01Enabled })
    .from(companies)
    .where(eq(companies.id, run.companyId))
    .then((rows) => rows[0] ?? null);
  const companyOptedIntoTier01Receipts = company?.receiptsTier01Enabled ?? false;

  const toolCalls = await db
    .select()
    .from(toolInvocations)
    .where(and(eq(toolInvocations.companyId, run.companyId), eq(toolInvocations.runId, run.id)));

  const [costRow] = await db
    .select({ costCentsSum: sql<number | null>`sum(${costEvents.costCents})` })
    .from(costEvents)
    .where(and(eq(costEvents.companyId, run.companyId), eq(costEvents.heartbeatRunId, run.id)));
  const costCents = Number(costRow?.costCentsSum ?? 0);

  const skillRef = resolvePrimarySkillForRun(run);
  const riskTier = await resolveReceiptRiskTier(skillRef.skillId);
  if (!shouldEmitExecutionReceipt(riskTier, companyOptedIntoTier01Receipts)) {
    return null;
  }

  const toolsInvoked: ExecutionReceiptToolInvoked[] = toolCalls.map((call) => ({
    toolName: call.toolName,
    invocationId: call.id,
    dryRun: false,
    policyDecision: call.policyDecision ?? null,
    status: call.status,
  }));

  const inputsRedacted = sanitizeRecord({
    toolCalls: toolCalls.map((call) => ({
      toolName: call.toolName,
      argumentsSummary: call.argumentsSummary ?? null,
    })),
    resultJson: run.resultJson ?? null,
  });

  const outcome = mapRunStatusToOutcome(run.status);
  const issueId = readContextIssueId(run.contextSnapshot);

  // `issueId` is a hard FK to `issues.id`. The issue can be gone by the time this
  // fires (deleted mid-flight, or any other staleness) — an audit trail whose
  // entire value is non-skippability must not let that sink the whole receipt.
  // The existence check below closes almost all of that window; the outer catch/
  // retry closes the remainder (issue deleted between the check and the insert).
  async function runReceiptTransaction(forceNullIssueId: boolean): Promise<ExecutionReceiptRow | null> {
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`paperclip:execution-receipts:${run.companyId}`}, 0))`,
      );

      const resolvedIssueId =
        issueId && !forceNullIssueId
          ? await tx
              .select({ id: issues.id })
              .from(issues)
              .where(eq(issues.id, issueId))
              .then((rows) => (rows.length > 0 ? issueId : null))
          : null;

      const [chainRow] = await tx
        .select({ maxSeq: sql<number | null>`max(${executionReceipts.chainSeq})` })
        .from(executionReceipts)
        .where(eq(executionReceipts.companyId, run.companyId));
      const maxSeq = chainRow?.maxSeq ?? null;

      let prevReceiptHash: string | null = null;
      if (maxSeq !== null) {
        const prevRow = await tx
          .select({ contentHash: executionReceipts.contentHash })
          .from(executionReceipts)
          .where(and(eq(executionReceipts.companyId, run.companyId), eq(executionReceipts.chainSeq, maxSeq)))
          .then((rows) => rows[0] ?? null);
        prevReceiptHash = prevRow?.contentHash ?? null;
      }
      const chainSeq = maxSeq === null ? 0 : maxSeq + 1;

      const hashInput: ReceiptHashInput = {
        companyId: run.companyId,
        agentId: run.agentId,
        runId: run.id,
        issueId: resolvedIssueId,
        skillId: skillRef.skillId,
        pluginId: skillRef.pluginId,
        skillName: skillRef.skillName,
        skillVersionHash: skillRef.skillVersionHash,
        riskTier,
        riskTierSource: riskTier === null ? "fail_safe_default" : "classifier",
        inputsRedacted,
        toolsInvoked,
        gateDecisions: {},
        evalScores: {},
        outcome,
        costCents,
        prevReceiptHash,
        chainSeq,
      };
      const contentHash = computeReceiptContentHash(hashInput);

      const [inserted] = await tx
        .insert(executionReceipts)
        .values({ ...hashInput, contentHash })
        .onConflictDoNothing({ target: executionReceipts.runId })
        .returning();
      return inserted ?? null;
    });
  }

  try {
    return await runReceiptTransaction(false);
  } catch (error) {
    if (issueId && isPostgresForeignKeyViolation(error, ISSUE_ID_FK_CONSTRAINT)) {
      return runReceiptTransaction(true);
    }
    throw error;
  }
}

export async function getReceiptsBySkillVersion(
  db: Db,
  companyId: string,
  skillVersionHash: string,
  opts: { limit?: number; cursor?: string } = {},
): Promise<ExecutionReceiptRow[]> {
  const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, 500) : 50;
  const conditions = [
    eq(executionReceipts.companyId, companyId),
    eq(executionReceipts.skillVersionHash, skillVersionHash),
  ];
  if (opts.cursor) {
    conditions.push(lt(executionReceipts.createdAt, new Date(opts.cursor)));
  }
  return db
    .select()
    .from(executionReceipts)
    .where(and(...conditions))
    .orderBy(desc(executionReceipts.createdAt))
    .limit(limit);
}

/** Full per-company hash chain, ordered by `chainSeq` — see SAG-7632 plan §5. */
export async function getReceiptChain(db: Db, companyId: string): Promise<ExecutionReceiptRow[]> {
  return db
    .select()
    .from(executionReceipts)
    .where(eq(executionReceipts.companyId, companyId))
    .orderBy(asc(executionReceipts.chainSeq));
}

export type ReceiptChainVerification =
  | { valid: true }
  | { valid: false; brokenAtChainSeq: number; brokenAtId: string };

/**
 * Implements the SAG-7632 plan §2 verification procedure: walk the chain in
 * `chainSeq` order, confirm each row's `prevReceiptHash` matches the previous
 * row's `contentHash`, and recompute each row's own `contentHash` from its
 * persisted columns. The first row that fails either check is reported as the
 * tamper point; this is the one implementation both the QA tamper test and
 * any future audit tooling call.
 */
export async function verifyReceiptChain(db: Db, companyId: string): Promise<ReceiptChainVerification> {
  const rows = await getReceiptChain(db, companyId);

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    const expectedPrevHash = i === 0 ? null : rows[i - 1]!.contentHash;
    if (row.prevReceiptHash !== expectedPrevHash) {
      return { valid: false, brokenAtChainSeq: row.chainSeq, brokenAtId: row.id };
    }

    const recomputed = computeReceiptContentHash(receiptHashInputFromRow(row));
    if (recomputed !== row.contentHash) {
      return { valid: false, brokenAtChainSeq: row.chainSeq, brokenAtId: row.id };
    }
  }

  return { valid: true };
}
