import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { afterEach, describe, expect, it } from "vitest";

import {
  authorizeSandboxCallbackBridgeRequestWithRoutes,
  getSandboxCallbackBridgeServerSource,
  SANDBOX_CALLBACK_BRIDGE_DUPLEX_MODE,
} from "./sandbox-callback-bridge.js";
import {
  DuplexFrameDecoder,
  DUPLEX_BODY_CHUNK_RAW_BYTES,
  DUPLEX_FRAME_VERSION,
  encodeDuplexFrame,
  type DuplexFrame,
  type DuplexReadyFrame,
  type DuplexRequestFrame,
} from "./duplex-frame-codec.js";
import {
  createDuplexBridgeBroker,
  type DuplexBridgeBroker,
  type DuplexBrokerForwardResult,
} from "./duplex-bridge-broker.js";
import type { ReassembledBody } from "./duplex-body-spool.js";
import type { CommandManagedDuplexChannel } from "./command-managed-runtime.js";

/**
 * Local real-process end-to-end harness for the composed duplex path.
 *
 * The harness spawns the real generated gateway with plain `node` from a
 * temporary file, attaches the real host broker to the child stdin and stdout,
 * and forwards each request to a local fake API server on a real HTTP call. It
 * uses no provider credentials.
 *
 * The child stdio pipes are kernel pipes. They give partial reads, split a
 * multi-byte UTF-8 sequence across two chunks, apply backpressure, and give a
 * true end of file when the child dies. The harness proves the composed path
 * handles each of these real conditions.
 */

/** One recorded call the fake API server received. */
interface FakeApiRequest {
  method: string;
  url: string;
  auth: string | null;
  runId: string | null;
  body: string;
}

/** The responder the fake API server calls for each request. */
type FakeApiResponder = (req: IncomingMessage, res: ServerResponse, body: string) => void;

/** The handle for one fake API server. */
interface FakeApiServer {
  origin: string;
  requests: FakeApiRequest[];
  setResponder: (responder: FakeApiResponder) => void;
  /** The count of sockets the server holds open right now. */
  openSocketCount: () => number;
  /** True while the server still accepts connections. */
  listening: () => boolean;
  close: () => Promise<void>;
}

/**
 * Start a local fake API server. The forward handler targets it, so one real
 * HTTP call proves the composed path end to end. The server tracks each open
 * socket, so a test asserts teardown leaves no open socket handle.
 */
async function startFakeApiServer(): Promise<FakeApiServer> {
  const requests: FakeApiRequest[] = [];
  const sockets = new Set<net.Socket>();
  let responder: FakeApiResponder = (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: url.pathname }));
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        auth: req.headers.authorization ?? null,
        runId:
          typeof req.headers["x-paperclip-run-id"] === "string"
            ? req.headers["x-paperclip-run-id"]
            : null,
        body,
      });
      responder(req, res, body);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("The fake API server did not expose a TCP port.");
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    setResponder: (next) => {
      responder = next;
    },
    openSocketCount: () => sockets.size,
    listening: () => server.listening,
    close: () =>
      new Promise<void>((resolve) => {
        // Destroy each open socket first. A keep-alive client socket keeps the
        // server open, so `server.close` alone could stall. The destroy makes the
        // close callback fire and drives the open socket count to zero.
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** The channel view over the spawned child, plus the frames the child sent host-ward. */
interface ChildDuplexChannel {
  channel: CommandManagedDuplexChannel;
  observedFrames: DuplexFrame[];
  stderr: () => string;
}

/**
 * Wrap the spawned child as a {@link CommandManagedDuplexChannel}. The broker
 * writes to the child stdin, reads the child stdout, and learns of the child
 * exit through this channel.
 *
 * The host end reads a byte stream from the stdout pipe. A pipe read can split
 * one multi-byte UTF-8 character across two chunks. The `StringDecoder` holds
 * the bytes of an incomplete character until the next chunk, so the broker only
 * ever reads whole characters. The channel keeps a second decoder for
 * observation only; it lets the harness assert the READY frame and the request
 * frames the child produced, and it never feeds the broker.
 */
function attachChildDuplexChannel(child: ChildProcessWithoutNullStreams): ChildDuplexChannel {
  const observed = new DuplexFrameDecoder();
  const observedFrames: DuplexFrame[] = [];
  const stdoutDecoder = new StringDecoder("utf8");
  let dataListener: ((chunk: string) => void) | null = null;
  let exitListener: ((exit: { exitCode: number | null }) => void) | null = null;
  let pendingText = "";
  let pendingExit: { exitCode: number | null } | null = null;
  let stderrText = "";

  child.stdout.on("data", (buffer: Buffer) => {
    for (const result of observed.push(buffer)) {
      if (result.ok) observedFrames.push(result.frame);
    }
    const text = stdoutDecoder.write(buffer);
    if (text.length === 0) return;
    if (dataListener) dataListener(text);
    else pendingText += text;
  });
  child.stderr.on("data", (buffer: Buffer) => {
    stderrText += buffer.toString("utf8");
  });
  child.on("exit", (code) => {
    const exit = { exitCode: code };
    if (exitListener) exitListener(exit);
    else pendingExit = exit;
  });
  // Swallow a stdin EPIPE. The broker can write one more frame while the child
  // exits; the write fails and the broker records the loss on its own path.
  child.stdin.on("error", () => undefined);

  const channel: CommandManagedDuplexChannel = {
    write: (data) => {
      child.stdin.write(data);
    },
    onData: (listener) => {
      dataListener = listener;
      if (pendingText.length > 0) {
        const replay = pendingText;
        pendingText = "";
        listener(replay);
      }
    },
    onExit: (listener) => {
      exitListener = listener;
      if (pendingExit) {
        const exit = pendingExit;
        pendingExit = null;
        listener(exit);
      }
    },
    stop: () => {
      child.kill("SIGKILL");
    },
    close: () =>
      new Promise<void>((resolve) => {
        // Close the write side. The child stdin reaches end of file, so the
        // gateway sees a real EOF.
        child.stdin.end(() => resolve());
      }),
  };

  return { channel, observedFrames, stderr: () => stderrText };
}

/** The forward-handler mode. `proxy` calls the fake API; `hang` blocks until abort. */
type ForwardMode = "proxy" | "hang";

/** The options for one harness. */
interface HarnessOptions {
  hostApiToken?: string;
  runId?: string;
  maxBodyBytes?: number;
  lossExitGraceMs?: number;
}

/** The full harness handle for one composed duplex path. */
interface DuplexE2EHarness {
  baseUrl: string;
  bridgeToken: string;
  hostApiToken: string;
  runId: string;
  nonce: string;
  broker: DuplexBridgeBroker;
  api: FakeApiServer;
  child: ChildProcessWithoutNullStreams;
  observedFrames: DuplexFrame[];
  forwardedRequests: DuplexRequestFrame[];
  setForwardMode: (mode: ForwardMode) => void;
  stderr: () => string;
  killChild: () => Promise<void>;
  waitFor: (predicate: () => boolean, message: string, timeoutMs?: number) => Promise<void>;
  teardown: () => Promise<void>;
}

/** Reserve one free loopback port. The host assigns it to the gateway. */
async function reserveLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close(() => reject(new Error("Could not reserve a loopback port.")));
        return;
      }
      const reserved = address.port;
      probe.close(() => resolve(reserved));
    });
  });
}

/**
 * Build the composed duplex path: a spawned gateway child, the real broker on
 * the child stdio, and a local fake API server as the forward target.
 */
async function createHarness(options: HarnessOptions = {}): Promise<DuplexE2EHarness> {
  const hostApiToken = options.hostApiToken ?? "real-run-jwt";
  const runId = options.runId ?? "run-e2e";
  const maxBodyBytes = options.maxBodyBytes ?? 1_000_000;
  const bridgeToken = "duplex-e2e-bridge-token";
  const nonce = "e2e112233445566778899aabbccddeeff";
  let forwardMode: ForwardMode = "proxy";
  const forwardedRequests: DuplexRequestFrame[] = [];

  const api = await startFakeApiServer();
  const assignedPort = await reserveLoopbackPort();

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-duplex-e2e-"));
  const entrypoint = path.join(tmpDir, "gateway.mjs");
  await writeFile(entrypoint, getSandboxCallbackBridgeServerSource(), "utf8");

  const child = spawn(process.execPath, [entrypoint], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PAPERCLIP_API_BRIDGE_MODE: SANDBOX_CALLBACK_BRIDGE_DUPLEX_MODE,
      PAPERCLIP_BRIDGE_HOST: "127.0.0.1",
      PAPERCLIP_BRIDGE_PORT: String(assignedPort),
      PAPERCLIP_BRIDGE_NONCE: nonce,
      PAPERCLIP_BRIDGE_TOKEN: bridgeToken,
      PAPERCLIP_BRIDGE_MAX_BODY_BYTES: String(maxBodyBytes),
      ...(options.lossExitGraceMs != null
        ? { PAPERCLIP_BRIDGE_LOSS_EXIT_GRACE_MS: String(options.lossExitGraceMs) }
        : {}),
    },
  }) as ChildProcessWithoutNullStreams;

  const { channel, observedFrames, stderr } = attachChildDuplexChannel(child);

  const forwardRequest = async (
    request: DuplexRequestFrame,
    opts: { signal: AbortSignal; body: ReassembledBody },
  ): Promise<DuplexBrokerForwardResult> => {
    forwardedRequests.push(request);
    // Keep the real route allowlist on the forward seam. The broker forwards
    // only an allowed route; it denies any other route with a 403.
    const denial = authorizeSandboxCallbackBridgeRequestWithRoutes(request);
    if (denial) {
      return {
        status: 403,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: denial }),
      };
    }
    if (forwardMode === "hang") {
      // Block until the broker aborts the forward. This lets a test hold an
      // outstanding request open while it forces a loss.
      await new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(new Error("The forward call was aborted."));
        if (opts.signal.aborted) {
          onAbort();
          return;
        }
        opts.signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    const method = request.method.trim().toUpperCase() || "GET";
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (value.trim().length === 0) continue;
      headers.set(key, value);
    }
    // Apply the real host token and the run id, the same as the file bridge path.
    headers.set("authorization", `Bearer ${hostApiToken}`);
    headers.set("x-paperclip-run-id", runId);
    const target = new URL(`${request.path}${request.query ?? ""}`, api.origin);
    // Stream the reassembled request body to the host, the same as the real
    // forward. A streamed body needs `duplex: "half"`.
    const forwardInit: RequestInit & { duplex?: "half" } = { method, headers, signal: opts.signal };
    if (method !== "GET" && method !== "HEAD") {
      forwardInit.body = Readable.toWeb(
        opts.body.createReadStream(),
      ) as unknown as ReadableStream<Uint8Array>;
      forwardInit.duplex = "half";
    }
    const response = await fetch(target, forwardInit);
    const body = await response.text();
    const outHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === "content-length") return;
      outHeaders[key] = value;
    });
    return { status: response.status, headers: outHeaders, body };
  };

  const broker = await createDuplexBridgeBroker({
    channel,
    forwardRequest,
    logger: () => undefined,
  });
  broker.start();

  const waitFor = async (
    predicate: () => boolean,
    message: string,
    timeoutMs = 5000,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (predicate()) return;
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${message}. stderr: ${stderr()}`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 20);
        timer.unref?.();
      });
    }
  };

  const waitForExit = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once("exit", () => resolve());
    });

  const killChild = async (): Promise<void> => {
    child.kill("SIGKILL");
    await waitForExit();
  };

  let torndown = false;
  const teardown = async (): Promise<void> => {
    if (torndown) return;
    torndown = true;
    child.kill("SIGKILL");
    await waitForExit();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    await api.close();
    await rm(tmpDir, { recursive: true, force: true });
  };

  return {
    baseUrl: `http://127.0.0.1:${assignedPort}`,
    bridgeToken,
    hostApiToken,
    runId,
    nonce,
    broker,
    api,
    child,
    observedFrames,
    forwardedRequests,
    setForwardMode: (mode) => {
      forwardMode = mode;
    },
    stderr,
    killChild,
    waitFor,
    teardown,
  };
}

/**
 * Build a large body of multi-byte UTF-8 characters. "€" uses three UTF-8 bytes
 * and "😀" uses four. A pipe read boundary at a 65536-byte multiple lands inside
 * a "€" sequence, because 65536 is not a multiple of three. This guarantees a
 * multi-byte character split across two pipe chunks.
 */
function buildMultiByteBody(targetBytes: number): string {
  const marker = "😀-start-😀";
  const filler = "€".repeat(Math.ceil(targetBytes / 3));
  return `${marker}${filler}${marker}`;
}

describe("duplex bridge local end-to-end harness", () => {
  const harnesses: DuplexE2EHarness[] = [];

  afterEach(async () => {
    while (harnesses.length > 0) {
      const harness = harnesses.pop();
      if (harness) await harness.teardown();
    }
  });

  const readyPredicate = (harness: DuplexE2EHarness) => () =>
    harness.observedFrames.some((frame) => frame.type === "ready");

  it("delivers a valid READY frame from the spawned gateway child to the attached broker", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    await harness.waitFor(readyPredicate(harness), "a READY frame from the gateway child");

    const ready = harness.observedFrames.find(
      (frame) => frame.type === "ready",
    ) as DuplexReadyFrame;
    expect(ready.version).toBe(2);
    expect(ready.nonce).toBe(harness.nonce);
    // READY is liveness only. It carries no address data.
    expect((ready as unknown as Record<string, unknown>).address).toBeUndefined();
    expect((ready as unknown as Record<string, unknown>).port).toBeUndefined();
    // The broker read the READY frame and stayed open with no loss.
    expect(harness.broker.state).toBe("open");
    expect(harness.broker.lossRecord).toBeNull();
  }, 20000);

  it("carries one real HTTP request through the child and the broker to the fake API unchanged", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    await harness.waitFor(readyPredicate(harness), "the gateway to become ready");

    harness.api.setResponder((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, echoedPath: url.pathname }));
    });

    const response = await fetch(`${harness.baseUrl}/api/agents/me`, {
      headers: { authorization: `Bearer ${harness.bridgeToken}` },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, echoedPath: "/api/agents/me" });

    // The fake API saw one request with the real host token and the run id. The
    // broker replaced the bridge token, so the fake API never saw it.
    expect(harness.api.requests).toHaveLength(1);
    expect(harness.api.requests[0]).toMatchObject({
      method: "GET",
      url: "/api/agents/me",
      auth: `Bearer ${harness.hostApiToken}`,
      runId: harness.runId,
    });
  }, 20000);

  it("reassembles a large response that spans many pipe chunks", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    await harness.waitFor(readyPredicate(harness), "the gateway to become ready");

    // The body is larger than the pipe buffer, so the response frame crosses the
    // child stdin pipe in many chunks. An ASCII body isolates the chunk-span
    // behavior from the multi-byte behavior the next test covers.
    const largeBody = "x".repeat(256 * 1024);
    expect(Buffer.byteLength(largeBody, "utf8")).toBeGreaterThan(200 * 1024);
    harness.api.setResponder((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(largeBody);
    });

    const response = await fetch(`${harness.baseUrl}/api/agents/me`, {
      headers: { authorization: `Bearer ${harness.bridgeToken}` },
    });
    expect(response.status).toBe(200);
    const received = await response.text();
    // The whole body returns complete after it crossed the pipe in many chunks.
    expect(received.length).toBe(largeBody.length);
    expect(received).toBe(largeBody);
  }, 20000);

  it("decodes a multi-byte UTF-8 sequence split across chunk borders", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    await harness.waitFor(readyPredicate(harness), "the gateway to become ready");

    const multiByteBody = buildMultiByteBody(256 * 1024);
    expect(Buffer.byteLength(multiByteBody, "utf8")).toBeGreaterThan(200 * 1024);
    harness.api.setResponder((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(multiByteBody);
    });

    const response = await fetch(`${harness.baseUrl}/api/agents/me`, {
      headers: { authorization: `Bearer ${harness.bridgeToken}` },
    });
    expect(response.status).toBe(200);
    const received = await response.text();
    // A multi-byte character split across a pipe chunk border decodes to the
    // same character, so the whole body returns unchanged.
    expect(received.length).toBe(multiByteBody.length);
    expect(received).toBe(multiByteBody);
  }, 20000);

  it("matches each concurrent request through one child to its own response", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    await harness.waitFor(readyPredicate(harness), "the gateway to become ready");

    harness.api.setResponder((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ path: url.pathname }));
    });

    const ids = Array.from({ length: 8 }, (_unused, index) => `issue-${index}`);
    const responses = await Promise.all(
      ids.map((id) =>
        fetch(`${harness.baseUrl}/api/issues/${id}`, {
          headers: { authorization: `Bearer ${harness.bridgeToken}` },
        }).then(async (response) => ({ status: response.status, body: await response.json() })),
      ),
    );

    responses.forEach((result, index) => {
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ path: `/api/issues/${ids[index]}` });
    });
    expect(harness.api.requests).toHaveLength(8);
  }, 20000);

  it("answers 409 to outstanding and 503 to new requests when the broker closes its write side", async () => {
    const harness = await createHarness({ lossExitGraceMs: 3000 });
    harnesses.push(harness);
    await harness.waitFor(readyPredicate(harness), "the gateway to become ready");

    // Hold the forward open, so the broker sends no response frame. The gateway
    // keeps the request outstanding until the loss.
    harness.setForwardMode("hang");
    const outstanding = fetch(`${harness.baseUrl}/api/agents/me`, {
      headers: { authorization: `Bearer ${harness.bridgeToken}` },
    });
    void outstanding.catch(() => undefined);
    await harness.waitFor(
      () => harness.forwardedRequests.length >= 1,
      "the broker to receive the forwarded request",
    );

    // The broker closes its write side, so the child stdin reaches a real EOF.
    await harness.broker.close();

    const lossResponse = await outstanding;
    expect(lossResponse.status).toBe(409);
    expect(lossResponse.headers.get("x-paperclip-bridge-outcome")).toBe("indeterminate");
    await expect(lossResponse.json()).resolves.toEqual({ error: "outcome_indeterminate" });

    const afterLoss = await fetch(`${harness.baseUrl}/api/agents/me`, {
      headers: { authorization: `Bearer ${harness.bridgeToken}` },
    });
    expect(afterLoss.status).toBe(503);
    await expect(afterLoss.json()).resolves.toEqual({ error: "bridge_unavailable" });
  }, 20000);

  it("moves the broker to lost on a child kill, dispatches nothing more, and leaks no handle after teardown", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    await harness.waitFor(readyPredicate(harness), "the gateway to become ready");

    // Hold one forward open, so a request is in flight when the child dies.
    harness.setForwardMode("hang");
    const outstanding = fetch(`${harness.baseUrl}/api/agents/me`, {
      headers: { authorization: `Bearer ${harness.bridgeToken}` },
    });
    void outstanding.catch(() => undefined);
    await harness.waitFor(
      () => harness.forwardedRequests.length >= 1,
      "the broker to receive the forwarded request",
    );
    const forwardedBeforeKill = harness.forwardedRequests.length;

    // A real process kill closes the stdout pipe and ends the child.
    await harness.killChild();
    await harness.waitFor(
      () => harness.broker.state === "lost",
      "the broker to record the channel loss",
    );
    expect(harness.broker.lossRecord?.reason).toBe("channel_exit");

    // The broker dispatches nothing more after the loss.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 100);
      timer.unref?.();
    });
    expect(harness.forwardedRequests.length).toBe(forwardedBeforeKill);
    // The outstanding fetch fails because the child died before it answered.
    await expect(outstanding).rejects.toThrow();

    await harness.teardown();
    // Teardown left no open pipe or socket handle.
    expect(harness.child.stdin.destroyed).toBe(true);
    expect(harness.child.stdout.destroyed).toBe(true);
    expect(harness.child.stderr.destroyed).toBe(true);
    expect(harness.api.listening()).toBe(false);
    expect(harness.api.openSocketCount()).toBe(0);
  }, 20000);

  it("fails a request with a local 502 when the host sends a malformed response chunk", async () => {
    const RAW = DUPLEX_BODY_CHUNK_RAW_BYTES;
    // Each case declares one malformed body_chunk a broken or hostile host could
    // send. The gateway must reject it at once with a local 502. It must not grow
    // its response reassembly buffer until the response timeout. `bodyByteCount`
    // sets the declared body size on the response envelope. `data` is the base64
    // payload of the one injected chunk.
    const cases: Array<{ name: string; bodyByteCount: number; data: string; error: string }> = [
      { name: "an empty chunk", bodyByteCount: RAW, data: "", error: "duplex response body_chunk is empty" },
      {
        name: "an undersized non-final chunk",
        bodyByteCount: RAW + 8,
        data: Buffer.alloc(4, 1).toString("base64"),
        error: "duplex response body_chunk has the wrong size",
      },
      {
        name: "an oversized chunk",
        bodyByteCount: RAW + 8,
        data: Buffer.alloc(RAW + 4, 1).toString("base64"),
        error: "duplex response body_chunk has the wrong size",
      },
      {
        name: "an overrun past the declared size",
        bodyByteCount: 10,
        data: Buffer.alloc(200, 1).toString("base64"),
        error: "duplex response body overruns the declared size",
      },
      {
        name: "a non-canonical base64 chunk",
        bodyByteCount: 10,
        data: "AB==",
        error: "duplex response body_chunk is not canonical base64",
      },
    ];

    const harness = await createHarness();
    harnesses.push(harness);
    await harness.waitFor(readyPredicate(harness), "the gateway to become ready");

    // Hold the broker forward open, so only the injected frames answer each
    // request. The gateway reassembles the response body itself, so a raw
    // malformed chunk on its stdin drives the reject path under test.
    harness.setForwardMode("hang");

    for (const testCase of cases) {
      const forwardedBefore = harness.forwardedRequests.length;
      const pendingFetch = fetch(`${harness.baseUrl}/api/agents/me`, {
        headers: { authorization: `Bearer ${harness.bridgeToken}` },
      });
      void pendingFetch.catch(() => undefined);
      await harness.waitFor(
        () => harness.forwardedRequests.length > forwardedBefore,
        `the broker to receive the forwarded request for ${testCase.name}`,
      );
      const id = harness.forwardedRequests[harness.forwardedRequests.length - 1].id;

      // Inject the response envelope, then the one malformed body_chunk, straight
      // to the gateway stdin. This bypasses the broker response encoder, so the
      // gateway sees the exact bytes a broken or hostile host could send.
      harness.child.stdin.write(
        encodeDuplexFrame({
          version: DUPLEX_FRAME_VERSION,
          type: "response",
          id,
          status: 200,
          headers: {},
          bodyByteCount: testCase.bodyByteCount,
          outcome: "completed",
        }),
      );
      harness.child.stdin.write(
        encodeDuplexFrame({
          version: DUPLEX_FRAME_VERSION,
          type: "body_chunk",
          id,
          seq: 0,
          data: testCase.data,
        }),
      );

      const response = await pendingFetch;
      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toEqual({ error: testCase.error });
    }
  }, 20000);
});
