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
// logs when a transport reservation fails. The child logger returns the same
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

// This suite proves the plugin worker manager charges the child-stdin transport
// buffer for every host→worker duplex write, under the `stdin_write` owner. The
// worker completes the open, then stops reading its stdin. The host write then
// stays in the host stdin write buffer. The tests prove the reservation covers the
// serialized frame, holds until the flush or the worker exit, survives the write
// RPC timeout and the route terminalization, and bounds the aggregate transport
// bytes across several routes and workers.

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

// A frame the host keeps in its stdin write buffer must pass the operating-system
// pipe buffer (about 64 KiB), so the write callback stays pending while the child
// does not read. Each write here is larger than that, so the host holds the
// transport token until the worker exit.
const HELD_WRITE_CHARS = 200_000;

describe("plugin worker manager duplex stdin transport byte ledger", () => {
  it("reserves the encoded serialized-frame size, larger than the raw payload, including the base64 wire inflation", async () => {
    const telemetry = peakTrackingTelemetry();
    const ledger = new DuplexAggregateByteLedger({ ceilingBytes: 8 << 20, telemetry });
    const handle = makeDuplexHandle({ duplexAggregateByteLedger: ledger });
    try {
      await handle.start();
      const route = await handle.openDuplexChannel(
        duplexOpenInput({
          workerSessionId: "ws-a",
          stopReadingStdinAfterOpen: true,
          exitAfterStopMs: 500,
        }),
      );
      // The JSON-RPC hop carries the write payload as a base64 string, because JSON
      // has no binary type (see `ChannelBytesWireValue` in protocol.ts). Base64
      // encodes three raw bytes as four characters, so the serialized frame is
      // larger than the raw payload by about that ratio, plus the small fixed cost
      // of the surrounding JSON envelope (the method name and the route identifiers).
      const rawBytes = 50_000;
      const data = new Uint8Array(rawBytes).fill(0x22); // an arbitrary byte value
      const encodedLength = Buffer.from(data).toString("base64").length;
      route.write(data);
      // The raw-payload token and the transport token both hold at once. The worker
      // does not read its stdin, so the transport token never flushes.
      expect(ledger.liveTokenCount).toBe(2);
      const transportBytes = ledger.bytesInUse - rawBytes;
      // The transport reservation covers the serialized frame: at least the base64
      // form of the raw payload, plus a bounded JSON envelope around it.
      expect(transportBytes).toBeGreaterThan(rawBytes);
      expect(transportBytes).toBeGreaterThanOrEqual(encodedLength);
      expect(transportBytes).toBeLessThan(encodedLength + 5_000);
    } finally {
      await handle.stop().catch(() => undefined);
    }
    // The worker exit discards the stdin buffer, so every token releases one time.
    await vi.waitFor(() => {
      expect(ledger.bytesInUse).toBe(0);
      expect(ledger.liveTokenCount).toBe(0);
    });
    expect(telemetry.underflows).toBe(0);
  });

  it("holds the transport token across a write-RPC timeout and releases it on worker exit", async () => {
    const telemetry = peakTrackingTelemetry();
    const ledger = new DuplexAggregateByteLedger({ ceilingBytes: 8 << 20, telemetry });
    // The write RPC times out fast; the worker exits later. The gap lets a test
    // prove the timeout does not release the transport token.
    const handle = makeDuplexHandle({
      duplexAggregateByteLedger: ledger,
      duplexChannelLimits: { openTimeoutMs: 150 },
    });
    try {
      await handle.start();
      const route = await handle.openDuplexChannel(
        duplexOpenInput({
          workerSessionId: "ws-t",
          stopReadingStdinAfterOpen: true,
          exitAfterStopMs: 900,
        }),
      );
      const data = "x".repeat(HELD_WRITE_CHARS);
      const rawBytes = Buffer.byteLength(data, "utf8");
      route.write(new TextEncoder().encode(data));
      // Both tokens hold at first: the raw payload and the serialized frame.
      expect(ledger.liveTokenCount).toBe(2);
      const transportBytes = ledger.bytesInUse - rawBytes;
      expect(transportBytes).toBeGreaterThan(0);
      // The write RPC times out. The RPC settle releases the raw-payload token, so
      // one token remains: the transport token. The timeout never releases it.
      await vi.waitFor(() => {
        expect(ledger.liveTokenCount).toBe(1);
      });
      expect(ledger.bytesInUse).toBe(transportBytes);
    } finally {
      await handle.stop().catch(() => undefined);
    }
    // The worker exit releases the still-held transport token.
    await vi.waitFor(() => {
      expect(ledger.bytesInUse).toBe(0);
      expect(ledger.liveTokenCount).toBe(0);
    });
    expect(telemetry.underflows).toBe(0);
  });

  it("does not release the transport token when the route terminalizes", async () => {
    const telemetry = peakTrackingTelemetry();
    const ledger = new DuplexAggregateByteLedger({ ceilingBytes: 8 << 20, telemetry });
    const handle = makeDuplexHandle({ duplexAggregateByteLedger: ledger });
    try {
      await handle.start();
      const route = await handle.openDuplexChannel(
        duplexOpenInput({
          workerSessionId: "ws-c",
          stopReadingStdinAfterOpen: true,
          exitAfterStopMs: 700,
        }),
      );
      const data = "x".repeat(HELD_WRITE_CHARS);
      const rawBytes = Buffer.byteLength(data, "utf8");
      route.write(new TextEncoder().encode(data));
      expect(ledger.liveTokenCount).toBe(2);
      const transportBytes = ledger.bytesInUse - rawBytes;
      // End the route. Route terminalization releases the route-owned tokens, but it
      // must never release the transport token, so at least the serialized frame
      // stays charged.
      void route.close();
      expect(ledger.bytesInUse).toBeGreaterThanOrEqual(transportBytes);
    } finally {
      await handle.stop().catch(() => undefined);
    }
    await vi.waitFor(() => {
      expect(ledger.bytesInUse).toBe(0);
      expect(ledger.liveTokenCount).toBe(0);
    });
    expect(telemetry.underflows).toBe(0);
  });

  it("bounds the aggregate transport bytes across several routes and workers, ending an over-ceiling near-limit write with the aggregate marker", async () => {
    vi.mocked(logger.warn).mockClear();
    const telemetry = peakTrackingTelemetry();
    // The ceiling admits only a couple of held serialized frames, so a near-limit
    // write across the routes passes it and rejects.
    const ceilingBytes = 600_000;
    const ledger = new DuplexAggregateByteLedger({ ceilingBytes, telemetry });
    const handleA = makeDuplexHandle({ duplexAggregateByteLedger: ledger });
    const handleB = makeDuplexHandle({ duplexAggregateByteLedger: ledger });
    try {
      await handleA.start();
      await handleB.start();
      const routeA = await handleA.openDuplexChannel(
        duplexOpenInput({
          workerSessionId: "ws-a",
          stopReadingStdinAfterOpen: true,
          exitAfterStopMs: 900,
        }),
      );
      const routeB = await handleB.openDuplexChannel(
        duplexOpenInput({
          workerSessionId: "ws-b",
          stopReadingStdinAfterOpen: true,
          exitAfterStopMs: 900,
        }),
      );
      // Each write is near the per-write size. The JSON-RPC hop carries it as
      // base64, so the reservation must count the encoded (larger) wire size, not
      // the raw payload size.
      const nearLimit = new Uint8Array(100_000).fill(0x22);
      const routes = [routeA, routeB, routeA, routeB];
      for (const route of routes) {
        route.write(nearLimit);
        // The aggregate bytes never pass the ceiling. Admission stops at the ceiling.
        expect(ledger.bytesInUse).toBeLessThanOrEqual(ceilingBytes);
      }
      // At least one near-limit write passed the ceiling and rejected. The manager
      // ended that route with the aggregate marker, never the route-busy marker.
      expect(telemetry.rejections).toBeGreaterThanOrEqual(1);
      expect(telemetry.peak).toBeLessThanOrEqual(ceilingBytes);
      const reasons = loggedWarnReasons();
      expect(reasons).toContain(DUPLEX_CHANNEL_AGGREGATE_BYTES_EXCEEDED);
      expect(reasons).not.toContain("DUPLEX_CHANNEL_ROUTE_BUSY");
    } finally {
      await handleA.stop().catch(() => undefined);
      await handleB.stop().catch(() => undefined);
    }
    // Every worker exit releases its held transport tokens, so the ledger ends at
    // zero with no accounting defect.
    await vi.waitFor(() => {
      expect(ledger.bytesInUse).toBe(0);
      expect(ledger.liveTokenCount).toBe(0);
    });
    expect(telemetry.underflows).toBe(0);
  });
});
