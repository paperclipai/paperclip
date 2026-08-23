import { afterEach, describe, expect, it } from "vitest";

import {
  createDuplexBridgeBroker,
  type DuplexBridgeBroker,
  type DuplexBrokerForwardResult,
} from "./duplex-bridge-broker.js";
import {
  DUPLEX_CHANNEL_AGGREGATE_BYTES_EXCEEDED,
  DuplexAggregateByteLedger,
} from "./duplex-aggregate-byte-ledger.js";
import {
  DUPLEX_FRAME_VERSION,
  DuplexFrameDecoder,
  encodeDuplexFrame,
  type DuplexRequestFrame,
  type DuplexResponseFrame,
} from "./duplex-frame-codec.js";
import type { CommandManagedDuplexChannel } from "./command-managed-runtime.js";

/**
 * Regression harness for the broker aggregate byte ledger charging.
 *
 * The harness feeds request frames straight into the broker through an in-memory
 * channel, the same as a provider that controls the transport. A test controls
 * when each forward settles, so it can assert the ledger charge while the forward
 * is still in flight and after it settles.
 */

/** One pending forward a test settles by hand. */
interface PendingForward {
  id: string;
  resolve: (result: DuplexBrokerForwardResult) => void;
  reject: (error: Error) => void;
  settled: boolean;
}

/** The in-memory channel plus the levers a test uses to drive the broker. */
interface FakeChannelHarness {
  channel: CommandManagedDuplexChannel;
  feed: (frame: DuplexRequestFrame) => void;
  exit: () => void;
  responses: DuplexResponseFrame[];
  forwards: PendingForward[];
  resolveForward: (id: string, body?: string) => void;
}

/** Build one valid request frame. */
function requestFrame(id: string, method = "POST"): DuplexRequestFrame {
  return {
    version: DUPLEX_FRAME_VERSION,
    type: "request",
    id,
    method,
    path: `/api/issues/${id}`,
    query: "",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  };
}

function createFakeChannelHarness(): FakeChannelHarness {
  const responses: DuplexResponseFrame[] = [];
  const forwards: PendingForward[] = [];
  const writtenDecoder = new DuplexFrameDecoder();
  let dataListener: ((chunk: string) => void) | null = null;
  let exitListener: ((exit: { exitCode: number | null }) => void) | null = null;

  const channel: CommandManagedDuplexChannel = {
    write: (data) => {
      for (const result of writtenDecoder.push(data)) {
        if (result.ok && result.frame.type === "response") responses.push(result.frame);
      }
    },
    onData: (listener) => {
      dataListener = listener;
    },
    onExit: (listener) => {
      exitListener = listener;
    },
    stop: () => undefined,
    close: () => Promise.resolve(),
  };

  return {
    channel,
    feed: (frame) => {
      if (!dataListener) throw new Error("The broker did not bind the data listener.");
      dataListener(encodeDuplexFrame(frame));
    },
    exit: () => {
      if (!exitListener) throw new Error("The broker did not bind the exit listener.");
      exitListener({ exitCode: 0 });
    },
    responses,
    forwards,
    resolveForward: (id, body = JSON.stringify({ ok: true })) => {
      const forward = [...forwards].reverse().find((entry) => entry.id === id && !entry.settled);
      if (!forward) throw new Error(`No unsettled forward for id ${id}.`);
      forward.settled = true;
      forward.resolve({ status: 200, headers: { "content-type": "application/json" }, body });
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

/** Wait for the microtask queue to drain, so a settled promise runs its handlers. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("duplex bridge broker aggregate byte ledger", () => {
  const brokers: DuplexBridgeBroker[] = [];

  afterEach(async () => {
    while (brokers.length > 0) {
      const broker = brokers.pop();
      if (broker) await broker.close();
    }
  });

  it("charges request-frame, request-payload, and seen-id tokens, then releases the request tokens on forward settlement", async () => {
    const harness = createFakeChannelHarness();
    const ledger = new DuplexAggregateByteLedger({ ceilingBytes: 1_000_000 });
    const broker = createDuplexBridgeBroker({
      channel: harness.channel,
      forwardRequest: controllableForward(harness),
      duplexAggregateByteLedger: ledger,
    });
    brokers.push(broker);
    broker.start();

    harness.feed(requestFrame("req-1"));
    // The dispatch retains three tokens: the raw frame, the normalized payload,
    // and the no-replay set entry.
    expect(ledger.liveTokenCount).toBe(3);
    expect(ledger.bytesInUse).toBeGreaterThan(0);
    const chargedInFlight = ledger.bytesInUse;

    harness.resolveForward("req-1");
    await flush();

    // The forward settled. The finally owner released the request-frame and the
    // request-payload tokens. The seen-id token stays charged for the channel
    // lifetime, so exactly one token remains.
    expect(ledger.liveTokenCount).toBe(1);
    expect(ledger.bytesInUse).toBeGreaterThan(0);
    expect(ledger.bytesInUse).toBeLessThan(chargedInFlight);

    // A close releases the seen-id token, so the ledger returns to zero.
    await broker.close();
    expect(ledger.bytesInUse).toBe(0);
    expect(ledger.liveTokenCount).toBe(0);
  });

  it("keeps request tokens charged when the response timer answers before the forward settles, and releases them on settlement", async () => {
    const harness = createFakeChannelHarness();
    const ledger = new DuplexAggregateByteLedger({ ceilingBytes: 1_000_000 });
    const broker = createDuplexBridgeBroker({
      channel: harness.channel,
      forwardRequest: controllableForward(harness),
      // Squeeze the nested budgets so the response timer fires quickly while the
      // forward stays unsettled.
      budgets: { forwardTimeoutMs: 5, responseBudgetMs: 10, gatewayWaitMs: 20 },
      duplexAggregateByteLedger: ledger,
    });
    brokers.push(broker);
    broker.start();

    harness.feed(requestFrame("req-1", "GET"));
    expect(ledger.liveTokenCount).toBe(3);

    // Wait past the response budget so the backstop answers the gateway while the
    // forward is still in flight.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(harness.responses.some((frame) => frame.id === "req-1")).toBe(true);
    // The gateway got its answer, but the forward has not settled. The request
    // tokens and the seen-id token stay charged: nothing released yet.
    expect(ledger.liveTokenCount).toBe(3);

    // Settle the orphaned forward. Its finally owner now releases the two request
    // tokens; the seen-id token still stays for the channel lifetime.
    harness.resolveForward("req-1");
    await flush();
    expect(ledger.liveTokenCount).toBe(1);

    await broker.close();
    expect(ledger.bytesInUse).toBe(0);
  });

  it("refuses a one-byte-over dispatch with the fixed marker and retains nothing", async () => {
    const harness = createFakeChannelHarness();
    // Measure the exact per-request charge with a throwaway broker, so the test
    // can size a ceiling one byte below it and force the reservation to fail.
    const probeHarness = createFakeChannelHarness();
    const measured = new DuplexAggregateByteLedger({ ceilingBytes: 1_000_000 });
    const measuringBroker = createDuplexBridgeBroker({
      channel: probeHarness.channel,
      forwardRequest: controllableForward(probeHarness),
      duplexAggregateByteLedger: measured,
    });
    measuringBroker.start();
    probeHarness.feed(requestFrame("req-1"));
    const perRequestBytes = measured.bytesInUse;
    await measuringBroker.close();

    const ledger = new DuplexAggregateByteLedger({ ceilingBytes: perRequestBytes - 1 });
    const broker = createDuplexBridgeBroker({
      channel: harness.channel,
      forwardRequest: controllableForward(harness),
      duplexAggregateByteLedger: ledger,
    });
    brokers.push(broker);
    broker.start();

    harness.feed(requestFrame("req-1"));
    await flush();

    // The broker retained nothing: no token, no forward, no seen id.
    expect(ledger.liveTokenCount).toBe(0);
    expect(ledger.bytesInUse).toBe(0);
    expect(harness.forwards.length).toBe(0);
    // The refusal carries the fixed marker and is a bounded terminal response.
    const refusal = harness.responses.find((frame) => frame.id === "req-1");
    expect(refusal).toBeTruthy();
    expect(refusal?.status).toBe(503);
    expect(refusal?.body).toContain(DUPLEX_CHANNEL_AGGREGATE_BYTES_EXCEEDED);

    // The refusal did not retain the id, so a resend after pressure eases is
    // admitted: raise the ceiling and re-feed.
    const roomyLedger = new DuplexAggregateByteLedger({ ceilingBytes: 1_000_000 });
    const roomyHarness = createFakeChannelHarness();
    const roomyBroker = createDuplexBridgeBroker({
      channel: roomyHarness.channel,
      forwardRequest: controllableForward(roomyHarness),
      duplexAggregateByteLedger: roomyLedger,
    });
    brokers.push(roomyBroker);
    roomyBroker.start();
    roomyHarness.feed(requestFrame("req-1"));
    expect(roomyHarness.forwards.length).toBe(1);
  });

  it("releases every retained token on a terminal channel loss", async () => {
    const harness = createFakeChannelHarness();
    const ledger = new DuplexAggregateByteLedger({ ceilingBytes: 1_000_000 });
    const broker = createDuplexBridgeBroker({
      channel: harness.channel,
      forwardRequest: controllableForward(harness),
      duplexAggregateByteLedger: ledger,
    });
    brokers.push(broker);
    broker.start();

    harness.feed(requestFrame("req-1"));
    harness.feed(requestFrame("req-2"));
    expect(ledger.liveTokenCount).toBe(6);

    // The channel exits mid-flight. The broker latches the loss, transfers the
    // in-flight forwards to the orphan registry, and releases the seen-id tokens.
    harness.exit();
    expect(broker.runDisposition.failed).toBe(true);
    // The seen-id tokens released at loss; the two request tokens per forward stay
    // charged until each aborted forward settles.
    expect(ledger.liveTokenCount).toBe(4);

    // The aborted forwards settle. Each finally owner releases its two request
    // tokens, so the ledger returns to zero.
    harness.forwards[0]?.reject(new Error("aborted"));
    harness.forwards[1]?.reject(new Error("aborted"));
    await flush();
    expect(ledger.bytesInUse).toBe(0);
    expect(ledger.liveTokenCount).toBe(0);
  });

  it("does not double-release a token when a forward settles after the channel closed", async () => {
    const harness = createFakeChannelHarness();
    let underflow = 0;
    const ledger = new DuplexAggregateByteLedger({
      ceilingBytes: 1_000_000,
      telemetry: {
        setBytesInUse() {},
        recordReservationRejection() {},
        recordAccountingUnderflow() {
          underflow += 1;
        },
      },
    });
    const broker = createDuplexBridgeBroker({
      channel: harness.channel,
      forwardRequest: controllableForward(harness),
      duplexAggregateByteLedger: ledger,
    });
    brokers.push(broker);
    broker.start();

    harness.feed(requestFrame("req-1"));
    await broker.close();
    // The close aborted the in-flight forward and orphaned it. The forward now
    // settles after the close: its finally owner releases the request tokens once.
    harness.forwards[0]?.reject(new Error("aborted"));
    await flush();

    expect(ledger.bytesInUse).toBe(0);
    expect(ledger.liveTokenCount).toBe(0);
    // No accounting defect: every token released exactly one time.
    expect(underflow).toBe(0);
  });
});
