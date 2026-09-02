import { describe, expect, it } from "vitest";

import type { HarnessSession } from "../contracts/harness-driver.js";
import { validatePrpEvent, type PrpEvent } from "../protocol/replay-contract.js";
import {
  applyPrpEvent,
  createSessionSnapshotFromMetadata,
  type SessionSnapshot,
} from "../reducer/session-reducer.js";
import {
  LIVE_CONSOLE_DEMO_MANIFESTS,
  findLiveConsoleDemoManifest,
  liveConsoleDemoManifestCatalogue,
} from "./live-console-demo-manifests.js";
import { LiveConsoleScriptedDriver } from "./live-console-scripted-driver.js";

/** Lets the collector loop drain events the driver already pushed. */
async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function collector(session: HarnessSession): {
  events: PrpEvent[];
  waitFor: (eventType: string, timeoutMs?: number) => Promise<PrpEvent>;
  done: Promise<void>;
} {
  const events: PrpEvent[] = [];
  const waiters: Array<{ eventType: string; resolve: (event: PrpEvent) => void }> = [];
  const done = (async () => {
    for await (const event of session.events()) {
      events.push(event);
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        if (waiters[index]!.eventType === event.eventType) {
          waiters.splice(index, 1)[0]!.resolve(event);
        }
      }
    }
  })();
  return {
    events,
    done,
    waitFor(eventType, timeoutMs = 5_000) {
      const existing = events.find((event) => event.eventType === eventType);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise<PrpEvent>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${eventType}`)),
          timeoutMs,
        );
        waiters.push({
          eventType,
          resolve: (event) => {
            clearTimeout(timer);
            resolve(event);
          },
        });
      });
    },
  };
}

async function openSession(manifestId: string, chunkDelayMs = 0) {
  const driver = new LiveConsoleScriptedDriver({ manifestId, chunkDelayMs });
  const session = await driver.openSession({
    runId: `run-${manifestId}`,
    normalizedSessionId: `session-${manifestId}`,
    workingDirectory: "/demo",
  });
  return { driver, session, stream: collector(session) };
}

function reduce(events: readonly PrpEvent[]): SessionSnapshot {
  return events.reduce(
    applyPrpEvent,
    createSessionSnapshotFromMetadata({
      fixtureName: "live-console-demo",
      identity: {
        schema: "paperclip.prp.identity.v1",
        companyId: "package-local-demo",
        issueId: "live-console-demo",
        runId: events[0]?.runId ?? "run",
        environmentLeaseId: "package-local",
        runnerInstanceId: "live-console-demo-server",
        normalizedSessionId: events[0]?.normalizedSessionId ?? "session",
      },
      capabilities: {
        schema: "paperclip.prp.capabilities.v1",
        sessionReusePolicy: "reuse_per_issue",
        driver: { kind: "live-console-demo", version: "1" },
        steer: true,
        interrupt: true,
        resume: true,
        runtimeRequests: true,
        structuredResult: true,
        typedEvents: true,
      },
    }),
  );
}

describe("Live console demo manifests", () => {
  it("gives every manifest a unique id and at least one expected observation", () => {
    const ids = LIVE_CONSOLE_DEMO_MANIFESTS.map((manifest) => manifest.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const manifest of LIVE_CONSOLE_DEMO_MANIFESTS) {
      expect(manifest.expectedObservations.length).toBeGreaterThan(0);
      expect(manifest.prompt.length).toBeGreaterThan(0);
    }
  });

  it("publishes a catalogue that carries no beat scripts to the browser", () => {
    const catalogue = liveConsoleDemoManifestCatalogue();
    expect(catalogue).toHaveLength(LIVE_CONSOLE_DEMO_MANIFESTS.length);
    expect(JSON.stringify(catalogue)).not.toContain("beats");
  });

  it("rejects an unknown manifest id", () => {
    expect(() => findLiveConsoleDemoManifest("nope")).toThrow(/unknown Live console demo manifest/);
  });
});

describe("Live console scripted driver", () => {
  it("emits schema-valid canonical events for a completed turn", async () => {
    const { session, stream } = await openSession("completion");
    await session.startTurn({ message: { role: "user", text: "Summarize." } });
    await stream.waitFor("turn.completed");

    for (const event of stream.events) {
      expect(validatePrpEvent(event).ok).toBe(true);
    }
    const snapshot = reduce(stream.events);
    expect(snapshot.integrity).toBe("complete");
    expect(snapshot.turnState).toBe("completed");
    expect(snapshot.proposedResult?.reportedWorkDisposition).toBe("done");
    expect(snapshot.items.map((item) => item.kind)).toEqual([
      "reasoning",
      "commandExecution",
      "agentMessage",
    ]);
    const submitted = stream.events.find((event) => event.eventType === "turn.submitted");
    expect((submitted?.payload as { text?: string }).text).toBe("Summarize.");
    await session.close({ reason: "test" });
  });

  it("acknowledges same-turn steering and rejects a stale turn", async () => {
    const { session, stream } = await openSession("steering", 20);
    const { turnId } = await session.startTurn({ message: { role: "user", text: "Go." } });
    await stream.waitFor("turn.started");
    await session.steer?.({ turnId, message: { role: "user", text: "Be brief." } });

    await tick();
    const ack = stream.events.find(
      (event) => (event.payload as { kind?: string }).kind === "steering_acknowledgement",
    );
    expect((ack?.payload as { text?: string }).text).toBe("Be brief.");

    await expect(
      session.steer?.({ turnId: "turn-999", message: { role: "user", text: "Stale." } }),
    ).rejects.toMatchObject({ code: "stale_turn" });
    expect(
      stream.events.some(
        (event) => (event.payload as { code?: string }).code === "stale_turn_rejected",
      ),
    ).toBe(true);

    await stream.waitFor("turn.completed");
    await expect(
      session.steer?.({ turnId, message: { role: "user", text: "Too late." } }),
    ).rejects.toMatchObject({ code: "already_terminal" });
    await session.close({ reason: "test" });
  });

  it("cancels a turn interrupted before the provider accepts it", async () => {
    const { session, stream } = await openSession("interrupt-before-start");
    const { turnId } = await session.startTurn({ message: { role: "user", text: "Slow." } });
    await session.interrupt?.({ turnId, reason: "browser_operator" });
    await stream.waitFor("turn.cancelled");

    expect(stream.events.some((event) => event.eventType === "turn.started")).toBe(false);
    expect(reduce(stream.events).turnState).toBe("cancelled");
    await session.close({ reason: "test" });
  });

  it("keeps partial text when a streaming item is interrupted", async () => {
    const { session, stream } = await openSession("interrupt-during-generation", 40);
    const { turnId } = await session.startTurn({ message: { role: "user", text: "Long." } });
    await stream.waitFor("item.delta");
    await session.interrupt?.({ turnId });
    await stream.waitFor("turn.interrupted");

    const snapshot = reduce(stream.events);
    expect(snapshot.turnState).toBe("interrupted");
    const item = snapshot.items.find((candidate) => candidate.itemId === "assistant-1");
    expect(item?.text.length).toBeGreaterThan(0);
    expect(item?.text).not.toContain("And this final one.");
    await session.close({ reason: "test" });
  });

  it("keeps an interrupted tool item without fabricating a result", async () => {
    const { session, stream } = await openSession("interrupt-during-tool", 5);
    const { turnId } = await session.startTurn({ message: { role: "user", text: "Tool." } });
    await stream.waitFor("item.started");
    await session.interrupt?.({ turnId });
    const interrupted = await stream.waitFor("turn.interrupted");
    expect(interrupted.eventType).toBe("turn.interrupted");

    const completion = stream.events.find(
      (event) => event.eventType === "item.completed" && event.itemId === "tool-1",
    );
    expect((completion?.payload as { status?: string }).status).toBe("interrupted");
    expect(completion?.payload).not.toHaveProperty("output");
    await session.close({ reason: "test" });
  });

  it("resolves each runtime request exactly once", async () => {
    const { session, stream } = await openSession("approvals");
    const { turnId } = await session.startTurn({ message: { role: "user", text: "Approve." } });
    const created = await stream.waitFor("runtime_request.created");
    const request = (created.payload as { request: { requestId: string; actions: string[] } }).request;
    expect(request.actions).toContain("accept_for_session");

    await session.resolveRuntimeRequest?.({
      requestId: request.requestId,
      turnId,
      resolution: { action: "accept" },
    });
    await expect(
      session.resolveRuntimeRequest?.({
        requestId: request.requestId,
        turnId,
        resolution: { action: "decline" },
      }),
    ).rejects.toMatchObject({ code: "already_terminal" });

    await tick();
    const resolved = stream.events.find(
      (event) => event.eventType === "runtime_request.resolved",
    );
    expect((resolved?.payload as { action?: string }).action).toBe("accept");
    await session.close({ reason: "test" });
  });

  it("never puts a submitted answer into the resolution acknowledgement", async () => {
    const { session, stream } = await openSession("user-input");
    const { turnId } = await session.startTurn({ message: { role: "user", text: "Ask." } });
    const created = await stream.waitFor("runtime_request.created");
    const request = (created.payload as { request: { requestId: string } }).request;
    await session.resolveRuntimeRequest?.({
      requestId: request.requestId,
      turnId,
      resolution: { action: "submit", answers: { environment: { answers: ["staging"] } } },
    });
    await tick();
    const resolved = stream.events.find((event) => event.eventType === "runtime_request.resolved");
    expect(JSON.stringify(resolved?.payload)).not.toContain("staging");
    await session.close({ reason: "test" });
  });

  it("fails an elicitation submit closed unless it carries content", async () => {
    const { session, stream } = await openSession("user-input");
    const { turnId } = await session.startTurn({ message: { role: "user", text: "Ask." } });
    const first = await stream.waitFor("runtime_request.created");
    await session.resolveRuntimeRequest?.({
      requestId: (first.payload as { request: { requestId: string } }).request.requestId,
      turnId,
      resolution: { action: "submit", answers: { environment: { answers: ["staging"] } } },
    });

    // `waitFor` replays the first match, so the elicitation beat is polled for
    // by kind rather than by event type.
    type CreatedRequest = { requestId: string; requestKind: string; itemId: string };
    let request: CreatedRequest | undefined;
    for (let attempt = 0; attempt < 50 && request === undefined; attempt += 1) {
      await tick();
      request = stream.events
        .filter((event) => event.eventType === "runtime_request.created")
        .map((event) => (event.payload as { request: CreatedRequest }).request)
        .find((candidate) => candidate.requestKind === "elicitation");
    }
    if (request === undefined) throw new Error("the elicitation request never opened");
    for (const resolution of [
      { action: "submit" },
      { action: "submit", content: {} },
      { action: "submit", answers: { channel: { answers: ["stable"] } } },
    ]) {
      await expect(session.resolveRuntimeRequest?.({
        requestId: request.requestId,
        turnId,
        resolution: resolution as never,
      })).rejects.toThrow(/elicitation rejected its resolution/);
    }
    // Every rejection left the request answerable rather than settling it.
    expect(session.pendingRuntimeRequests?.().map(({ requestId }) => requestId))
      .toContain(request.requestId);

    await session.resolveRuntimeRequest?.({
      requestId: request.requestId,
      turnId,
      resolution: { action: "submit", content: { channel: "stable" } },
    });
    await tick();
    const resolved = stream.events.filter((event) =>
      event.eventType === "runtime_request.resolved");
    expect(resolved.at(-1)?.payload).toEqual({
      requestId: request.requestId,
      requestKind: "elicitation",
      turnId,
      itemId: "input-2",
      action: "submit",
    });
    expect(JSON.stringify(resolved.at(-1)?.payload)).not.toContain("stable");
    await session.close({ reason: "test" });
  });

  it("reports the exact diagnostic when goals are unsupported", async () => {
    const { session } = await openSession("goals-unsupported");
    await expect(session.goal?.({ action: "get" })).rejects.toThrow(
      /does not advertise the goals capability/,
    );
    await session.close({ reason: "test" });
  });

  it("moves a goal through set, pause, resume, and clear", async () => {
    const { session, stream } = await openSession("goals");
    expect(await session.goal?.({ action: "get" })).toBeNull();
    expect((await session.goal?.({ action: "set", objective: "Ship it" }))?.status).toBe("active");
    expect((await session.goal?.({ action: "pause" }))?.status).toBe("paused");
    expect((await session.goal?.({ action: "resume" }))?.status).toBe("active");
    expect(await session.goal?.({ action: "clear" })).toBeNull();

    await tick();
    const goalEvents = stream.events.filter((event) =>
      ["goal", "goal_cleared"].includes((event.payload as { kind?: string }).kind ?? ""),
    );
    expect(goalEvents).toHaveLength(4);
    await session.close({ reason: "test" });
  });

  it("tracks child threads and keeps their terminal states", async () => {
    const { session, stream } = await openSession("subagents");
    await session.startTurn({ message: { role: "user", text: "Delegate." } });
    await stream.waitFor("turn.completed");

    const lineage = session.lineage?.() ?? [];
    expect(lineage.map((entry) => entry.threadId)).toEqual([
      "thread-session-subagents",
      "thread-child-a",
      "thread-child-b",
    ]);
    expect(lineage[1]?.status).toBe("completed");
    expect(lineage[2]?.status).toBe("failed");
    await session.close({ reason: "test" });
  });

  it("reports a failed turn and a blocked disposition", async () => {
    const { session, stream } = await openSession("failure");
    await session.startTurn({ message: { role: "user", text: "Fail." } });
    await stream.waitFor("turn.failed");

    const snapshot = reduce(stream.events);
    expect(snapshot.turnState).toBe("failed");
    expect(snapshot.items[0]?.status).toBe("failed");
    expect(snapshot.proposedResult?.reportedWorkDisposition).toBe("blocked");
    await session.close({ reason: "test" });
  });

  it("resumes the same session identity and continues the source sequence", async () => {
    const { driver, session, stream } = await openSession("completion");
    await session.startTurn({ message: { role: "user", text: "First." } });
    await stream.waitFor("turn.completed");
    const persisted = await session.snapshot();
    await session.close({ reason: "browser_reconnect" });

    const recovery = await driver.recoverSession(persisted);
    expect(recovery.recovered).toBe(true);
    const resumed = recovery.session!;
    const resumedStream = collector(resumed);
    await resumedStream.waitFor("session.resumed");

    const combined = [...stream.events, ...resumedStream.events];
    const snapshot = reduce(combined);
    expect(snapshot.integrity).toBe("complete");
    expect(snapshot.identity.normalizedSessionId).toBe("session-completion");
    expect(resumed.ids().driverSessionId).toBe(session.ids().driverSessionId);
    await resumed.close({ reason: "test" });
  });
});
