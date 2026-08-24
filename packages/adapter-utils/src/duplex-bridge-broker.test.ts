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
import { splitBodyIntoChunkFrames } from "./duplex-body-spool.js";
import {
  createDuplexTelemetry,
  DUPLEX_COUNTER_LOSS_TOTAL,
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

/**
 * One reassembled response the broker wrote back. The broker writes a response as
 * one envelope frame that carries `bodyByteCount`, then the `body_chunk` frames
 * that carry the body. The harness reassembles the body and exposes it as `body`,
 * so a test asserts the response the same way it did with the one-frame model.
 */
type ReassembledResponse = DuplexResponseFrame & { body: string };

/** One request the harness feeds: the envelope frame plus its raw body text. */
interface RequestInput {
  frame: DuplexRequestFrame;
  bodyText: string;
}

/** The in-memory channel plus the levers a test uses to drive the broker. */
interface FakeChannelHarness {
  channel: CommandManagedDuplexChannel;
  /** Push one request (its envelope frame and its body_chunk frames) into the broker read path. */
  feed: (input: RequestInput) => void;
  /** The reassembled responses the broker wrote back, in order. */
  responses: ReassembledResponse[];
  /** Every forward call the broker made, in order. */
  forwards: PendingForward[];
  /** Resolve the newest unsettled forward for one id with a 200 result. */
  resolveForward: (id: string, body?: string) => void;
  /** Resolve every unsettled forward with a 200 result. */
  resolveAll: () => void;
}

/**
 * Build one valid request with distinctive, secret-looking fields. The envelope
 * carries `bodyByteCount`, and the harness rides the body on `body_chunk` frames.
 */
function requestFrame(
  id: string,
  method = "POST",
  bodyText: string = JSON.stringify({ secret: "secret-request-body" }),
): RequestInput {
  return {
    frame: {
      version: DUPLEX_FRAME_VERSION,
      type: "request",
      id,
      method,
      path: `/api/issues/${id}`,
      query: "?secret-query=leak",
      headers: { authorization: "Bearer super-secret-provider-token" },
      bodyByteCount: Buffer.byteLength(bodyText, "utf8"),
    },
    bodyText,
  };
}

/**
 * Build the in-memory channel harness. The channel keeps the broker read
 * listener, so `feed` pushes the encoded envelope and its body_chunk frames into
 * the broker. The channel decodes each written frame and reassembles a response
 * body, so `responses` holds one reassembled response per delivered request.
 */
function createFakeChannelHarness(): FakeChannelHarness {
  const responses: ReassembledResponse[] = [];
  const forwards: PendingForward[] = [];
  const writtenDecoder = new DuplexFrameDecoder();
  // The in-flight response reassembly, keyed by request id.
  const responseAssembly = new Map<
    string,
    { frame: DuplexResponseFrame; received: number; chunks: Buffer[] }
  >();
  let dataListener: ((chunk: string) => void) | null = null;

  const channel: CommandManagedDuplexChannel = {
    write: (data) => {
      for (const result of writtenDecoder.push(data)) {
        if (!result.ok) continue;
        const frame = result.frame;
        if (frame.type === "response") {
          if (frame.bodyByteCount === 0) {
            responses.push({ ...frame, body: "" });
          } else {
            responseAssembly.set(frame.id, { frame, received: 0, chunks: [] });
          }
        } else if (frame.type === "body_chunk") {
          const assembly = responseAssembly.get(frame.id);
          if (!assembly) continue;
          const decoded = Buffer.from(frame.data, "base64");
          assembly.received += decoded.length;
          assembly.chunks.push(decoded);
          if (assembly.received >= assembly.frame.bodyByteCount) {
            responseAssembly.delete(frame.id);
            responses.push({
              ...assembly.frame,
              body: Buffer.concat(assembly.chunks).toString("utf8"),
            });
          }
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
    feed: ({ frame, bodyText }) => {
      if (!dataListener) throw new Error("The broker did not bind the data listener.");
      dataListener(encodeDuplexFrame(frame));
      if (bodyText.length > 0) {
        const chunks = splitBodyIntoChunkFrames(
          frame.id,
          Buffer.from(bodyText, "utf8"),
          DUPLEX_FRAME_VERSION,
        );
        for (const chunk of chunks) dataListener(encodeDuplexFrame(chunk));
      }
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

/** Flush the microtasks and one macrotask, so the broker dispatches its reassembled forwards. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
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

  it("bounds the in-flight forwards and refuses the excess with a retryable terminal response", async () => {
    const harness = createFakeChannelHarness();
    const { telemetry, capture } = createTelemetryCapture();
    const maxInFlightRequests = 4;
    const broker = await createDuplexBridgeBroker({
      channel: harness.channel,
      forwardRequest: controllableForward(harness),
      telemetry,
      maxInFlightRequests,
    });
    brokers.push(broker);
    broker.start();

    // Inject more than the limit of unique valid frames. Every forward hangs, so
    // the broker holds the maximum number of in-flight forwards. The broker gates
    // the in-flight limit at the request envelope, so it refuses the excess at
    // once; it dispatches each accepted forward after it reassembles the body.
    const total = 10;
    const ids = Array.from({ length: total }, (_unused, index) => `flight-${index}`);
    for (const id of ids) harness.feed(requestFrame(id));
    await flush();

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
    const broker = await createDuplexBridgeBroker({
      channel: harness.channel,
      forwardRequest: controllableForward(harness),
      maxInFlightRequests,
    });
    brokers.push(broker);
    broker.start();

    // Saturate the in-flight limit with two hung forwards. The broker reserves the
    // in-flight slot at the request envelope, then dispatches the forward after it
    // reassembles the body.
    harness.feed(requestFrame("keep-0"));
    harness.feed(requestFrame("keep-1"));
    await flush();
    expect(harness.forwards).toHaveLength(2);

    // A third unique id is refused, retryable. The broker did not forward it and
    // did not retain its id.
    harness.feed(requestFrame("resend-me"));
    await flush();
    expect(harness.forwards).toHaveLength(2);
    expect(harness.responses).toHaveLength(1);
    expect(JSON.parse(harness.responses[0].body).retryable).toBe(true);

    // Free one in-flight slot. The delivered request drains the pending record.
    harness.resolveForward("keep-0");
    await flush();

    // The gateway resends the refused id. Capacity is free now, so the broker
    // forwards it exactly one time. This proves the refusal did not poison the id.
    harness.feed(requestFrame("resend-me"));
    await flush();
    expect(harness.forwards.filter((forward) => forward.id === "resend-me")).toHaveLength(1);

    // A resend of an already-forwarded id never reaches the forward twice.
    const forwardedKeep1 = harness.forwards.filter((forward) => forward.id === "keep-1").length;
    harness.feed(requestFrame("keep-1"));
    await flush();
    expect(harness.forwards.filter((forward) => forward.id === "keep-1")).toHaveLength(forwardedKeep1);

    harness.resolveAll();
  });

  it("bounds the retained request ids over the channel lifetime and refuses each new id past the limit", async () => {
    const harness = createFakeChannelHarness();
    const { telemetry, capture } = createTelemetryCapture();
    const maxLifetimeRequests = 3;
    const broker = await createDuplexBridgeBroker({
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
      await flush();
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
    await flush();
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

  it("forwards nothing and fails the channel closed under a flood of over-limit ids", async () => {
    const harness = createFakeChannelHarness();
    const broker = await createDuplexBridgeBroker({
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

  it("forwards a maximal-size id exactly once and does not forward a resend (no-replay preserved)", async () => {
    const harness = createFakeChannelHarness();
    const broker = await createDuplexBridgeBroker({
      channel: harness.channel,
      forwardRequest: controllableForward(harness),
    });
    brokers.push(broker);
    broker.start();

    // An id at the maximum byte size is allowed. The broker forwards it one time.
    const maxId = "a".repeat(DEFAULT_MAX_DUPLEX_REQUEST_ID_BYTES);
    harness.feed(requestFrame(maxId));
    await flush();
    expect(harness.forwards.filter((forward) => forward.id === maxId)).toHaveLength(1);

    // Deliver the response, then resend the same id. The broker retained the id,
    // so the resend never reaches the forward a second time.
    harness.resolveForward(maxId);
    harness.feed(requestFrame(maxId));
    await flush();
    expect(harness.forwards.filter((forward) => forward.id === maxId)).toHaveLength(1);
    expect(broker.state).toBe("open");
  });

  it("maps a forward that resolves with the indeterminate marker to a non-retryable response and retains the id", async () => {
    const harness = createFakeChannelHarness();
    const broker = await createDuplexBridgeBroker({
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
    await flush();
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
    const broker = await createDuplexBridgeBroker({
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
    await flush();
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

  it("substitutes a bounded terminal response for an oversized response and keeps the channel open", async () => {
    const harness = createFakeChannelHarness();
    const { telemetry, capture } = createTelemetryCapture();
    const broker = await createDuplexBridgeBroker({
      channel: harness.channel,
      forwardRequest: controllableForward(harness),
      telemetry,
      // A small frame bound makes a legitimately large response body exceed the
      // bound, so the test exercises the encode guard without a megabyte body.
      maxFrameBytes: 1000,
    });
    brokers.push(broker);
    broker.start();

    // Two requests are in flight at the same time. One resolves with a normal
    // body; the other resolves with a body that pushes the response frame over
    // the bound. The host produced both results, so both requests reached the
    // host.
    harness.feed(requestFrame("small-1", "POST"));
    harness.feed(requestFrame("big-1", "POST"));
    await flush();

    const smallForward = harness.forwards.find((entry) => entry.id === "small-1" && !entry.settled);
    if (!smallForward) throw new Error("The broker did not forward the small request.");
    smallForward.settled = true;
    smallForward.resolve({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const bigForward = harness.forwards.find((entry) => entry.id === "big-1" && !entry.settled);
    if (!bigForward) throw new Error("The broker did not forward the big request.");
    bigForward.settled = true;
    bigForward.resolve({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: "y".repeat(2000) }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The other in-flight request delivered its full response, unaffected by the
    // oversized one.
    expect(harness.responses).toHaveLength(2);
    const delivered = harness.responses.find((entry) => entry.id === "small-1")!;
    expect(delivered.status).toBe(200);
    expect(delivered.outcome).toBe("completed");
    expect(JSON.parse(delivered.body)).toEqual({ ok: true });

    // The oversized response became one bounded terminal response marked
    // indeterminate and non-retryable, so a caller does not retry a possible
    // mutation. The broker did not write the oversized frame.
    const terminal = harness.responses.find((entry) => entry.id === "big-1")!;
    expect(terminal.status).toBe(502);
    expect(terminal.outcome).toBe("indeterminate");
    expect(terminal.headers["x-paperclip-bridge-outcome"]).toBe("indeterminate");
    expect(JSON.parse(terminal.body)).toEqual({
      error: "upstream response too large to deliver",
      outcome: "indeterminate",
      retryable: false,
    });

    // The oversized body never crossed the wire. The broker did not truncate it or
    // pass it through.
    const writtenText = harness.responses.map((entry) => encodeDuplexFrame(entry)).join("");
    expect(writtenText).not.toContain("yyyy");

    // The broker recorded the oversized request as an error outcome, never a loss.
    // The channel stays open and the run does not fail.
    const errorSpans = capture.spans.filter((span) => span.dimensions.outcome === "error");
    expect(errorSpans).toHaveLength(1);
    expect(errorSpans[0]!.name).toBe(DUPLEX_SPAN_REQUEST);
    expect(broker.lossRecord).toBeNull();
    expect(broker.state).toBe("open");
    expect(broker.runDisposition.failed).toBe(false);
  });

  it("sends a minimal terminal response when the frame bound rejects the full replacement", async () => {
    const harness = createFakeChannelHarness();
    const { telemetry, capture } = createTelemetryCapture();
    // The bound accepts a compact request envelope (128 bytes) and the minimal
    // terminal response envelope (114 bytes), but rejects the full replacement
    // response envelope (193 bytes). This proves the broker never drops the channel
    // or strands the request when the bound is smaller than the full replacement.
    const broker = await createDuplexBridgeBroker({
      channel: harness.channel,
      forwardRequest: controllableForward(harness),
      telemetry,
      maxFrameBytes: 150,
    });
    brokers.push(broker);
    broker.start();

    // A compact request envelope with an empty body fits the bound, so the broker
    // forwards it.
    harness.feed({
      frame: {
        version: DUPLEX_FRAME_VERSION,
        type: "request",
        id: "big-1",
        method: "POST",
        path: "/api/issues/big-1",
        query: "",
        headers: {},
        bodyByteCount: 0,
      },
      bodyText: "",
    });
    await flush();

    const forward = harness.forwards.find((entry) => entry.id === "big-1" && !entry.settled);
    if (!forward) throw new Error("The broker did not forward the request.");
    forward.settled = true;
    // The host produced a large response body that pushes the real response frame
    // and the full replacement frame over the bound.
    forward.resolve({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: "y".repeat(2000) }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The broker sent one minimal terminal response, not the oversized real
    // response and not the full replacement. The minimal response carries the
    // indeterminate outcome, so the gateway maps it to a terminal 409.
    expect(harness.responses).toHaveLength(1);
    const terminal = harness.responses[0]!;
    expect(terminal.id).toBe("big-1");
    expect(terminal.status).toBe(502);
    expect(terminal.outcome).toBe("indeterminate");
    expect(terminal.headers).toEqual({});
    expect(terminal.body).toBe("");

    // The oversized body never crossed the wire.
    const writtenText = harness.responses.map((entry) => encodeDuplexFrame(entry)).join("");
    expect(writtenText).not.toContain("yyyy");

    // The broker recorded the request as an error outcome, never a loss. The
    // channel stays open and the run does not fail.
    const errorSpans = capture.spans.filter((span) => span.dimensions.outcome === "error");
    expect(errorSpans).toHaveLength(1);
    expect(errorSpans[0]!.name).toBe(DUPLEX_SPAN_REQUEST);
    expect(broker.lossRecord).toBeNull();
    expect(broker.state).toBe("open");
    expect(broker.runDisposition.failed).toBe(false);
  });

  it("keeps the channel open and logs when the bound rejects even the minimal terminal response", async () => {
    const harness = createFakeChannelHarness();
    const { telemetry, capture } = createTelemetryCapture();
    const logs: string[] = [];
    // The bound accepts a tiny request envelope (107 bytes) but rejects even the
    // minimal terminal response envelope (110 bytes). The broker cannot send any
    // frame for this request, so it must keep the channel open and log a clear
    // local error.
    const broker = await createDuplexBridgeBroker({
      channel: harness.channel,
      forwardRequest: controllableForward(harness),
      telemetry,
      maxFrameBytes: 109,
      logger: (message) => logs.push(message),
    });
    brokers.push(broker);
    broker.start();

    harness.feed({
      frame: {
        version: DUPLEX_FRAME_VERSION,
        type: "request",
        id: "x",
        method: "GET",
        path: "/",
        query: "",
        headers: {},
        bodyByteCount: 0,
      },
      bodyText: "",
    });
    await flush();

    const forward = harness.forwards.find((entry) => entry.id === "x" && !entry.settled);
    if (!forward) throw new Error("The broker did not forward the request.");
    forward.settled = true;
    forward.resolve({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: "y".repeat(200) }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The broker sent no response frame, because no frame fits the bound.
    expect(harness.responses).toHaveLength(0);
    // The broker recorded the request as an error outcome, never a loss.
    const errorSpans = capture.spans.filter((span) => span.dimensions.outcome === "error");
    expect(errorSpans).toHaveLength(1);
    // The broker logged a clear local error and kept the channel open.
    expect(logs.some((line) => line.includes("could not deliver a terminal response"))).toBe(true);
    expect(broker.lossRecord).toBeNull();
    expect(broker.state).toBe("open");
    expect(broker.runDisposition.failed).toBe(false);
  });

  it("completes a request within the bound and delivers the real response", async () => {
    const harness = createFakeChannelHarness();
    const { telemetry, capture } = createTelemetryCapture();
    const broker = await createDuplexBridgeBroker({
      channel: harness.channel,
      forwardRequest: controllableForward(harness),
      telemetry,
      maxFrameBytes: 1000,
    });
    brokers.push(broker);
    broker.start();

    harness.feed(requestFrame("ok-1", "POST"));
    await flush();
    harness.resolveForward("ok-1", JSON.stringify({ ok: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The broker delivered the real response promptly with the completed outcome.
    expect(harness.responses).toHaveLength(1);
    const delivered = harness.responses[0]!;
    expect(delivered.id).toBe("ok-1");
    expect(delivered.status).toBe(200);
    expect(delivered.outcome).toBe("completed");
    expect(JSON.parse(delivered.body)).toEqual({ ok: true });

    // The delivered response records an `ok` span, never an error, and never a loss.
    const okSpans = capture.spans.filter((span) => span.dimensions.outcome === "ok");
    expect(okSpans).toHaveLength(1);
    const errorSpans = capture.spans.filter((span) => span.dimensions.outcome === "error");
    expect(errorSpans).toHaveLength(0);
    expect(broker.lossRecord).toBeNull();
    expect(broker.state).toBe("open");
    expect(broker.runDisposition.failed).toBe(false);
  });

  it("maps a forward rejection for a safe method to a retryable response", async () => {
    const harness = createFakeChannelHarness();
    const broker = await createDuplexBridgeBroker({
      channel: harness.channel,
      forwardRequest: controllableForward(harness),
    });
    brokers.push(broker);
    broker.start();

    // A safe method never changes host state, so a retry cannot double-apply a
    // mutation. A forward rejection for a GET stays retryable: the broker
    // returns a 502 with the completed outcome, so the gateway passes it through.
    harness.feed(requestFrame("read-1", "GET"));
    await flush();
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
    const broker = await createDuplexBridgeBroker({
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
    await flush();
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
    const broker = await createDuplexBridgeBroker({
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
    await flush();
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
    const broker = await createDuplexBridgeBroker({
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
    await flush();
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
    const broker = await createDuplexBridgeBroker({
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
    await flush();
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


/**
 * A channel harness that captures the broker exit listener. `emitExit` invokes it,
 * so a test drives one channel exit into the broker.
 */
function createExitChannelHarness(): {
  channel: CommandManagedDuplexChannel;
  emitExit: (exit: { exitCode: number | null; transportClosed?: boolean }) => void;
} {
  let exitListener:
    | ((exit: { exitCode: number | null; transportClosed?: boolean }) => void)
    | null = null;
  const channel: CommandManagedDuplexChannel = {
    write: () => undefined,
    onData: () => undefined,
    onExit: (listener) => {
      exitListener = listener;
    },
    stop: () => undefined,
    close: () => Promise.resolve(),
  };
  return {
    channel,
    emitExit: (exit) => {
      if (!exitListener) throw new Error("The broker did not bind the exit listener.");
      exitListener(exit);
    },
  };
}

describe("duplex bridge broker exit taxonomy", () => {
  const brokers: DuplexBridgeBroker[] = [];

  afterEach(async () => {
    while (brokers.length > 0) {
      const broker = brokers.pop();
      if (broker) await broker.close();
    }
  });

  it("records a transport close as a distinct loss, not a process exit", async () => {
    const { telemetry, capture } = createTelemetryCapture();
    const harness = createExitChannelHarness();
    const broker = await createDuplexBridgeBroker({
      channel: harness.channel,
      forwardRequest: () =>
        Promise.resolve({ status: 200, headers: {}, body: "" }),
      telemetry,
    });
    brokers.push(broker);
    broker.start();

    // A reason-less transport close carries the discriminator and no exit code.
    harness.emitExit({ exitCode: null, transportClosed: true });

    expect(broker.lossRecord?.reason).toBe("transport_closed");
    expect(broker.runDisposition).toEqual({ failed: true, lossReason: "transport_closed" });
    const lossCounter = capture.counters.find(
      (record) => record.metric === DUPLEX_COUNTER_LOSS_TOTAL,
    );
    expect(lossCounter?.dimensions.loss_reason).toBe("transport_closed");
  });

  it("records a numeric exit as a process exit", async () => {
    const { telemetry, capture } = createTelemetryCapture();
    const harness = createExitChannelHarness();
    const broker = await createDuplexBridgeBroker({
      channel: harness.channel,
      forwardRequest: () =>
        Promise.resolve({ status: 200, headers: {}, body: "" }),
      telemetry,
    });
    brokers.push(broker);
    broker.start();

    // A numeric exit code is a real process exit, so the broker keeps the existing
    // channel_exit -> provider_exit mapping.
    harness.emitExit({ exitCode: 0 });

    expect(broker.lossRecord?.reason).toBe("channel_exit");
    expect(broker.runDisposition).toEqual({ failed: true, lossReason: "provider_exit" });
    const lossCounter = capture.counters.find(
      (record) => record.metric === DUPLEX_COUNTER_LOSS_TOTAL,
    );
    expect(lossCounter?.dimensions.loss_reason).toBe("provider_exit");
  });
});
