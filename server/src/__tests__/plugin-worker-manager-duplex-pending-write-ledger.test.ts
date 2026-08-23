import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  DUPLEX_CHANNEL_AGGREGATE_BYTES_EXCEEDED,
  DuplexAggregateByteLedger,
  type DuplexAggregateByteLedgerTelemetry,
} from "@paperclipai/adapter-utils/duplex-aggregate-byte-ledger";

// Mock the shared logger, so a test reads the fixed rejection marker the manager
// logs when a pending-write reservation fails. The child logger returns the same
// object, so `log.warn` is this mock's `warn`.
vi.mock("../middleware/logger.js", () => {
  const mockLogger: Record<string, unknown> = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => mockLogger),
  };
  return { logger: mockLogger, httpLogger: vi.fn() };
});

import { logger } from "../middleware/logger.js";
import {
  createDuplexRouteSlotController,
  createPluginWorkerHandle,
} from "../services/plugin-worker-manager.js";

// This suite proves the plugin worker manager charges every host→worker pending
// write against the injected aggregate byte ledger, and releases each token one
// time when the write RPC settles. The tests drive a real worker fixture process,
// so they exercise the true enqueue and settlement order.

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const DUPLEX_CHANNEL_WORKER_ENTRYPOINT = path.join(
  FIXTURES_DIR,
  "plugin-worker-duplex-channel.cjs",
);

const TEST_MANIFEST: PaperclipPluginManifestV1 = {
  id: "test.plugin",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Test plugin",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [],
  entrypoints: { worker: "dist/worker.js" },
};

function makeDuplexHandle(extra?: Record<string, unknown>) {
  return createPluginWorkerHandle("test.plugin", {
    entrypointPath: DUPLEX_CHANNEL_WORKER_ENTRYPOINT,
    manifest: TEST_MANIFEST,
    config: {},
    instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
    apiVersion: 1,
    hostHandlers: {},
    ...extra,
  });
}

// The test directive rides in `providerLeaseId`, an opaque field the manager
// forwards to the worker unchanged.
function duplexOpenInput(directive: unknown, companyId = "company-1") {
  return {
    driverKey: "daytona",
    companyId,
    environmentId: "env-1",
    providerLeaseId: JSON.stringify(directive),
    command: "bridge-callback",
  };
}

// A telemetry surface that tracks the peak gauge value and the two counters. A
// test asserts the peak never passes the ceiling, so it proves aggregate admission
// stops at the ceiling instead of overshooting it.
function peakTrackingTelemetry(): DuplexAggregateByteLedgerTelemetry & {
  gauge: number;
  peak: number;
  rejections: number;
  underflows: number;
} {
  const state = {
    gauge: 0,
    peak: 0,
    rejections: 0,
    underflows: 0,
    setBytesInUse(bytes: number) {
      state.gauge = bytes;
      if (bytes > state.peak) state.peak = bytes;
    },
    recordReservationRejection() {
      state.rejections += 1;
    },
    recordAccountingUnderflow() {
      state.underflows += 1;
    },
  };
  return state;
}

// Return every reason string the manager logged through the mock `warn` sink.
function loggedWarnReasons(): string[] {
  const calls = (logger.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return calls
    .map((call) => {
      const first = call[0];
      return first && typeof first === "object"
        ? (first as { reason?: unknown }).reason
        : undefined;
    })
    .filter((reason): reason is string => typeof reason === "string");
}

describe("plugin worker manager duplex pending-write byte ledger", () => {
  it("charges each held host→worker write, ends an over-ceiling write with the aggregate marker, and returns to zero after worker exit", async () => {
    vi.mocked(logger.warn).mockClear();
    const telemetry = peakTrackingTelemetry();
    // Each write reserves eight bytes. The ceiling holds exactly three writes.
    const writeBytes = 8;
    const writeData = "x".repeat(writeBytes);
    const ledger = new DuplexAggregateByteLedger({ ceilingBytes: 3 * writeBytes, telemetry });
    // The route-count controller has ample room, so the byte ledger binds first and
    // a rejection is never the route-busy marker.
    const routeSlots = createDuplexRouteSlotController(100);
    const handleA = makeDuplexHandle({
      duplexAggregateByteLedger: ledger,
      duplexRouteSlots: routeSlots,
    });
    const handleB = makeDuplexHandle({
      duplexAggregateByteLedger: ledger,
      duplexRouteSlots: routeSlots,
    });
    try {
      await handleA.start();
      await handleB.start();
      // Two routes on two workers. Neither worker replies to a write, so each write
      // RPC stays pending and holds its reserved bytes.
      const routeA = await handleA.openDuplexChannel(
        duplexOpenInput({ workerSessionId: "ws-a", mode: "no-write-reply" }),
      );
      const routeB = await handleB.openDuplexChannel(
        duplexOpenInput({ workerSessionId: "ws-b", mode: "no-write-reply" }),
      );
      // Three held writes fill the ceiling. The reserve runs synchronously in
      // `write`, so the gauge reflects each write at once.
      routeA.write(writeData);
      routeA.write(writeData);
      routeB.write(writeData);
      expect(ledger.bytesInUse).toBe(3 * writeBytes);
      expect(ledger.liveTokenCount).toBe(3);
      expect(telemetry.peak).toBe(3 * writeBytes);

      // One more write passes the ceiling. The reservation fails, the manager
      // retains nothing, and it ends the route fail-closed with the aggregate
      // marker. The three held writes stay charged, because route terminalization
      // never releases a pending-write token.
      routeB.write(writeData);
      expect(telemetry.rejections).toBe(1);
      expect(ledger.bytesInUse).toBe(3 * writeBytes);
      expect(telemetry.peak).toBe(3 * writeBytes);
      const reasons = loggedWarnReasons();
      expect(reasons).toContain(DUPLEX_CHANNEL_AGGREGATE_BYTES_EXCEEDED);
      expect(reasons).not.toContain("DUPLEX_CHANNEL_ROUTE_BUSY");
    } finally {
      await handleA.stop().catch(() => undefined);
      await handleB.stop().catch(() => undefined);
    }
    // Every worker exit settles its pending writes, so each token releases one time
    // and the ledger ends at zero with no accounting defect.
    await vi.waitFor(() => {
      expect(ledger.bytesInUse).toBe(0);
      expect(ledger.liveTokenCount).toBe(0);
    });
    expect(telemetry.underflows).toBe(0);
  });

  it("releases the pending-write token after a delayed write RPC settles, with no worker exit", async () => {
    const telemetry = peakTrackingTelemetry();
    const ledger = new DuplexAggregateByteLedger({ ceilingBytes: 1 << 20, telemetry });
    const handle = makeDuplexHandle({ duplexAggregateByteLedger: ledger });
    try {
      await handle.start();
      // The worker delays its write reply, so the host holds the reservation for a
      // measurable time before the RPC settles.
      const route = await handle.openDuplexChannel(
        duplexOpenInput({ workerSessionId: "ws-d", writeReplyDelayMs: 100 }),
      );
      const writeBytes = 8;
      route.write("x".repeat(writeBytes));
      // The reserve runs synchronously, so the gauge holds the reserved bytes while
      // the RPC is in flight.
      expect(ledger.bytesInUse).toBe(writeBytes);
      expect(ledger.liveTokenCount).toBe(1);
      // The delayed reply settles the RPC, and the `finally` releases the token.
      await vi.waitFor(() => {
        expect(ledger.bytesInUse).toBe(0);
        expect(ledger.liveTokenCount).toBe(0);
      });
    } finally {
      await handle.stop().catch(() => undefined);
    }
    expect(ledger.bytesInUse).toBe(0);
    expect(telemetry.underflows).toBe(0);
  });

  it("reserves the exact UTF-8 byte count of a write, not the character length", async () => {
    const telemetry = peakTrackingTelemetry();
    const ledger = new DuplexAggregateByteLedger({ ceilingBytes: 1 << 20, telemetry });
    const handle = makeDuplexHandle({ duplexAggregateByteLedger: ledger });
    try {
      await handle.start();
      const route = await handle.openDuplexChannel(
        duplexOpenInput({ workerSessionId: "ws-u", mode: "no-write-reply" }),
      );
      // "a€" is two characters but four UTF-8 bytes (one plus three). The reserve
      // must charge four bytes, so it uses the UTF-8 byte count, not the length.
      const data = "a€";
      expect(data.length).toBe(2);
      expect(Buffer.byteLength(data, "utf8")).toBe(4);
      route.write(data);
      expect(ledger.bytesInUse).toBe(4);
      expect(ledger.liveTokenCount).toBe(1);
    } finally {
      await handle.stop().catch(() => undefined);
    }
    await vi.waitFor(() => {
      expect(ledger.bytesInUse).toBe(0);
      expect(ledger.liveTokenCount).toBe(0);
    });
    expect(telemetry.underflows).toBe(0);
  });
});
