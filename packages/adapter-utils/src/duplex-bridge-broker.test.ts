import { afterEach, describe, expect, it } from "vitest";

import {
  assertDuplexBrokerLimits,
  createDuplexBridgeBroker,
  type DuplexBridgeBroker,
  type DuplexBrokerForwardResult,
} from "./duplex-bridge-broker.js";
import {
  DEFAULT_MAX_DUPLEX_REQUEST_ID_BYTES,
  DUPLEX_FRAME_VERSION,
  DuplexFrameDecoder,
  encodeDuplexFrame,
  type DuplexRequestFrame,
  type DuplexResponseFrame,
} from "./duplex-frame-codec.js";
import {
  createDuplexTelemetry,
  DUPLEX_SPAN_REQUEST,
  type DuplexTelemetryCounterRecord,
  type DuplexTelemetryEventRecord,
  type DuplexTelemetrySpanRecord,
} from "./duplex-telemetry.js";
import type { CommandManagedDuplexChannel } from "./command-managed-runtime.js";

/**
 * Unit harness for the host broker limit gate.
 *
 * The harness drives frames straight into the broker through an in-memory
 * channel. It does not spawn the gateway, so a test injects untrusted request
 * frames directly, the same as a malicious provider that controls the transport.
 * The channel records each frame the broker writes back, so a test asserts the
 * exact response the broker returns for a refused request.
 */

/** One pending forward the test controls. */
interface PendingForward {
  id: string;
  resolve: (result: DuplexBrokerForwardResult) => void;
  reject: (error: Error) => void;
  settled: boolean;
}

/** The in-memory channel plus the levers a test uses to drive the broker. */
interface FakeChannelHarness {
  channel: CommandManagedDuplexChannel;
  /** Push one request frame into the broker read path. */
  feed: (frame: DuplexRequestFrame) => void;
  /** The response frames the broker wrote back, in order. */
  responses: DuplexResponseFrame[];
  /** Every forward call the broker made, in order. */
  forwards: PendingForward[];
  /** Resolve the newest unsettled forward for one id with a 200 result. */
  resolveForward: (id: string, body?: string) => void;
  /** Resolve every unsettled forward with a 200 result. */
  resolveAll: () => void;
}

/** Build one valid request frame with distinctive, secret-looking fields. */
function requestFrame(id: string, method = "POST"): DuplexRequestFrame {
  return {
    version: DUPLEX_FRAME_VERSION,
    type: "request",
    id,
    method,
    path: `/api/issues/${id}`,
    query: "?secret-query=leak",
    headers: { authorization: "Bearer super-secret-provider-token" },
    body: JSON.stringify({ secret: "secret-request-body" }),
  };
}

/**
 * Build the in-memory channel harness. The channel keeps the broker read
 * listener, so `feed` pushes an encoded frame into the broker. The channel
 * decodes each written frame, so `responses` holds the response frames only.
 */
function createFakeChannelHarness(): FakeChannelHarness {
  const responses: DuplexResponseFrame[] = [];
  const forwards: PendingForward[] = [];
  const writtenDecoder = new DuplexFrameDecoder();
  let dataListener: ((chunk: string) => void) | null = null;

  const channel: CommandManagedDuplexChannel = {
    write: (data) => {
      for (const result of writtenDecoder.push(data)) {
        if (result.ok && result.frame.type === "response") {
          responses.push(result.frame);
        }
      }
    },
    onData: (listener) => {
      dataListener = listener;
    },
    onExit: () => undefined,
    stop: () => undefined,
    close: () => Promise.resolve(),
  };

  return {
    channel,
    feed: (frame) => {
      if (!dataListener) throw new Error("The broker did not bind the data listener.");
      dataListener(encodeDuplexFrame(frame));
    },
    responses,
    forwards,
    resolveForward: (id, body = JSON.stringify({ ok: true })) => {
      const forward = [...forwards].reverse().find((entry) => entry.id === id && !entry.settled);
      if (!forward) throw new Error(`No unsettled forward for id ${id}.`);
      forward.settled = true;
      forward.resolve({ status: 200, headers: { "content-type": "application/json" }, body });
    },
    resolveAll: () => {
      for (const forward of forwards) {
        if (forward.settled) continue;
        forward.settled = true;
        forward.resolve({
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ok: true }),
        });
      }
    },
  };
}

/** A forward handler that hands each call to the harness and never auto-resolves. */
function controllableForward(harness: FakeChannelHarness) {
  return (request: DuplexRequestFrame): Promise<DuplexBrokerForwardResult> =>
    new Promise<DuplexBrokerForwardResult>((resolve, reject) => {
      harness.forwards.push({ id: request.id, resolve, reject, settled: false });
    });
}

/** The telemetry sink capture. It proves the broker records nothing for a refusal. */
interface TelemetryCapture {
  spans: DuplexTelemetrySpanRecord[];
  counters: DuplexTelemetryCounterRecord[];
  events: DuplexTelemetryEventRecord[];
}

/** Build the real telemetry facade over a capturing recorder. */
function createTelemetryCapture(): { telemetry: ReturnType<typeof createDuplexTelemetry>; capture: TelemetryCapture } {
  const capture: TelemetryCapture = { spans: [], counters: [], events: [] };
  const telemetry = createDuplexTelemetry({
    providerKey: "daytona",
    recorder: {
      recordSpan: (record) => capture.spans.push(record),
      incrementCounter: (record) => capture.counters.push(record),
      emitEvent: (record) => capture.events.push(record),
    },
  });
  return { telemetry, capture };
}

describe("duplex bridge broker request limits", () => {
  const brokers: DuplexBridgeBroker[] = [];

  afterEach(async () => {
    while (brokers.length > 0) {
      const broker = brokers.pop();
      if (broker) await broker.close();
    }
  });

  it("rejects a non-positive or non-integer limit at construction", () => {
    expect(() => assertDuplexBrokerLimits({ maxInFlightRequests: 0, maxLifetimeRequests: 10 })).toThrow();
    expect(() => assertDuplexBrokerLimits({ maxInFlightRequests: 5, maxLifetimeRequests: 0 })).toThrow();
    expect(() => assertDuplexBrokerLimits({ maxInFlightRequests: 1.5, maxLifetimeRequests: 10 })).toThrow();
    expect(() =>
      assertDuplexBrokerLimits({ maxInFlightRequests: Number.POSITIVE_INFINITY, maxLifetimeRequests: 10 }),
    ).toThrow();
    expect(() => assertDuplexBrokerLimits({ maxInFlightRequests: 8, maxLifetimeRequests: 16 })).not.toThrow();
  });

  it("bounds the in-flight forwards and refuses the excess with a retryable terminal response", () => {
    const harness = createFakeChannelHarness();
    const { telemetry, capture } = createTelemetryCapture();
    const maxInFlightRequests = 4;
    const broker = createDuplexBridgeBroker({
      channel: harness.channel,
      forwardRequest: controllableForward(harness),
      telemetry,
      maxInFlightRequests,
    });
    brokers.push(broker);
    broker.start();

    // Inject more than the limit of unique valid frames. Every forward hangs, so
    // the broker holds the maximum number of in-flight forwards.
    const total = 10;
    const ids = Array.from({ length: total }, (_unused, index) => `flight-${index}`);
    for (const id of ids) harness.feed(requestFrame(id));

    // The broker forwarded only up to the limit. It refused the rest.
    expect(harness.forwards).toHaveLength(maxInFlightRequests);
    expect(harness.responses).toHaveLength(total - maxInFlightRequests);
    for (const response of harness.responses) {
      expect(response.status).toBe(503);
      expect(response.outcome).toBe("unavailable");
      expect(response.headers["x-paperclip-bridge-outcome"]).toBe("unavailable");
      expect(JSON.parse(response.body)).toEqual({
        error: "Duplex broker capacity limit reached.",
        outcome: "unavailable",
        retryable: true,
      });
    }
    // The refusal leaks no route, query, body, or token.
    const refusalText = harness.responses.map((response) => encodeDuplexFrame(response)).join("");
    expect(refusalText).not.toContain("secret");
    expect(refusalText).not.toContain("super-secret-provider-token");
    expect(refusalText).not.toContain("/api/issues/");

    // The broker recorded no request span and no counter for a refusal. Only the
    // delivered requests below produce a span.
    expect(capture.spans).toHaveLength(0);
    expect(capture.counters).toHaveLength(0);

    // Resolve the in-flight forwards. The broker delivers one response for each
    // and drains the pending bookkeeping.
    harness.resolveAll();
  });

  it("frees capacity after a delivered request and forwards a resent refused id (no-replay preserved)", async () => {
    const harness = createFakeChannelHarness();
    const maxInFlightRequests = 2;
    const broker = createDuplexBridgeBroker({
      channel: harness.channel,
      forwardRequest: controllableForward(harness),
      maxInFlightRequests,
    });
    brokers.push(broker);
    broker.start();

    // Saturate the in-flight limit with two hung forwards.
    harness.feed(requestFrame("keep-0"));
    harness.feed(requestFrame("keep-1"));
    expect(harness.forwards).toHaveLength(2);

    // A third unique id is refused, retryable. The broker did not forward it and
    // did not retain its id.
    harness.feed(requestFrame("resend-me"));
    expect(harness.forwards).toHaveLength(2);
    expect(harness.responses).toHaveLength(1);
    expect(JSON.parse(harness.responses[0].body).retryable).toBe(true);

    // Free one in-flight slot. The delivered request drains the pending record.
    harness.resolveForward("keep-0");
    await Promise.resolve();

    // The gateway resends the refused id. Capacity is free now, so the broker
    // forwards it exactly one time. This proves the refusal did not poison the id.
    harness.feed(requestFrame("resend-me"));
    expect(harness.forwards.filter((forward) => forward.id === "resend-me")).toHaveLength(1);

    // A resend of an already-forwarded id never reaches the forward twice.
    const forwardedKeep1 = harness.forwards.filter((forward) => forward.id === "keep-1").length;
    harness.feed(requestFrame("keep-1"));
    expect(harness.forwards.filter((forward) => forward.id === "keep-1")).toHaveLength(forwardedKeep1);

    harness.resolveAll();
  });

  it("bounds the retained request ids over the channel lifetime and refuses each new id past the limit", async () => {
    const harness = createFakeChannelHarness();
    const { telemetry, capture } = createTelemetryCapture();
    const maxLifetimeRequests = 3;
    const broker = createDuplexBridgeBroker({
      channel: harness.channel,
      // Resolve every forward at once, so each dispatched id leaves the in-flight
      // count but stays in the retained-id set.
      forwardRequest: async (request: DuplexRequestFrame): Promise<DuplexBrokerForwardResult> => {
        harness.forwards.push({ id: request.id, resolve: () => undefined, reject: () => undefined, settled: true });
        return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true }) };
      },
      telemetry,
      maxLifetimeRequests,
    });
    brokers.push(broker);
    broker.start();

    // Inject more than the lifetime limit of unique valid frames.
    const total = 9;
    for (let index = 0; index < total; index += 1) {
      harness.feed(requestFrame(`life-${index}`));
      await Promise.resolve();
    }

    // The broker forwarded only up to the lifetime limit. The retained-id set
    // stays bounded, because a refused id never joins it.
    expect(harness.forwards).toHaveLength(maxLifetimeRequests);

    // The broker delivered a real response for each forwarded request, then a
    // bounded terminal refusal for each id past the limit.
    const refusals = harness.responses.filter((response) => response.status === 503);
    expect(refusals).toHaveLength(total - maxLifetimeRequests);
    for (const refusal of refusals) {
      expect(refusal.outcome).toBe("unavailable");
      // A lifetime refusal is terminal, so a resend does not help.
      expect(JSON.parse(refusal.body).retryable).toBe(false);
    }

    // A resend of a refused id stays refused, so the set never grows.
    harness.feed(requestFrame("life-8"));
    await Promise.resolve();
    expect(harness.forwards).toHaveLength(maxLifetimeRequests);

    // The telemetry surface stayed on the fixed request span for the delivered
    // requests only. No refusal produced a span, a counter, or a loss record.
    expect(capture.spans).toHaveLength(maxLifetimeRequests);
    for (const span of capture.spans) {
      expect(span.name).toBe(DUPLEX_SPAN_REQUEST);
      expect(span.dimensions.outcome).toBe("ok");
      expect(Object.keys(span.dimensions).sort()).toEqual(["outcome", "provider", "transport"]);
    }
    expect(capture.counters).toHaveLength(0);
    expect(broker.lossRecord).toBeNull();
    expect(broker.state).toBe("open");
  });

  it("forwards nothing and fails the channel closed under a flood of over-limit ids", () => {
    const harness = createFakeChannelHarness();
    const broker = createDuplexBridgeBroker({
      channel: harness.channel,
      forwardRequest: controllableForward(harness),
    });
    brokers.push(broker);
    broker.start();

    // Send a sustained flood of distinct ids, each one byte over the id bound. The
    // codec rejects each frame on the read path, so no over-limit id ever reaches
    // the retained-id set or a forward.
    const overLimitId = (index: number): string =>
      `${"a".repeat(DEFAULT_MAX_DUPLEX_REQUEST_ID_BYTES)}-${index}`;
    for (let index = 0; index < 20; index += 1) {
      harness.feed(requestFrame(overLimitId(index)));
    }

    // The broker forwarded nothing. The retained-id set never grew, because the
    // set only grows on a dispatched forward, and the broker dispatched none.
    expect(harness.forwards).toHaveLength(0);
    // The first over-limit frame is a protocol failure, so the broker fails the
    // whole channel closed. It stays lost for the rest of the flood.
    expect(broker.state).toBe("lost");
    expect(broker.lossRecord?.reason).toBe("protocol_failure");
  });

  it("forwards a maximal-size id exactly once and does not forward a resend (no-replay preserved)", () => {
    const harness = createFakeChannelHarness();
    const broker = createDuplexBridgeBroker({
      channel: harness.channel,
      forwardRequest: controllableForward(harness),
    });
    brokers.push(broker);
    broker.start();

    // An id at the maximum byte size is allowed. The broker forwards it one time.
    const maxId = "a".repeat(DEFAULT_MAX_DUPLEX_REQUEST_ID_BYTES);
    harness.feed(requestFrame(maxId));
    expect(harness.forwards.filter((forward) => forward.id === maxId)).toHaveLength(1);

    // Deliver the response, then resend the same id. The broker retained the id,
    // so the resend never reaches the forward a second time.
    harness.resolveForward(maxId);
    harness.feed(requestFrame(maxId));
    expect(harness.forwards.filter((forward) => forward.id === maxId)).toHaveLength(1);
    expect(broker.state).toBe("open");
  });

  it("maps a forward that resolves with the indeterminate marker to a non-retryable response and retains the id", async () => {
    const harness = createFakeChannelHarness();
    const broker = createDuplexBridgeBroker({
      channel: harness.channel,
      forwardRequest: controllableForward(harness),
    });
    brokers.push(broker);
    broker.start();

    // The forward handler resolves with a 504 that carries the indeterminate
    // marker. This is the shape the host forward returns for a response-read
    // failure after the host commit. The broker must keep the marker and the
    // non-retryable body, so the gateway maps it to a non-retryable status and a
    // caller never repeats a possibly-committed mutation.
    harness.feed(requestFrame("commit-1"));
    const forward = harness.forwards.find((entry) => entry.id === "commit-1" && !entry.settled);
    if (!forward) throw new Error("The broker did not forward the request.");
    forward.settled = true;
    forward.resolve({
      status: 504,
      headers: {
        "content-type": "application/json",
        "x-paperclip-bridge-outcome": "indeterminate",
      },
      body: JSON.stringify({
        error: "Bridge response body exceeded the configured size limit of 32 bytes.",
        outcome: "indeterminate",
        retryable: false,
      }),
    });
    // The broker answers inside the forward `then` microtask, so let it settle.
    await Promise.resolve();

    expect(harness.responses).toHaveLength(1);
    const response = harness.responses[0]!;
    expect(response.status).toBe(504);
    expect(response.outcome).toBe("indeterminate");
    expect(response.headers["x-paperclip-bridge-outcome"]).toBe("indeterminate");
    expect(JSON.parse(response.body)).toEqual({
      error: "Bridge response body exceeded the configured size limit of 32 bytes.",
      outcome: "indeterminate",
      retryable: false,
    });

    // The broker delivered a response, so it retained the id. A resend never
    // reaches the forward a second time, so a caller that ignores the
    // non-retryable status still cannot repeat the mutation through the broker.
    harness.feed(requestFrame("commit-1"));
    expect(harness.forwards.filter((entry) => entry.id === "commit-1")).toHaveLength(1);
    expect(broker.state).toBe("open");
  });

  it("maps a forward rejection for a mutating method to a non-retryable indeterminate response and retains the id", async () => {
    const harness = createFakeChannelHarness();
    const broker = createDuplexBridgeBroker({
      channel: harness.channel,
      forwardRequest: controllableForward(harness),
    });
    brokers.push(broker);
    broker.start();

    // The forward rejects before the host delivers a response. A fetch can
    // reject after the request reaches the host and the host commits, but
    // before the response headers arrive. The broker did not abort the
    // forward, so a POST must return a non-retryable indeterminate response.
    // A retryable status would let a caller repeat a committed mutation.
    harness.feed(requestFrame("mutate-1", "POST"));
    const forward = harness.forwards.find((entry) => entry.id === "mutate-1" && !entry.settled);
    if (!forward) throw new Error("The broker did not forward the request.");
    forward.settled = true;
    forward.reject(new Error("fetch failed before the response headers arrived"));
    // The broker answers inside the forward rejection microtask, so let it settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.responses).toHaveLength(1);
    const response = harness.responses[0]!;
    expect(response.status).toBe(504);
    expect(response.outcome).toBe("indeterminate");
    expect(response.headers["x-paperclip-bridge-outcome"]).toBe("indeterminate");
    expect(JSON.parse(response.body)).toEqual({
      error: "fetch failed before the response headers arrived",
      outcome: "indeterminate",
      retryable: false,
    });

    // The broker delivered a response, so it retained the id. A resend never
    // reaches the forward a second time, so a caller that ignores the
    // non-retryable status still cannot repeat the mutation through the broker.
    harness.feed(requestFrame("mutate-1", "POST"));
    expect(harness.forwards.filter((entry) => entry.id === "mutate-1")).toHaveLength(1);
    expect(broker.state).toBe("open");
  });

  it("maps a forward rejection for a safe method to a retryable response", async () => {
    const harness = createFakeChannelHarness();
    const broker = createDuplexBridgeBroker({
      channel: harness.channel,
      forwardRequest: controllableForward(harness),
    });
    brokers.push(broker);
    broker.start();

    // A safe method never changes host state, so a retry cannot double-apply a
    // mutation. A forward rejection for a GET stays retryable: the broker
    // returns a 502 with the completed outcome, so the gateway passes it through.
    harness.feed(requestFrame("read-1", "GET"));
    const forward = harness.forwards.find((entry) => entry.id === "read-1" && !entry.settled);
    if (!forward) throw new Error("The broker did not forward the request.");
    forward.settled = true;
    forward.reject(new Error("fetch failed before the response headers arrived"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.responses).toHaveLength(1);
    const response = harness.responses[0]!;
    expect(response.status).toBe(502);
    expect(response.outcome).toBe("completed");
    expect(response.headers["x-paperclip-bridge-outcome"]).toBeUndefined();
    expect(JSON.parse(response.body)).toEqual({
      error: "fetch failed before the response headers arrived",
    });
  });

  it("maps a forward-budget timeout for a safe method to a retryable response", async () => {
    const harness = createFakeChannelHarness();
    const broker = createDuplexBridgeBroker({
      channel: harness.channel,
      forwardRequest: controllableForward(harness),
      // A tiny forward budget aborts the controller before the manual rejection.
      budgets: { forwardTimeoutMs: 5 },
    });
    brokers.push(broker);
    broker.start();

    // A safe method never changes host state. A forward timeout for a GET must
    // stay retryable: the broker returns a 504 with the completed outcome and no
    // indeterminate marker, so the gateway does not map it to a terminal 409.
    harness.feed(requestFrame("read-timeout-1", "GET"));
    const forward = harness.forwards.find((entry) => entry.id === "read-timeout-1" && !entry.settled);
    if (!forward) throw new Error("The broker did not forward the request.");

    // Wait for the forward-budget timer to abort the controller, then reject the
    // forward. The rejection handler now sees the aborted signal.
    await new Promise((resolve) => setTimeout(resolve, 20));
    forward.settled = true;
    forward.reject(new Error("Duplex broker forward budget exceeded."));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.responses).toHaveLength(1);
    const response = harness.responses[0]!;
    expect(response.status).toBe(504);
    expect(response.outcome).toBe("completed");
    expect(response.headers["x-paperclip-bridge-outcome"]).toBeUndefined();
    expect(JSON.parse(response.body)).toEqual({
      error: "Duplex broker forward budget exceeded.",
      retryable: true,
    });
  });

  it("maps a forward-budget timeout for a mutating method to a non-retryable indeterminate response", async () => {
    const harness = createFakeChannelHarness();
    const broker = createDuplexBridgeBroker({
      channel: harness.channel,
      forwardRequest: controllableForward(harness),
      budgets: { forwardTimeoutMs: 5 },
    });
    brokers.push(broker);
    broker.start();

    // A POST may commit before the forward budget aborts the call. The broker
    // must keep the terminal contract: a 504 with the indeterminate outcome, so
    // the gateway maps it to a non-retryable 409 and no caller double-applies it.
    harness.feed(requestFrame("mutate-timeout-1", "POST"));
    const forward = harness.forwards.find((entry) => entry.id === "mutate-timeout-1" && !entry.settled);
    if (!forward) throw new Error("The broker did not forward the request.");

    await new Promise((resolve) => setTimeout(resolve, 20));
    forward.settled = true;
    forward.reject(new Error("Duplex broker forward budget exceeded."));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.responses).toHaveLength(1);
    const response = harness.responses[0]!;
    expect(response.status).toBe(504);
    expect(response.outcome).toBe("indeterminate");
    expect(response.headers["x-paperclip-bridge-outcome"]).toBe("indeterminate");
    expect(JSON.parse(response.body)).toEqual({
      error: "Duplex broker forward budget exceeded.",
      outcome: "indeterminate",
      retryable: false,
    });
  });

  it("maps a response-budget backstop for a safe method to a retryable response", async () => {
    const harness = createFakeChannelHarness();
    const broker = createDuplexBridgeBroker({
      channel: harness.channel,
      forwardRequest: controllableForward(harness),
      // The forward budget aborts the call, but the forward promise stays
      // pending. A GET receives the response headers, but the body reader stalls
      // through the response budget, so the forward promise never settles. The
      // response-budget backstop must answer the request.
      budgets: { forwardTimeoutMs: 5, responseBudgetMs: 15, gatewayWaitMs: 40 },
    });
    brokers.push(broker);
    broker.start();

    // A safe method never changes host state, so a stalled body reader cannot
    // leave a mutation half-applied. The backstop must keep the request
    // retryable: a 504 with the completed outcome and no indeterminate marker,
    // so the gateway does not map it to a terminal 409.
    harness.feed(requestFrame("read-stall-1", "GET"));
    const forward = harness.forwards.find((entry) => entry.id === "read-stall-1" && !entry.settled);
    if (!forward) throw new Error("The broker did not forward the request.");

    // Never settle the forward. Wait past the response budget so the backstop
    // fires on the stalled body reader.
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(harness.responses).toHaveLength(1);
    const response = harness.responses[0]!;
    expect(response.status).toBe(504);
    expect(response.outcome).toBe("completed");
    expect(response.headers["x-paperclip-bridge-outcome"]).toBeUndefined();
    expect(JSON.parse(response.body)).toEqual({
      error: "Duplex broker response budget exceeded.",
      retryable: true,
    });
  });

  it("maps a response-budget backstop for a mutating method to a non-retryable indeterminate response", async () => {
    const harness = createFakeChannelHarness();
    const broker = createDuplexBridgeBroker({
      channel: harness.channel,
      forwardRequest: controllableForward(harness),
      budgets: { forwardTimeoutMs: 5, responseBudgetMs: 15, gatewayWaitMs: 40 },
    });
    brokers.push(broker);
    broker.start();

    // A POST may commit before the response budget passes, and the broker cannot
    // prove the host applied no mutation. The backstop must keep the terminal
    // contract: a 504 with the indeterminate outcome, so the gateway maps it to a
    // non-retryable 409 and no caller double-applies it.
    harness.feed(requestFrame("mutate-stall-1", "POST"));
    const forward = harness.forwards.find((entry) => entry.id === "mutate-stall-1" && !entry.settled);
    if (!forward) throw new Error("The broker did not forward the request.");

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(harness.responses).toHaveLength(1);
    const response = harness.responses[0]!;
    expect(response.status).toBe(504);
    expect(response.outcome).toBe("indeterminate");
    expect(response.headers["x-paperclip-bridge-outcome"]).toBe("indeterminate");
    expect(JSON.parse(response.body)).toEqual({
      error: "Duplex broker response budget exceeded.",
      outcome: "indeterminate",
      retryable: false,
    });
  });
});
