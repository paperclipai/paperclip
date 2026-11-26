import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns, issues } from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter, type AdapterExecutionContext } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { getRunLogStore } from "../services/run-log-store.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping run output tests: ${support.reason}`);

describePostgres("heartbeat output through adapter dispatch and finalization", () => {
  const adapterType = "run_output_test";
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const executeByAgent = new Map<string, (input: AdapterExecutionContext) => Promise<void>>();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("heartbeat-run-output-");
    db = createDb(temporary.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: adapterType, supportsLocalAgentJwt: false,
      execute: async (input) => {
        await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, String(input.context.issueId)));
        await executeByAgent.get(input.agent.id)!(input);
        return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
      },
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 30_000);
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    unregisterServerAdapter(adapterType);
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });

  async function seed(execute: (input: AdapterExecutionContext) => Promise<void>) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Output fixture", issuePrefix: `O${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Output writer", adapterType, status: "idle" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Output fixture", status: "todo", assigneeAgentId: agentId, responsibleUserId: "output-user", issueNumber: 1 });
    executeByAgent.set(agentId, execute);
    return { companyId, agentId, issueId };
  }
  async function execute(f: Awaited<ReturnType<typeof seed>>) {
    const run = await heartbeat.wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual", reason: "manual", payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId } });
    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    const finished = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id)).then(rows => rows[0]);
    expect(finished).toBeDefined();
    const log = await heartbeat.readLog(run!.id);
    const entries = log.content.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    return { finished, entries };
  }

  it("redacts stored and live chunks, preserves sequence, and flushes the last output at completion", async () => {
    const secret = "output-test-bearer-canary";
    const f = await seed(async input => {
      await input.onLog("stdout", `first: Authorization: Bearer ${secret}\n`);
      await input.onLog("stdout", `${"x".repeat(10_000)}live-tail\n`);
      await input.onLog("stderr", "last stderr\n");
      await input.onMeta?.({ adapterType, command: "fixture", env: { PAPERCLIP_API_KEY: secret }, prompt: "fixture prompt" });
      await input.onEvent?.({ eventType: "  fixture.progress  ", stream: "system", level: "info", message: "fixture event", payload: { step: 1 } });
      await input.onEvent?.({ eventType: "   ", stream: "system", level: "info", message: "ignored blank event" });
    });
    const live: Record<string, unknown>[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(f.companyId, event => {
      if (event.type === "heartbeat.run.log") live.push(event.payload);
    });
    try {
      const { finished, entries } = await execute(f);
      expect(finished.status, finished.error ?? undefined).toBe("succeeded");
      const ownLive = live.filter(event => event.runId === finished.id);
      expect(entries.map(entry => entry.seq)).toEqual(entries.map((_, i) => i + 1));
      expect(ownLive.map(event => event.seq)).toEqual(entries.map(entry => entry.seq));
      expect(JSON.stringify(entries)).not.toContain(secret);
      expect(JSON.stringify(ownLive)).not.toContain(secret);
      expect(finished.stdoutExcerpt).not.toContain(secret);
      expect(finished.stderrExcerpt).toContain("last stderr");
      expect(ownLive.find(event => String(event.chunk).endsWith("live-tail\n"))).toMatchObject({ truncated: true });
      expect(finished.lastOutputSeq).toBe(entries.at(-1).seq);
      expect(finished.lastOutputStream).toBe("stderr");
      expect(finished.lastOutputBytes).toBe(finished.logBytes);
      expect(finished.lastOutputAt).toEqual(new Date(entries.at(-1).ts));
      const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, finished.id));
      expect(JSON.stringify(events)).not.toContain(secret);
      expect(events.find(event => event.eventType === "adapter.invoke")?.payload).toMatchObject({ env: { PAPERCLIP_API_KEY: "***REDACTED***" } });
      expect(events.find(event => event.eventType === "fixture.progress")).toMatchObject({ message: "fixture event", payload: { step: 1 } });
      expect(events.some(event => event.message === "ignored blank event")).toBe(false);
    } finally { unsubscribe(); }
  });

  it.each([false, true])("retains output arriving during finalization (adapter throws: %s)", async fail => {
    let onLog: AdapterExecutionContext["onLog"];
    const f = await seed(async input => {
      onLog = input.onLog;
      await onLog("stdout", "before finalization\n");
      if (fail) throw new Error("invalid fixture configuration");
    });
    const store = getRunLogStore();
    const finalize = store.finalize.bind(store);
    vi.spyOn(store, "finalize").mockImplementationOnce(async handle => {
      await onLog("stdout", "during finalization\n");
      return finalize(handle);
    });
    const { finished, entries } = await execute(f);
    expect(finished.status, finished.error ?? undefined).toBe(fail ? "failed" : "succeeded");
    expect(finished.stdoutExcerpt).toContain("before finalization");
    expect(finished.stdoutExcerpt).toContain("during finalization");
    expect(entries.at(-1).chunk).toBe("during finalization\n");
    expect(finished.lastOutputSeq).toBe(entries.at(-1).seq);
    expect(finished.lastOutputBytes).toBe(finished.logBytes);
  });
});
