import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { WebSocket } from "ws";
import {
  agents, authUsers, companies, companyMemberships, completionContracts,
  createDb, heartbeatRunEvents, heartbeatRuns, issues, type Db,
} from "@paperclipai/db";
import * as schema from "@paperclipai/db/schema/index";
import type { LiveEvent } from "@paperclipai/shared";
import type { PrpEvent } from "../vendor/paperclip-runner/index.js";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import { PaperclipControlPlanePort } from "../services/native-runtime/paperclip-control-plane-port.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { compareObserverReplays, type ObserverReplayMeasurement } from "./helpers/observer-replay-report.js";

const output = "Synthetic replay output.\n";
const fixturePayloads = [
  ...Array.from({ length: 6 }, (_, index) => ({
    eventType: "tool.execution.started",
    payload: {
      schema: "paperclip.tool.execution.v1", executionId: `fixture-tool-${index + 1}`,
      transport: "builtin", operation: "execute", name: "synthetic-tool", target: null,
      namespace: null, readOnly: true, status: "running", durationMs: null, exitCode: null,
      progress: null, output: null, outputBytes: 0, outputTruncated: false, outputDigest: null,
    },
  })),
  { eventType: "item.delta", payload: { kind: "agentMessage", text: output } },
  { eventType: "item.completed", payload: { kind: "agentMessage", item: { id: "answer", text: output } } },
];
const fixture = createHash("sha256").update(JSON.stringify(fixturePayloads)).digest("hex");
const expectedDeliveries = 7; // item.delta is durable but does not emit a live signal.

describe("native event replay observation evidence", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  const companyId = randomUUID();
  const agentId = randomUUID();
  const userId = `observer-${randomUUID()}`;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("observer-replay-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Synthetic replay", issuePrefix: "REPLAY" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", adapterType: "codex_local" });
    await db.insert(authUsers).values({ id: userId, name: "Fixture viewer", email: `${userId}@example.test`,
      createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId,
      membershipRole: "owner", status: "active" });
  });

  afterAll(async () => { await temporary?.cleanup(); });

  async function replay(id: string, viewerCount: number, cadenceMs: number | null,
    firstBatchDelayAfterWorkMs = 0): Promise<ObserverReplayMeasurement> {
    const runId = randomUUID(), issueId = randomUUID(), sessionId = randomUUID();
    const sourceInstanceId = randomUUID(), completionContractId = randomUUID();
    const identity = { companyId, agentId, issueId, runId, sessionId };
    const binding = { ...identity, sourceInstanceId, controlPlaneSourceInstanceId: `control-${runId}`,
      completionContractId, completionContractSha256: "observer-replay-contract" };
    await db.insert(issues).values({ id: issueId, companyId, title: "Synthetic replay", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(completionContracts).values({ id: completionContractId, companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "fixture-v1", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "fixture-v1", objective: "Synthetic replay", criteria: [{ id: "objective", requirement: "Replay" }] },
      canonicalSha256: binding.completionContractSha256, createdByActorType: "system", createdByActorId: "test" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, scopeKind: "issue", issueId,
      status: "running", runtimeMode: "native", nativeIssueId: issueId, nativeSessionId: sessionId,
      runnerInstanceId: sourceInstanceId, completionContractId, completionContractSha256: binding.completionContractSha256 });

    const queries = { persistence: 0, viewerDelivery: 0, polling: 0, visibilityProof: 0, total: 0 };
    let measuring = false;
    const counted = (category: "persistence" | "viewerDelivery" | "polling") => drizzle(db.$client, {
      schema, logger: { logQuery() { if (measuring) queries[category] += 1; } },
    }) as Db;
    const port = new PaperclipControlPlanePort(counted("persistence"), binding);
    const pollPort = new PaperclipControlPlanePort(counted("polling"), binding);
    await port.openRun({ identity, backendKind: "mock", sourceInstanceId });
    const server = createServer();
    const wss = setupLiveEventsWebSocketServer(server, counted("viewerDelivery"), {
      deploymentMode: "authenticated",
      resolveCloudActor: async () => ({ userId, companyIds: [companyId] }),
    });
    const sockets: WebSocket[] = [];
    const received: LiveEvent[][] = [];
    const completedDeliveries: Promise<void>[] = [];
    const deliveryReads: Promise<void>[] = [];
    const visibilityDb = createDb(temporary.connectionString);
    const proofDb = drizzle(visibilityDb.$client, { schema, logger: {
      logQuery() { if (measuring) queries.visibilityProof += 1; },
    } });
    const pollOffsets: number[][] = Array.from({ length: viewerCount }, () => []);
    const signals: LiveEvent[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(companyId, event => {
      if (event.type === "heartbeat.run.event" && event.payload.runId === runId) signals.push(event);
    });
    let polling = false;
    let pollWork = Promise.resolve();
    let completedPollBatches = 0;
    let pollingFailure: unknown;
    const workFinished = Promise.withResolvers<void>();
    let activeViewers = 0;
    let minViewers = viewerCount;
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/companies/${companyId}/events/ws`;
      // The production upgrade path must reject a company outside the actor's scope.
      const denied = new WebSocket(url.replace(companyId, randomUUID()));
      const rejection = await new Promise<number>((resolve, reject) => {
        denied.once("unexpected-response", (_request, response) => { response.resume(); denied.terminate(); resolve(response.statusCode!); });
        denied.once("error", () => {});
        denied.once("open", () => { denied.terminate(); reject(new Error("foreign-company viewer admitted")); });
      });
      expect(rejection).toBe(403);
      for (let index = 0; index < viewerCount; index += 1) {
        const socket = new WebSocket(url);
        sockets.push(socket);
        const messages: LiveEvent[] = [];
        const delivered = Promise.withResolvers<void>();
        completedDeliveries.push(delivered.promise);
        received.push(messages);
        socket.on("message", bytes => {
          const event = JSON.parse(bytes.toString()) as LiveEvent;
          messages.push(event);
          // A separate connection must see the committed row at delivery time.
          deliveryReads.push((async () => {
            const rows = await proofDb.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
            expect(rows.some(row => row.seq === event.payload.seq)).toBe(true);
          })());
          if (messages.length === expectedDeliveries) delivered.resolve();
        });
        await once(socket, "open");
        activeViewers += 1;
        socket.once("close", () => {
          activeViewers -= 1;
          if (measuring) minViewers = Math.min(minViewers, activeViewers);
        });
      }
      const events: PrpEvent[] = fixturePayloads.map((entry, index) => ({
        schema: "paperclip.prp.event.v1", sourceEventId: `fixture:${index + 1}`, sourceSeq: index + 1,
        sourceInstanceId, sourceKind: "runner", runId, normalizedSessionId: sessionId,
        turnId: "fixture-turn", itemId: "answer", eventType: entry.eventType, payload: entry.payload,
        schemaVersion: 1, priority: 0, emittedAt: "2026-10-01T00:00:00.000Z",
      }));
      const startedAt = new Date().toISOString();
      const started = performance.now();
      measuring = true;
      polling = cadenceMs !== null;
      pollWork = (async () => {
        while (polling) {
          // Controlled slow-read regression: keep the first batch pending past
          // work completion and the minimum window, while retaining real reads.
          if (completedPollBatches === 0 && firstBatchDelayAfterWorkMs > 0) {
            await workFinished.promise;
            await delay(firstBatchDelayAfterWorkMs);
          }
          await Promise.all(pollOffsets.map(async offsets => {
            offsets.push(performance.now() - started);
            await pollPort.replayEvents({ runId, sourceInstanceId, afterSourceSeq: 0, limit: 100 });
          }));
          completedPollBatches += 1;
          if (polling) await delay(cadenceMs!);
        }
      })().catch(error => { pollingFailure = error; polling = false; });
      for (const event of events) expect((await port.appendEvent(event)).disposition).toBe("committed");
      // Observe delivery directly so a polling assertion's retry interval does
      // not quantize work timing. Keep a bounded failure path for lost frames.
      const deliveryDeadline = new AbortController();
      try {
        await Promise.race([
          Promise.all(completedDeliveries),
          delay(5_000, undefined, { signal: deliveryDeadline.signal }).then(() => {
            throw new Error("replay viewer delivery deadline exceeded");
          }),
        ]);
      } finally { deliveryDeadline.abort(); }
      for (const event of events) expect((await port.appendEvent(event)).disposition).toBe("duplicate");
      // This synchronous guard catches duplicate publication even if an async
      // authorization queue has not reached the client by the final pong.
      expect(signals).toHaveLength(expectedDeliveries);
      // A pong follows earlier server frames; duplicate replay must add none.
      await Promise.all(sockets.map(async socket => {
        const pong = once(socket, "pong"); socket.ping(); await pong;
      }));
      await Promise.all(deliveryReads);
      // Work timing stops before the deliberate observation extension. This
      // preserves timing differences even when both runs finish within 60 ms.
      const workMs = performance.now() - started;
      workFinished.resolve();
      // Give every case the same minimum observation window, including the control.
      await delay(Math.max(0, 60 - (performance.now() - started)));
      if (cadenceMs !== null) {
        // Read offsets count starts, not completions. Slow database reads must
        // finish two batches before the observation window can close.
        await expect.poll(() => {
          if (pollingFailure) throw pollingFailure;
          return completedPollBatches;
        }, { timeout: 5_000 }).toBeGreaterThanOrEqual(2);
      }
      polling = false;
      await pollWork;
      if (pollingFailure) throw pollingFailure;
      const interval = { startedAt, finishedAt: new Date().toISOString(), wallMs: performance.now() - started, workMs };
      measuring = false;
      queries.total = queries.persistence + queries.viewerDelivery + queries.polling + queries.visibilityProof;

      // Read through a fresh production port after ingestion, not a writer cache.
      const reopened = new PaperclipControlPlanePort(visibilityDb, binding);
      const durable = await reopened.replayEvents({ runId, sourceInstanceId, afterSourceSeq: 0, limit: 100 });
      expect(durable.events).toEqual(events);
      expect(durable.highestContiguousSourceSeq).toBe(events.length);
      const rows = await visibilityDb.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId)).orderBy(asc(heartbeatRunEvents.seq));
      expect(rows.map(row => row.seq)).toEqual(events.map(event => event.sourceSeq));
      expect(durable.events.at(-1)?.payload).toEqual({ kind: "agentMessage", item: { id: "answer", text: output } });
      for (const messages of received) {
        expect(messages.map(event => event.payload)).toEqual(events.filter(event => event.eventType !== "item.delta").map(event => ({
          runId, agentId, issueId, seq: event.sourceSeq, eventType: event.eventType,
        })));
        expect(messages.every(event => event.companyId === companyId)).toBe(true);
        expect(JSON.stringify(messages)).not.toContain(output.trim());
      }
      expect(activeViewers).toBe(viewerCount);
      if (cadenceMs !== null) expect(pollOffsets.every(offsets => offsets.length >= 2)).toBe(true);
      return {
        id, fixture, zeroViewerControlId: "zero-viewers",
        interval, queries,
        observers: {
          activeViewers: { start: viewerCount, end: activeViewers, min: minViewers, max: viewerCount },
          activeSubscribers: { start: viewerCount + 1, end: wss.clients.size + 1, min: minViewers + 1, max: viewerCount + 1 },
          diagnosticSubscribers: 1,
          transport: "authenticated_websocket",
          polling: { applicability: cadenceMs === null ? "not_applicable" : "applicable",
            reason: cadenceMs !== null ? "scheduled_log_reads" : viewerCount === 0 ? "no_viewers" : "push_only",
            cadenceMs, firstBatchDelayAfterWorkMs, completedBatches: completedPollBatches, offsetsMs: pollOffsets },
        },
        correctness: { committedEvents: events.length, durableEvents: rows.length, duplicateReceipts: events.length,
          deliveriesPerViewer: received.map(messages => messages.length), durableOutput: true,
          orderedEvents: true, duplicateReplay: true, safeViewerPayloads: true },
      };
    } finally {
      measuring = false;
      polling = false;
      workFinished.resolve();
      unsubscribe();
      await pollWork;
      for (const socket of sockets) socket.terminate();
      // Wait for server-side close handlers to remove the subscriptions.
      await Promise.all([...wss.clients].map(socket => {
        const closed = new Promise<void>(resolve => socket.on("close", resolve)); socket.terminate(); return closed;
      }));
      // Closing the real WebSocket server emits its close event and clears the
      // production heartbeat timer. Closing only HTTP would leave it running.
      await new Promise<void>((resolve, reject) => {
        (wss as typeof wss & { close(callback: (error?: Error) => void): void })
          .close(error => error ? reject(error) : resolve());
      });
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await visibilityDb.$client.end();
    }
  }

  it("reports matched, confounded, and intentional observer-load comparisons with a zero-viewer control", async () => {
    const zero = await replay("zero-viewers", 0, null);
    const first = await replay("push-a", 2, null);
    const second = await replay("push-b", 2, null);
    const polled = await replay("polled", 2, 20);
    const slowPolled = await replay("slow-first-poll", 2, 20, 100);
    const comparisons = [
      compareObserverReplays(first, second),
      compareObserverReplays(zero, first),
      compareObserverReplays(first, polled),
      compareObserverReplays(zero, first, "observation_load"),
      compareObserverReplays(zero, polled, "observation_load"),
      compareObserverReplays(polled, slowPolled),
    ];
    expect(comparisons.map(pair => pair.status)).toEqual(["matched", "unmatched", "unmatched", "observation_experiment", "observation_experiment", "unmatched"]);
    expect(comparisons[5].differences).toEqual(["polling"]);
    expect(comparisons[1].wallTimeRatio).toBeNull();
    expect(comparisons[2].differences).toEqual(["polling"]);
    // Equal observation windows must not hide different work-completion times.
    expect(compareObserverReplays(
      { ...first, interval: { ...first.interval, wallMs: 60, workMs: 15 } },
      { ...second, interval: { ...second.interval, wallMs: 60, workMs: 45 } },
    )).toMatchObject({ timingBasis: "interval.workMs", wallTimeRatio: 3 });
    expect(first.queries.viewerDelivery).toBeGreaterThan(zero.queries.viewerDelivery);
    expect(zero.queries.polling).toBe(0);
    expect(polled.queries.polling).toBeGreaterThan(0);
    // A declared experiment cannot excuse a different fixture or observer churn.
    expect(compareObserverReplays(first, { ...second, fixture: "different" }, "observation_load").status).toBe("unmatched");
    const churn = structuredClone(second);
    churn.observers.activeSubscribers.min = 0;
    expect(compareObserverReplays(first, churn, "observation_load").status).toBe("unmatched");
    process.stdout.write(`OBSERVER_REPLAY ${JSON.stringify({
      schema: "paperclip.observer_replay.v1",
      sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      node: process.version, platform: process.platform,
      queryScope: "Drizzle statement attempts during ingestion, duplicate replay, and viewer/poll drain, including separately counted delivery-time visibility proofs; excludes seed, handshake, post-interval proof reads, and driver-internal SQL",
      scope: "Synthetic local production persistence and authorized WebSocket delivery; no browser, provider, hosted latency, or exact historical query-count claim",
      cases: [zero, first, second, polled, slowPolled], comparisons,
    })}\n`);
  }, 30_000);
});
