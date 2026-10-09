import { describe, expect, it } from "vitest";

import { LiveConsoleScriptedDriver } from "../mock-core/live-console-scripted-driver";
import {
  parseHarnessRuntimeRequestResolution,
  type HarnessSession,
} from "../contracts/harness-driver";
import type { PrpEvent } from "../protocol/replay-contract";
import {
  applyPrpEvent,
  createSessionSnapshotFromMetadata,
  reduceSessionEvents,
  type SessionSnapshot,
} from "../reducer/session-reducer";
import type { RunnerCapabilities } from "./protocol.js";
import {
  buildTranscript,
  capabilityRows,
  composerState,
  goalAvailability,
  runtimeRequestSubmission,
  transcriptRole,
  type TranscriptEntry,
} from "./transcript-model.js";

const FULL: RunnerCapabilities = {
  resume: true,
  typedEvents: true,
  steering: true,
  interruption: true,
  structuredResult: true,
  runtimeRequestResolution: true,
  goals: true,
  threadLineage: true,
};

function seed(runId: string, sessionId: string): SessionSnapshot {
  return createSessionSnapshotFromMetadata({
    fixtureName: "live-console-demo",
    identity: {
      schema: "paperclip.prp.identity.v1",
      companyId: "package-local-demo",
      issueId: "live-console-demo",
      runId,
      environmentLeaseId: "package-local",
      runnerInstanceId: "live-console-demo-server",
      normalizedSessionId: sessionId,
      driverSessionId: `thread-${sessionId}`,
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
  });
}

async function drive(
  manifestId: string,
  interact?: (session: HarnessSession, turnId: string) => Promise<void>,
): Promise<{ events: PrpEvent[]; snapshot: SessionSnapshot }> {
  const driver = new LiveConsoleScriptedDriver({ manifestId, chunkDelayMs: 0 });
  const session = await driver.openSession({
    runId: `run-${manifestId}`,
    normalizedSessionId: `session-${manifestId}`,
    workingDirectory: "/demo",
  });
  const events: PrpEvent[] = [];
  const pump = (async () => {
    for await (const event of session.events()) events.push(event);
  })();
  const { turnId } = await session.startTurn({ message: { role: "user", text: "Go." } });
  if (interact !== undefined) await interact(session, turnId);
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  await session.close({ reason: "test" });
  await pump;
  return {
    events,
    snapshot: events.reduce(applyPrpEvent, seed(`run-${manifestId}`, `session-${manifestId}`)),
  };
}

function kinds(entries: readonly TranscriptEntry[]): string[] {
  return entries.map((entry) => (entry.kind === "item" ? `item:${entry.role}` : entry.kind));
}

describe("transcriptRole", () => {
  it("maps canonical item kinds onto transcript roles", () => {
    expect(transcriptRole("reasoning")).toBe("reasoning");
    expect(transcriptRole("agentMessage")).toBe("assistant");
    expect(transcriptRole("commandExecution")).toBe("tool");
    expect(transcriptRole("fileChange")).toBe("tool");
    expect(transcriptRole("planUpdate")).toBe("tool");
    expect(transcriptRole("steering_acknowledgement")).toBe("steering");
    expect(transcriptRole("thread_lineage")).toBe("lineage");
    expect(transcriptRole("something_new")).toBe("system");
  });
});

describe("buildTranscript", () => {
  it("orders entries by the reducer timeline and shows the submitted message", async () => {
    const { events, snapshot } = await drive("completion");
    const entries = buildTranscript(snapshot, events);
    expect(kinds(entries)).toEqual([
      "user",
      "item:reasoning",
      "item:tool",
      "item:assistant",
      "turn",
    ]);
    const user = entries[0];
    expect(user.kind === "user" && user.text).toBe("Go.");
    const tool = entries[2];
    expect(tool.kind === "item" && tool.input).toBe("docs/live-console-protocol-server.md");
    expect(tool.kind === "item" && tool.output).toContain("server-sent events");
    expect(tool.kind === "item" && tool.debugEvents?.map((event) => event.eventType)).toEqual([
      "item.started",
      "item.completed",
    ]);
  });

  it("marks an interrupted item and never claims it completed cleanly", async () => {
    const { events, snapshot } = await drive("interrupt-during-tool", async (session, turnId) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      await session.interrupt?.({ turnId });
    });
    const entries = buildTranscript(snapshot, events);
    const tool = entries.find((entry) => entry.kind === "item" && entry.role === "tool");
    expect(tool?.kind === "item" && tool.interrupted).toBe(true);
    expect(tool?.kind === "item" && tool.output).toBeNull();
    const turn = entries.find((entry) => entry.kind === "turn");
    expect(turn?.kind === "turn" && turn.state).toBe("interrupted");
  });

  it("keeps a resolved request in the record with the chosen action", async () => {
    const { events, snapshot } = await drive("approvals", async (session, turnId) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      await session.resolveRuntimeRequest?.({
        requestId: "request-command",
        turnId,
        resolution: { action: "accept_for_session" },
      });
    });
    const request = buildTranscript(snapshot, events).find(
      (entry) => entry.kind === "request" && entry.requestId === "request-command",
    );
    expect(request?.kind === "request" && request.status).toBe("resolved");
    expect(request?.kind === "request" && request.resolvedAction).toBe("accept_for_session");
    expect(request?.kind === "request" && request.actions).toEqual([
      "accept",
      "accept_for_session",
      "decline",
      "cancel",
    ]);
  });

  it("renders a failed item with its exact diagnostic", async () => {
    const { events, snapshot } = await drive("failure");
    const failed = buildTranscript(snapshot, events).find(
      (entry) => entry.kind === "item" && entry.failure !== null,
    );
    expect(failed?.kind === "item" && failed.failure).toContain("cannot find module");
  });

  it("keeps a replayed prefix a real prefix of the finished transcript", async () => {
    // Replay mode reduces events[0..n]. Stepping forward must only ever add
    // entries in the same positions the live session produced.
    const { events, snapshot } = await drive("completion");
    const full = buildTranscript(snapshot, events);

    for (let cut = 1; cut <= events.length; cut += 1) {
      const prefix = events.slice(0, cut);
      const stepped = buildTranscript(
        prefix.reduce(applyPrpEvent, seed("run-completion", "session-completion")),
        prefix,
      );
      expect(stepped.length).toBeLessThanOrEqual(full.length);
      stepped.forEach((entry, index) => {
        expect(entry.key).toBe(full[index]?.key);
        expect(entry.position).toBe(full[index]?.position);
      });
    }
    expect(
      buildTranscript(
        events.reduce(applyPrpEvent, seed("run-completion", "session-completion")),
        events,
      ),
    ).toEqual(full);
  });

  it("keeps deliberate duplicate ids in reducer parity evidence", async () => {
    const { events } = await drive("completion");
    const duplicate = events.find((event) => event.eventType === "item.delta");
    expect(duplicate).toBeDefined();
    const replay = duplicate === undefined ? events : [...events, duplicate];
    const snapshot = reduceSessionEvents(
      seed("run-completion", "session-completion"),
      replay,
    );
    expect(snapshot.duplicateEventIds).toContain(duplicate?.sourceEventId);
    expect(snapshot.integrity).toBe("complete");
  });
});

describe("composerState", () => {
  const base = {
    connection: "connected" as const,
    submitting: false,
    interrupting: false,
    activeTurnId: null,
    sessionState: "running" as const,
  };

  it("shows exactly one state per protocol situation", () => {
    expect(composerState(base)).toBe("idle");
    expect(composerState({ ...base, submitting: true })).toBe("submitting");
    expect(composerState({ ...base, activeTurnId: "turn-1" })).toBe("active-turn");
    expect(composerState({ ...base, interrupting: true, activeTurnId: "turn-1" })).toBe(
      "interrupting",
    );
    expect(composerState({ ...base, connection: "disconnected" })).toBe("disconnected");
    expect(composerState({ ...base, sessionState: "closed" })).toBe("terminal");
  });

  it("puts a terminal session ahead of every other state", () => {
    expect(
      composerState({
        ...base,
        sessionState: "failed",
        activeTurnId: "turn-1",
        connection: "disconnected",
      }),
    ).toBe("terminal");
  });
});

describe("goalAvailability", () => {
  it("disables every verb with the exact diagnostic when goals are unsupported", () => {
    const rows = goalAvailability(
      {
        ...FULL,
        goals: false,
        unsupported: ["Goal operations unsupported: app-server 0.132.0 does not advertise goals"],
      },
      null,
    );
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => !row.enabled)).toBe(true);
    expect(rows[0]?.reason).toContain("does not advertise goals");
  });

  it("disables only the verbs that are invalid for the current goal state", () => {
    const active = goalAvailability(FULL, "active");
    expect(active.find((row) => row.operation === "pause")?.enabled).toBe(true);
    expect(active.find((row) => row.operation === "resume")?.enabled).toBe(false);

    const paused = goalAvailability(FULL, "paused");
    expect(paused.find((row) => row.operation === "resume")?.enabled).toBe(true);
    expect(paused.find((row) => row.operation === "pause")?.enabled).toBe(false);

    const none = goalAvailability(FULL, null);
    expect(none.find((row) => row.operation === "set")?.enabled).toBe(true);
    expect(none.find((row) => row.operation === "clear")?.enabled).toBe(false);
  });
});

describe("runtimeRequestSubmission", () => {
  it("shapes each submit body the way its request kind is validated", async () => {
    expect(runtimeRequestSubmission("user_input", "staging")).toEqual({
      action: "submit",
      answers: { answer: { answers: ["staging"] } },
    });
    expect(runtimeRequestSubmission("elicitation", "stable")).toEqual({
      action: "submit",
      content: { answer: "stable" },
    });

    // The driver is the authority on shape, so both bodies are checked against
    // the real validator rather than against this test's expectations alone.
    for (const [requestKind, answer] of [
      ["user_input", "staging"],
      ["elicitation", "stable"],
    ] as const) {
      expect(() =>
        parseHarnessRuntimeRequestResolution(
          requestKind,
          runtimeRequestSubmission(requestKind, answer),
        )).not.toThrow();
      // ...and the other kind's body is rejected, which is what the browser
      // used to send for elicitation.
      const wrongKind = requestKind === "user_input" ? "elicitation" : "user_input";
      expect(() =>
        parseHarnessRuntimeRequestResolution(
          requestKind,
          runtimeRequestSubmission(wrongKind, answer),
        )).toThrow(/rejected its resolution/);
    }
  });
});

describe("capabilityRows", () => {
  it("gives every unsupported capability a diagnostic string", () => {
    const rows = capabilityRows({ ...FULL, goals: false, usage: false });
    expect(rows.filter((row) => !row.supported).every((row) => row.diagnostic !== null)).toBe(true);
    expect(rows.find((row) => row.name === "steer")?.supported).toBe(true);
  });
});
