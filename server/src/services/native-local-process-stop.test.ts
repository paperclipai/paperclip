import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { currentProcessSpaceHash, currentProcessStartedAtMs } from "./controller-process-identity.js";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { PROCESS_IDENTITY_RECORDED, recordedLocalExecutionStopped } from "./native-local-process-stop.js";

const support = await getEmbeddedPostgresTestSupport();

// Phase 2: a bound local execution is judged by the shared prover
// (proveOwnerGone), in the PID space the row recorded.
(support.supported ? describe : describe.skip)("recordedLocalExecutionStopped", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("native-local-stop-");
    db = createDb(database.connectionString, { maxConnections: 2 });
    companyId = randomUUID(); agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Local stop", issuePrefix: `L${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", role: "general", adapterType: "codex_local",
      status: "idle" });
  }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  /** A failed run with its process identity bound by the launch event. */
  async function execution(input: { pid: number; startedAt: Date; processHostHash: string | null }) {
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed", runtimeMode: "native",
      processPid: input.pid, processGroupId: input.pid, processStartedAt: input.startedAt,
      processHostHash: input.processHostHash }).returning();
    await appendHeartbeatRunEvent(db, { companyId, runId: run!.id, agentId, eventType: PROCESS_IDENTITY_RECORDED,
      payload: { targetKind: "local", hostname: hostname(), processPid: input.pid, processGroupId: input.pid,
        processStartedAt: input.startedAt.toISOString() } });
    return run!;
  }
  const deadPid = 2_000_000_001;
  const minuteAgo = () => new Date(Date.now() - 60_000);
  const ownStart = async () => new Date((await currentProcessStartedAtMs())!);

  it("is stopped when its dead PID was recorded in this PID space", async () => {
    expect(await recordedLocalExecutionStopped(db, await execution({ pid: deadPid, startedAt: minuteAgo(),
      processHostHash: currentProcessSpaceHash() }))).toBe(true);
  });

  it("is never stopped by a dead PID recorded in another PID space", async () => {
    expect(await recordedLocalExecutionStopped(db, await execution({ pid: deadPid, startedAt: minuteAgo(),
      processHostHash: "another-pid-space" }))).toBe(false);
  });

  it("keeps the host-bound proof for a row saved before its PID space", async () => {
    expect(await recordedLocalExecutionStopped(db, await execution({ pid: deadPid, startedAt: minuteAgo(),
      processHostHash: null }))).toBe(true);
  });

  it("is not stopped while the same process is alive", async () => {
    expect(await recordedLocalExecutionStopped(db, await execution({ pid: process.pid, startedAt: await ownStart(),
      processHostHash: currentProcessSpaceHash() }))).toBe(false);
  });

  it("is stopped when a later process reused its PID and leads the group", async () => {
    // This test process started definitely after the recorded execution.
    const recorded = new Date((await ownStart()).getTime() - 5_000);
    // A group with this id is either empty or led by this later process, so
    // it cannot hold the recorded execution's children.
    expect(await recordedLocalExecutionStopped(db, await execution({ pid: process.pid, startedAt: recorded,
      processHostHash: currentProcessSpaceHash() }))).toBe(true);
  });
});
