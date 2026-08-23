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
import { createPluginWorkerHandle } from "../services/plugin-worker-manager.js";

// This suite proves the plugin worker manager charges every host→worker write raw
// payload against the injected aggregate byte ledger under the `pending_write`
// owner, and releases each token one time when the write RPC settles. The child
// reads its stdin here, so the separate `stdin_write` transport token flushes and
// releases at once. Each test waits for that flush, so the assertions isolate the
// raw-payload token. The transport token has its own suite.

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
  it("charges each held raw payload and returns to zero after worker exit", async () => {
    const telemetry = peakTrackingTelemetry();
    // The ceiling has ample room, so a transient transport reservation never
    // rejects. Each write holds its raw payload until the RPC settles.
    const ledger = new DuplexAggregateByteLedger({ ceilingBytes: 1 << 20, telemetry });
    const handle = makeDuplexHandle({ duplexAggregateByteLedger: ledger });
    const writeBytes = 1000;
    const writeData = "x".repeat(writeBytes);
    try {
      await handle.start();
      // The worker reads its stdin but never replies to a write, so each write RPC
      // stays pending and holds its raw payload.
      const route = await handle.openDuplexChannel(
        duplexOpenInput({ workerSessionId: "ws-a", mode: "no-write-reply" }),
      );
      route.write(writeData);
      route.write(writeData);
      route.write(writeData);
      // The worker reads its stdin, so each transport token flushes and releases.
      // Only the three held raw payloads remain, so the gauge settles at three
      // times the payload byte count with three live tokens.
      await vi.waitFor(() => {
        expect(ledger.liveTokenCount).toBe(3);
        expect(ledger.bytesInUse).toBe(3 * writeBytes);
      });
      expect(telemetry.peak).toBeLessThanOrEqual(ledger.ceilingBytes);
    } finally {
      await handle.stop().catch(() => undefined);
    }
    // The worker exit settles each pending write, so each token releases one time
    // and the ledger ends at zero with no accounting defect.
    await vi.waitFor(() => {
      expect(ledger.bytesInUse).toBe(0);
      expect(ledger.liveTokenCount).toBe(0);
    });
    expect(telemetry.underflows).toBe(0);
  });

  it("releases the raw-payload token after a delayed write RPC settles, with no worker exit", async () => {
    const telemetry = peakTrackingTelemetry();
    const ledger = new DuplexAggregateByteLedger({ ceilingBytes: 1 << 20, telemetry });
    const handle = makeDuplexHandle({ duplexAggregateByteLedger: ledger });
    try {
      await handle.start();
      // The worker reads its stdin and delays its write reply, so the host holds the
      // raw-payload reservation for a measurable time before the RPC settles.
      const route = await handle.openDuplexChannel(
        duplexOpenInput({ workerSessionId: "ws-d", writeReplyDelayMs: 150 }),
      );
      const writeBytes = 1000;
      route.write("x".repeat(writeBytes));
      // The transport token flushes at once, so one raw-payload token stays held for
      // the full write byte count while the RPC is in flight.
      await vi.waitFor(() => {
        expect(ledger.liveTokenCount).toBe(1);
        expect(ledger.bytesInUse).toBe(writeBytes);
      });
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

  it("reserves the exact UTF-8 byte count of the raw payload, not the character length", async () => {
    const telemetry = peakTrackingTelemetry();
    const ledger = new DuplexAggregateByteLedger({ ceilingBytes: 1 << 20, telemetry });
    const handle = makeDuplexHandle({ duplexAggregateByteLedger: ledger });
    try {
      await handle.start();
      const route = await handle.openDuplexChannel(
        duplexOpenInput({ workerSessionId: "ws-u", mode: "no-write-reply" }),
      );
      // "a€" is two characters but four UTF-8 bytes (one plus three). The raw-payload
      // reservation must charge four bytes, so it uses the UTF-8 byte count.
      const data = "a€";
      expect(data.length).toBe(2);
      expect(Buffer.byteLength(data, "utf8")).toBe(4);
      route.write(data);
      // The transport token flushes, so one raw-payload token of four bytes remains.
      await vi.waitFor(() => {
        expect(ledger.liveTokenCount).toBe(1);
        expect(ledger.bytesInUse).toBe(4);
      });
    } finally {
      await handle.stop().catch(() => undefined);
    }
    await vi.waitFor(() => {
      expect(ledger.bytesInUse).toBe(0);
      expect(ledger.liveTokenCount).toBe(0);
    });
    expect(telemetry.underflows).toBe(0);
  });

  it("ends an over-ceiling single write fail-closed with the aggregate marker, not the route-busy marker", async () => {
    vi.mocked(logger.warn).mockClear();
    const telemetry = peakTrackingTelemetry();
    // The ceiling is smaller than one raw payload, so the raw-payload reservation
    // fails before the frame reaches the transport. The manager retains nothing.
    const ledger = new DuplexAggregateByteLedger({ ceilingBytes: 100, telemetry });
    const handle = makeDuplexHandle({ duplexAggregateByteLedger: ledger });
    try {
      await handle.start();
      const route = await handle.openDuplexChannel(
        duplexOpenInput({ workerSessionId: "ws-o", mode: "no-write-reply" }),
      );
      // The single write is larger than the ceiling. The raw-payload reservation
      // fails, so the manager ends the route with the aggregate marker, never the
      // route-busy marker, and never writes the frame.
      route.write("x".repeat(200));
      expect(telemetry.rejections).toBeGreaterThanOrEqual(1);
      expect(ledger.bytesInUse).toBe(0);
      expect(telemetry.peak).toBeLessThanOrEqual(ledger.ceilingBytes);
      const reasons = loggedWarnReasons();
      expect(reasons).toContain(DUPLEX_CHANNEL_AGGREGATE_BYTES_EXCEEDED);
      expect(reasons).not.toContain("DUPLEX_CHANNEL_ROUTE_BUSY");
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
