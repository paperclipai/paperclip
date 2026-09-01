import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  createDuplexRouteSlotController,
  createPluginWorkerHandle,
} from "../services/plugin-worker-manager.js";

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
function duplexOpenInput(directive: unknown, companyId = "company-1") {
  return {
    driverKey: "daytona",
    companyId,
    environmentId: "env-1",
    providerLeaseId: JSON.stringify(directive),
    command: "bridge-callback",
  };
}

describe("plugin worker manager duplex channel route", () => {
  it("fails closed and retires the worker on a forged worker session id", async () => {
    const handle = makeDuplexHandle();
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          workerSessionId: "ws-A",
          // The frame carries the bound host route id but a forged worker session
          // id, so its pair matches no live route.
          data: [{ chunk: "forged", sid: "ws-EVIL" }],
        }),
      );
      const chunks: string[] = [];
      // The session streams raw `Uint8Array` chunks. Decode each one back to
      // text, so the assertion below compares the plain-text payload the
      // fixture directive scripted.
      session.onData((chunk) => chunks.push(new TextDecoder().decode(chunk)));
      // The forged pair is an ownership violation. The host reaches no listener and
      // retires the worker, so the wait settles with the fixed non-secret null exit.
      await expect(session.wait()).resolves.toEqual({ exitCode: null });
      expect(chunks).toEqual([]);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("fails closed and retires the worker on a forged host route id", async () => {
    const handle = makeDuplexHandle();
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          workerSessionId: "ws-A",
          // The frame carries the bound worker session id but a forged host route
          // id, so its pair matches no live route.
          data: [{ chunk: "forged", rid: "duplex-route-forged" }],
        }),
      );
      const chunks: string[] = [];
      // The session streams raw `Uint8Array` chunks. Decode each one back to
      // text, so the assertion below compares the plain-text payload the
      // fixture directive scripted.
      session.onData((chunk) => chunks.push(new TextDecoder().decode(chunk)));
      await expect(session.wait()).resolves.toEqual({ exitCode: null });
      expect(chunks).toEqual([]);
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
      // The session streams raw `Uint8Array` chunks. Decode each one back to
      // text, so the assertion below compares the plain-text payload the
      // fixture directive scripted.
      session.onData((chunk) => chunks.push(new TextDecoder().decode(chunk)));
      session.write(new TextEncoder().encode("callback-payload"));
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
      // The session streams raw `Uint8Array` chunks. Decode each one back to
      // text, so the assertion below compares the plain-text payload the
      // fixture directive scripted.
      session.onData((chunk) => chunks.push(new TextDecoder().decode(chunk)));
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
        const text = new TextDecoder().decode(chunk);
        chunks.push(text);
        if (text === "boom") throw new Error("listener failure");
      });
      await expect(session.wait()).resolves.toEqual({ exitCode: 0 });
      expect(chunks).toEqual(["ok-1", "boom", "ok-2"]);
      await session.close();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("carries a transport-close exit through to the wait result", async () => {
    const handle = makeDuplexHandle();
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          // Batch the exit with the open response to exercise the pre-bind hold
          // and prove its normalized representation retains the discriminator.
          batchWithOpenReply: true,
          workerSessionId: "ws-A",
          data: [{ chunk: "one" }],
          // The worker reports a reason-less transport close with no exit code.
          transportClosed: true,
        }),
      );
      const chunks: string[] = [];
      // The session streams raw `Uint8Array` chunks. Decode each one back to
      // text, so the assertion below compares the plain-text payload the
      // fixture directive scripted.
      session.onData((chunk) => chunks.push(new TextDecoder().decode(chunk)));
      // The discriminator survives the worker exit notification, so the host wait
      // resolves with the transport-close mark and no exit code.
      await expect(session.wait()).resolves.toEqual({ exitCode: null, transportClosed: true });
      expect(chunks).toEqual(["one"]);
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
          const text = new TextDecoder().decode(chunk);
          chunks.push(text);
          if (text === "boom") throw new Error("listener failure");
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
      // The session streams raw `Uint8Array` chunks. Decode each one back to
      // text, so the assertion below compares the plain-text payload the
      // fixture directive scripted.
      session.onData((chunk) => chunks.push(new TextDecoder().decode(chunk)));
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

  it("routes two concurrent cross-company duplex routes by the exact pair with no cross-talk", async () => {
    const handle = makeDuplexHandle();
    try {
      await handle.start();
      const routeA = await handle.openDuplexChannel(
        duplexOpenInput({ workerSessionId: "ws-A", data: [{ chunk: "a-1" }], exitCode: 0 }, "company-A"),
      );
      const routeB = await handle.openDuplexChannel(
        duplexOpenInput({ workerSessionId: "ws-B", data: [{ chunk: "b-1" }], exitCode: 0 }, "company-B"),
      );
      const aChunks: string[] = [];
      const bChunks: string[] = [];
      routeA.onData((chunk) => aChunks.push(new TextDecoder().decode(chunk)));
      routeB.onData((chunk) => bChunks.push(new TextDecoder().decode(chunk)));
      await expect(routeA.wait()).resolves.toEqual({ exitCode: 0 });
      await expect(routeB.wait()).resolves.toEqual({ exitCode: 0 });
      // The host routes each frame by the exact pair, so each route receives only
      // its own data. Neither route sees the other's chunk.
      expect(aChunks).toEqual(["a-1"]);
      expect(bChunks).toEqual(["b-1"]);
      await routeA.close();
      await routeB.close();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("reports an explicit route-busy result when the aggregate ceiling is full", async () => {
    // A process-scoped ceiling of one slot. The manager injects one shared
    // controller into every worker; the test injects a small one directly.
    const handle = makeDuplexHandle({ duplexRouteSlots: createDuplexRouteSlotController(1) });
    try {
      await handle.start();
      const first = await handle.openDuplexChannel(duplexOpenInput({ workerSessionId: "ws-A" }));
      // The ceiling is full, so the second open rejects with the fixed route-busy
      // error before it reaches the worker. An active channel never downgrades.
      await expect(
        handle.openDuplexChannel(duplexOpenInput({ workerSessionId: "ws-B" })),
      ).rejects.toThrow("DUPLEX_CHANNEL_ROUTE_BUSY");
      // Closing the first route releases its slot, so a later open is admitted.
      await first.close();
      const third = await handle.openDuplexChannel(duplexOpenInput({ workerSessionId: "ws-C" }));
      await third.close();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("drops a late frame for a tombstoned pair and keeps the worker for a new open", async () => {
    const handle = makeDuplexHandle();
    try {
      await handle.start();
      const first = await handle.openDuplexChannel(
        duplexOpenInput({ workerSessionId: "ws-A", emitAfterCloseChunk: "after-close" }),
      );
      const chunks: string[] = [];
      first.onData((chunk) => chunks.push(new TextDecoder().decode(chunk)));
      // Close the route. The host installs the tombstone atomically before the slot
      // frees. The worker then emits one late frame for the closed pair.
      await first.close();
      // Give the late frame time to arrive. The host drops it, so it reaches no
      // listener and does not retire the worker.
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(chunks).toEqual([]);
      // The worker is still alive: a new open on the same worker succeeds and
      // delivers its own data.
      const second = await handle.openDuplexChannel(
        duplexOpenInput({ workerSessionId: "ws-B", data: [{ chunk: "b-1" }], exitCode: 0 }),
      );
      const secondChunks: string[] = [];
      second.onData((chunk) => secondChunks.push(new TextDecoder().decode(chunk)));
      await expect(second.wait()).resolves.toEqual({ exitCode: 0 });
      expect(secondChunks).toEqual(["b-1"]);
      await second.close();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  // -------------------------------------------------------------------------
  // The five explicit bounds. Each bound ends the route when it is exceeded.
  // -------------------------------------------------------------------------

  it("ends the route when the post-bind buffered bytes pass the bound", async () => {
    const handle = makeDuplexHandle({
      duplexChannelLimits: { maxPreBindBufferedChars: 10 },
    });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({
          // Hold these frames until the fixture acknowledges a host write. A
          // write can only come from the returned session, so this makes the
          // post-bind path deterministic instead of depending on pipe batching.
          emitScriptedFramesAfterFirstWrite: true,
          data: [
            { chunk: "aaaaa" }, // total 5 → buffered
            { chunk: "bbbbb" }, // total 10 → buffered
            { chunk: "ccccc" }, // total 15 > 10 → end route
          ],
        }),
      );
      session.write(new TextEncoder().encode("emit"));
      // No listener attaches, so the post-bind data buffers. The cumulative bytes
      // pass the bound and the route ends. The channel wait resolves with a null
      // exit code.
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
      session.write(new TextEncoder().encode("one"));
      session.write(new TextEncoder().encode("two"));
      session.write(new TextEncoder().encode("three"));
      await expect(waitResult).resolves.toEqual({ exitCode: null });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("ends the route when the pending host-to-worker write bytes pass the route bound", async () => {
    const handle = makeDuplexHandle({
      duplexChannelLimits: { maxPendingWriteBytes: 10 },
    });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({ mode: "no-write-reply", workerSessionId: "ws-A" }),
      );
      const waitResult = session.wait();
      // The worker never replies to a write, so each write's bytes stay charged
      // against the route. The second write brings the cumulative bytes past
      // the 10-byte bound and ends the route.
      session.write(new TextEncoder().encode("aaaaa")); // 5 bytes → 5, under the bound
      session.write(new TextEncoder().encode("bbbbbb")); // 6 bytes → 11 > 10, ends the route
      await expect(waitResult).resolves.toEqual({ exitCode: null });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("returns the pending write bytes to the route bound after a failed write", async () => {
    const handle = makeDuplexHandle({
      duplexChannelLimits: { maxPendingWriteBytes: 10, openTimeoutMs: 100 },
    });
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({ mode: "no-write-reply", workerSessionId: "ws-A" }),
      );
      let routeEnded = false;
      session.wait().then(() => {
        routeEnded = true;
      });
      // The worker never replies, so each write's own request times out and
      // rejects. The rejection must release this write's charged bytes, the
      // same as a reply would. Wait past the first write's timeout before the
      // second write sends.
      session.write(new TextEncoder().encode("12345678")); // 8 bytes, under the 10-byte bound
      await new Promise((resolve) => setTimeout(resolve, 200));
      // If the first write's bytes had not released on its timeout, this
      // second 8-byte write would bring the route to 16 bytes, past the
      // 10-byte bound, and end the route at once, synchronously, in this call.
      session.write(new TextEncoder().encode("87654321"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(routeEnded).toBe(false);
      await session.close();
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
      session.write(new TextEncoder().encode("this-write-is-too-large"));
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
      // The session streams raw `Uint8Array` chunks. Decode each one back to
      // text, so the assertion below compares the plain-text payload the
      // fixture directive scripted.
      session.onData((chunk) => chunks.push(new TextDecoder().decode(chunk)));
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
      // The session streams raw `Uint8Array` chunks. Decode each one back to
      // text, so the assertion below compares the plain-text payload the
      // fixture directive scripted.
      session.onData((chunk) => chunks.push(new TextDecoder().decode(chunk)));
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
      // The session streams raw `Uint8Array` chunks. Decode each one back to
      // text, so the assertion below compares the plain-text payload the
      // fixture directive scripted.
      session.onData((chunk) => chunks.push(new TextDecoder().decode(chunk)));
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
      // The session streams raw `Uint8Array` chunks. Decode each one back to
      // text, so the assertion below compares the plain-text payload the
      // fixture directive scripted.
      session.onData((chunk) => chunks.push(new TextDecoder().decode(chunk)));
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
      // The session streams raw `Uint8Array` chunks. Decode each one back to
      // text, so the assertion below compares the plain-text payload the
      // fixture directive scripted.
      session.onData((chunk) => chunks.push(new TextDecoder().decode(chunk)));
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

  it("ends the route when the pre-bind hold bytes pass the route input bound", async () => {
    const handle = makeDuplexHandle({
      duplexChannelLimits: { maxPreBindBufferedChars: 10 },
    });
    try {
      await handle.start();
      // The worker batches the three data frames with the open reply, so all
      // three frames arrive before the route binds and land in the pre-bind
      // hold, not the post-bind buffered queue. The frame-count bound stays
      // far above three frames, so only the byte bound can end the route
      // here: this proves the hold itself counts bytes, not only frames. The
      // hold ends the route before the bind completes, so the open call
      // itself fails, the same way a malformed open reply fails it.
      await expect(
        handle.openDuplexChannel(
          duplexOpenInput({
            batchWithOpenReply: true,
            data: [
              { chunk: "aaaaa" }, // total 5 → held
              { chunk: "bbbbb" }, // total 10 → held
              { chunk: "ccccc" }, // total 15 > 10 → end the route in the hold
            ],
          }),
        ),
      ).rejects.toThrow("DUPLEX_CHANNEL_OPEN_FAILED");
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
      // The session streams raw `Uint8Array` chunks. Decode each one back to
      // text, so the assertion below compares the plain-text payload the
      // fixture directive scripted.
      session.onData((chunk) => chunks.push(new TextDecoder().decode(chunk)));
      await expect(session.wait()).resolves.toEqual({ exitCode: null });
      expect(chunks).toEqual(["€"]);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  // -------------------------------------------------------------------------
  // Byte fidelity across the worker remote-procedure-call hop.
  // -------------------------------------------------------------------------

  it("test_worker_channel_preserves_all_byte_values", async () => {
    const handle = makeDuplexHandle();
    try {
      await handle.start();
      const session = await handle.openDuplexChannel(
        duplexOpenInput({ workerSessionId: "ws-A", echoInput: true }),
      );
      const allByteValues = Uint8Array.from({ length: 256 }, (_, value) => value);
      const received: Uint8Array[] = [];
      session.onData((chunk) => received.push(chunk));

      session.write(allByteValues);

      // The fixture echoes the write as one data notification, prefixed with the
      // five ASCII bytes "echo:". It builds the echo on the decoded byte buffer,
      // not a string, so the round trip through the base64 JSON-RPC wire form
      // (`ChannelBytesWireValue`) carries every one of the 256 byte values
      // unchanged, including the byte value zero, which a UTF-8 string hop would
      // not preserve reliably end to end.
      await vi.waitFor(() => expect(received.length).toBe(1));
      const echoPrefix = new TextEncoder().encode("echo:");
      const echoed = received[0]!;
      expect(echoed.byteLength).toBe(echoPrefix.byteLength + allByteValues.byteLength);
      expect(echoed.subarray(0, echoPrefix.byteLength)).toEqual(echoPrefix);
      expect(echoed.subarray(echoPrefix.byteLength)).toEqual(allByteValues);
      await session.close();
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
