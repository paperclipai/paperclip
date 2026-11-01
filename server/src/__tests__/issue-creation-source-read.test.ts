import { randomUUID } from "node:crypto";
import { activityLog, agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { createDatabaseResponseCapture, installDatabaseResponseCapture } from "@paperclipai/db/response-capture";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveIssueCreationSource, runBoundIssueReference } from "../services/issue-creation-source.js";

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("creation source run projections", () => {
  const companyId = randomUUID(), otherCompanyId = randomUUID(), agentId = randomUUID();
  const sourceId = randomUUID(), secondId = randomUUID(), foreignId = randomUUID();
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let childNumber = 100;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("creation-source-read-");
    db = createDb(database.connectionString);
    await db.insert(companies).values([
      { id: companyId, name: "Creation source fixture", issuePrefix: "CSR" },
      { id: otherCompanyId, name: "Foreign source fixture", issuePrefix: "FSR" },
    ]);
    await db.insert(agents).values({ id: agentId, companyId, name: "Source agent", adapterType: "process" });
    await db.insert(issues).values([
      { id: sourceId, companyId, title: "Source task", identifier: "CSR-1", issueNumber: 1 },
      { id: secondId, companyId, title: "Second source task", identifier: "CSR-2", issueNumber: 2 },
      { id: foreignId, companyId: otherCompanyId, title: "Foreign task", identifier: "FSR-1", issueNumber: 1 },
    ]);
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });

  async function fixture(values: Partial<typeof heartbeatRuns.$inferInsert>) {
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded", ...values }).returning();
    const number = childNumber++;
    const [child] = await db.insert(issues).values({ companyId, title: "Created task", identifier: `CSR-${number}`,
      issueNumber: number, originRunId: run.id }).returning();
    return { run, child };
  }

  it.each(["scoped", "legacy task key", "legacy nested identifier"])("omits saved run payloads for %s bindings while preserving provenance and storage", async (binding) => {
    const bulk = "retained-source-context🙂".repeat(32_768);
    const contextSnapshot = binding === "scoped"
      ? { issueId: sourceId, paperclipIssue: { id: sourceId, retainedDescription: bulk }, retainedLaunchInput: bulk }
      : binding === "legacy task key"
        ? { taskKey: "CSR-1", paperclipIssue: { retainedDescription: bulk }, retainedLaunchInput: bulk }
        : { paperclipIssue: { id: "CSR-1", retainedDescription: bulk }, retainedLaunchInput: bulk };
    const { run, child } = await fixture({ contextSnapshot,
      runnerProfileJson: { retainedInput: bulk }, stdoutExcerpt: bulk, stderrExcerpt: bulk, resultJson: { retainedReceipt: bulk } });
    expect(run.issueId).toBe(binding === "scoped" ? sourceId : null);
    expect(run.nativeIssueId).toBeNull();
    const observed = createDb(database.connectionString), events: Array<Record<string, unknown>> = [], now = Date.now();
    const capture = createDatabaseResponseCapture({ start: now - 100, end: now + 59_000 }, event => events.push(event));
    installDatabaseResponseCapture(observed, { heartbeatRuns, issues }, capture);
    try {
      const result = await resolveIssueCreationSource(observed, child);
      capture.flush();
      const reads = events.filter(event => event.table === "heartbeat_runs" && event.operation === "select");
      expect(reads.reduce((count, event) => count + Number(event.calls), 0)).toBe(1);
      expect(reads.reduce((bytes, event) => bytes + Number(event.responseValueBytes), 0)).toBeLessThan(8192);
      expect(result).toMatchObject({ run: { id: run.id, companyId, agentId }, sourceIssue: { id: sourceId } });
      expect(runBoundIssueReference(result!.run)).toBe(binding === "scoped" ? sourceId : "CSR-1");
      for (const key of ["runnerProfileJson", "stdoutExcerpt", "stderrExcerpt", "resultJson"]) expect(result!.run).not.toHaveProperty(key);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0]).toEqual(run);
      expect(JSON.stringify(events)).not.toContain("retained-source-context");
    } finally {
      capture.flush();
      await observed.$client.end();
    }
  });

  it.each([
    { label: "native identity", nativeIssueId: sourceId, issueId: secondId, contextSnapshot: { issueId: secondId }, expected: sourceId },
    { label: "issue scope", issueId: sourceId, contextSnapshot: { issueId: secondId }, expected: sourceId },
    { label: "legacy issue id", contextSnapshot: { issueId: sourceId, taskId: secondId }, expected: sourceId },
    { label: "typed task id fallback", contextSnapshot: { issueId: 42, taskId: sourceId }, expected: sourceId },
    { label: "nested issue identifier", contextSnapshot: { issueId: " ", paperclipIssue: { id: "CSR-1", ignored: "payload" }, taskKey: "CSR-2" }, expected: sourceId },
    { label: "typed nested id fallback", contextSnapshot: { paperclipIssue: { id: 42 }, taskKey: "CSR-1" }, expected: sourceId },
    { label: "foreign context", contextSnapshot: { taskId: foreignId }, expected: null },
    { label: "null context", contextSnapshot: null, expected: null },
  ])("preserves binding precedence for $label", async ({ label: _label, expected, ...values }) => {
    const { child } = await fixture(values);
    expect((await resolveIssueCreationSource(db, child))?.sourceIssue.id ?? null).toBe(expected);
  });

  it.each([42, "scalar", ["issueId", sourceId]])("does not invent a task binding from malformed context %j", async (context) => {
    const { child } = await fixture({ contextSnapshot: context as unknown as Record<string, unknown> });
    expect(await resolveIssueCreationSource(db, child)).toBeNull();
  });

  it("preserves historical activity lookup, current bindings, and missing or foreign source denial", async () => {
    const { run, child } = await fixture({ contextSnapshot: { taskKey: "CSR-1" } });
    await db.update(issues).set({ originRunId: null }).where(eq(issues.id, child.id));
    await db.insert(activityLog).values({ companyId, actorType: "system", actorId: "fixture", action: "issue.created",
      entityType: "issue", entityId: child.id, runId: run.id });
    expect((await resolveIssueCreationSource(db, { ...child, originRunId: null }))?.sourceIssue.id).toBe(sourceId);
    await db.update(heartbeatRuns).set({ contextSnapshot: { taskKey: "CSR-2" } }).where(eq(heartbeatRuns.id, run.id));
    expect((await resolveIssueCreationSource(db, child))?.sourceIssue.id).toBe(secondId);
    expect(await resolveIssueCreationSource(db, { ...child, companyId: otherCompanyId })).toBeNull();
    expect(await resolveIssueCreationSource(db, { ...child, originRunId: randomUUID() })).toBeNull();
    await db.update(heartbeatRuns).set({ contextSnapshot: { taskId: child.id } }).where(eq(heartbeatRuns.id, run.id));
    expect(await resolveIssueCreationSource(db, child)).toBeNull();
  });
});
