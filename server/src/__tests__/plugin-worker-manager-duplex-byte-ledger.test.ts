import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  DuplexAggregateByteLedger,
  type DuplexAggregateByteLedgerTelemetry,
} from "@paperclipai/adapter-utils/duplex-aggregate-byte-ledger";
import {
  createDuplexRouteSlotController,
  createPluginWorkerHandle,
} from "../services/plugin-worker-manager.js";

// This suite proves the plugin worker manager charges every retained duplex route
// representation against the injected aggregate byte ledger, and releases each
// token exactly once through the one cleanup path. The tests drive a real worker
// fixture process, so they exercise the true frame order across the bind boundary.

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

// A counting telemetry surface. It records how many times the ledger rejected a
// reservation and how many accounting defects it saw, so a test asserts a
// fail-closed rejection and proves the cleanup never double-releases.
function countingTelemetry(): DuplexAggregateByteLedgerTelemetry & {
  rejections: number;
  underflows: number;
} {
  const state = {
    rejections: 0,
    underflows: 0,
    setBytesInUse() {},
    recordReservationRejection() {
      state.rejections += 1;
    },
    recordAccountingUnderflow() {
      state.underflows += 1;
    },
  };
  return state;
}

describe("plugin worker manager duplex aggregate byte ledger", () => {
  it("keeps terminalized buffered bytes charged until a late listener drains them, then a worker exit is harmless", async () => {
    const telemetry = countingTelemetry();
    const ledger = new DuplexAggregateByteLedger({ ceilingBytes: 1 << 20, telemetry });
    // Lower the per-chunk char bound, so the second chunk ends the route while the
    // first chunk stays buffered.
    const handle = makeDuplexHandle({
      duplexAggregateByteLedger: ledger,
      duplexChannelLimits: { maxChunkChars: 4 },
    });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        // No listener attaches, so "ok" buffers and charges its two raw bytes. The
        // "toolong" chunk passes the per-chunk bound, so the route terminalizes and
        // moves the still-buffered "ok" token to the terminal registry.
        duplexOpenInput({ data: [{ chunk: "ok" }, { chunk: "toolong" }] }),
      );
      // The buffered "ok" stays charged after the route leaves the live map.
      await vi.waitFor(() => {
        expect(ledger.bytesInUse).toBe(2);
        expect(ledger.liveTokenCount).toBe(1);
      });
      // A late listener drains the terminal buffered record and releases its token.
      const chunks: string[] = [];
      session.onData((chunk) => chunks.push(chunk));
      await vi.waitFor(() => {
        expect(chunks).toEqual(["ok"]);
        expect(ledger.bytesInUse).toBe(0);
        expect(ledger.liveTokenCount).toBe(0);
      });
      // The over-bound chunk retained nothing, so no reservation ever rejected.
      expect(telemetry.rejections).toBe(0);
    } finally {
      await handle.stop().catch(() => undefined);
    }
    // The worker exit sweep runs on stop. The ledger stays at zero, and the sweep
    // records no accounting defect, so the drain and the exit never double-release.
    expect(ledger.bytesInUse).toBe(0);
    expect(ledger.liveTokenCount).toBe(0);
    expect(telemetry.underflows).toBe(0);
  });

  it("transfers pre-bind held bytes to the buffered representation across the bind, then releases them on drain", async () => {
    const telemetry = countingTelemetry();
    const ledger = new DuplexAggregateByteLedger({ ceilingBytes: 1 << 20, telemetry });
    const handle = makeDuplexHandle({ duplexAggregateByteLedger: ledger });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        // The worker writes the open reply and the two data frames in one stdout
        // write, so both frames arrive before the route binds. The host holds them
        // as pre-bind events, then the bind replays and transfers each token to the
        // buffered representation.
        duplexOpenInput({ batchWithOpenReply: true, data: [{ chunk: "aa" }, { chunk: "bb" }] }),
      );
      // The two held events keep their exact reserved bytes across the transfer, so
      // the live-token count never grows and the gauge never re-admits.
      await vi.waitFor(() => {
        expect(ledger.bytesInUse).toBe(4);
        expect(ledger.liveTokenCount).toBe(2);
      });
      const chunks: string[] = [];
      session.onData((chunk) => chunks.push(chunk));
      await vi.waitFor(() => {
        expect(chunks).toEqual(["aa", "bb"]);
        expect(ledger.bytesInUse).toBe(0);
        expect(ledger.liveTokenCount).toBe(0);
      });
    } finally {
      await handle.stop().catch(() => undefined);
    }
    expect(ledger.bytesInUse).toBe(0);
    expect(telemetry.underflows).toBe(0);
  });

  it("fails closed and retains nothing when a buffered reservation would pass the ceiling", async () => {
    const telemetry = countingTelemetry();
    // A four-byte ceiling. One five-byte chunk cannot fit.
    const ledger = new DuplexAggregateByteLedger({ ceilingBytes: 4, telemetry });
    const handle = makeDuplexHandle({ duplexAggregateByteLedger: ledger });
    try {
      await handle.start();
      await handle.openDuplexChannel(
        // No listener attaches, so "hello" tries to buffer. Its five raw bytes pass
        // the four-byte ceiling, so the reservation rejects and the route ends.
        duplexOpenInput({ data: [{ chunk: "hello" }] }),
      );
      await vi.waitFor(() => {
        expect(telemetry.rejections).toBeGreaterThanOrEqual(1);
        expect(ledger.bytesInUse).toBe(0);
        expect(ledger.liveTokenCount).toBe(0);
      });
    } finally {
      await handle.stop().catch(() => undefined);
    }
    expect(ledger.bytesInUse).toBe(0);
    expect(ledger.liveTokenCount).toBe(0);
    expect(telemetry.underflows).toBe(0);
  });
});

// A telemetry surface that also tracks the peak gauge value. A test asserts the
// peak never passes the ceiling, so it proves aggregate admission stops at the
// ceiling instead of overshooting it.
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

// The exact raw byte count of one buffered chunk each route retains.
const LOAD_CHUNK_BYTES = 8;
const LOAD_CHUNK = "x".repeat(LOAD_CHUNK_BYTES);

describe("plugin worker manager duplex aggregate byte ledger load across workers", () => {
  it("stops aggregate byte admission at the ceiling across many routes and workers while the route-count controller stays open", async () => {
    const telemetry = peakTrackingTelemetry();
    // The ceiling holds exactly six eight-byte buffered chunks.
    const fittingRoutes = 6;
    const ceilingBytes = fittingRoutes * LOAD_CHUNK_BYTES;
    const ledger = new DuplexAggregateByteLedger({ ceilingBytes, telemetry });
    // The route-count controller has ample room, so the byte ledger binds first.
    const routeSlots = createDuplexRouteSlotController(100);
    const handleCount = 3;
    const routesPerHandle = 3;
    const totalRoutes = handleCount * routesPerHandle;
    const rejectedRoutes = totalRoutes - fittingRoutes;
    const handles: Array<ReturnType<typeof makeDuplexHandle>> = [];
    try {
      for (let h = 0; h < handleCount; h += 1) {
        const handle = makeDuplexHandle({
          duplexAggregateByteLedger: ledger,
          duplexRouteSlots: routeSlots,
        });
        await handle.start();
        handles.push(handle);
      }
      // Open every route in order. Each worker batches one data chunk with the open
      // reply, so the host holds the chunk as a pre-bind event and reserves its exact
      // raw bytes before the route binds. No listener attaches, so a bound route holds
      // the chunk. The first six chunks fit the ceiling. Each later reservation passes
      // the ceiling, so the ledger rejects it and the route fails closed with the open
      // marker (not the route-busy marker), because the route-count controller has room.
      let opened = 0;
      let failedClosed = 0;
      for (let h = 0; h < handleCount; h += 1) {
        for (let r = 0; r < routesPerHandle; r += 1) {
          try {
            await handles[h].openDuplexChannel(
              duplexOpenInput({
                workerSessionId: `ws-${h}-${r}`,
                batchWithOpenReply: true,
                data: [{ chunk: LOAD_CHUNK }],
              }),
            );
            opened += 1;
          } catch (err) {
            // A byte-ceiling rejection fails the route closed with the open marker.
            // The route-count controller had room, so this is never the route-busy
            // marker.
            expect(String(err)).toContain("DUPLEX_CHANNEL_OPEN_FAILED");
            expect(String(err)).not.toContain("DUPLEX_CHANNEL_ROUTE_BUSY");
            failedClosed += 1;
          }
        }
      }
      // Six routes bound and hold their bytes; three failed closed at the ceiling.
      expect(opened).toBe(fittingRoutes);
      expect(failedClosed).toBe(rejectedRoutes);
      expect(opened + failedClosed).toBe(totalRoutes);
      // The aggregate gauge holds at the ceiling and the ledger recorded one rejection
      // per over-ceiling route.
      await vi.waitFor(() => {
        expect(telemetry.rejections).toBe(rejectedRoutes);
        expect(ledger.bytesInUse).toBe(ceilingBytes);
        expect(ledger.liveTokenCount).toBe(fittingRoutes);
      });
      // The gauge never passed the ceiling, so admission stopped at the ceiling and
      // never overshot it.
      expect(telemetry.peak).toBe(ceilingBytes);
    } finally {
      for (const handle of handles) await handle.stop().catch(() => undefined);
    }
    // Every worker exit sweep released its buffered tokens once, so the ledger ends
    // at zero with no accounting defect.
    expect(ledger.bytesInUse).toBe(0);
    expect(ledger.liveTokenCount).toBe(0);
    expect(telemetry.underflows).toBe(0);
  });

  it("still bounds the route count for fixed per-route overhead when the byte ceiling has ample room", async () => {
    const telemetry = peakTrackingTelemetry();
    // A large byte ceiling, so retained bytes never bind admission.
    const ledger = new DuplexAggregateByteLedger({ ceilingBytes: 1 << 20, telemetry });
    // The route-count controller holds two slots for the whole process.
    const routeSlots = createDuplexRouteSlotController(2);
    const handleA = makeDuplexHandle({
      duplexAggregateByteLedger: ledger,
      duplexRouteSlots: routeSlots,
    });
    const handleB = makeDuplexHandle({
      duplexAggregateByteLedger: ledger,
      duplexRouteSlots: routeSlots,
    });
    let opened = 0;
    let busy = 0;
    try {
      await handleA.start();
      await handleB.start();
      // Attempt four routes across the two workers. The shared controller admits the
      // first two and rejects the last two with the fixed route-busy error.
      const attempts: Array<[ReturnType<typeof makeDuplexHandle>, string]> = [
        [handleA, "ws-a1"],
        [handleA, "ws-a2"],
        [handleB, "ws-b1"],
        [handleB, "ws-b2"],
      ];
      for (const [handle, ws] of attempts) {
        try {
          await handle.openDuplexChannel(
            duplexOpenInput({ workerSessionId: ws, data: [{ chunk: "aa" }] }),
          );
          opened += 1;
        } catch (err) {
          expect(String(err)).toContain("DUPLEX_CHANNEL_ROUTE_BUSY");
          busy += 1;
        }
      }
      // The route-count controller admitted two routes and rejected the rest, so it
      // still bounds the fixed per-route overhead on its own.
      expect(opened).toBe(2);
      expect(busy).toBe(2);
      // The two open routes buffered four raw bytes, far under the byte ceiling, and
      // the byte ledger rejected nothing.
      await vi.waitFor(() => {
        expect(ledger.bytesInUse).toBe(4);
        expect(ledger.liveTokenCount).toBe(2);
      });
      expect(telemetry.rejections).toBe(0);
    } finally {
      await handleA.stop().catch(() => undefined);
      await handleB.stop().catch(() => undefined);
    }
    expect(ledger.bytesInUse).toBe(0);
    expect(telemetry.underflows).toBe(0);
  });
});
