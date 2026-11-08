import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { PROCESS_IDENTITY_RECORDED } from "../native-local-process-stop.js";
import { persistHeartbeatRunProcessMetadata, retryTransientRunWrite } from "./run-lifecycle.js";

const support = await getEmbeddedPostgresTestSupport();
const companyId = "30000000-0000-4000-8000-000000000001";
const agentId = "30000000-0000-4000-8000-000000000002";
const issueId = "30000000-0000-4000-8000-000000000003";
const predecessorRunId = "30000000-0000-4000-8000-000000000004";
const runId = "30000000-0000-4000-8000-000000000005";
type Tx = ReturnType<typeof createDb>;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!support.supported)("spawn process identity persistence", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let other: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-process-identity-");
    db = createDb(temporary.connectionString);
    other = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Identity", issuePrefix: "PID" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Identity agent" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Retry me" });
    await db.insert(heartbeatRuns).values([
      { id: predecessorRunId, companyId, agentId, issueId, scopeKind: "issue", status: "failed" },
      { id: runId, companyId, agentId, issueId, scopeKind: "issue", status: "running", retryOfRunId: predecessorRunId },
    ]);
  });

  afterAll(async () => {
    await temporary?.cleanup();
  });

  // A user Retry spawned the provider while another transaction held a parent
  // row (the issue or predecessor run) FOR UPDATE. Writing the identity
  // and then reserving the event sequence updated the run row twice, and the
  // second UPDATE re-checked heartbeat_runs' foreign keys (KEY SHARE on those
  // parents; the event row's own agent/company keys are checked either way). It waited behind the holder and then failed, so the live run
  // ended as native_session_interrupted.
  it.each([
    ["issue", (tx: Tx) => tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issueId))],
    ["predecessor run", (tx: Tx) => tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.id, predecessorRunId))],
  ] as const)("records identity without waiting on a transaction holding the %s FOR UPDATE", async (_label, lockParent) => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => { locked = resolve; });
    const holder = other.transaction(async (tx) => {
      await lockParent(tx as unknown as Tx).for("update");
      locked();
      await released;
    });
    await holding;
    try {
      const pid = 40_000 + Math.floor(Math.random() * 1000);
      const persisted = persistHeartbeatRunProcessMetadata(db, runId, {
        pid, processGroupId: null, startedAt: new Date().toISOString(), targetKind: "remote",
      });
      const outcome = await Promise.race([
        persisted.then((run) => ({ run }), (error: unknown) => ({ error })),
        sleep(3_000).then(() => "blocked" as const),
      ]);
      expect(outcome).not.toBe("blocked");
      expect(outcome).not.toHaveProperty("error");
      const run = (outcome as { run: typeof heartbeatRuns.$inferSelect | null }).run;
      expect(run).toMatchObject({ id: runId, processPid: pid, processHostHash: "remote" });
      const events = await db.select().from(heartbeatRunEvents).where(and(
        eq(heartbeatRunEvents.runId, runId),
        eq(heartbeatRunEvents.eventType, PROCESS_IDENTITY_RECORDED),
      ));
      expect(events.at(-1)?.payload).toMatchObject({ processPid: pid, targetKind: "remote" });
      expect(events.at(-1)?.seq).toBe(Number(run!.nextEventSeq) - 1);
    } finally {
      release();
      await holder;
    }
  }, 30_000);
});

describe("transient run write retry", () => {
  it("retries a deadlock victim and rethrows other failures", async () => {
    let calls = 0;
    await expect(retryTransientRunWrite(async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error("Failed query"), { cause: { code: "40P01" } });
      return "persisted";
    })).resolves.toBe("persisted");
    expect(calls).toBe(3);
    await expect(retryTransientRunWrite(async () => {
      throw Object.assign(new Error("Failed query"), { cause: { code: "23505" } });
    })).rejects.toThrow("Failed query");
  });
});
