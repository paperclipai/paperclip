import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  type Db,
} from "@paperclipai/db";
import {
  canAgentDelegate,
  createDelegateTaskCallback,
} from "../services/delegation.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// -----------------------------------------------------------------------------
// Phase 0D acceptance tests for `delegate_task` (6 scenarios).
//
// Split by shape:
//   Unit (always run):
//     - Test 2: recursion guard via canAgentDelegate()
//     - Test 3: case-insensitive assignee name resolution
//     - Test 4: not-a-direct-report rejection
//   E2E (only with PAPERCLIP_E2E=1, requires live paperclip server +
//        ANTHROPIC_API_KEY with managed-agents beta access):
//     - Test 1: basic sync delegation round-trip
//     - Test 5: timeout characterization
//     - Test 6: waitForCompletion=false characterization
// -----------------------------------------------------------------------------

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeUnit = embeddedPostgresSupport.supported ? describe : describe.skip;

interface SeededCompany {
  companyId: string;
  parentAgent: { id: string; companyId: string; name: string; permissions: Record<string, unknown> };
  directReport: { id: string; name: string };
  unrelatedAgent: { id: string; name: string };
  childNoDelegate: { id: string; name: string; permissions: Record<string, unknown> };
}

async function seedDelegationCompany(db: Db): Promise<SeededCompany> {
  const companyId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: `delegation-test-${companyId.slice(0, 8)}`,
    issuePrefix: `DT${companyId.slice(0, 3).toUpperCase()}`,
  } as Parameters<typeof db.insert>[0] extends unknown ? Record<string, unknown> : never);

  const parentId = randomUUID();
  const directId = randomUUID();
  const unrelatedId = randomUUID();
  const childNoDelId = randomUUID();

  await db.insert(agents).values([
    {
      id: parentId,
      companyId,
      name: "CEO",
      role: "ceo",
      reportsTo: null,
      adapterType: "managed_agents",
      permissions: { canDelegate: true },
    },
    {
      id: directId,
      companyId,
      name: "Direct Report",
      role: "general",
      reportsTo: parentId,
      adapterType: "managed_agents",
      permissions: { canDelegate: false },
    },
    {
      id: unrelatedId,
      companyId,
      name: "Unrelated",
      role: "general",
      reportsTo: null,
      adapterType: "managed_agents",
      permissions: { canDelegate: false },
    },
    {
      id: childNoDelId,
      companyId,
      name: "Child Without Delegate",
      role: "general",
      reportsTo: parentId,
      adapterType: "managed_agents",
      permissions: { canDelegate: false },
    },
  ]);

  return {
    companyId,
    parentAgent: { id: parentId, companyId, name: "CEO", permissions: { canDelegate: true } },
    directReport: { id: directId, name: "Direct Report" },
    unrelatedAgent: { id: unrelatedId, name: "Unrelated" },
    childNoDelegate: { id: childNoDelId, name: "Child Without Delegate", permissions: { canDelegate: false } },
  };
}

describeUnit("delegation — unit", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: Db;
  const cleanupIds: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-delegation-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    if (cleanupIds.length > 0) {
      await db.delete(heartbeatRuns).where(inArray(heartbeatRuns.companyId, cleanupIds));
      await db.delete(issues).where(inArray(issues.companyId, cleanupIds));
      await db.delete(agents).where(inArray(agents.companyId, cleanupIds));
      await db.delete(companies).where(inArray(companies.id, cleanupIds));
      cleanupIds.length = 0;
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // -------------------------------------------------------------------------
  // Test 2 — Recursion guard: canAgentDelegate() returns false for a child
  // agent lacking permissions.canDelegate, so the adapter sees
  // ctx.delegateTask=undefined and does NOT pass customTools to createAgent
  // (packages/adapters/managed-agents/src/server/execute.ts:340-342).
  // -------------------------------------------------------------------------
  it("Test 2 — canAgentDelegate returns false for child without canDelegate (recursion guard)", async () => {
    const seed = await seedDelegationCompany(db);
    cleanupIds.push(seed.companyId);

    const parentAllowed = await canAgentDelegate(db, {
      id: seed.parentAgent.id,
      companyId: seed.companyId,
      permissions: seed.parentAgent.permissions,
    });
    expect(parentAllowed).toBe(true);

    const childAllowed = await canAgentDelegate(db, {
      id: seed.childNoDelegate.id,
      companyId: seed.companyId,
      permissions: seed.childNoDelegate.permissions,
    });
    expect(childAllowed).toBe(false);

    const parentWithoutFlag = await canAgentDelegate(db, {
      id: seed.parentAgent.id,
      companyId: seed.companyId,
      permissions: {},
    });
    expect(parentWithoutFlag).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 3 — Case-insensitive name resolution. Delegating with an uppercased
  // assignee name should resolve to the same direct report.
  // -------------------------------------------------------------------------
  it("Test 3 — case-insensitive assignee resolution", async () => {
    const seed = await seedDelegationCompany(db);
    cleanupIds.push(seed.companyId);

    let wakeupCalledWithAgentId: string | null = null;
    const stubRunId = randomUUID();

    const delegateTask = createDelegateTaskCallback({
      db,
      heartbeat: {
        wakeup: async (agentId: string) => {
          wakeupCalledWithAgentId = agentId;
          return { id: stubRunId };
        },
      },
      parentAgent: seed.parentAgent,
      parentRunId: randomUUID(),
    });

    const result = await delegateTask({
      assigneeAgentName: "DIRECT REPORT",
      title: "Test delegation",
      description: "Verify name resolution ignores case",
      waitForCompletion: false,
      timeoutSeconds: 30,
    });

    expect(result.status).toBe("queued");
    expect(result.childRunId).toBe(stubRunId);
    expect(result.errorCode).toBeNull();
    expect(wakeupCalledWithAgentId).toBe(seed.directReport.id);
  });

  // -------------------------------------------------------------------------
  // Test 1b — Parent consumes child output (full delegation loop).
  //
  // Closes the Phase 0E acceptance gap exposed by the 2026-04-24 dogfood
  // failure where Ada's delegate_task never received a tool_result even
  // though Donald's child run produced a clean finalText. Root cause: the
  // poller checked for status "done" while the runtime writes "succeeded",
  // so the poller spun to timeout and the issue was never flipped.
  //
  // This test asserts the full loop at the delegation-service layer (the
  // adapter layer on top just JSON.stringifies the DelegationResult into
  // postCustomToolResult, so if the result here is right the tool_result
  // posted to the parent MA session necessarily carries it):
  //
  //   1. Poller detects SUCCEEDED terminal status (not "done")
  //   2. result.finalText matches the exact bytes the child wrote to
  //      resultJson.finalText (the acceptance marker proves identity, not
  //      shape)
  //   3. Child issue flipped to "done" so reconciler stops re-waking via
  //      issue.continuation_recovery
  //   4. result.status === "completed", errorCode null
  // -------------------------------------------------------------------------
  it("Test 1b — parent receives child finalText + issue flipped to done", async () => {
    const seed = await seedDelegationCompany(db);
    cleanupIds.push(seed.companyId);

    const parentRunId = randomUUID();
    const childRunId = randomUUID();
    const childFinalText =
      "### CHAA-3 hygiene audit — 0 stale, 1 duplicate pair, 0 contradictions. ACCEPTANCE-MARKER-2f3a9c7e.";

    // Pre-seed parent heartbeat_run so any FK from child.parentRunId holds.
    await db.insert(heartbeatRuns).values({
      id: parentRunId,
      companyId: seed.companyId,
      agentId: seed.parentAgent.id,
      status: "running",
      invocationSource: "on_demand",
    } as Parameters<typeof db.insert>[0] extends unknown ? Record<string, unknown> : never);

    const delegateTask = createDelegateTaskCallback({
      db,
      heartbeat: {
        wakeup: async (agentId: string, opts) => {
          // Insert the child run the way the real heartbeat service would.
          await db.insert(heartbeatRuns).values({
            id: childRunId,
            companyId: seed.companyId,
            agentId,
            status: "queued",
            invocationSource: "assignment",
            parentRunId: opts.parentRunId ?? null,
          } as Parameters<typeof db.insert>[0] extends unknown ? Record<string, unknown> : never);
          // Simulate asynchronous completion — the poller's warmup is 3s, so
          // flipping after 100ms means the first poll cycle will observe the
          // terminal state.
          setTimeout(() => {
            db
              .update(heartbeatRuns)
              .set({
                status: "succeeded",
                finishedAt: new Date(),
                resultJson: { finalText: childFinalText, stopReason: "completed" },
                updatedAt: new Date(),
              })
              .where(eq(heartbeatRuns.id, childRunId))
              .catch(() => {
                /* test will fail on assertions if this fails; don't crash the event loop */
              });
          }, 100);
          return { id: childRunId };
        },
      },
      parentAgent: seed.parentAgent,
      parentRunId,
    });

    const result = await delegateTask({
      assigneeAgentName: seed.directReport.name,
      title: "Run Cornerstone hygiene audit",
      description: "Audit Mal's default namespace for stale facts, duplicates, contradictions.",
      waitForCompletion: true,
      timeoutSeconds: 30,
    });

    // Full-loop acceptance: parent receives the EXACT bytes the child wrote.
    // The adapter posts JSON.stringify(result) as the tool_result, so
    // anything asserted here is what the parent MA session observes.
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe(childFinalText);
    expect(result.finalText ?? "").toContain("ACCEPTANCE-MARKER-2f3a9c7e");
    expect(result.errorCode).toBeNull();
    expect(result.errorMessage).toBeNull();
    expect(result.childRunId).toBe(childRunId);
    expect(result.childIssueId).toBeTruthy();

    // Issue must be flipped to done so the reconciler doesn't re-wake the
    // assignee via issue.continuation_recovery.
    const flippedIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, result.childIssueId!))
      .then((rows) => rows[0] ?? null);
    expect(flippedIssue?.status).toBe("done");
  }, 15_000);

  // -------------------------------------------------------------------------
  // Test 4 — Not-a-direct-report rejection. Target resolves (same company)
  // but does not reportsTo the parent agent.
  // -------------------------------------------------------------------------
  it("Test 4 — rejects delegation when target is not a direct report", async () => {
    const seed = await seedDelegationCompany(db);
    cleanupIds.push(seed.companyId);

    let wakeupCalled = false;
    const delegateTask = createDelegateTaskCallback({
      db,
      heartbeat: {
        wakeup: async () => {
          wakeupCalled = true;
          return { id: randomUUID() };
        },
      },
      parentAgent: seed.parentAgent,
      parentRunId: randomUUID(),
    });

    const result = await delegateTask({
      assigneeAgentName: seed.unrelatedAgent.name,
      title: "Should reject",
      description: "Unrelated agent doesn't report to parent",
      waitForCompletion: false,
      timeoutSeconds: 30,
    });

    expect(result.status).toBe("rejected");
    expect(result.errorCode).toBe("not_direct_report");
    expect(result.childRunId).toBeNull();
    expect(wakeupCalled).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// E2E scenarios (Tests 1, 5, 6) — DEFERRED. Scaffolded behind PAPERCLIP_E2E=1
// but intentionally kept as .skip until a future sprint.
//
// Why deferred (context from Phase 0D on 2026-04-24):
//   The running local dev server (`localhost:3100`) was built before the
//   managed-agents adapter package existed in the tree (it was untracked
//   spike work until commit c962fa4 landed on branch phase-0-delegation).
//   `GET /api/adapters` on that server returns 10 adapters; `managed_agents`
//   is not among them, so agent creation via `POST /api/companies/:id/agents`
//   rejects `adapterType: "managed_agents"` with "Unknown adapter type".
//
//   Rather than rebuild + restart the dev server and resolve the remaining
//   harness gaps in-session (DATABASE_URL plumbing for embedded-postgres,
//   parent heartbeat_run id resolution from issue creation response), we
//   chose to close Phase 0D with the three unit tests above (all green) and
//   make the end-to-end delegation run the smoke step for Phase 0E — i.e.
//   it runs once against the freshly deployed Cloud Run revision, where the
//   new adapter is guaranteed present and env is already wired.
//
// To implement in a future sprint, the three gaps to resolve are:
//   (a) Live dev server with managed_agents in its adapter registry (rebuild
//       on phase-0-delegation or later)
//   (b) DATABASE_URL exported in the test process, pointing at the same DB
//       the server writes to (embedded-postgres requires reading the paperclip
//       config for the connection string)
//   (c) Parent heartbeat_run id resolution — issue creation returns issue.id
//       but not the run id; needs either API extension or a DB lookup via
//       `heartbeat_runs.contextSnapshot->>'issueId' = :issueId`
// -----------------------------------------------------------------------------
describe.skip("delegation — e2e (deferred)", () => {
  it.skip("Test 1 — basic sync delegation round-trip (deferred)", () => {
    // Parent CEO delegates to a direct report with waitForCompletion=true;
    // expect status="completed", finalText set, child.parent_run_id = parent.id,
    // costUsd > 0.
  });

  it.skip("Test 5 — timeout characterization (deferred)", () => {
    // Short timeoutSeconds should yield status="timeout", errorCode="timeout";
    // child run should still complete independently (not cancelled by the
    // parent's timeout).
  });

  it.skip("Test 6 — waitForCompletion=false (deferred)", () => {
    // Tool returns immediately with status="queued", childRunId populated,
    // finalText=null, costUsd=null.
  });
});
