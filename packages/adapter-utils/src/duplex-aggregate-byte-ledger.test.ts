import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_AGGREGATE_DUPLEX_ROUTE_BYTES,
  DUPLEX_AGGREGATE_TOKEN_OWNERS,
  DUPLEX_CHANNEL_AGGREGATE_BYTES_EXCEEDED,
  DuplexAggregateByteLedger,
  MIN_HOST_PROCESS_MEMORY_BYTES_FOR_DUPLEX,
  assertDuplexAggregateCeilingBytes,
  resolveDuplexAggregateCeilingBytes,
  type DuplexAggregateByteLedgerTelemetry,
} from "./duplex-aggregate-byte-ledger.js";

// A telemetry surface that counts each fixed record, so a test asserts the exact
// gauge value and the exact counter counts.
function createCountingTelemetry(): DuplexAggregateByteLedgerTelemetry & {
  gauge: number;
  rejections: number;
  underflows: number;
} {
  const state = { gauge: 0, rejections: 0, underflows: 0 };
  return {
    ...state,
    setBytesInUse(bytes: number) {
      this.gauge = bytes;
    },
    recordReservationRejection() {
      this.rejections += 1;
    },
    recordAccountingUnderflow() {
      this.underflows += 1;
    },
  };
}

describe("DuplexAggregateByteLedger", () => {
  it("reserves under the ceiling and tracks the gauge and the live-token count", () => {
    const telemetry = createCountingTelemetry();
    const ledger = new DuplexAggregateByteLedger({ ceilingBytes: 1000, telemetry });

    const a = ledger.reserve("buffered_chunk", 400);
    const b = ledger.reserve("buffered_chunk", 500);

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(ledger.bytesInUse).toBe(900);
    expect(ledger.liveTokenCount).toBe(2);
    expect(telemetry.gauge).toBe(900);
    expect(a?.bytes).toBe(400);
    expect(a?.owner).toBe("buffered_chunk");
    expect(a?.state).toBe("held");
  });

  it("rejects a one-byte-over reservation, retains nothing, and increments the rejection counter", () => {
    const telemetry = createCountingTelemetry();
    const ledger = new DuplexAggregateByteLedger({ ceilingBytes: 1000, telemetry });

    ledger.reserve("buffered_chunk", 1000);
    const over = ledger.reserve("buffered_chunk", 1);

    expect(over).toBeNull();
    expect(ledger.bytesInUse).toBe(1000);
    expect(ledger.liveTokenCount).toBe(1);
    expect(telemetry.rejections).toBe(1);
    // The public rejection marker is the fixed string the caller reports.
    expect(DUPLEX_CHANNEL_AGGREGATE_BYTES_EXCEEDED).toBe("DUPLEX_CHANNEL_AGGREGATE_BYTES_EXCEEDED");
  });

  it("transfers ownership without a decrement or a re-reserve, so no admission gap opens", () => {
    const telemetry = createCountingTelemetry();
    const ledger = new DuplexAggregateByteLedger({ ceilingBytes: 100, telemetry });

    // Reserve the whole ceiling as a pre-bind event, then transfer to buffered.
    const token = ledger.reserve("pre_bind_event", 100);
    expect(token).not.toBeNull();
    // A second reservation cannot fit while the token stays held.
    expect(ledger.reserve("buffered_chunk", 1)).toBeNull();

    ledger.transfer(token!, "buffered_chunk");

    // The transfer changed only the owner. The gauge never moved, so no window
    // opened where the bytes were released and re-admitted.
    expect(ledger.bytesInUse).toBe(100);
    expect(ledger.liveTokenCount).toBe(1);
    expect(token?.owner).toBe("buffered_chunk");
    expect(telemetry.gauge).toBe(100);
    // No reservation fit during the transfer, so no rejection or underflow fired
    // beyond the one rejection above.
    expect(telemetry.rejections).toBe(1);
    expect(telemetry.underflows).toBe(0);
  });

  it("releases a token one time and decrements the gauge", () => {
    const telemetry = createCountingTelemetry();
    const ledger = new DuplexAggregateByteLedger({ ceilingBytes: 1000, telemetry });

    const token = ledger.reserve("response_body", 250);
    expect(token).not.toBeNull();
    ledger.release(token!);

    expect(ledger.bytesInUse).toBe(0);
    expect(ledger.liveTokenCount).toBe(0);
    expect(token?.state).toBe("released");
    expect(telemetry.gauge).toBe(0);
    expect(telemetry.underflows).toBe(0);
  });

  it("records the underflow counter on a second release and does not clamp the gauge again", () => {
    const telemetry = createCountingTelemetry();
    const ledger = new DuplexAggregateByteLedger({ ceilingBytes: 1000, telemetry });

    const kept = ledger.reserve("request_frame", 300);
    const doubled = ledger.reserve("request_frame", 200);
    expect(kept).not.toBeNull();
    expect(doubled).not.toBeNull();
    ledger.release(doubled!);
    expect(ledger.bytesInUse).toBe(300);

    // A forced second release of the same token is an accounting defect.
    ledger.release(doubled!);

    expect(telemetry.underflows).toBe(1);
    // The gauge did not drop a second time, so the defect stays visible.
    expect(ledger.bytesInUse).toBe(300);
    expect(ledger.liveTokenCount).toBe(1);
  });

  it("records the underflow counter on a transfer of a released token", () => {
    const telemetry = createCountingTelemetry();
    const ledger = new DuplexAggregateByteLedger({ ceilingBytes: 1000, telemetry });
    const token = ledger.reserve("pre_bind_event", 100);
    ledger.release(token!);

    ledger.transfer(token!, "buffered_chunk");

    expect(telemetry.underflows).toBe(1);
    expect(ledger.bytesInUse).toBe(0);
  });

  it("throws on a non-integer or negative reservation, so a programming error fails loud", () => {
    const ledger = new DuplexAggregateByteLedger({ ceilingBytes: 1000 });
    expect(() => ledger.reserve("buffered_chunk", -1)).toThrow();
    expect(() => ledger.reserve("buffered_chunk", 1.5)).toThrow();
    expect(() => ledger.reserve("buffered_chunk", Number.NaN)).toThrow();
  });

  it("admits a zero-byte reservation as a valid held token", () => {
    const ledger = new DuplexAggregateByteLedger({ ceilingBytes: 1000 });
    const token = ledger.reserve("seen_request_id", 0);
    expect(token).not.toBeNull();
    expect(token?.bytes).toBe(0);
    expect(ledger.liveTokenCount).toBe(1);
  });

  it("exposes the closed owner-label set", () => {
    expect([...DUPLEX_AGGREGATE_TOKEN_OWNERS]).toEqual([
      "pre_bind_event",
      "buffered_chunk",
      "terminal_buffered",
      "request_frame",
      "request_payload",
      "response_body",
      "seen_request_id",
      "decoder_buffer",
      "readiness_buffer",
      "readiness_replay",
      "http2_preface_scan",
      "http2_preface_replay",
      "pending_write",
      "stdin_write",
    ]);
  });
});

describe("aggregate ceiling configuration", () => {
  it("uses the default when the override is absent", () => {
    expect(resolveDuplexAggregateCeilingBytes()).toBe(DEFAULT_MAX_AGGREGATE_DUPLEX_ROUTE_BYTES);
    expect(resolveDuplexAggregateCeilingBytes(null)).toBe(DEFAULT_MAX_AGGREGATE_DUPLEX_ROUTE_BYTES);
    expect(DEFAULT_MAX_AGGREGATE_DUPLEX_ROUTE_BYTES).toBe(256 * 1024 * 1024);
  });

  it("accepts a valid positive override under the process allocation minus the reserve", () => {
    expect(resolveDuplexAggregateCeilingBytes(64 * 1024 * 1024)).toBe(64 * 1024 * 1024);
    const maxCeiling =
      MIN_HOST_PROCESS_MEMORY_BYTES_FOR_DUPLEX - DEFAULT_MAX_AGGREGATE_DUPLEX_ROUTE_BYTES;
    expect(resolveDuplexAggregateCeilingBytes(maxCeiling)).toBe(maxCeiling);
  });

  it("rejects an invalid override to the safe default and reports each rejection", () => {
    const overMaximum = MIN_HOST_PROCESS_MEMORY_BYTES_FOR_DUPLEX;
    const invalidOverrides = [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN, overMaximum];
    for (const invalid of invalidOverrides) {
      const rejected: number[] = [];
      // An invalid present override returns the safe default. It never throws, so a
      // single bad environment value never fails host startup.
      expect(resolveDuplexAggregateCeilingBytes(invalid, (value) => rejected.push(value))).toBe(
        DEFAULT_MAX_AGGREGATE_DUPLEX_ROUTE_BYTES,
      );
      // The resolver reports the rejection one time with the rejected numeric value.
      expect(rejected).toEqual([invalid]);
    }
  });

  it("does not report a rejection for a valid or a missing override", () => {
    const rejected: number[] = [];
    const reporter = (value: number): void => {
      rejected.push(value);
    };
    expect(resolveDuplexAggregateCeilingBytes(64 * 1024 * 1024, reporter)).toBe(64 * 1024 * 1024);
    expect(resolveDuplexAggregateCeilingBytes(undefined, reporter)).toBe(
      DEFAULT_MAX_AGGREGATE_DUPLEX_ROUTE_BYTES,
    );
    expect(resolveDuplexAggregateCeilingBytes(null, reporter)).toBe(
      DEFAULT_MAX_AGGREGATE_DUPLEX_ROUTE_BYTES,
    );
    expect(rejected).toEqual([]);
  });

  it("still throws for a direct ceiling assertion on an unsafe integer", () => {
    // The ledger constructor asserts its ceiling and must fail loud on a
    // programming error, so `assertDuplexAggregateCeilingBytes` keeps throwing.
    expect(() => assertDuplexAggregateCeilingBytes(Number.MAX_SAFE_INTEGER + 2)).toThrow();
  });
});
