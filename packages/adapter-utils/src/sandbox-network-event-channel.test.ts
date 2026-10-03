import { describe, expect, it } from "vitest";
import {
  SANDBOX_NETWORK_EVENT_SCHEMA_VERSION,
  type SandboxNetworkDecision,
  type SandboxNetworkEvent,
} from "./local-process-sandbox.js";
import { createSandboxNetworkEventChannel } from "./sandbox-network-event-channel.js";
import type { AdapterRuntimeEvent } from "./types.js";

const identity = {
  runId: "11111111-1111-4111-8111-111111111111",
  agentId: "22222222-2222-4222-8222-222222222222",
  companyId: "33333333-3333-4333-8333-333333333333",
};

function decision(overrides: Partial<SandboxNetworkDecision> = {}): SandboxNetworkDecision {
  return {
    ts: "2026-09-27T00:00:00.000Z",
    schemaVersion: SANDBOX_NETWORK_EVENT_SCHEMA_VERSION,
    event: "sandbox.network.decision",
    decision: "deny",
    reason: "network_target_denied",
    hostname: "denied.example",
    port: "443",
    method: "CONNECT",
    scheme: null,
    targetSanitized: [],
    methodSanitized: false,
    tunnelId: null,
    ...overrides,
  };
}

/**
 * Both host sinks an adapter holds. `onLog` is the confined child's own output pipe — the child's
 * stdout arrives on it with the same `"stdout"` discriminator and no framing — while `onEvent` is
 * host-authored. The separation is the whole point, so the harness keeps them separately observable.
 */
function harness() {
  const runEvents: AdapterRuntimeEvent[] = [];
  const logs: Array<{ stream: string; chunk: string }> = [];
  return {
    runEvents,
    logs,
    onEvent: async (event: AdapterRuntimeEvent) => {
      runEvents.push(event);
    },
    onLog: async (stream: "stdout" | "stderr", chunk: string) => {
      logs.push({ stream, chunk });
    },
  };
}

/** What a reader of the security event stream sees. Child output cannot produce a row here. */
function securityEvents(runEvents: AdapterRuntimeEvent[]): Array<Record<string, unknown>> {
  return runEvents
    .filter((event) => event.eventType.startsWith("sandbox.network."))
    .map((event) => event.payload ?? {});
}

describe("sandbox network event channel", () => {
  it("carries the event on the host channel and never on the child's log stream", async () => {
    const host = harness();
    const channel = createSandboxNetworkEventChannel({ identity, onEvent: host.onEvent, onLog: host.onLog });

    await channel(decision());

    expect(host.runEvents).toHaveLength(1);
    expect(host.runEvents[0]).toMatchObject({
      eventType: "sandbox.network.decision",
      // Host-authored: the child's two stream names are the ones it cannot be.
      stream: "system",
      level: "info",
    });
    expect(host.runEvents[0].payload).toMatchObject({
      event: "sandbox.network.decision",
      decision: "deny",
      hostname: "denied.example",
      ...identity,
    });
    // Nothing was written to the channel the confined process also writes to.
    expect(host.logs).toEqual([]);
  });

  it("keeps a forged child line out of the security event stream", async () => {
    const host = harness();
    const channel = createSandboxNetworkEventChannel({ identity, onEvent: host.onEvent, onLog: host.onLog });

    await channel(decision());
    // The agent holds the three identity values in its environment and the schema is public, so these
    // two lines are byte-indistinguishable from host-authored ones on the log stream. The second is
    // the more dangerous of the pair: a fabricated liveness signal.
    await host.onLog("stdout", `${JSON.stringify({ ...decision({ decision: "allow", hostname: "evil.example" }), ...identity })}\n`);
    await host.onLog("stdout", `${JSON.stringify({
      event: "sandbox.network.proxy.started",
      ruleCount: 1,
      rulesetDigest: "0000000000000000",
      ...identity,
    })}\n`);

    const stream = securityEvents(host.runEvents);
    expect(stream).toHaveLength(1);
    expect(stream[0]).toMatchObject({ decision: "deny", hostname: "denied.example" });
    // The forged allow and the forged liveness event are absent, not merely outnumbered.
    expect(JSON.stringify(stream)).not.toContain("evil.example");
    expect(stream.some((event) => event.event === "sandbox.network.proxy.started")).toBe(false);
  });

  it("parses a genuine event after the child holds an unterminated chunk open", async () => {
    const host = harness();
    const channel = createSandboxNetworkEventChannel({ identity, onEvent: host.onEvent, onLog: host.onLog });

    // The suppression primitive: no trailing newline, so on a shared line-delimited stream the next
    // record would be prepended to and dropped by a JSON-per-line reader.
    await host.onLog("stdout", "{\"partial\": \"no trailing newline");
    await channel(decision({ decision: "allow", reason: "allowlist_match", hostname: "allowed.example" }));

    // Each event is its own record, so framing is structural rather than a newline convention.
    const stream = securityEvents(host.runEvents);
    expect(stream).toHaveLength(1);
    expect(stream[0]).toMatchObject({ event: "sandbox.network.decision", hostname: "allowed.example" });
  });

  it("writes events in emission order even when an earlier write is slower", async () => {
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const channel = createSandboxNetworkEventChannel({
      identity,
      onEvent: async (event) => {
        if (event.payload?.hostname === "first.example") await firstWrite;
        order.push(String(event.payload?.hostname));
      },
    });

    // The run-event store allocates a sequence number inside the write, so unchained writes could
    // persist in the wrong order and `proxy.stopped` could land before the events it closes.
    const first = channel(decision({ hostname: "first.example" })) as Promise<void>;
    const second = channel(decision({ hostname: "second.example" })) as Promise<void>;
    expect(order).toEqual([]);
    releaseFirst?.();
    await Promise.all([first, second]);

    expect(order).toEqual(["first.example", "second.example"]);
  });

  it("returns the rejection so the sink can count it, and keeps writing afterwards", async () => {
    const written: string[] = [];
    let failNext = true;
    const channel = createSandboxNetworkEventChannel({
      identity,
      onEvent: async (event) => {
        if (failNext) {
          failNext = false;
          throw new Error("run-event sink down");
        }
        written.push(String(event.payload?.hostname));
      },
    });

    // Swallowing this rejection here is what made `sinkErrorCount` structurally zero: the counter
    // lives in the proxy's sink, and it can only count a failure it is handed.
    await expect(channel(decision({ hostname: "first.example" })) as Promise<void>).rejects.toThrow("run-event sink down");
    // One failed write must not poison the ordering chain for everything after it.
    await (channel(decision({ hostname: "second.example" })) as Promise<void>);

    expect(written).toEqual(["second.example"]);
  });

  it("reports a missing run-event channel once and records nothing instead of falling back to the log", async () => {
    const host = harness();
    const channel = createSandboxNetworkEventChannel({ identity, onEvent: undefined, onLog: host.onLog });

    const results = [channel(decision()), channel(decision()), channel(decision())];

    expect(results).toEqual([undefined, undefined, undefined]);
    expect(host.runEvents).toEqual([]);
    // Loud once on stderr, and never the events themselves: a forgeable presence is worse than a
    // visible absence, which the missing `proxy.started` already makes alertable.
    expect(host.logs).toHaveLength(1);
    expect(host.logs[0].stream).toBe("stderr");
    expect(host.logs[0].chunk).toContain("not being recorded");
    expect(host.logs[0].chunk).not.toContain("sandbox.network.decision");
  });

  it("describes every event kind without interpolating an unbounded field", async () => {
    const host = harness();
    const channel = createSandboxNetworkEventChannel({ identity, onEvent: host.onEvent });
    const events: SandboxNetworkEvent[] = [
      {
        ts: "2026-09-27T00:00:00.000Z",
        schemaVersion: SANDBOX_NETWORK_EVENT_SCHEMA_VERSION,
        event: "sandbox.network.proxy.started",
        emitterVersion: "2026.916.1",
        allowlistEntryCount: 1,
        trustedUrlCount: 0,
        ruleCount: 1,
        rulesetDigest: "0123456789abcdef",
      },
      decision(),
      {
        ts: "2026-09-27T00:00:00.000Z",
        schemaVersion: SANDBOX_NETWORK_EVENT_SCHEMA_VERSION,
        event: "sandbox.network.tunnel.closed",
        tunnelId: "44444444-4444-4444-8444-444444444444",
        hostname: "allowed.example",
        port: "443",
        targetSanitized: [],
        bytesOut: 10,
        bytesIn: 20,
        durationMs: 5,
        closedAtTeardown: true,
      },
      {
        ts: "2026-09-27T00:00:00.000Z",
        schemaVersion: SANDBOX_NETWORK_EVENT_SCHEMA_VERSION,
        event: "sandbox.network.proxy.stopped",
        allowCount: 1,
        denyCount: 2,
        sinkErrorCount: 0,
        droppedEventCount: 0,
      },
    ];

    for (const event of events) await channel(event);

    expect(host.runEvents.map((runEvent) => runEvent.eventType)).toEqual(events.map((event) => event.event));
    for (const runEvent of host.runEvents) {
      expect(runEvent.stream).toBe("system");
      // A message is an operator-facing line, not a place for a field of unknown length.
      expect(runEvent.message?.length ?? 0).toBeGreaterThan(0);
      expect(runEvent.message!.length).toBeLessThan(400);
    }
  });
});
