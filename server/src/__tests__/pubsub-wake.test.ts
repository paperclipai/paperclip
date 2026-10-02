import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, companies, createDb, issues, type Db,
} from "@paperclipai/db";
import { selectPaperclipPromptSections } from "@paperclipai/adapter-utils/server-utils";
import { PUBSUB_WAKE_COOLDOWN_MS, PUBSUB_WAKE_STALE_MS } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { buildPaperclipWakePayload } from "../services/heartbeat.js";
import { createPubsubWake, findOrCreatePubsubCoordinationIssue } from "../services/pubsub-wake.js";
import { NativeRuntimeEligibilityError, resolveNativeRuntimeMode } from "../services/native-runtime/runtime-mode.js";

// The wake bridge creates the coordination issue through the issue service.
// Tests swap the service-level create for a stub; production code is untouched.
const wakeIssueCreate = vi.hoisted(() => ({ override: null as null | ((companyId: string, input: Record<string, unknown>) => Promise<{ id: string }>) }));
vi.mock("../services/issues.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/issues.js")>();
  return {
    issueService: (db: Db) => ({
      create: async (companyId: string, input: Record<string, unknown>) =>
        wakeIssueCreate.override
          ? wakeIssueCreate.override(companyId, input)
          : real.issueService(db).create(companyId, input as never),
    }),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const deliveredMessage = {
  id: randomUUID(),
  topic: "fleet.chat.workload",
  payload: { instruction: "coordinate the cutover", labels: ["alpha", "beta"] },
  fromInstance: randomUUID(),
  fromCompany: randomUUID(),
  fromAgent: null,
  fromRole: "board",
};

describe("PubSub wake projection", () => {
  it("surfaces the delivered message in the projected wake payload and the rendered prompt", async () => {
    // No issueId and no other snapshot content: the builder must not touch the database.
    const db = { select: () => { throw new Error("unexpected database access"); } } as unknown as Db;
    const projected = await buildPaperclipWakePayload({
      db,
      companyId: randomUUID(),
      contextSnapshot: { wakeReason: "pubsub_message", pubsubMessage: deliveredMessage },
    });
    expect(projected).not.toBeNull();
    expect(projected?.reason).toBe("pubsub_message");
    expect(projected?.pubsubMessage).toEqual({
      messageId: deliveredMessage.id,
      topic: deliveredMessage.topic,
      payload: deliveredMessage.payload,
      sender: {
        instance: deliveredMessage.fromInstance,
        company: deliveredMessage.fromCompany,
        agent: null,
        role: "board",
      },
    });

    const { wakePrompt } = selectPaperclipPromptSections({ paperclipWake: projected });
    expect(wakePrompt).toContain("## PubSub Message");
    expect(wakePrompt).toContain(`- Message ID: ${deliveredMessage.id}`);
    expect(wakePrompt).toContain("- Topic: fleet.chat.workload");
    expect(wakePrompt).toContain("- Sender: role board");
    expect(wakePrompt).toContain("```text");
    expect(wakePrompt).toContain(JSON.stringify(deliveredMessage.payload, null, 2));
  });
});

/** Receipt rows the wake-bridge mock serves; the mock applies each query's real filters. */
type WakeReceipt = { id: string; companyId: string; idempotencyKey: string; status: string; error: string | null; finishedAt: string | null; updatedAt: string; runId: string | null };
const LIVE_WAKE_STATUSES = ["queued", "claimed", "coalesced", "deferred_issue_execution", "running"];
const DELIVERED_WAKE_STATUSES = [...LIVE_WAKE_STATUSES, "completed", "failed"];
const SETTLED_RUN_STATUSES = ["succeeded", "failed", "cancelled", "timed_out", "interrupted", "skipped"];
/** Linked run rows the guard's EXISTS reads: status plus liveness evidence. */
type StubRun = { status: string; lastOutputAt?: string | null; startedAt?: string | null; createdAt?: string | null; controllerLeaseExpiresAt?: string | null };

/**
 * Fixture db emulating the wake bridge's `agent_wakeup_requests` queries: the
 * receipt verdict filters the exact idempotency key (selects status+error),
 * the in-flight guard filters company + live status (selects id), and the
 * post-wake check filters exact key + delivered status (selects id). The
 * guard mirrors production: a live receipt holds the slot while its linked
 * run (from `runs`) is open AND still shows liveness (unexpired controller
 * lease or an activity clock inside the stale window), or while the receipt
 * itself is inside the stale window; terminal receipts hold it through the
 * cooldown.
 */
function wakeBridgeDb(options: {
  ceo: { id: string; companyId: string; role: string; status: string; adapterType: string };
  companyId: string;
  key: string;
  receipts: WakeReceipt[];
  runs: Record<string, StubRun>;
  standingIssues: Array<{ id: string }>;
  postWake: { current: boolean };
}) {
  const getSql = () => ({ sql: "select 1", nativeParameters: [] as unknown[], parameters: [] as unknown[] });
  const rowsFor = (table: object, fields?: unknown): unknown[] => {
    if (table === agents) return [options.ceo];
    if (table === issues) return options.standingIssues;
    if (table === agentWakeupRequests) {
      const keys = fields ? Object.keys(fields as Record<string, unknown>) : [];
      if (keys.includes("status")) return options.receipts.filter((receipt) => receipt.idempotencyKey === options.key);
      if (options.postWake.current) return options.receipts.filter((receipt) => receipt.idempotencyKey === options.key
        && DELIVERED_WAKE_STATUSES.includes(receipt.status));
      // Guard: live wakes hold the slot while their linked run is open AND
      // demonstrates liveness (mirrors production's EXISTS over
      // heartbeat_runs with the lease/activity-clock predicate), or while the
      // receipt itself is inside the stale window; terminal wakes hold it
      // through the cooldown.
      return options.receipts.filter((receipt) => {
        if (receipt.companyId !== options.companyId) return false;
        if (LIVE_WAKE_STATUSES.includes(receipt.status)) {
          const run = receipt.runId !== null ? options.runs[receipt.runId] : undefined;
          const runStillOpen = run !== undefined && !SETTLED_RUN_STATUSES.includes(run.status);
          const activityClock = run ? run.lastOutputAt ?? run.startedAt ?? run.createdAt ?? null : null;
          const runLive = runStillOpen && run !== undefined && (
            (run.controllerLeaseExpiresAt != null && Date.parse(run.controllerLeaseExpiresAt) >= Date.now())
            || (activityClock != null && Date.parse(activityClock) >= Date.now() - PUBSUB_WAKE_STALE_MS));
          return runLive || Date.parse(receipt.updatedAt) >= Date.now() - PUBSUB_WAKE_STALE_MS;
        }
        return ["completed", "failed"].includes(receipt.status) && receipt.finishedAt !== null
          && Date.parse(receipt.finishedAt) >= Date.now() - PUBSUB_WAKE_COOLDOWN_MS;
      });
    }
    return [];
  };
  const db = {
    select: (fields?: unknown) => ({
      from: (table: object) => ({
        where: (_where?: unknown) => ({
          getSQL: getSql,
          orderBy: (..._order: unknown[]) => ({ getSQL: getSql, limit: async () => rowsFor(table, fields) }),
          limit: async () => rowsFor(table, fields),
        }),
      }),
    }),
  };
  db.execute = async () => ({});
  db.transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(db);
  return db as unknown as Db;
}

type ReceiptSeed = { status: string; error?: string | null; idempotencyKey?: string; companyId?: string; finishedAt?: string | null; updatedAt?: string; runId?: string | null };

describe("PubSub wake task scope for native-runner CEOs", () => {
  const ceoId = randomUUID();
  const coordinationIssue = { id: randomUUID(), title: "PubSub Coordination" };

  function wakeHarness(options: { adapterType: string; receipts?: ReceiptSeed[]; standingIssueId?: string; runs?: Record<string, StubRun>; topic?: string }) {
    const companyId = randomUUID();
    const message = {
      id: randomUUID(), topic: options.topic ?? "fleet.chat.workload", payload: deliveredMessage.payload,
      fromInstance: randomUUID(), fromCompany: randomUUID(), fromAgent: null, fromRole: "board",
      envelope: null,
    };
    const key = `pubsub:${companyId}:${message.fromInstance}:${message.fromCompany}:${message.id}`;
    const receipts: WakeReceipt[] = (options.receipts ?? []).map((seed) => ({
      id: randomUUID(),
      companyId: seed.companyId ?? companyId,
      idempotencyKey: seed.idempotencyKey ?? key,
      status: seed.status,
      error: seed.error ?? null,
      finishedAt: seed.finishedAt ?? null,
      updatedAt: seed.updatedAt ?? new Date().toISOString(),
      runId: seed.runId ?? null,
    }));
    const postWake = { current: false };
    const seen: Array<{ agentId: string; options: Record<string, unknown> }> = [];
    const heartbeat = {
      wakeup: async (agentId: string, wakeOptions: Record<string, unknown>) => {
        seen.push({ agentId, options: wakeOptions });
        // Simulate the durable receipt so the bridge's post-wake check passes.
        postWake.current = true;
        receipts.push({ id: randomUUID(), companyId, idempotencyKey: key, status: "queued", error: null, finishedAt: null, updatedAt: new Date().toISOString(), runId: null });
      },
    };
    const db = wakeBridgeDb({
      ceo: { id: ceoId, companyId, role: "ceo", status: "active", adapterType: options.adapterType },
      companyId, key, receipts,
      runs: options.runs ?? {},
      standingIssues: options.standingIssueId ? [{ id: options.standingIssueId }] : [],
      postWake,
    });
    return { db, heartbeat, seen, message, companyId, key };
  }

  it("gives a runner CEO wake a durable issue scope that passes native eligibility", async () => {
    wakeIssueCreate.override = async (_companyId, input) => {
      expect(input).toMatchObject({ title: "PubSub Coordination", status: "todo", priority: "medium", allowDuplicate: false });
      return coordinationIssue;
    };
    const { db, heartbeat, seen, message, companyId } = wakeHarness({ adapterType: "paperclip_runner" });
    await createPubsubWake(db, heartbeat)(companyId, message);
    wakeIssueCreate.override = null;

    expect(seen).toHaveLength(1);
    expect(seen[0].agentId).toBe(ceoId);
    const { payload, contextSnapshot } = seen[0].options as {
      payload: Record<string, unknown>;
      contextSnapshot: Record<string, unknown>;
    };
    // The scope is a durably created issue id persisted on the wake, not recomputed later.
    expect(payload.issueId).toBe(coordinationIssue.id);
    expect(contextSnapshot.issueId).toBe(coordinationIssue.id);
    expect(contextSnapshot.wakeReason).toBe("pubsub_message");
    expect(contextSnapshot.pubsubMessage).toMatchObject({
      id: message.id, topic: message.topic, fromRole: "board",
    });

    // The exact native runtime eligibility input built from the wake scope is runnable.
    const resolution = resolveNativeRuntimeMode({
      enabled: true, runtimeConfig: null, adapterConfig: { provider: "codex" },
      agent: { id: ceoId, status: "active", adapterType: "paperclip_runner" },
      issue: { id: coordinationIssue.id, workMode: "standard" },
      target: null, workspaceId: null,
    });
    expect(resolution.kind).toBe("native");
    // Without the scope the same selection is exactly the failure the review found.
    let thrown: unknown;
    try {
      resolveNativeRuntimeMode({
        enabled: true, runtimeConfig: null, adapterConfig: { provider: "codex" },
        agent: { id: ceoId, status: "active", adapterType: "paperclip_runner" },
        issue: null, target: null, workspaceId: null,
      });
    } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(NativeRuntimeEligibilityError);
    expect((thrown as NativeRuntimeEligibilityError).code).toBe("paperclip_runner_issue_ineligible");

    // The durable receipt suppresses re-queueing; the wake is neither lost nor duplicated.
    await createPubsubWake(db, heartbeat)(companyId, message);
    expect(seen).toHaveLength(1);
  });

  it("keeps unscoped wake behavior for non-runner CEOs", async () => {
    const created: unknown[] = [];
    wakeIssueCreate.override = async (_companyId, input) => {
      created.push(input);
      return coordinationIssue;
    };
    const { db, heartbeat, seen, message, companyId } = wakeHarness({ adapterType: "claude_local" });
    await createPubsubWake(db, heartbeat)(companyId, message);
    wakeIssueCreate.override = null;

    expect(seen).toHaveLength(1);
    expect(created).toHaveLength(0);
    const { payload, contextSnapshot } = seen[0].options as {
      payload: Record<string, unknown>;
      contextSnapshot: Record<string, unknown>;
    };
    expect(payload.issueId).toBeUndefined();
    expect(contextSnapshot.issueId).toBeUndefined();
    expect(contextSnapshot.pubsubMessage).toBeDefined();
  });

  it("re-queues a wake that a budget pause cancelled", async () => {
    const { db, heartbeat, seen, message, companyId } = wakeHarness({
      adapterType: "claude_local",
      receipts: [{ status: "cancelled", error: "Cancelled due to budget pause" }],
    });
    await createPubsubWake(db, heartbeat)(companyId, message);
    expect(seen).toHaveLength(1);
  });

  it("keeps operator-stopped wakes suppressed", async () => {
    const { db, heartbeat, seen, message, companyId } = wakeHarness({
      adapterType: "claude_local",
      receipts: [{ status: "cancelled", error: "Cancelled by operator" }],
    });
    await createPubsubWake(db, heartbeat)(companyId, message);
    expect(seen).toHaveLength(0);
  });

  it("re-queues a skipped wake until the CEO is available", async () => {
    const { db, heartbeat, seen, message, companyId } = wakeHarness({
      adapterType: "claude_local",
      receipts: [{ status: "skipped" }],
    });
    await createPubsubWake(db, heartbeat)(companyId, message);
    expect(seen).toHaveLength(1);
  });

  it("defers a wake while another PubSub wake for the company is live", async () => {
    const otherKey = `pubsub:${randomUUID()}:${randomUUID()}:${randomUUID()}:${randomUUID()}`;
    const { db, heartbeat, seen, message, companyId } = wakeHarness({
      adapterType: "claude_local",
      receipts: [{ status: "running", idempotencyKey: otherKey }],
    });
    await expect(createPubsubWake(db, heartbeat)(companyId, message)).rejects.toThrow("in flight");
    expect(seen).toHaveLength(0);
  });

  it("re-allows a wake once a live PubSub receipt for the company is stale (owner crashed)", async () => {
    const otherKey = `pubsub:${randomUUID()}:${randomUUID()}:${randomUUID()}:${randomUUID()}`;
    const { db, heartbeat, seen, message, companyId } = wakeHarness({
      adapterType: "claude_local",
      // A live receipt whose owner was killed mid-flight: it stays non-terminal
      // (its run sits behind the controller lease / reaper staleness threshold),
      // so it must stop holding the slot once it is older than the stale window.
      receipts: [{ status: "claimed", updatedAt: new Date(Date.now() - (PUBSUB_WAKE_STALE_MS + 1_000)).toISOString(), idempotencyKey: otherKey }],
    });
    await createPubsubWake(db, heartbeat)(companyId, message);
    expect(seen).toHaveLength(1);
  });

  it("keeps deferring while a live PubSub receipt's linked run still shows liveness (healthy long wake)", async () => {
    const otherKey = `pubsub:${randomUUID()}:${randomUUID()}:${randomUUID()}:${randomUUID()}`;
    const runId = randomUUID();
    const { db, heartbeat, seen, message, companyId } = wakeHarness({
      adapterType: "claude_local",
      // A healthy wake running well past the stale window: its receipt is old
      // but the linked run is open and producing provider output, so it must
      // keep holding the slot.
      runs: { [runId]: { status: "running", startedAt: new Date(Date.now() - 3_600_000).toISOString(), lastOutputAt: new Date(Date.now() - 5_000).toISOString() } },
      receipts: [{ status: "running", runId, updatedAt: new Date(Date.now() - (PUBSUB_WAKE_STALE_MS + 600_000)).toISOString(), idempotencyKey: otherKey }],
    });
    await expect(createPubsubWake(db, heartbeat)(companyId, message)).rejects.toThrow("in flight");
    expect(seen).toHaveLength(0);
  });

  it("re-allows a wake once a stale live PubSub receipt's linked run lost liveness (SIGKILL orphan)", async () => {
    const otherKey = `pubsub:${randomUUID()}:${randomUUID()}:${randomUUID()}:${randomUUID()}`;
    const runId = randomUUID();
    const { db, heartbeat, seen, message, companyId } = wakeHarness({
      adapterType: "claude_local",
      // The stuck-receipt defect: the wake owner was SIGKILL'd mid-flight, so
      // the receipt stayed `claimed` while the run sits parked non-terminal
      // forever. Once the receipt AND every liveness signal on the run age
      // past the stale window, the slot must be released for new wakes.
      runs: { [runId]: { status: "running", startedAt: new Date(Date.now() - (PUBSUB_WAKE_STALE_MS + 600_000)).toISOString(), lastOutputAt: null, createdAt: new Date(Date.now() - (PUBSUB_WAKE_STALE_MS + 600_000)).toISOString(), controllerLeaseExpiresAt: null } },
      receipts: [{ status: "claimed", runId, updatedAt: new Date(Date.now() - (PUBSUB_WAKE_STALE_MS + 1_000)).toISOString(), idempotencyKey: otherKey }],
    });
    await createPubsubWake(db, heartbeat)(companyId, message);
    expect(seen).toHaveLength(1);
  });

  it("re-allows a wake once a stale live PubSub receipt's linked run has settled", async () => {
    const otherKey = `pubsub:${randomUUID()}:${randomUUID()}:${randomUUID()}:${randomUUID()}`;
    const runId = randomUUID();
    const { db, heartbeat, seen, message, companyId } = wakeHarness({
      adapterType: "claude_local",
      // A live receipt older than the stale window whose run already settled:
      // the receipt no longer holds the slot even if reconciliation has not
      // yet settled the receipt itself.
      runs: { [runId]: { status: "succeeded" } },
      receipts: [{ status: "running", runId, updatedAt: new Date(Date.now() - (PUBSUB_WAKE_STALE_MS + 1_000)).toISOString(), idempotencyKey: otherKey }],
    });
    await createPubsubWake(db, heartbeat)(companyId, message);
    expect(seen).toHaveLength(1);
  });

  it("keeps deferring while a live PubSub receipt for the company is still fresh", async () => {
    const otherKey = `pubsub:${randomUUID()}:${randomUUID()}:${randomUUID()}:${randomUUID()}`;
    const { db, heartbeat, seen, message, companyId } = wakeHarness({
      adapterType: "claude_local",
      receipts: [{ status: "claimed", updatedAt: new Date(Date.now() - 5_000).toISOString(), idempotencyKey: otherKey }],
    });
    await expect(createPubsubWake(db, heartbeat)(companyId, message)).rejects.toThrow("in flight");
    expect(seen).toHaveLength(0);
  });

  it("defers a wake while a recent PubSub wake for the company is inside the cooldown", async () => {
    const otherKey = `pubsub:${randomUUID()}:${randomUUID()}:${randomUUID()}:${randomUUID()}`;
    const { db, heartbeat, seen, message, companyId } = wakeHarness({
      adapterType: "claude_local",
      receipts: [{ status: "completed", finishedAt: new Date(Date.now() - 10_000).toISOString(), idempotencyKey: otherKey }],
    });
    await expect(createPubsubWake(db, heartbeat)(companyId, message)).rejects.toThrow("recently settled");
    expect(seen).toHaveLength(0);
  });

  it("re-allows a wake once the company PubSub wake cooldown has passed", async () => {
    const otherKey = `pubsub:${randomUUID()}:${randomUUID()}:${randomUUID()}:${randomUUID()}`;
    const { db, heartbeat, seen, message, companyId } = wakeHarness({
      adapterType: "claude_local",
      receipts: [{ status: "failed", finishedAt: new Date(Date.now() - (PUBSUB_WAKE_COOLDOWN_MS + 1_000)).toISOString(), idempotencyKey: otherKey }],
    });
    await createPubsubWake(db, heartbeat)(companyId, message);
    expect(seen).toHaveLength(1);
  });

  it("reuses the standing coordination issue without recreating it", async () => {
    const standingId = randomUUID();
    const created: unknown[] = [];
    wakeIssueCreate.override = async (_companyId, input) => {
      created.push(input);
      return coordinationIssue;
    };
    const { db, heartbeat, seen, message, companyId } = wakeHarness({ adapterType: "paperclip_runner", standingIssueId: standingId });
    await createPubsubWake(db, heartbeat)(companyId, message);
    wakeIssueCreate.override = null;
    expect(created).toHaveLength(0);
    expect(seen).toHaveLength(1);
    expect((seen[0].options as { payload: Record<string, unknown> }).payload.issueId).toBe(standingId);
  });

  // Task-state journal traffic is persisted to inbox/history by the PubSub
  // receiver before this wake runs; the gate keeps it wake-free. The wake
  // function returns normally, so the receiver marks the message
  // non-pending and the inbox/history row stays.
  it.each([
    "fleet.task.created",
    "fleet.task.updated",
    "fleet.task.comment_added",
    "fleet.task.completed",
    "fleet.task.blocked",
    "fleet.task.cancelled",
  ])("does not enqueue a CEO wake for journal topic %s", async (topic) => {
    const { db, heartbeat, seen, message, companyId } = wakeHarness({ adapterType: "claude_local", topic });
    await createPubsubWake(db, heartbeat)(companyId, message);
    expect(seen).toHaveLength(0);
  });

  it("enqueues the CEO wake for a fleet.task.review escalation", async () => {
    const { db, heartbeat, seen, message, companyId } = wakeHarness({ adapterType: "claude_local", topic: "fleet.task.review" });
    await createPubsubWake(db, heartbeat)(companyId, message);
    expect(seen).toHaveLength(1);
    expect(seen[0].agentId).toBe(ceoId);
    const { contextSnapshot } = seen[0].options as { contextSnapshot: Record<string, unknown> };
    expect(contextSnapshot.pubsubMessage).toMatchObject({ id: message.id, topic: "fleet.task.review" });
  });
});

describeEmbeddedPostgres("PubSub wake coordination issue persistence", () => {
  let tempDb: EmbeddedPostgresTestDatabase | null = null;
  let db: Db;
  let companyId: string;
  let ceoId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pubsub-wake-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    ceoId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Wake fixture", issuePrefix: "WK" });
    await db.insert(agents).values({ id: ceoId, companyId, name: "Runner CEO", role: "ceo", status: "active", adapterType: "paperclip_runner" });
  }, 30_000);

  afterEach(async () => {
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("persists the coordination issue and the wake receipt carrying its id", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const heartbeat = {
      wakeup: async (agentId: string, options: Record<string, unknown>) => {
        seen.push(options);
        await db.insert(agentWakeupRequests).values({
          companyId, agentId,
          source: String(options.source), triggerDetail: String(options.triggerDetail), reason: String(options.reason),
          payload: options.payload as Record<string, unknown>, status: "queued",
          requestedByActorType: String(options.requestedByActorType), requestedByActorId: String(options.requestedByActorId),
          idempotencyKey: String(options.idempotencyKey),
        });
      },
    };
    const message = {
      id: randomUUID(), topic: "fleet.chat.workload", payload: deliveredMessage.payload,
      fromInstance: randomUUID(), fromCompany: randomUUID(), fromAgent: null, fromRole: "board",
      envelope: null,
    };
    await createPubsubWake(db, heartbeat)(companyId, message);

    expect(seen).toHaveLength(1);
    const [issue] = await db.select().from(issues).where(eq(issues.id, (seen[0].contextSnapshot as Record<string, unknown>).issueId as string));
    expect(issue.title).toBe("PubSub Coordination");
    expect(issue.companyId).toBe(companyId);
    expect(issue.status).toBe("todo");
    expect(issue.workMode).toBe("standard");

    // A second wake for the same message reuses the standing issue without creating another.
    await createPubsubWake(db, heartbeat)(companyId, message);
    expect(seen).toHaveLength(1);
    const standing = await db.select({ id: issues.id }).from(issues).where(eq(issues.title, "PubSub Coordination"));
    expect(standing).toHaveLength(1);
    expect(standing[0].id).toBe(issue.id);
    const receipts = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId),
      eq(agentWakeupRequests.agentId, ceoId),
    ));
    expect(receipts).toHaveLength(1);
    expect((receipts[0].payload as Record<string, unknown>)?.issueId).toBe(issue.id);
  });

  it("converges concurrent coordination-issue creation on a single standing issue", async () => {
    // Parallel wakes for a fresh company must not fork duplicate standing issues.
    const created = await Promise.all(
      Array.from({ length: 4 }, () => findOrCreatePubsubCoordinationIssue(db, companyId)),
    );
    expect(new Set(created)).toHaveLength(1);
    const standing = await db.select({ id: issues.id }).from(issues).where(eq(issues.title, "PubSub Coordination"));
    expect(standing).toHaveLength(1);
    expect(standing[0].id).toBe(created[0]);
  });
});
