import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createPluginWorkerHandle } from "../services/plugin-worker-manager.js";

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
// forwards to the worker unchanged. The duplex channel is generic, so the
// command is a plain fixed string with no allowlist.
function duplexOpenInput(directive: unknown) {
  return {
    driverKey: "daytona",
    companyId: "company-1",
    environmentId: "env-1",
    providerLeaseId: JSON.stringify(directive),
    command: "bridge-callback",
  };
}

describe("plugin worker manager duplex channel route", () => {
  it("delivers data only for the exact bound worker session id and drops a mismatch", async () => {
    const handle = makeDuplexHandle();
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          workerSessionId: "ws-A",
          data: [
            { chunk: "good-1" },
            { chunk: "forged", sid: "ws-EVIL" },
            { chunk: "good-2" },
          ],
          exitCode: 0,
        }),
      );
      const chunks: string[] = [];
      session.onData((chunk) => chunks.push(chunk));
      await expect(session.wait()).resolves.toEqual({ exitCode: 0 });
      // The forged notification carries a wrong worker session id, so the host
      // drops it. Only the two bound chunks reach the listener, in order.
      expect(chunks).toEqual(["good-1", "good-2"]);
      await session.close();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("routes input to the worker and back to the listener", async () => {
    const handle = makeDuplexHandle();
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({ workerSessionId: "ws-A", echoInput: true }),
      );
      const chunks: string[] = [];
      session.onData((chunk) => chunks.push(chunk));
      session.write("callback-payload");
      // The worker echoes the input as one data notification for the bound
      // session, so the listener receives it.
      await vi.waitFor(() => expect(chunks).toContain("echo:callback-payload"));
      await session.close();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("buffers early data in order until a listener attaches and drains it in order", async () => {
    const handle = makeDuplexHandle();
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          data: [{ chunk: "one" }, { chunk: "two" }, { chunk: "three" }],
        }),
      );
      // Wait so the three data notifications arrive and buffer before a listener
      // attaches. The drain then delivers them in order.
      await new Promise((resolve) => setTimeout(resolve, 60));
      const chunks: string[] = [];
      session.onData((chunk) => chunks.push(chunk));
      await vi.waitFor(() => expect(chunks.length).toBe(3));
      expect(chunks).toEqual(["one", "two", "three"]);
      await session.close();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("isolates a throwing listener during live delivery so later chunks still route", async () => {
    const handle = makeDuplexHandle();
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          workerSessionId: "ws-A",
          data: [{ chunk: "ok-1" }, { chunk: "boom" }, { chunk: "ok-2" }],
          exitCode: 0,
        }),
      );
      const chunks: string[] = [];
      // The listener throws on one chunk. The manager catches the throw, so it
      // does not escape the worker stdout notification handler. The later chunk
      // still routes and the route still settles.
      session.onData((chunk) => {
        chunks.push(chunk);
        if (chunk === "boom") throw new Error("listener failure");
      });
      await expect(session.wait()).resolves.toEqual({ exitCode: 0 });
      expect(chunks).toEqual(["ok-1", "boom", "ok-2"]);
      await session.close();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("isolates a throwing listener during the buffered replay so every buffered chunk routes", async () => {
    const handle = makeDuplexHandle();
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          data: [{ chunk: "one" }, { chunk: "boom" }, { chunk: "three" }],
        }),
      );
      // Wait so the three data notifications arrive and buffer before a listener
      // attaches. The drain then delivers them in order.
      await new Promise((resolve) => setTimeout(resolve, 60));
      const chunks: string[] = [];
      // The listener throws on one buffered chunk. The manager catches the throw
      // inside the drain, so it does not escape `onData` and every buffered chunk
      // still routes.
      expect(() =>
        session.onData((chunk) => {
          chunks.push(chunk);
          if (chunk === "boom") throw new Error("listener failure");
        }),
      ).not.toThrow();
      expect(chunks).toEqual(["one", "boom", "three"]);
      await session.close();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("binds the worker session id one time and ignores a duplicate open reply", async () => {
    const handle = makeDuplexHandle();
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          mode: "duplicate-open-reply",
          workerSessionId: "ws-A",
          data: [{ chunk: "hello" }],
          exitCode: 0,
        }),
      );
      const chunks: string[] = [];
      session.onData((chunk) => chunks.push(chunk));
      // The duplicate open reply never rebinds or reopens the route, so the
      // session runs normally on the one bind.
      await expect(session.wait()).resolves.toEqual({ exitCode: 0 });
      expect(chunks).toEqual(["hello"]);
      await session.close();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("terminalizes and fails closed on a malformed open reply, then admits a later open", async () => {
    const handle = makeDuplexHandle();
    try {
      await handle.start();
      await expect(
        handle.openDuplexChannel(duplexOpenInput({ mode: "malformed-open" })),
      ).rejects.toThrow("DUPLEX_CHANNEL_OPEN_FAILED");
      // The terminalize closed the route by the host route id and the worker
      // acknowledged the close, so a later open is admitted.
      const session = await handle.openDuplexChannel(duplexOpenInput({ mode: "normal" }));
      expect(session).toBeDefined();
      await session.close();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("permits one active duplex channel per worker", async () => {
    const handle = makeDuplexHandle();
    try {
      await handle.start();
      const first = await handle.openDuplexChannel(duplexOpenInput({ mode: "normal" }));
      // A second open while the first route is not closed rejects with one fixed
      // non-secret error before it reaches the worker.
      await expect(
        handle.openDuplexChannel(duplexOpenInput({ mode: "normal" })),
      ).rejects.toThrow("DUPLEX_CHANNEL_ROUTE_BUSY");
      await first.close();
      // After the first route closes and the worker acknowledges the close, a new
      // open is admitted.
      const second = await handle.openDuplexChannel(duplexOpenInput({ mode: "normal" }));
      await second.close();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  // -------------------------------------------------------------------------
  // The five explicit bounds. Each bound ends the route when it is exceeded.
  // -------------------------------------------------------------------------

  it("ends the route when the pre-bind buffered bytes pass the bound", async () => {
    const handle = makeDuplexHandle({
      duplexChannelLimits: { maxPreBindBufferedChars: 10 },
    });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          data: [
            { chunk: "aaaaa" }, // total 5 → buffered
            { chunk: "bbbbb" }, // total 10 → buffered
            { chunk: "ccccc" }, // total 15 > 10 → end route
          ],
        }),
      );
      // No listener attaches, so the data buffers. The cumulative bytes pass the
      // bound and the route ends. The login wait resolves with a null exit code.
      await expect(session.wait()).resolves.toEqual({ exitCode: null });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("ends the route when the pre-bind buffered frame count passes the bound", async () => {
    const handle = makeDuplexHandle({
      duplexChannelLimits: { maxPreBindBufferedFrames: 2 },
    });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          data: [{ chunk: "a" }, { chunk: "b" }, { chunk: "c" }],
        }),
      );
      // No listener attaches, so the data buffers. The third frame passes the
      // frame-count bound and the route ends.
      await expect(session.wait()).resolves.toEqual({ exitCode: null });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("ends the route when the pending request count passes the bound", async () => {
    const handle = makeDuplexHandle({
      duplexChannelLimits: { maxPendingRequests: 2 },
    });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({ mode: "no-write-reply", workerSessionId: "ws-A" }),
      );
      const waitResult = session.wait();
      // The worker never replies to a write, so each write stays pending. The
      // third write passes the pending-request bound and the route ends.
      session.write("one");
      session.write("two");
      session.write("three");
      await expect(waitResult).resolves.toEqual({ exitCode: null });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("ends the route when one host-to-worker write passes the size bound", async () => {
    const handle = makeDuplexHandle({
      duplexChannelLimits: { maxWriteChars: 8 },
    });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({ workerSessionId: "ws-A" }),
      );
      const waitResult = session.wait();
      // One write is larger than the size bound, so the host rejects it and ends
      // the route before it reaches the worker.
      session.write("this-write-is-too-large");
      await expect(waitResult).resolves.toEqual({ exitCode: null });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("ends the route when the protocol error count passes the bound", async () => {
    const handle = makeDuplexHandle({
      duplexChannelLimits: { maxProtocolErrors: 2 },
    });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          workerSessionId: "ws-A",
          data: [
            { chunk: "e1", sid: "ws-EVIL" },
            { chunk: "e2", sid: "ws-EVIL" },
            { chunk: "e3", sid: "ws-EVIL" },
          ],
        }),
      );
      // Each mismatched-session data frame is a protocol error. The third frame
      // passes the error bound and the route ends.
      await expect(session.wait()).resolves.toEqual({ exitCode: null });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("ends the route when the total data bytes pass the cap for a bound listener", async () => {
    const handle = makeDuplexHandle({
      duplexChannelLimits: { maxTotalDataBytes: 10 },
    });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          workerSessionId: "ws-A",
          data: [
            { chunk: "aaaaa" }, // total 5 → deliver
            { chunk: "bbbbb" }, // total 10 → deliver
            { chunk: "ccccc" }, // total 15 > 10 → end route
          ],
        }),
      );
      const chunks: string[] = [];
      session.onData((chunk) => chunks.push(chunk));
      // A listener is bound, so the host forwards each chunk until the cumulative
      // bytes pass the cap. The third chunk passes the cap, so the host drops it
      // and ends the route. The listener never receives data past the cap.
      await expect(session.wait()).resolves.toEqual({ exitCode: null });
      expect(chunks).toEqual(["aaaaa", "bbbbb"]);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("counts inbound bytes, not characters, against the total cap", async () => {
    const handle = makeDuplexHandle({
      duplexChannelLimits: { maxTotalDataBytes: 4 },
    });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          workerSessionId: "ws-A",
          // "€" is one character but three bytes in UTF-8. The first chunk is 3
          // bytes (≤ 4), so the host delivers it. The second chunk brings the
          // total to 6 bytes (> 4), so the host ends the route. A character count
          // would admit both chunks (2 ≤ 4), so one delivered chunk proves the
          // host counts bytes.
          data: [{ chunk: "€" }, { chunk: "€" }],
        }),
      );
      const chunks: string[] = [];
      session.onData((chunk) => chunks.push(chunk));
      await expect(session.wait()).resolves.toEqual({ exitCode: null });
      expect(chunks).toEqual(["€"]);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("drains a buffered valid chunk to a listener that binds after the byte cap ends the route", async () => {
    const handle = makeDuplexHandle({
      duplexChannelLimits: { maxTotalDataBytes: 4 },
    });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          workerSessionId: "ws-A",
          // "€" is three bytes in UTF-8. The first chunk is 3 bytes (≤ 4), so the
          // host counts and buffers it. The second chunk brings the total to 6
          // bytes (> 4), so the host ends the route.
          data: [{ chunk: "€" }, { chunk: "€" }],
        }),
      );
      // Wait so both data frames arrive and the route ends on the byte cap before
      // a listener binds. The first chunk is a valid buffered frame. The host must
      // keep it, so the late listener drains it. This proves the host does not
      // drop a buffered valid chunk when the route ends before a listener binds.
      await expect(session.wait()).resolves.toEqual({ exitCode: null });
      const chunks: string[] = [];
      session.onData((chunk) => chunks.push(chunk));
      expect(chunks).toEqual(["€"]);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("ends the active route when the lifetime timer expires", async () => {
    const handle = makeDuplexHandle({
      duplexChannelLimits: { maxDurationMs: 100 },
    });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({ mode: "normal", workerSessionId: "ws-A" }),
      );
      const waitResult = session.wait();
      // The route sends no exit. The lifetime timer expires, so the host ends the
      // route and resolves the wait with the fixed null exit code.
      await expect(waitResult).resolves.toEqual({ exitCode: null });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("ends the route at once when one inbound chunk passes the per-chunk limit before a listener binds", async () => {
    const handle = makeDuplexHandle({
      duplexChannelLimits: { maxChunkChars: 4 },
    });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          workerSessionId: "ws-A",
          data: [{ chunk: "this-one-chunk-is-too-large" }],
        }),
      );
      // No listener attaches. One inbound chunk is larger than the per-chunk
      // limit, so the host ends the route at once. The default protocol-error
      // budget is far above one, so a single chunk that ends the route proves the
      // host does not treat it as a protocol error.
      await expect(session.wait()).resolves.toEqual({ exitCode: null });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("ends the route at once when one inbound chunk passes the per-chunk limit after a listener binds", async () => {
    const handle = makeDuplexHandle({
      duplexChannelLimits: { maxChunkChars: 4 },
    });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          workerSessionId: "ws-A",
          data: [{ chunk: "this-one-chunk-is-too-large" }],
        }),
      );
      const chunks: string[] = [];
      session.onData((chunk) => chunks.push(chunk));
      // A listener is bound. One inbound chunk is larger than the per-chunk
      // limit, so the host ends the route at once and never forwards the chunk.
      await expect(session.wait()).resolves.toEqual({ exitCode: null });
      expect(chunks).toEqual([]);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  // -------------------------------------------------------------------------
  // The open reply and a frame arrive in one read batch.
  // -------------------------------------------------------------------------

  it("holds and replays a data frame that arrives in the open-reply read batch", async () => {
    const handle = makeDuplexHandle();
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          // The worker writes the open reply and the data and exit frames in one
          // stdout write. The host reads them in one batch, so the data and exit
          // frames arrive before the route binds. The host must hold the frames
          // and replay them after the bind, not drop them.
          batchWithOpenReply: true,
          workerSessionId: "ws-A",
          data: [{ chunk: "batched-one" }, { chunk: "batched-two" }],
          exitCode: 0,
        }),
      );
      const chunks: string[] = [];
      session.onData((chunk) => chunks.push(chunk));
      await expect(session.wait()).resolves.toEqual({ exitCode: 0 });
      expect(chunks).toEqual(["batched-one", "batched-two"]);
      await session.close();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("ends the route when a batched frame passes the per-chunk limit before the bind", async () => {
    const handle = makeDuplexHandle({
      duplexChannelLimits: { maxChunkChars: 4 },
    });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          // The worker batches the data frame with the open reply, so the frame
          // arrives before the route binds. The replay after the bind applies the
          // per-chunk limit, so the one large chunk ends the route.
          batchWithOpenReply: true,
          workerSessionId: "ws-A",
          data: [{ chunk: "this-one-chunk-is-too-large" }],
        }),
      );
      await expect(session.wait()).resolves.toEqual({ exitCode: null });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("ends the route when batched pre-bind frames pass the frame count bound", async () => {
    const handle = makeDuplexHandle({
      duplexChannelLimits: { maxPreBindBufferedFrames: 2 },
    });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          // The worker batches the three data frames with the open reply, so all
          // three frames arrive before the route binds. No listener attaches, so
          // the replay buffers them. The third frame passes the frame-count bound
          // and the route ends. The pre-open hold must not drop the third frame
          // before the buffered bound can end the route.
          batchWithOpenReply: true,
          data: [{ chunk: "a" }, { chunk: "b" }, { chunk: "c" }],
        }),
      );
      await expect(session.wait()).resolves.toEqual({ exitCode: null });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("ends the route on the frame count bound even when a caller raises that bound well past the module default", async () => {
    // Regression test: the pre-open hold ceiling must track
    // maxDuplexChannelPreBindFrames, not a fixed value. A fixed ceiling at or
    // below this bound would drop the 13th frame in the hold before the replay
    // ever applies the buffered bound to it, and the route would never end.
    const handle = makeDuplexHandle({
      duplexChannelLimits: { maxPreBindBufferedFrames: 12 },
    });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          batchWithOpenReply: true,
          data: Array.from({ length: 13 }, (_, i) => ({ chunk: String(i) })),
        }),
      );
      await expect(session.wait()).resolves.toEqual({ exitCode: null });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("ends the route on the frame count bound even when an exit notification arrives before the overflow data frame", async () => {
    // Regression test: an exit notification must never share the pre-open hold's
    // capacity with data frames. The worker here batches exactly
    // maxPreBindBufferedFrames valid data frames (no violation), then its exit,
    // then one more data frame that should trip the buffered-frame bound. If the
    // exit consumed a hold slot, that last data frame would be dropped by the
    // hold before the replay ever applies the buffered bound to it, and the
    // route would end normally on the exit (exitCode: 0) instead of on the
    // bound (exitCode: null).
    const handle = makeDuplexHandle({
      duplexChannelLimits: { maxPreBindBufferedFrames: 3 },
    });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          batchWithOpenReply: true,
          data: [{ chunk: "a" }, { chunk: "b" }, { chunk: "c" }],
          exitCode: 0,
          dataAfterExit: [{ chunk: "overflow" }],
        }),
      );
      await expect(session.wait()).resolves.toEqual({ exitCode: null });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("delivers a batched pre-bind chunk that a later listener drains before the byte cap ends the route", async () => {
    const handle = makeDuplexHandle({
      duplexChannelLimits: { maxTotalDataBytes: 4 },
    });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          // The worker batches the two data frames with the open reply, so both
          // frames arrive before the route binds and before a listener attaches.
          // "€" is three bytes in UTF-8. The first chunk (3 bytes ≤ 4) buffers.
          // The second chunk brings the total to 6 bytes (> 4), so the route ends.
          // The route end must not discard the buffered first chunk. The listener
          // attaches after the open resolves and drains the first chunk.
          batchWithOpenReply: true,
          workerSessionId: "ws-A",
          data: [{ chunk: "€" }, { chunk: "€" }],
        }),
      );
      const chunks: string[] = [];
      session.onData((chunk) => chunks.push(chunk));
      await expect(session.wait()).resolves.toEqual({ exitCode: null });
      expect(chunks).toEqual(["€"]);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  // -------------------------------------------------------------------------
  // Authoritative closure and worker retirement.
  // -------------------------------------------------------------------------

  it("closes the route with a fixed exit when the worker exits", async () => {
    const handle = makeDuplexHandle();
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(duplexOpenInput({ mode: "normal" }));
      const waitResult = session.wait();
      await handle.stop();
      // A worker exit closes the one route and resolves the wait with the fixed
      // non-secret exit.
      await expect(waitResult).resolves.toEqual({ exitCode: null });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("retires the worker on an unconfirmed close acknowledgement", async () => {
    const handle = makeDuplexHandle({
      duplexChannelLimits: { closeTimeoutMs: 200 },
    });
    try {
      await handle.start();
      const exited = new Promise<void>((resolve) => {
        handle.on("exit", () => resolve());
      });
      const session = await handle.openDuplexChannel(
        duplexOpenInput({ mode: "normal", closeMode: "bad-ack" }),
      );
      await session.close();
      // The close acknowledgement carried a mismatched host route id, so the host
      // fails closed and retires the worker before any reuse.
      await exited;
      await expect(
        handle.openDuplexChannel(duplexOpenInput({ mode: "normal" })),
      ).rejects.toThrow();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });
});
