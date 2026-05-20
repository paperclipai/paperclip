import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, get as httpGet, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Response } from "express";

import { sseRegistry } from "../services/sse-registry.js";
import { logShutdownSignal, writeShutdownBreadcrumb } from "../shutdown-log.js";

interface FakeRes extends EventEmitter {
  _written: string[];
  _ended: boolean;
  writable: boolean;
  write: (chunk: string) => boolean;
  end: () => void;
}

function fakeRes(): FakeRes {
  const emitter = new EventEmitter() as FakeRes;
  emitter._written = [];
  emitter._ended = false;
  emitter.writable = true;
  emitter.write = (chunk: string) => {
    emitter._written.push(chunk);
    return true;
  };
  emitter.end = () => {
    emitter._ended = true;
    emitter.writable = false;
    // Model real Node: 'finish' fires once the underlying socket flushes the
    // queued bytes. The default fake assumes a healthy socket — tests that
    // want to simulate a wedged socket override end() to skip the emit.
    setImmediate(() => emitter.emit("finish"));
  };
  return emitter;
}

describe("sseRegistry", () => {
  beforeEach(async () => {
    // Drain any leftover state between tests
    await sseRegistry.drain({ timeoutMs: 50, reason: "test:reset" });
  });

  it("register adds, unregister removes", () => {
    const r1 = fakeRes();
    const r2 = fakeRes();
    expect(sseRegistry.size()).toBe(0);

    sseRegistry.register(r1 as unknown as Response);
    expect(sseRegistry.size()).toBe(1);

    sseRegistry.register(r2 as unknown as Response);
    expect(sseRegistry.size()).toBe(2);

    sseRegistry.unregister(r1 as unknown as Response);
    expect(sseRegistry.size()).toBe(1);

    sseRegistry.unregister(r2 as unknown as Response);
    expect(sseRegistry.size()).toBe(0);
  });

  it("drain emits final shutdown event and calls res.end() on each tracked response", async () => {
    const r1 = fakeRes();
    const r2 = fakeRes();
    sseRegistry.register(r1 as unknown as Response);
    sseRegistry.register(r2 as unknown as Response);

    await sseRegistry.drain({ timeoutMs: 1000, reason: "shutdown:SIGTERM" });

    for (const r of [r1, r2]) {
      expect(r._ended).toBe(true);
      expect(r.writable).toBe(false);
      // Expect exactly one write containing the shutdown event frame
      expect(r._written.length).toBe(1);
      const frame = r._written[0];
      expect(frame).toContain("event: shutdown\n");
      expect(frame).toContain("data: ");
      // Payload should include the reason and a ts ISO timestamp
      const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
      expect(dataLine).toBeDefined();
      const payload = JSON.parse(dataLine!.slice("data: ".length));
      expect(payload.reason).toBe("shutdown:SIGTERM");
      expect(typeof payload.ts).toBe("string");
      expect(() => new Date(payload.ts)).not.toThrow();
    }

    expect(sseRegistry.size()).toBe(0);
  });

  it("drain enforces the timeout when a response wedges", async () => {
    // A wedged response: writable stays true forever and end() does nothing
    const wedged = fakeRes();
    wedged.end = () => {
      // Simulates an end() that never actually closes — writable remains true
    };
    sseRegistry.register(wedged as unknown as Response);

    const start = Date.now();
    await sseRegistry.drain({ timeoutMs: 50, reason: "shutdown:test" });
    const elapsed = Date.now() - start;

    // Should not block forever — bounded by timeout (with reasonable upper bound)
    expect(elapsed).toBeLessThan(500);
    // Final clear should remove the wedged entry
    expect(sseRegistry.size()).toBe(0);
  });

  it("drain waits for the socket 'finish' event, not just res.writable flipping", async () => {
    // Real-Node semantics: res.end() flips res.writable=false synchronously, but the
    // underlying socket may still be flushing the buffered shutdown frame. drain()
    // must await the 'finish' event so the bytes are guaranteed on the wire before
    // the caller (the SIGTERM handler) proceeds to process.exit(0).
    //
    // The buggy implementation polled res.writable and resolved as soon as it
    // flipped — well before the socket flush completed. process.exit then raced
    // with libuv's pending write and the shutdown frame was lost on the wire.
    const slow = new EventEmitter() as FakeRes;
    slow._written = [];
    slow._ended = false;
    slow.writable = true;
    slow.write = (chunk: string) => {
      slow._written.push(chunk);
      return true;
    };
    slow.end = () => {
      slow._ended = true;
      slow.writable = false; // mimics Node: flips synchronously on .end()
      // 'finish' fires later, after the kernel actually accepts the bytes
      setTimeout(() => slow.emit("finish"), 100);
    };

    sseRegistry.register(slow as unknown as Response);

    let drainResolved = false;
    const drainPromise = sseRegistry
      .drain({ timeoutMs: 1000, reason: "shutdown:SIGTERM" })
      .then(() => {
        drainResolved = true;
      });

    // 40ms in — long enough for the buggy implementation (~10ms polling) to have
    // already resolved, but well before the 100ms-delayed 'finish' event.
    await new Promise((r) => setTimeout(r, 40));
    expect(drainResolved).toBe(false);

    await drainPromise;
    expect(drainResolved).toBe(true);
    expect(slow._ended).toBe(true);
    expect(sseRegistry.size()).toBe(0);
  });

  it(
    "end-to-end: drain delivers shutdown frame to a real SSE client AND unblocks server.close()",
    async () => {
      // This test models the production shutdown sequence end-to-end:
      //   1. boot a real http.Server, register the SSE response in sseRegistry
      //      from inside the request handler (mirrors routes/plugins.ts)
      //   2. open a real HTTP client connection and read it as a stream
      //   3. invoke sseRegistry.drain — must emit the shutdown frame on the wire
      //   4. invoke server.close — must resolve promptly (no SSE keep-alive
      //      deadlock) now that the drain has ended() the response
      //
      // Regression coverage for BLO-4137: the old ordering (server.close before
      // drain) would deadlock here because http.Server.close keeps existing
      // connections open until they end themselves — and a registered SSE
      // never ends on its own.
      const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(":ok\n\n");
        sseRegistry.register(res as unknown as Response);
        res.on("close", () => sseRegistry.unregister(res as unknown as Response));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;

      const received: string[] = [];
      let clientEnded = false;
      const clientReq = httpGet(`http://127.0.0.1:${port}/`, (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk) => received.push(chunk as string));
        res.on("end", () => {
          clientEnded = true;
        });
      });

      // Wait until the SSE is registered AND the client has the :ok heartbeat
      const heartbeatDeadline = Date.now() + 2000;
      while (
        (sseRegistry.size() === 0 || !received.some((c) => c.includes(":ok"))) &&
        Date.now() < heartbeatDeadline
      ) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(sseRegistry.size()).toBe(1);
      expect(received.some((c) => c.includes(":ok"))).toBe(true);

      // Drain — must emit shutdown frame and end the response.
      await sseRegistry.drain({ timeoutMs: 5000, reason: "shutdown:SIGTERM" });

      // Client should have received the shutdown frame (the FIN that follows
      // res.end() triggers the client's 'end'; give libuv a tick to flush).
      const drainDeadline = Date.now() + 1000;
      while (
        !received.join("").includes("event: shutdown") &&
        Date.now() < drainDeadline
      ) {
        await new Promise((r) => setTimeout(r, 10));
      }
      const body = received.join("");
      expect(body).toContain("event: shutdown\n");
      expect(body).toContain('"reason":"shutdown:SIGTERM"');

      // server.close() must resolve promptly — with the SSE drained there are
      // no long-lived connections holding the callback. If we ever regress
      // and put server.close before drain, this would hang forever.
      const closeStart = Date.now();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("server.close did not resolve within 2s — SSE drain failed to release the connection")),
          2000,
        );
        server.close((err) => {
          clearTimeout(timer);
          if (err) reject(err);
          else resolve();
        });
      });
      expect(Date.now() - closeStart).toBeLessThan(1000);

      // Tidy up the client; it's fine if it's already ended.
      clientReq.destroy();
      // Give the 'end' handler a tick if it hasn't fired yet (the FIN sent by
      // res.end() should have driven it before this point).
      if (!clientEnded) {
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    10_000,
  );
});

describe("logShutdownSignal", () => {
  // Capture process.stderr.write while the test runs. We can't replace pino
  // (and don't want to), but stderr.write is the only path that's guaranteed
  // synchronous on Linux when stdio is piped to kubelet — that's the whole
  // point of this module.
  let captured: string[];
  let originalWrite: typeof process.stderr.write;

  beforeEach(() => {
    captured = [];
    originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      const s = typeof chunk === "string" ? chunk : (chunk as Buffer).toString();
      captured.push(s);
      // Don't actually forward to stderr — the test output stays clean.
      // Returning true is correct for non-flushed writes.
      const cb = rest.find((arg) => typeof arg === "function") as
        | ((err?: Error) => void)
        | undefined;
      if (cb) cb();
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
  });

  it("writes a single line containing the signal name to process.stderr", () => {
    logShutdownSignal("SIGTERM");
    expect(captured.length).toBeGreaterThan(0);
    const joined = captured.join("");
    expect(joined).toContain("SIGTERM");
    // The line is a meaningful breadcrumb — must mention shutdown.
    expect(joined.toLowerCase()).toContain("shutdown");
    // And it must end with a newline so it's a complete log line, not a
    // partial that some downstream reader could fail to flush.
    expect(joined.endsWith("\n")).toBe(true);
  });

  it("writes synchronously — the line is in stderr BEFORE the function returns", () => {
    // This is the load-bearing guarantee. pino's async transport drops logs
    // on process.exit; this module must not. Calling write must produce a
    // captured entry before the next synchronous statement runs — no
    // setImmediate / setTimeout / await tricks allowed in the implementation.
    expect(captured).toHaveLength(0);
    logShutdownSignal("SIGINT");
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain("SIGINT");
  });

  it("escapes nothing — signal name appears verbatim", () => {
    logShutdownSignal("SIGTERM");
    // Easy regression: if someone wraps in JSON.stringify or adds quoting
    // later, the kubectl logs grep `Shutdown signal received | grep SIGTERM`
    // recipe in BLO-4137 stops matching.
    expect(captured[0]).toMatch(/(^|[\s\W])SIGTERM([\s\W]|$)/);
  });
});

describe("writeShutdownBreadcrumb", () => {
  // Same capture pattern as logShutdownSignal — these helpers share the same
  // synchronous-stderr load-bearing guarantee. See that describe block above
  // for the rationale.
  let captured: string[];
  let originalWrite: typeof process.stderr.write;

  beforeEach(() => {
    captured = [];
    originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      const s = typeof chunk === "string" ? chunk : (chunk as Buffer).toString();
      captured.push(s);
      const cb = rest.find((arg) => typeof arg === "function") as
        | ((err?: Error) => void)
        | undefined;
      if (cb) cb();
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
  });

  it("prefixes every line with [shutdown] and a trailing newline", () => {
    writeShutdownBreadcrumb("stopping embedded PostgreSQL (signal=SIGTERM)");
    expect(captured.length).toBe(1);
    const line = captured[0];
    expect(line.startsWith("[shutdown] ")).toBe(true);
    expect(line.endsWith("\n")).toBe(true);
    expect(line).toContain("stopping embedded PostgreSQL");
    expect(line).toContain("SIGTERM");
  });

  it("writes synchronously — captured BEFORE the function returns", () => {
    // The load-bearing guarantee: each call must produce a stderr entry
    // before the next synchronous statement runs. The trailing shutdown log
    // lines exist precisely because pino's async transport drops late lines
    // on process.exit; if this helper acquired async semantics it would
    // re-introduce the gap.
    expect(captured).toHaveLength(0);
    writeShutdownBreadcrumb("step one");
    expect(captured).toHaveLength(1);
    writeShutdownBreadcrumb("step two");
    expect(captured).toHaveLength(2);
    expect(captured[0]).toContain("step one");
    expect(captured[1]).toContain("step two");
  });

  it("logShutdownSignal shares the [shutdown] prefix so one grep recipe captures both", () => {
    // The BLO-4137 verification flow greps `kubectl logs … | grep '^\[shutdown\]'`
    // to enumerate the breadcrumbs the handler emitted. Keep both helpers
    // funneling through the same prefix so that recipe doesn't grow special
    // cases over time.
    logShutdownSignal("SIGTERM");
    writeShutdownBreadcrumb("handler complete; exiting (signal=SIGTERM)");
    expect(captured.length).toBe(2);
    expect(captured.every((line) => line.startsWith("[shutdown] "))).toBe(true);
  });

  it("does not escape — message payload appears verbatim for kubectl grep", () => {
    // If someone wraps in JSON.stringify later, recipes like
    //   `grep -F 'sseRegistry.drain failed'`
    // stop matching. Pin verbatim semantics.
    writeShutdownBreadcrumb("sseRegistry.drain failed: ECONNRESET");
    expect(captured[0]).toContain("sseRegistry.drain failed: ECONNRESET");
    expect(captured[0]).not.toContain('"');
  });
});
