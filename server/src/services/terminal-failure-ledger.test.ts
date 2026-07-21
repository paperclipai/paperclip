/**
 * Terminal control-plane failure ledger — real-DB atomicity/dedupe tests
 * (FALA-880).
 *
 * These run against an embedded Postgres and exercise the REAL ledger table
 * (`terminal_failure_ledger`) with its DB unique index and ON CONFLICT upsert,
 * plus the REAL top-level report issue creation via `issueService.create`. They
 * prove:
 *   - issue-scoped process_lost → 1 ledger row + 1 top-level report + 1 comment
 *   - generic (issue-less) process_lost → 1 ledger row + 1 top-level report + 0 comments
 *   - re-delivery (sequential AND concurrent) → 0 duplicate ledger, 0 duplicate
 *     report, redelivery counter bumps
 *   - a retry lineage sharing one canonical root collapses to a single record
 */

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  issueComments,
  issues,
  terminalFailureLedger,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { issueService } from "./issues.js";
import {
  buildDedupeKey,
  recordTerminalFailure,
  type CreateTerminalFailureReportIssue,
} from "./terminal-failure-ledger.js";

const REPORT_ORIGIN_KIND = "control_plane_terminal_failure";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres terminal-failure ledger tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("terminal-failure-ledger — real DB atomicity/dedupe", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("terminal-failure-ledger-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(terminalFailureLedger);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Ledger Co",
      status: "active",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Ledger Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedIssue(companyId: string, agentId: string) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Source issue",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    return issueId;
  }

  // Real top-level report creation — unassigned, non-waking backlog issue.
  function makeCreateReportIssue(): CreateTerminalFailureReportIssue {
    const svc = issueService(db);
    return async (input) => {
      const report = await svc.create(input.companyId, {
        title: `[Fail-closed] Terminal control-plane failure (${input.failureCause})`,
        description: `Dedupe key: ${input.dedupeKey}`,
        status: "backlog",
        priority: "high",
        originKind: REPORT_ORIGIN_KIND,
        originId: input.dedupeKey,
        idempotencyKey: `terminal-failure-report:${input.companyId}:${input.dedupeKey}`,
        allowDuplicate: false,
      });
      return { issueId: report.id };
    };
  }

  async function countLedger(companyId: string, dedupeKey: string) {
    return db
      .select({ id: terminalFailureLedger.id })
      .from(terminalFailureLedger)
      .where(
        and(
          eq(terminalFailureLedger.companyId, companyId),
          eq(terminalFailureLedger.dedupeKey, dedupeKey),
        ),
      )
      .then((rows) => rows.length);
  }

  async function countReportIssues(companyId: string) {
    return db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, REPORT_ORIGIN_KIND)))
      .then((rows) => rows.length);
  }

  async function countSystemComments(companyId: string, issueId: string) {
    return db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, companyId),
          eq(issueComments.issueId, issueId),
          eq(issueComments.authorType, "system"),
        ),
      )
      .then((rows) => rows.length);
  }

  it("issue-scoped: 1 ledger row + 1 top-level report, records the issue but posts no in-context comment", async () => {
    const { companyId, agentId } = await seed();
    const issueId = await seedIssue(companyId, agentId);
    const rootRunId = randomUUID();
    const dedupeKey = buildDedupeKey(agentId, rootRunId, "process_lost");

    const result = await recordTerminalFailure(db, {
      companyId,
      agentId,
      issueId,
      runId: rootRunId,
      rootRunId,
      failureCause: "process_lost",
      createReportIssue: makeCreateReportIssue(),
    });

    expect(result.kind).toBe("created");
    expect(result.reportIssueId).toBeTruthy();
    // The top-level report is the only visible surface — the source issue's own
    // recovery/blocking thread is never perturbed by an escalation comment.
    expect(result.ledgerCommentId).toBeNull();
    expect(await countLedger(companyId, dedupeKey)).toBe(1);
    expect(await countReportIssues(companyId)).toBe(1);
    const [row] = await db
      .select({ issueId: terminalFailureLedger.issueId })
      .from(terminalFailureLedger)
      .where(eq(terminalFailureLedger.dedupeKey, dedupeKey));
    expect(row.issueId).toBe(issueId);
    expect(await countSystemComments(companyId, issueId)).toBe(0);
  });

  it("generic (issue-less) run: 1 ledger row + 1 top-level report + 0 comments", async () => {
    const { companyId, agentId } = await seed();
    const rootRunId = randomUUID();
    const dedupeKey = buildDedupeKey(agentId, rootRunId, "process_lost");

    const result = await recordTerminalFailure(db, {
      companyId,
      agentId,
      issueId: null,
      runId: rootRunId,
      rootRunId,
      failureCause: "process_lost",
      createReportIssue: makeCreateReportIssue(),
    });

    expect(result.kind).toBe("created");
    expect(result.reportIssueId).toBeTruthy();
    expect(result.ledgerCommentId).toBeNull();
    expect(await countLedger(companyId, dedupeKey)).toBe(1);
    expect(await countReportIssues(companyId)).toBe(1);
  });

  it("sequential re-delivery: 0 duplicate ledger, 0 duplicate report, counter bumps", async () => {
    const { companyId, agentId } = await seed();
    const rootRunId = randomUUID();
    const dedupeKey = buildDedupeKey(agentId, rootRunId, "process_lost");
    const createReportIssue = makeCreateReportIssue();

    const first = await recordTerminalFailure(db, {
      companyId, agentId, issueId: null, runId: rootRunId, rootRunId,
      failureCause: "process_lost", createReportIssue,
    });
    const second = await recordTerminalFailure(db, {
      companyId, agentId, issueId: null, runId: rootRunId, rootRunId,
      failureCause: "process_lost", createReportIssue,
    });

    expect(first.kind).toBe("created");
    expect(second.kind).toBe("deduplicated");
    expect(second.redeliveryCount).toBe(1);
    expect(await countLedger(companyId, dedupeKey)).toBe(1);
    expect(await countReportIssues(companyId)).toBe(1);
  });

  it("concurrent re-delivery (race): atomic upsert → 1 ledger, 1 report, exactly one created", async () => {
    const { companyId, agentId } = await seed();
    const rootRunId = randomUUID();
    const dedupeKey = buildDedupeKey(agentId, rootRunId, "process_lost");
    const createReportIssue = makeCreateReportIssue();

    const N = 6;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        recordTerminalFailure(db, {
          companyId, agentId, issueId: null, runId: rootRunId, rootRunId,
          failureCause: "process_lost", createReportIssue,
        }),
      ),
    );

    const created = results.filter((r) => r.kind === "created").length;
    const deduped = results.filter((r) => r.kind === "deduplicated").length;
    expect(created).toBe(1);
    expect(deduped).toBe(N - 1);
    expect(await countLedger(companyId, dedupeKey)).toBe(1);
    expect(await countReportIssues(companyId)).toBe(1);

    const [row] = await db
      .select({ redeliveryCount: terminalFailureLedger.redeliveryCount })
      .from(terminalFailureLedger)
      .where(eq(terminalFailureLedger.dedupeKey, dedupeKey));
    expect(row.redeliveryCount).toBe(N - 1);
  });

  it("crash window A: report create throws, then re-delivery reconciles to 1 ledger + 1 report + non-null pointer", async () => {
    const { companyId, agentId } = await seed();
    const rootRunId = randomUUID();
    const dedupeKey = buildDedupeKey(agentId, rootRunId, "process_lost");
    const realCreate = makeCreateReportIssue();
    let calls = 0;
    const flakyCreate: CreateTerminalFailureReportIssue = async (input) => {
      calls += 1;
      if (calls === 1) throw new Error("injected report-create failure");
      return realCreate(input);
    };

    // First delivery: the atomic upsert durably commits the ledger row, then the
    // report create throws. The throw propagates (the caller logs and swallows).
    await expect(
      recordTerminalFailure(db, {
        companyId, agentId, issueId: null, runId: rootRunId, rootRunId,
        failureCause: "process_lost", createReportIssue: flakyCreate,
      }),
    ).rejects.toThrow(/injected report-create failure/);

    // Crash state: the ledger row exists but the side effect is incomplete —
    // no report, null pointer. A naive dedupe would strand this forever.
    expect(await countLedger(companyId, dedupeKey)).toBe(1);
    expect(await countReportIssues(companyId)).toBe(0);

    // Re-delivery reconciles the incomplete side effect exactly once.
    const recovered = await recordTerminalFailure(db, {
      companyId, agentId, issueId: null, runId: rootRunId, rootRunId,
      failureCause: "process_lost", createReportIssue: flakyCreate,
    });

    expect(recovered.kind).toBe("deduplicated");
    expect(recovered.reportIssueId).toBeTruthy();
    expect(await countLedger(companyId, dedupeKey)).toBe(1);
    expect(await countReportIssues(companyId)).toBe(1);

    const [ledgerRow] = await db
      .select({ reportIssueId: terminalFailureLedger.reportIssueId })
      .from(terminalFailureLedger)
      .where(eq(terminalFailureLedger.dedupeKey, dedupeKey));
    expect(ledgerRow.reportIssueId).toBeTruthy();
  });

  it("crash window B: report created but pointer write lost — re-delivery recovers via idempotency, 0 duplicate report", async () => {
    const { companyId, agentId } = await seed();
    const rootRunId = randomUUID();
    const dedupeKey = buildDedupeKey(agentId, rootRunId, "process_lost");
    const realCreate = makeCreateReportIssue();

    // Reproduce the crash window: the ledger row is committed with a NULL pointer
    // and the report issue already exists (created via its idempotencyKey), but
    // the process died before the pointer write landed.
    await db.insert(terminalFailureLedger).values({
      companyId, agentId, dedupeKey,
      normalizedFailureCause: "process_lost", failureCause: "process_lost",
      rootRunId, runId: rootRunId, issueId: null,
      reportIssueId: null, ledgerCommentId: null, redeliveryCount: 0,
    });
    const pre = await realCreate({
      companyId, agentId, issueId: null, runId: rootRunId, rootRunId,
      failureCause: "process_lost", dedupeKey,
    });
    expect(await countReportIssues(companyId)).toBe(1);

    // Re-delivery reconciles: createReportIssue returns the SAME issue via its
    // idempotencyKey, so the pointer is filled with no duplicate report.
    const recovered = await recordTerminalFailure(db, {
      companyId, agentId, issueId: null, runId: rootRunId, rootRunId,
      failureCause: "process_lost", createReportIssue: realCreate,
    });

    expect(recovered.kind).toBe("deduplicated");
    expect(recovered.reportIssueId).toBe(pre.issueId);
    expect(await countLedger(companyId, dedupeKey)).toBe(1);
    expect(await countReportIssues(companyId)).toBe(1);

    const [ledgerRow] = await db
      .select({ reportIssueId: terminalFailureLedger.reportIssueId })
      .from(terminalFailureLedger)
      .where(eq(terminalFailureLedger.dedupeKey, dedupeKey));
    expect(ledgerRow.reportIssueId).toBe(pre.issueId);
  });

  it("retry lineage sharing a canonical root collapses to one record", async () => {
    const { companyId, agentId } = await seed();
    const rootRunId = randomUUID();
    const retryRunId = randomUUID(); // a later retry of the same failure
    const dedupeKey = buildDedupeKey(agentId, rootRunId, "process_lost");
    const createReportIssue = makeCreateReportIssue();

    // First failure of the origin run.
    await recordTerminalFailure(db, {
      companyId, agentId, issueId: null, runId: rootRunId, rootRunId,
      failureCause: "process_lost", createReportIssue,
    });
    // The retry fails too, but carries the SAME canonical root.
    const retry = await recordTerminalFailure(db, {
      companyId, agentId, issueId: null, runId: retryRunId, rootRunId,
      failureCause: "process_lost", createReportIssue,
    });

    expect(retry.kind).toBe("deduplicated");
    expect(await countLedger(companyId, dedupeKey)).toBe(1);
    expect(await countReportIssues(companyId)).toBe(1);
  });
});
