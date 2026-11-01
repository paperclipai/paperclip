import { randomBytes, randomUUID } from "node:crypto";
import { heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { createDatabaseResponseCapture, installDatabaseResponseCapture } from "@paperclipai/db/response-capture";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { isAcknowledgedNativeStop } from "../acknowledged-native-stop.js";
import { callbacks, runControlPostgresSupport, setupRunControlDatabase } from "./__tests__/run-control-fixtures.js";
import { readNativeStopExecutionEvidence } from "./native-stop-evidence-read.js";
import { createHeartbeatRunControl } from "./run-control.js";

vi.mock("../local-service-supervisor.js", async importOriginal => ({
  ...await importOriginal<typeof import("../local-service-supervisor.js")>(),
  terminateLocalService: vi.fn(async () => undefined),
}));

describe.skipIf(!runControlPostgresSupport.supported)("native Stop evidence reads", () => {
  let db: Db;
  const { fixture } = setupRunControlDatabase("native-stop-evidence-", value => { db = value; });

  it("reads current receipts below the byte budget without changing saved data", async () => {
    const { company, agent } = await fixture();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Stop evidence fixture" }).returning();
    const id = randomUUID(), bulk = randomBytes(128 * 1024).toString("base64");
    const receipt = { schema: "paperclip.native-cancellation.v1", runId: id, companyId: company.id, issueId: issue.id,
      scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
      intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(), futureProof: { version: 2 } };
    const result = { nativeCancellation: receipt, cancelledByActorType: "user", cancelledByUserId: randomUUID(),
      stdout: bulk, stderr: bulk, futureExecutionEvidence: { savedInput: bulk } };
    const [before] = await db.insert(heartbeatRuns).values({ id, companyId: company.id, agentId: agent.id,
      nativeIssueId: issue.id, runtimeMode: "native", status: "cancelled", processPid: 123, processGroupId: 456,
      contextSnapshot: { savedInput: bulk }, runnerProfileJson: { savedInput: bulk }, stdoutExcerpt: bulk,
      stderrExcerpt: bulk, resultJson: result }).returning();
    const events: Array<Record<string, unknown>> = [], now = Date.now();
    const capture = createDatabaseResponseCapture({ start: now - 100, end: now + 59_000 }, event => events.push(event));
    installDatabaseResponseCapture(db, { heartbeatRuns }, capture);
    let evidence: Awaited<ReturnType<typeof readNativeStopExecutionEvidence>>;
    try { evidence = await readNativeStopExecutionEvidence(db, company.id, id); }
    finally { capture.flush(); }
    expect(evidence!).toEqual({ id, companyId: company.id, nativeIssueId: issue.id, status: "cancelled", processPid: 123,
      processGroupId: 456, resultJson: { nativeCancellation: receipt, cancelledByActorType: "user", cancelledByUserId: result.cancelledByUserId } });
    expect(isAcknowledgedNativeStop(evidence!)).toBe(true);
    expect(events.at(-1)).toMatchObject({ completedQueries: 1, groups: 1 });
    expect(Number(events.at(-1)?.responseValueBytes)).toBeLessThan(2048);
    expect(JSON.stringify(events)).not.toContain(bulk.slice(0, 64));
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]).toEqual(before);
    await db.update(heartbeatRuns).set({ resultJson: { ...result, nativeCancellation: { ...receipt, dispatchState: "pending" } } })
      .where(eq(heartbeatRuns.id, id));
    expect(isAcknowledgedNativeStop((await readNativeStopExecutionEvidence(db, company.id, id))!)).toBe(false);
    expect(await readNativeStopExecutionEvidence(db, randomUUID(), id)).toBeNull();
    expect(await readNativeStopExecutionEvidence(db, company.id, randomUUID())).toBeNull();
  });

  it.each([null, [], false, 42, "not a receipt", { nativeCancellation: null }, { nativeCancellation: { dispatched: "true" } }])(
    "keeps malformed receipts fail-closed: %j", async result => {
      const { company, agent } = await fixture();
      const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
        runtimeMode: "native", status: "cancelled" }).returning();
      await db.execute(sql`update ${heartbeatRuns} set result_json = ${JSON.stringify(result)}::jsonb where id = ${run.id}`);
      expect(isAcknowledgedNativeStop((await readNativeStopExecutionEvidence(db, company.id, run.id))!)).toBe(false);
    },
  );

  it.each(["string", "array"])("does not transfer a large malformed %s result", async kind => {
    const { company, agent } = await fixture();
    const bulk = randomBytes(128 * 1024).toString("base64");
    const saved = kind === "array" ? [bulk] : bulk;
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
      runtimeMode: "native", status: "cancelled" }).returning();
    await db.execute(sql`update ${heartbeatRuns} set result_json = ${JSON.stringify(saved)}::jsonb where id = ${run.id}`);
    const events: Array<Record<string, unknown>> = [], now = Date.now();
    const capture = createDatabaseResponseCapture({ start: now - 100, end: now + 59_000 }, event => events.push(event));
    installDatabaseResponseCapture(db, { heartbeatRuns }, capture);
    try {
      const evidence = await readNativeStopExecutionEvidence(db, company.id, run.id);
      expect(evidence?.resultJson).toBeNull();
      expect(isAcknowledgedNativeStop(evidence!)).toBe(false);
    } finally { capture.flush(); }
    expect(events.at(-1)).toMatchObject({ completedQueries: 1, groups: 1 });
    expect(Number(events.at(-1)?.responseValueBytes)).toBeLessThan(1024);
    expect((await db.select({ result: heartbeatRuns.resultJson }).from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0].result).toEqual(saved);
  });

  it("uses the scoped receipt reader for the native continuation recheck", async () => {
    const { company, agent } = await fixture();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Native continuation fixture" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
      nativeIssueId: issue.id, runtimeMode: "native", status: "succeeded" }).returning();
    const deps = callbacks(db);
    const control = createHeartbeatRunControl(db, deps);
    await control.resumeRemoteStopComments(run);
    expect(deps.getRun).not.toHaveBeenCalled();
  });
});
