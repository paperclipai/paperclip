import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";

const execute = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.js")>("../adapters/index.js");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute })) };
});
const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("native terminal-run cleanup admission", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-cleanup-admission-");
    db = createDb(temporary.connectionString);
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });

  it("holds the same task until its native executor settles while allowing unrelated tasks", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), otherIssueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Cleanup admission", issuePrefix: "CLN", defaultResponsibleUserId: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "process",
      adapterConfig: {}, permissions: {}, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 20 } } });
    await db.insert(issues).values([issueId, otherIssueId].map(id => ({ id, companyId, title: "Recovery task", status: "todo", assigneeAgentId: agentId, responsibleUserId: "owner" })));
    let release!: () => void, entered!: () => void;
    const cleanupGate = new Promise<void>(resolve => { release = resolve; });
    const terminal = new Promise<void>(resolve => { entered = resolve; });
    let first = true;
    execute.mockImplementation(async (context: { runId: string; context: { issueId: string } }) => {
      if (first) {
        first = false;
        // Native finalization commits success before workspace/lease cleanup
        // finishes. Keep the real heartbeat executor alive across that boundary.
        await db.update(heartbeatRuns).set({ status: "succeeded", runtimeMode: "native", finishedAt: new Date() }).where(eq(heartbeatRuns.id, context.runId));
        entered();
        await cleanupGate;
      } else {
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, context.context.issueId));
      }
      return { exitCode: 0, signal: null, timedOut: false, summary: "Completed" };
    });
    const heartbeat = heartbeatService(db);
    const nextId = randomUUID(), otherId = randomUUID();
    try {
      await heartbeat.invoke(agentId, "on_demand", { issueId }, "manual");
      await terminal;
      await db.insert(heartbeatRuns).values([
        { id: nextId, companyId, agentId, status: "queued", invocationSource: "on_demand", responsibleUserId: "owner", contextSnapshot: { issueId } },
        { id: otherId, companyId, agentId, status: "queued", invocationSource: "on_demand", responsibleUserId: "owner", contextSnapshot: { issueId: otherIssueId } },
      ]);
      await heartbeat.resumeQueuedRuns();
      expect((await heartbeat.getRun(nextId))?.status).toBe("queued");
      expect((await heartbeat.getRun(otherId))?.status).not.toBe("queued");
    } finally {
      release();
      await heartbeat.drainActiveRunExecutions();
    }
    expect((await heartbeat.getRun(nextId))?.status).toBe("succeeded");
    expect(execute).toHaveBeenCalledTimes(3);
  }, 30_000);
});
