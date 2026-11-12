import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  executeNativeSession,
  NativeSessionCloseUnrecoverableError,
  nativeSessionCleanupBlock,
  parseNativeExecutionInput,
  type NativeSession,
} from "../vendor/paperclip-runner/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * Reassignment stops the previous assignee's native run mid-turn. Its session
 * close continues in this process, and the runner refuses every new session of
 * the task until that close settles. The new assignee's run was dispatched into
 * that gate one second later and failed with native_session_cleanup_quarantined;
 * only a Retry continued the task. Admission now waits for the close instead.
 */
describeEmbeddedPostgres("queued native run behind the task's previous session cleanup", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let base: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-native-cleanup-hold-");
    db = createDb(tempDb.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: true });
    base = await mkdtemp(join(tmpdir(), "native-cleanup-hold-"));
  }, 90_000);

  afterAll(async () => {
    await db?.$client.end();
    await tempDb?.cleanup();
    if (base) await rm(base, { recursive: true, force: true });
  });

  async function seed() {
    const companyId = randomUUID(), previousId = randomUUID(), nextId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Cleanup Hold", defaultResponsibleUserId: "board",
      issuePrefix: `H${companyId.replaceAll("-", "").slice(0, 8)}` });
    await db.insert(agents).values([previousId, nextId].map(id => ({ id, companyId, name: `Worker ${id.slice(0, 4)}`,
      adapterType: "paperclip_runner", status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } })));
    await db.insert(issues).values({ id: issueId, companyId, title: "Edit the task", status: "todo", assigneeAgentId: nextId });
    return { companyId, previousId, nextId, issueId };
  }

  /** The previous assignee's session, stopped by the reassignment, still closing. */
  async function retainPreviousSessionClose(f: Awaited<ReturnType<typeof seed>>, close: () => Promise<void>) {
    const runId = randomUUID();
    const identity = { runId, sessionId: `closing-${runId}`, companyId: f.companyId, issueId: f.issueId, agentId: f.previousId };
    const capabilities = { resume: true, typedEvents: true, steering: false, interruption: false, structuredResult: true };
    const session: NativeSession = {
      identity: () => identity, capabilities: async () => capabilities,
      async *events() { throw new Error("stopped for reassignment"); },
      startTurn: async () => ({ turnId: "previous-turn" }), result: async () => null,
      async snapshot() { return { backendKind: "mock", sessionId: "previous-driver", identity,
        providerSessionId: "previous-provider", cursor: null, activeTurnId: null, pendingRuntimeRequests: [], lineage: [] }; },
      close,
    };
    await expect(executeNativeSession({
      input: parseNativeExecutionInput({ schema: "paperclip.native-execution-input.v1", provider: { kind: "codex", model: null },
        binding: { companyId: f.companyId, agentId: f.previousId, issueId: f.issueId, runId, executionWorkspaceId: runId },
        task: { identifier: "TEST", title: "Edit the task", description: null, prompt: "Edit the task", workMode: "standard" },
        workspace: { cwd: base, repoUrl: null, repoRef: null, branchName: null },
        session: { normalizedSessionId: identity.sessionId, driverKind: "codex_app_server", protocolVersion: 1,
          lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
        completionContract: { id: "contract", sha256: "sha", schemaVersion: "paperclip.completion-contract.v1",
          contract: { revision: "1", objective: "Edit the task", criteria: [{ id: "done", requirement: "Save the edit" }] } },
        interactionResponses: [], credentialBindings: [] }),
      backend: { descriptor: async () => ({ kind: "runner", name: "reassigned-backend", version: "1", capabilities }),
        openSession: async () => session },
      controlPlane: { openRun: async () => {}, checkpointSession: async () => {},
        appendEvent: async () => ({ cursor: 0, highestContiguousSourceSeq: 0, disposition: "committed" }),
        replayEvents: async () => ({ events: [], highestContiguousSourceSeq: 0 }), completeRun: async () => {} },
      runnerInstanceId: randomUUID(), controlPlaneInstanceId: "control",
    })).rejects.toThrow("stopped for reassignment");
  }

  async function queueNextAssigneeRun(f: Awaited<ReturnType<typeof seed>>) {
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.nextId,
      invocationSource: "assignment", triggerDetail: "system", status: "queued",
      contextSnapshot: { issueId: f.issueId, wakeReason: "issue_assigned" } }).returning();
    return run!;
  }

  const readRun = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;

  it("keeps the new assignee's run queued while the close settles, then admits it", async () => {
    const f = await seed();
    let settle = () => {};
    await retainPreviousSessionClose(f, () => new Promise<void>(resolve => { settle = resolve; }));
    expect(nativeSessionCleanupBlock({ companyId: f.companyId, issueId: f.issueId })).toBe("pending");

    const run = await queueNextAssigneeRun(f);
    await heartbeatService(db).resumeQueuedRuns();
    expect(await readRun(run.id)).toMatchObject({ status: "queued", startedAt: null });

    settle();
    await expect.poll(() => nativeSessionCleanupBlock({ companyId: f.companyId, issueId: f.issueId })).toBeNull();
    await heartbeatService(db).resumeQueuedRuns();
    await expect.poll(async () => (await readRun(run.id)).status).not.toBe("queued");
    expect((await readRun(run.id)).errorCode).not.toBe("native_session_cleanup_quarantined");
  });

  it("does not dispatch into a close that needs proof the old session stopped", async () => {
    const f = await seed();
    await retainPreviousSessionClose(f, async () => {
      throw new NativeSessionCloseUnrecoverableError({ runnerSuspended: true, providerDrained: false });
    });
    expect(nativeSessionCleanupBlock({ companyId: f.companyId, issueId: f.issueId })).toBe("operator_required");

    const run = await queueNextAssigneeRun(f);
    await heartbeatService(db).resumeQueuedRuns();
    // Not failed with native_session_cleanup_quarantined: it waits, and the
    // gate is retired as soon as the old runner and provider are proven stopped.
    expect(await readRun(run.id)).toMatchObject({ status: "queued", startedAt: null, errorCode: null });
  });

  it("does not hold a run for a different task", async () => {
    const f = await seed();
    await retainPreviousSessionClose(f, () => new Promise<void>(() => {}));
    const other = await seed();
    const run = await queueNextAssigneeRun(other);
    await heartbeatService(db).resumeQueuedRuns();
    await expect.poll(async () => (await readRun(run.id)).status).not.toBe("queued");
  });
});
