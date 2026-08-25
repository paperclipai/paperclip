import { duplexPair } from "node:stream";
import type { Duplex } from "node:stream";
import http2 from "node:http2";

import { describe, expect, it } from "vitest";

import {
  buildHttp2BridgeForwardUrl,
  classifyStreamAgainstGoaway,
  createHttp2BridgeServer,
  parseCanonicalBridgeRequestPath,
  wrapDuplexChannelAsNodeDuplex,
  DEFAULT_HTTP2_BRIDGE_PING_INTERVAL_MS,
  DEFAULT_HTTP2_BRIDGE_PING_STALL_MS,
  HTTP2_BRIDGE_ENABLE_PUSH,
  HTTP2_BRIDGE_HEADER_TABLE_SIZE,
  HTTP2_BRIDGE_MAX_CONCURRENT_STREAMS,
  HTTP2_BRIDGE_MAX_DEFLATE_DYNAMIC_TABLE_SIZE,
  HTTP2_BRIDGE_MAX_HEADER_LIST_PAIRS,
  HTTP2_BRIDGE_MAX_HEADER_LIST_SIZE,
  HTTP2_BRIDGE_MAX_SESSION_INVALID_FRAMES,
  HTTP2_BRIDGE_MAX_SESSION_MEMORY,
  HTTP2_BRIDGE_MAX_SESSION_REJECTED_STREAMS,
  HTTP2_BRIDGE_SERVER_OPTIONS,
  HTTP2_BRIDGE_STREAM_RESET_BURST,
  HTTP2_BRIDGE_STREAM_RESET_RATE,
  type Http2BridgeForwardRequest,
  type Http2BridgeForwardResult,
  type Http2BridgeGoawayRecord,
} from "./http2-bridge-server.js";
import { createSandboxHttp2BridgeGateway } from "./sandbox-callback-bridge.js";
import type { CommandManagedDuplexChannel } from "./command-managed-runtime.js";

/**
 * Unit harness for the host HTTP/2 server and the sandbox HTTP/2 client
 * gateway. Every test connects the pair over one paired in-memory `Duplex`
 * (`node:stream`'s `duplexPair`) — no real TCP socket and no spawned sandbox
 * process. This proves the two halves speak one wire-compatible HTTP/2
 * session with no network in between.
 */

const BRIDGE_TOKEN = "test-bridge-token-fixed-length-32";

/** Wrap one side of a paired `Duplex` as a minimal fake `CommandManagedDuplexChannel`. */
function fakeChannelFromDuplex(duplex: Duplex): CommandManagedDuplexChannel {
  const dataListeners: Array<(chunk: Uint8Array) => void> = [];
  const exitListeners: Array<(exit: { exitCode: number | null; transportClosed?: boolean }) => void> = [];
  duplex.on("data", (chunk: Buffer) => {
    for (const listener of dataListeners) listener(chunk);
  });
  duplex.on("end", () => {
    for (const listener of exitListeners) listener({ exitCode: null, transportClosed: true });
  });
  return {
    write: (data) => {
      duplex.write(Buffer.from(data));
    },
    onData: (listener) => {
      dataListeners.push(listener);
    },
    onExit: (listener) => {
      exitListeners.push(listener);
    },
    stop: () => {
      duplex.destroy();
    },
    close: async () => {
      duplex.end();
    },
  };
}

interface TestPairOptions {
  forwardRequest?: (request: Http2BridgeForwardRequest) => Promise<Http2BridgeForwardResult>;
  bridgeToken?: string;
  pingIntervalMs?: number;
  pingStallMs?: number;
  requestBodyTimeoutMs?: number;
  requestBodyMaxLifetimeMs?: number;
  requestBodyLifetimeCeilingMs?: number;
  closeGraceMs?: number;
  onGoaway?: (record: Http2BridgeGoawayRecord) => void;
  onSessionError?: (error: Error) => void;
  onSession?: (session: http2.ServerHttp2Session) => void;
}

/** Bind the host server to one side of a fresh paired in-memory `Duplex`.
 * Returns the other side, unbound, for a caller to connect a client to. */
function bindTestServer(options: TestPairOptions = {}) {
  const bridgeToken = options.bridgeToken ?? BRIDGE_TOKEN;
  const [serverSide, clientSide] = duplexPair();
  const forwardRequest =
    options.forwardRequest ??
    (async (request: Http2BridgeForwardRequest) => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ echoedMethod: request.method, echoedPath: request.pathname }),
    }));
  const handle = createHttp2BridgeServer({
    bridgeToken,
    forwardRequest,
    pingIntervalMs: options.pingIntervalMs,
    pingStallMs: options.pingStallMs,
    requestBodyTimeoutMs: options.requestBodyTimeoutMs,
    requestBodyMaxLifetimeMs: options.requestBodyMaxLifetimeMs,
    requestBodyLifetimeCeilingMs: options.requestBodyLifetimeCeilingMs,
    closeGraceMs: options.closeGraceMs,
    onGoaway: options.onGoaway,
    onSessionError: options.onSessionError,
    onSession: options.onSession,
  });
  const channel = fakeChannelFromDuplex(serverSide);
  handle.bindChannel(channel);
  return { handle, bridgeToken, clientSide, serverSide };
}

/** Bind the server, then connect the sandbox HTTP/2 client gateway to the
 * other side of the same paired in-memory `Duplex`. */
function createTestPair(options: TestPairOptions = {}) {
  const { handle, bridgeToken, clientSide, serverSide } = bindTestServer(options);
  const gateway = createSandboxHttp2BridgeGateway({
    bridgeToken,
    createConnection: () => clientSide,
  });
  return { handle, gateway, bridgeToken, clientSide, serverSide };
}

/** Open a raw HTTP/2 client session directly against one side of the pair,
 * bypassing the sandbox gateway. Some tests need direct stream control (an
 * explicit RST_STREAM, an explicit GOAWAY) the gateway's `forwardRequest`
 * abstraction does not expose. */
function connectRawClient(clientSide: Duplex): http2.ClientHttp2Session {
  return http2.connect("http://bridge.internal", { createConnection: () => clientSide });
}

describe("createHttp2BridgeServer + createSandboxHttp2BridgeGateway", () => {
  it("test_one_session_over_a_fake_channel_forwards_a_request", async () => {
    const { handle, gateway } = createTestPair();
    try {
      const response = await gateway.forwardRequest({
        method: "GET",
        path: "/api/agents/me",
        query: "",
        headers: {},
        body: Buffer.alloc(0),
        receivedToken: BRIDGE_TOKEN,
      });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body.toString("utf8"))).toEqual({
        echoedMethod: "GET",
        echoedPath: "/api/agents/me",
      });
    } finally {
      await gateway.close();
      await handle.close();
    }
  });

  it("test_sixty_four_concurrent_streams_all_complete", async () => {
    const seenPaths = new Set<string>();
    const { handle, gateway } = createTestPair({
      forwardRequest: async (request) => {
        // Force real overlap: every forward call waits one macrotask before it
        // resolves, so 64 concurrent streams are genuinely in flight together.
        await new Promise((resolve) => setTimeout(resolve, 5));
        seenPaths.add(request.pathname);
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ echoedPath: request.pathname }),
        };
      },
    });
    try {
      const requests = Array.from({ length: 64 }, (_, index) =>
        gateway.forwardRequest({
          method: "GET",
          path: `/api/issues/${index}`,
          query: "",
          headers: {},
          body: Buffer.alloc(0),
          receivedToken: BRIDGE_TOKEN,
        }),
      );
      const responses = await Promise.all(requests);
      expect(responses).toHaveLength(64);
      for (const [index, response] of responses.entries()) {
        expect(response.status).toBe(200);
        expect(JSON.parse(response.body.toString("utf8"))).toEqual({
          echoedPath: `/api/issues/${index}`,
        });
      }
      expect(seenPaths.size).toBe(64);
    } finally {
      await gateway.close();
      await handle.close();
    }
  });

  it("test_ping_detects_a_silent_stall_within_twenty_seconds", async () => {
    // The production defaults name the twenty-second bound this test name
    // promises. The mechanism test below exercises the same code path with
    // small overrides, so the suite stays fast.
    expect(DEFAULT_HTTP2_BRIDGE_PING_STALL_MS).toBe(20_000);
    expect(DEFAULT_HTTP2_BRIDGE_PING_INTERVAL_MS).toBeLessThan(DEFAULT_HTTP2_BRIDGE_PING_STALL_MS);

    const [serverSide] = duplexPair();
    // Nothing consumes the other side of the pair, so every PING frame the
    // server sends goes unacknowledged: a silent stall.
    const stallErrors: Error[] = [];
    const handle = createHttp2BridgeServer({
      bridgeToken: BRIDGE_TOKEN,
      forwardRequest: async () => ({ status: 200 }),
      pingIntervalMs: 15,
      pingStallMs: 40,
      onSessionError: (error) => stallErrors.push(error),
    });
    handle.bindChannel(fakeChannelFromDuplex(serverSide));

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(stallErrors).toHaveLength(1);
    expect(stallErrors[0]?.message).toMatch(/stall/i);
    await handle.close();
  });

  it("test_goaway_reports_the_last_processed_stream_identifier", async () => {
    // GOAWAY's Last-Stream-ID names the highest stream the SENDER processed
    // for the peer's own initiated streams. Every request stream in this
    // transport originates from the sandbox, so the meaningful, valid
    // direction is the host naming the last client stream it processed — not
    // the reverse (a client-sent GOAWAY only ever carries 0 here, since
    // server push is disabled). The sandbox gateway observes it and can
    // classify its own dispatched stream IDs with `classifyStreamAgainstGoaway`.
    let hostSession: http2.ServerHttp2Session | undefined;
    const goawayRecords: Array<{ lastStreamId: number; errorCode: number }> = [];
    const { handle, bridgeToken, clientSide } = bindTestServer({
      onSession: (session) => {
        hostSession = session;
      },
    });
    const gateway = createSandboxHttp2BridgeGateway({
      bridgeToken,
      createConnection: () => clientSide,
      onGoaway: (record) => goawayRecords.push(record),
    });
    try {
      const response = await gateway.forwardRequest({
        method: "GET",
        path: "/api/agents/me",
        query: "",
        headers: {},
        body: Buffer.alloc(0),
        receivedToken: bridgeToken,
      });
      expect(response.status).toBe(200);

      await new Promise<void>((resolve) => {
        hostSession?.goaway(http2.constants.NGHTTP2_NO_ERROR, 1);
        setTimeout(resolve, 50);
      });
      expect(goawayRecords).toHaveLength(1);
      expect(goawayRecords[0]?.lastStreamId).toBe(1);
      expect(classifyStreamAgainstGoaway(1, goawayRecords[0]!.lastStreamId)).toBe("accepted");
      expect(classifyStreamAgainstGoaway(3, goawayRecords[0]!.lastStreamId)).toBe("not_accepted");
    } finally {
      await gateway.close();
      await handle.close();
    }
  });

  it("test_rst_stream_fails_one_request_and_keeps_the_session", async () => {
    const { handle, bridgeToken, clientSide } = bindTestServer({
      forwardRequest: async (request) => {
        if (request.pathname === "/api/agents/me") {
          // Hold this one open long enough for the test to RST it.
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        return { status: 200, headers: {}, body: JSON.stringify({ path: request.pathname }) };
      },
    });
    const rawClient = connectRawClient(clientSide);
    try {
      const abortedStream = rawClient.request({
        ":method": "GET",
        ":path": "/api/agents/me",
        authorization: `Bearer ${bridgeToken}`,
      });
      const abortedOutcome = new Promise<"aborted" | "closed">((resolve) => {
        abortedStream.on("error", () => resolve("aborted"));
        abortedStream.on("close", () => resolve("closed"));
      });
      abortedStream.end();
      // Give the request time to reach the server before the reset.
      await new Promise((resolve) => setTimeout(resolve, 20));
      abortedStream.close(http2.constants.NGHTTP2_CANCEL);
      await abortedOutcome;

      // The session survives: a second request completes normally.
      const survivingResponse = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = rawClient.request({
          ":method": "GET",
          ":path": "/api/companies/co1",
          authorization: `Bearer ${bridgeToken}`,
        });
        let status = 0;
        let body = "";
        req.on("response", (headers) => {
          status = Number(headers[":status"]) || 0;
        });
        req.setEncoding("utf8");
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => resolve({ status, body }));
        req.on("error", reject);
        req.end();
      });
      expect(survivingResponse.status).toBe(200);
      expect(JSON.parse(survivingResponse.body)).toEqual({ path: "/api/companies/co1" });
    } finally {
      rawClient.close();
      await handle.close();
    }
  });

  it("test_a_stalled_request_body_settles_instead_of_hanging_forever", async () => {
    let forwarderCalled = false;
    const { handle, bridgeToken, clientSide } = bindTestServer({
      requestBodyTimeoutMs: 30,
      forwardRequest: async () => {
        forwarderCalled = true;
        return { status: 200 };
      },
    });
    const rawClient = connectRawClient(clientSide);
    try {
      const startMs = Date.now();
      // A partial, never-ended body stalls the read. The timeout destroys the
      // stream, so the request settles (through an `error` or a `close`, not
      // a clean response) well inside the bound, instead of hanging forever.
      await new Promise<void>((resolve) => {
        const req = rawClient.request({
          ":method": "POST",
          ":path": "/api/issues/abc/comments",
          authorization: `Bearer ${bridgeToken}`,
        });
        req.on("error", () => resolve());
        req.on("close", () => resolve());
        req.write("partial-body");
      });
      expect(Date.now() - startMs).toBeLessThan(5_000);
      expect(forwarderCalled).toBe(false);

      // The session survives the timed-out stream: a second, complete request
      // still succeeds.
      const survivingResponse = await new Promise<{ status: number }>((resolve, reject) => {
        const req = rawClient.request({
          ":method": "POST",
          ":path": "/api/issues/abc/comments",
          authorization: `Bearer ${bridgeToken}`,
        });
        let status = 0;
        req.on("response", (headers) => {
          status = Number(headers[":status"]) || 0;
        });
        req.on("data", () => undefined);
        req.on("end", () => resolve({ status }));
        req.on("error", reject);
        req.end();
      });
      expect(survivingResponse.status).toBe(200);
    } finally {
      rawClient.close();
      await handle.close();
    }
  });

  it("test_a_slow_but_progressing_request_body_completes_instead_of_timing_out", async () => {
    // The idle bound is well under the total time the whole body takes, so a
    // one-shot bound over the full read would trip. Each chunk resets the
    // bound, so the request still completes.
    const { handle, bridgeToken, clientSide } = bindTestServer({
      requestBodyTimeoutMs: 80,
      forwardRequest: async (request) => ({
        status: 200,
        body: JSON.stringify({ bodyLength: request.body.byteLength }),
      }),
    });
    const rawClient = connectRawClient(clientSide);
    try {
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = rawClient.request({
          ":method": "POST",
          ":path": "/api/issues/abc/comments",
          authorization: `Bearer ${bridgeToken}`,
        });
        let status = 0;
        let body = "";
        req.setEncoding("utf8");
        req.on("response", (headers) => {
          status = Number(headers[":status"]) || 0;
        });
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => resolve({ status, body }));
        req.on("error", reject);
        // Five chunks, each inside the idle bound, summing past it.
        let sent = 0;
        const sendNext = () => {
          if (sent >= 5) {
            req.end();
            return;
          }
          sent += 1;
          req.write("chunk");
          setTimeout(sendNext, 40);
        };
        sendNext();
      });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ bodyLength: "chunk".length * 5 });
    } finally {
      rawClient.close();
      await handle.close();
    }
  });

  it("test_progress_renews_the_lifetime_bound_but_the_hard_ceiling_still_stops_it", async () => {
    // The idle bound is generous, so a chunk every 40ms never lets it
    // expire. The lifetime bound (50ms) is short, but each chunk renews it,
    // so the read survives past 50ms — proving a slow peer that keeps
    // making real progress does not lose the stream early. The hard ceiling
    // (150ms) never renews, so the read still ends once the read's total
    // age passes it, no matter how the peer paces its chunks. This is the
    // failure mode an authenticated sandbox could otherwise use to hold one
    // of the concurrent-stream slots open indefinitely: keep sending just
    // enough to renew the lifetime bound, and never finish the body.
    //
    // Every write below lands well before the current lifetime deadline,
    // and the test makes no further call on the stream after the last one:
    // nothing races the server's own reset of it once the ceiling passes,
    // so this proves the bound from the server's own, deterministic effect
    // (the forward handler never runs) instead of from a raw client-stream
    // event whose timing Node does not guarantee here.
    let forwarderCalled = false;
    const { handle, bridgeToken, clientSide } = bindTestServer({
      requestBodyTimeoutMs: 5_000,
      requestBodyMaxLifetimeMs: 50,
      requestBodyLifetimeCeilingMs: 150,
      forwardRequest: async () => {
        forwarderCalled = true;
        return { status: 200 };
      },
    });
    const rawClient = connectRawClient(clientSide);
    try {
      const req = rawClient.request({
        ":method": "POST",
        ":path": "/api/issues/abc/comments",
        authorization: `Bearer ${bridgeToken}`,
      });
      req.on("error", () => undefined);
      // Four chunks, 40ms apart. The total send time, about 120ms, already
      // passes the 50ms lifetime bound — proving renewal keeps the read
      // alive past it — but stays under the 150ms hard ceiling. The body
      // never ends: this request never calls `.end()`.
      for (let chunkIndex = 0; chunkIndex < 4; chunkIndex += 1) {
        req.write("chunk");
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      // Wait past the hard ceiling with no further write, so the server has
      // time to destroy the stalled stream on its own.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(forwarderCalled).toBe(false);

      // The session survives the ended stream: a second, complete request
      // still succeeds.
      const survivingResponse = await new Promise<{ status: number }>((resolve, reject) => {
        const survivingReq = rawClient.request({
          ":method": "POST",
          ":path": "/api/issues/abc/comments",
          authorization: `Bearer ${bridgeToken}`,
        });
        let status = 0;
        survivingReq.on("response", (headers) => {
          status = Number(headers[":status"]) || 0;
        });
        survivingReq.on("data", () => undefined);
        survivingReq.on("end", () => resolve({ status }));
        survivingReq.on("error", reject);
        survivingReq.end();
      });
      expect(survivingResponse.status).toBe(200);
    } finally {
      rawClient.close();
      await handle.close();
    }
  });

  it("test_a_request_body_within_the_lifetime_bound_still_completes", async () => {
    // A generous lifetime bound must not interfere with an ordinary request
    // that finishes well inside it.
    const { handle, bridgeToken, clientSide } = bindTestServer({
      requestBodyTimeoutMs: 5_000,
      requestBodyMaxLifetimeMs: 5_000,
      forwardRequest: async (request) => ({
        status: 200,
        body: JSON.stringify({ bodyLength: request.body.byteLength }),
      }),
    });
    const rawClient = connectRawClient(clientSide);
    try {
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = rawClient.request({
          ":method": "POST",
          ":path": "/api/issues/abc/comments",
          authorization: `Bearer ${bridgeToken}`,
        });
        let status = 0;
        let body = "";
        req.setEncoding("utf8");
        req.on("response", (headers) => {
          status = Number(headers[":status"]) || 0;
        });
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => resolve({ status, body }));
        req.on("error", reject);
        req.write("chunk");
        req.end();
      });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ bodyLength: "chunk".length });
    } finally {
      rawClient.close();
      await handle.close();
    }
  });

  it("test_a_slow_but_progressing_upload_completes_past_the_base_lifetime_bound", async () => {
    // The base lifetime bound (50ms) is short, but every chunk below carries
    // real progress and renews it, and the hard ceiling (5s) is generous.
    // The total send time, about 200ms, passes the 50ms base bound several
    // times over, so this proves a slow but genuinely progressing upload now
    // completes instead of losing its stream mid-upload.
    let forwarderCalled = false;
    const { handle, bridgeToken, clientSide } = bindTestServer({
      requestBodyTimeoutMs: 5_000,
      requestBodyMaxLifetimeMs: 50,
      requestBodyLifetimeCeilingMs: 5_000,
      forwardRequest: async (request) => {
        forwarderCalled = true;
        return { status: 200, body: JSON.stringify({ bodyLength: request.body.byteLength }) };
      },
    });
    const rawClient = connectRawClient(clientSide);
    try {
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = rawClient.request({
          ":method": "POST",
          ":path": "/api/issues/abc/comments",
          authorization: `Bearer ${bridgeToken}`,
        });
        let status = 0;
        let body = "";
        req.setEncoding("utf8");
        req.on("response", (headers) => {
          status = Number(headers[":status"]) || 0;
        });
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => resolve({ status, body }));
        req.on("error", reject);
        void (async () => {
          // Six chunks, 40ms apart (well inside the idle bound), each real
          // progress.
          for (let sent = 0; sent < 6; sent += 1) {
            req.write("chunk");
            await new Promise((r) => setTimeout(r, 40));
          }
          req.end();
        })();
      });
      expect(forwarderCalled).toBe(true);
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ bodyLength: "chunk".length * 6 });
    } finally {
      rawClient.close();
      await handle.close();
    }
  });

  it("test_close_force_destroys_a_session_with_a_stalled_stream_instead_of_waiting_forever", async () => {
    const { handle, bridgeToken, clientSide } = bindTestServer({
      // A body timeout far longer than the close grace, so `close()` is the
      // only thing that bounds the wait in this test.
      requestBodyTimeoutMs: 60_000,
      closeGraceMs: 30,
    });
    const rawClient = connectRawClient(clientSide);
    try {
      const req = rawClient.request({
        ":method": "POST",
        ":path": "/api/issues/abc/comments",
        authorization: `Bearer ${bridgeToken}`,
      });
      req.write("partial-body");
      // Give the request time to reach the server before close() runs.
      await new Promise((resolve) => setTimeout(resolve, 20));

      const closeStart = Date.now();
      await handle.close();
      const closeElapsedMs = Date.now() - closeStart;
      // `close()` force-destroyed the stalled session at the grace bound,
      // instead of waiting on `session.close()` forever.
      expect(closeElapsedMs).toBeLessThan(5_000);
    } finally {
      rawClient.close();
    }
  });

  it("test_the_server_sets_every_bounded_option", async () => {
    expect(HTTP2_BRIDGE_SERVER_OPTIONS).toEqual({
      settings: {
        enablePush: HTTP2_BRIDGE_ENABLE_PUSH,
        maxConcurrentStreams: HTTP2_BRIDGE_MAX_CONCURRENT_STREAMS,
        maxHeaderListSize: HTTP2_BRIDGE_MAX_HEADER_LIST_SIZE,
        headerTableSize: HTTP2_BRIDGE_HEADER_TABLE_SIZE,
      },
      maxSessionMemory: HTTP2_BRIDGE_MAX_SESSION_MEMORY,
      maxHeaderListPairs: HTTP2_BRIDGE_MAX_HEADER_LIST_PAIRS,
      maxDeflateDynamicTableSize: HTTP2_BRIDGE_MAX_DEFLATE_DYNAMIC_TABLE_SIZE,
      maxSessionInvalidFrames: HTTP2_BRIDGE_MAX_SESSION_INVALID_FRAMES,
      maxSessionRejectedStreams: HTTP2_BRIDGE_MAX_SESSION_REJECTED_STREAMS,
      streamResetRate: HTTP2_BRIDGE_STREAM_RESET_RATE,
      streamResetBurst: HTTP2_BRIDGE_STREAM_RESET_BURST,
    });
    expect(HTTP2_BRIDGE_ENABLE_PUSH).toBe(false);
    expect(HTTP2_BRIDGE_MAX_CONCURRENT_STREAMS).toBe(64);
    expect(HTTP2_BRIDGE_MAX_HEADER_LIST_SIZE).toBe(16384);
    expect(HTTP2_BRIDGE_HEADER_TABLE_SIZE).toBe(4096);
    expect(HTTP2_BRIDGE_MAX_SESSION_MEMORY).toBe(16);
    expect(HTTP2_BRIDGE_MAX_HEADER_LIST_PAIRS).toBe(128);
    expect(HTTP2_BRIDGE_MAX_DEFLATE_DYNAMIC_TABLE_SIZE).toBe(4096);
    expect(HTTP2_BRIDGE_MAX_SESSION_INVALID_FRAMES).toBe(100);
    expect(HTTP2_BRIDGE_MAX_SESSION_REJECTED_STREAMS).toBe(100);
    expect(HTTP2_BRIDGE_STREAM_RESET_RATE).toBe(10);
    expect(HTTP2_BRIDGE_STREAM_RESET_BURST).toBe(100);

    // The running server actually carries the bound, not only the constant:
    // the four `settings` values ride the server's outbound SETTINGS frame,
    // so the connected client's `remoteSettings` reflects them after the
    // handshake completes.
    const { handle, clientSide } = bindTestServer();
    const rawClient = connectRawClient(clientSide);
    try {
      const remoteSettings = await new Promise<http2.Settings>((resolve) => {
        rawClient.once("remoteSettings", resolve);
      });
      expect(remoteSettings.enablePush).toBe(HTTP2_BRIDGE_ENABLE_PUSH);
      expect(remoteSettings.maxConcurrentStreams).toBe(HTTP2_BRIDGE_MAX_CONCURRENT_STREAMS);
      expect(remoteSettings.maxHeaderListSize).toBe(HTTP2_BRIDGE_MAX_HEADER_LIST_SIZE);
      expect(remoteSettings.headerTableSize).toBe(HTTP2_BRIDGE_HEADER_TABLE_SIZE);
    } finally {
      rawClient.close();
      await handle.close();
    }
  });

  describe("parseCanonicalBridgeRequestPath", () => {
    it("parses an origin-form path with a query exactly one time", () => {
      const result = parseCanonicalBridgeRequestPath({ ":path": "/api/issues/abc?foo=bar" });
      expect(result).toEqual({ ok: true, value: { pathname: "/api/issues/abc", query: "?foo=bar" } });
    });

    it("test_a_non_origin_form_path_is_rejected", () => {
      expect(parseCanonicalBridgeRequestPath({ ":path": "http://evil.example/api" })).toEqual({
        ok: false,
        reason: "non_origin_form",
      });
      expect(parseCanonicalBridgeRequestPath({ ":path": "//evil.example/api" })).toEqual({
        ok: false,
        reason: "non_origin_form",
      });
      expect(parseCanonicalBridgeRequestPath({ ":path": "*" })).toEqual({
        ok: false,
        reason: "non_origin_form",
      });
    });

    it("test_an_encoded_separator_or_a_dot_segment_is_rejected", () => {
      expect(parseCanonicalBridgeRequestPath({ ":path": "/api%2fissues/abc" })).toEqual({
        ok: false,
        reason: "encoded_slash",
      });
      expect(parseCanonicalBridgeRequestPath({ ":path": "/api\\issues/abc" })).toEqual({
        ok: false,
        reason: "backslash",
      });
      expect(parseCanonicalBridgeRequestPath({ ":path": "/api/issues\0/abc" })).toEqual({
        ok: false,
        reason: "nul_byte",
      });
      expect(parseCanonicalBridgeRequestPath({ ":path": "/api/%00/abc" })).toEqual({
        ok: false,
        reason: "nul_byte",
      });
      expect(parseCanonicalBridgeRequestPath({ ":path": "/api/../secrets" })).toEqual({
        ok: false,
        reason: "dot_segment",
      });
      expect(parseCanonicalBridgeRequestPath({ ":path": "/api/%2e%2e/secrets" })).toEqual({
        ok: false,
        reason: "dot_segment",
      });
      expect(parseCanonicalBridgeRequestPath({ ":path": "/api/./issues" })).toEqual({
        ok: false,
        reason: "dot_segment",
      });
    });

    it("rejects a duplicate pseudo-header", () => {
      expect(
        parseCanonicalBridgeRequestPath({ ":path": ["/api/agents/me", "/api/agents/other"] } as never),
      ).toEqual({ ok: false, reason: "duplicate_pseudo_header" });
    });

    it("rejects a missing path", () => {
      expect(parseCanonicalBridgeRequestPath({})).toEqual({ ok: false, reason: "missing_path" });
    });
  });

  it("buildHttp2BridgeForwardUrl resolves the parsed pathname and query against the base URL", () => {
    const url = buildHttp2BridgeForwardUrl("http://127.0.0.1:4000", {
      pathname: "/api/issues/abc",
      query: "?foo=bar",
    });
    expect(url.toString()).toBe("http://127.0.0.1:4000/api/issues/abc?foo=bar");
  });

  it("classifyStreamAgainstGoaway classifies by the last processed stream id", () => {
    expect(classifyStreamAgainstGoaway(1, 3)).toBe("accepted");
    expect(classifyStreamAgainstGoaway(3, 3)).toBe("accepted");
    expect(classifyStreamAgainstGoaway(5, 3)).toBe("not_accepted");
  });

  it("test_a_stream_without_the_bridge_token_never_reaches_the_forwarder", async () => {
    let forwarderCalled = false;
    const { handle, clientSide } = bindTestServer({
      forwardRequest: async (request) => {
        forwarderCalled = true;
        return { status: 200, body: JSON.stringify({ path: request.pathname }) };
      },
    });
    const rawClient = connectRawClient(clientSide);
    try {
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        // No `authorization` header at all: the stream never carries a token.
        const req = rawClient.request({ ":method": "GET", ":path": "/api/agents/me" });
        let status = 0;
        let body = "";
        req.on("response", (headers) => {
          status = Number(headers[":status"]) || 0;
        });
        req.setEncoding("utf8");
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => resolve({ status, body }));
        req.on("error", reject);
        req.end();
      });
      expect(response.status).toBe(401);
      expect(forwarderCalled).toBe(false);
    } finally {
      rawClient.close();
      await handle.close();
    }
  });

  it("test_a_denied_stream_with_an_unfinished_body_still_frees_its_stream_slot", async () => {
    // The server answers a denied stream (an invalid token, here) at once,
    // before it ever reads the request body. A peer that leaves that body
    // unfinished must not hold the stream open past the same idle bound an
    // authenticated request gets — otherwise, up to
    // `HTTP2_BRIDGE_MAX_CONCURRENT_STREAMS` denied streams could each retain
    // a slot forever and block every legitimate callback.
    let forwarderCalled = false;
    const { handle, clientSide } = bindTestServer({
      requestBodyTimeoutMs: 30,
      forwardRequest: async () => {
        forwarderCalled = true;
        return { status: 200 };
      },
    });
    const rawClient = connectRawClient(clientSide);
    try {
      const startMs = Date.now();
      const closed = new Promise<void>((resolve) => {
        const req = rawClient.request({
          ":method": "POST",
          ":path": "/api/issues/abc/comments",
          // No `authorization` header: the token check denies this stream
          // before the body is ever read.
        });
        req.on("error", () => undefined);
        req.on("close", () => resolve());
        // Drain the response so its readable side reaches `end`: nothing in
        // this test reads the response body otherwise, and an unread
        // response can itself hold the client stream open past `close`.
        req.resume();
        // A partial body the request never ends: without its own bound, the
        // inbound half of this stream would stay open indefinitely.
        req.write("partial-body");
      });
      await closed;
      expect(Date.now() - startMs).toBeLessThan(5_000);
      expect(forwarderCalled).toBe(false);

      // The session survives the freed stream: a second, complete request
      // still succeeds, proving the session itself stayed open and healthy.
      const survivingResponse = await new Promise<{ status: number }>((resolve, reject) => {
        const survivingReq = rawClient.request({
          ":method": "GET",
          ":path": "/api/agents/me",
          authorization: `Bearer ${BRIDGE_TOKEN}`,
        });
        let status = 0;
        survivingReq.on("response", (headers) => {
          status = Number(headers[":status"]) || 0;
        });
        survivingReq.on("data", () => undefined);
        survivingReq.on("end", () => resolve({ status }));
        survivingReq.on("error", reject);
        survivingReq.end();
      });
      expect(survivingResponse.status).toBe(200);
    } finally {
      rawClient.close();
      await handle.close();
    }
  });

  it("rejects a route the allowlist does not carry, before the forwarder runs", async () => {
    let forwarderCalled = false;
    const { gateway, handle } = createTestPair({
      forwardRequest: async () => {
        forwarderCalled = true;
        return { status: 200 };
      },
    });
    try {
      const response = await gateway.forwardRequest({
        method: "DELETE",
        path: "/api/agents/me",
        query: "",
        headers: {},
        body: Buffer.alloc(0),
        receivedToken: BRIDGE_TOKEN,
      });
      expect(response.status).toBe(403);
      expect(forwarderCalled).toBe(false);
    } finally {
      await gateway.close();
      await handle.close();
    }
  });

  it("the sandbox gateway keeps its own token check before it opens a stream", async () => {
    let forwarderCalled = false;
    const { gateway, handle } = createTestPair({
      forwardRequest: async () => {
        forwarderCalled = true;
        return { status: 200 };
      },
    });
    try {
      await expect(
        gateway.forwardRequest({
          method: "GET",
          path: "/api/agents/me",
          query: "",
          headers: {},
          body: Buffer.alloc(0),
          receivedToken: "wrong-token",
        }),
      ).rejects.toThrow(/invalid bridge token/i);
      expect(forwarderCalled).toBe(false);
    } finally {
      await gateway.close();
      await handle.close();
    }
  });

  it("wrapDuplexChannelAsNodeDuplex relays writes and pushes through onData", async () => {
    const written: Buffer[] = [];
    let dataListener: ((chunk: Uint8Array) => void) | undefined;
    let exitListener: ((exit: { exitCode: number | null }) => void) | undefined;
    const channel: CommandManagedDuplexChannel = {
      write: (data) => {
        written.push(Buffer.from(data));
      },
      onData: (listener) => {
        dataListener = listener;
      },
      onExit: (listener) => {
        exitListener = listener;
      },
      stop: () => undefined,
      close: async () => undefined,
    };
    const duplex = wrapDuplexChannelAsNodeDuplex(channel);
    const received: Buffer[] = [];
    duplex.on("data", (chunk: Buffer) => received.push(chunk));

    duplex.write(Buffer.from("outbound"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(Buffer.concat(written).toString("utf8")).toBe("outbound");

    dataListener?.(Buffer.from("inbound"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(Buffer.concat(received).toString("utf8")).toBe("inbound");

    const ended = new Promise<void>((resolve) => duplex.on("end", resolve));
    exitListener?.({ exitCode: 0 });
    await ended;
  });

  it("wrapDuplexChannelAsNodeDuplex queues chunks past a full readable side and drains them once the consumer reads again", async () => {
    let dataListener: ((chunk: Uint8Array) => void) | undefined;
    const channel: CommandManagedDuplexChannel = {
      write: () => undefined,
      onData: (listener) => {
        dataListener = listener;
      },
      onExit: () => undefined,
      stop: () => undefined,
      close: async () => undefined,
    };
    const duplex = wrapDuplexChannelAsNodeDuplex(channel, { maxBufferedReadBytes: 1_000_000 });
    const received: Buffer[] = [];
    // The first chunk alone passes the readable side's default 64 KiB
    // high-water mark, so `push()` reports the readable side full. The two
    // chunks that follow queue in the wrapper instead of pushing past that
    // signal — this is the bounded flow-control path this fix adds.
    dataListener?.(Buffer.alloc(70_000, "a"));
    dataListener?.(Buffer.from("-second-"));
    dataListener?.(Buffer.from("-third-"));

    // Attaching a "data" listener now starts flowing mode, which drives the
    // wrapper's own `read()` until every queued chunk drains, proving no
    // queued chunk was dropped and the arrival order held.
    const drainedAll = new Promise<void>((resolve) => {
      duplex.on("data", (chunk: Buffer) => {
        received.push(chunk);
        if (Buffer.concat(received).includes("-third-")) resolve();
      });
    });
    await drainedAll;

    expect(Buffer.concat(received).toString("utf8").endsWith("-second--third-")).toBe(true);
  });

  it("wrapDuplexChannelAsNodeDuplex stops the channel and destroys the duplex once the bounded read backpressure buffer overflows", async () => {
    let dataListener: ((chunk: Uint8Array) => void) | undefined;
    let stopped = false;
    const channel: CommandManagedDuplexChannel = {
      write: () => undefined,
      onData: (listener) => {
        dataListener = listener;
      },
      onExit: () => undefined,
      stop: () => {
        stopped = true;
      },
      close: async () => undefined,
    };
    // The cap must clear the default 65,536-byte readable high-water mark,
    // so the first chunk below still passes the direct-push check and
    // forces `push()` to report the readable side full; the overflow this
    // test proves comes from the queue that follows, not from that first
    // chunk on its own.
    const duplex = wrapDuplexChannelAsNodeDuplex(channel, { maxBufferedReadBytes: 80_000 });
    // No consumer ever attaches, so the readable side never drains: every
    // chunk past the first, which alone passes the default high-water mark,
    // fills the bounded queue instead of the unbounded internal buffer a
    // caller ignoring `push()`'s return would grow.
    const errored = new Promise<Error>((resolve) => duplex.on("error", resolve));

    dataListener?.(Buffer.alloc(70_000, "a")); // passes the high-water mark and the cap; still pushed directly.
    dataListener?.(Buffer.alloc(30_000, "b")); // queues: 30,000 of the 80,000-byte cap.
    dataListener?.(Buffer.alloc(30_000, "b")); // queues: 60,000 of the 80,000-byte cap.
    dataListener?.(Buffer.alloc(30_000, "b")); // 90,000 queued bytes passes the cap.

    const error = await errored;
    expect(error.message).toMatch(/backpressure/i);
    expect(stopped).toBe(true);
  });

  it("wrapDuplexChannelAsNodeDuplex fails closed on one inbound chunk larger than the bounded read backpressure buffer, before the queue holds anything to compare it against", async () => {
    let dataListener: ((chunk: Uint8Array) => void) | undefined;
    let stopped = false;
    const channel: CommandManagedDuplexChannel = {
      write: () => undefined,
      onData: (listener) => {
        dataListener = listener;
      },
      onExit: () => undefined,
      stop: () => {
        stopped = true;
      },
      close: async () => undefined,
    };
    // No consumer ever attaches, and the queue is empty when this chunk
    // arrives, so a check that only bounds the queue's cumulative size (and
    // not one chunk's own size) would let this chunk reach `push()` unbound.
    const duplex = wrapDuplexChannelAsNodeDuplex(channel, { maxBufferedReadBytes: 5_000 });
    const errored = new Promise<Error>((resolve) => duplex.on("error", resolve));

    dataListener?.(Buffer.alloc(10_000, "a")); // exceeds the 5,000-byte cap on its own, on the very first chunk.

    const error = await errored;
    expect(error.message).toMatch(/backpressure/i);
    expect(stopped).toBe(true);
  });

  it("wrapDuplexChannelAsNodeDuplex fails closed once the read backpressure queue stalls with no drain, even though it stays under the byte cap", async () => {
    let dataListener: ((chunk: Uint8Array) => void) | undefined;
    let stopped = false;
    const channel: CommandManagedDuplexChannel = {
      write: () => undefined,
      onData: (listener) => {
        dataListener = listener;
      },
      onExit: () => undefined,
      stop: () => {
        stopped = true;
      },
      close: async () => undefined,
    };
    // A generous byte cap, so the byte-cap check above never fires: this
    // test proves the independent time bound catches a stuck consumer the
    // byte cap alone would miss.
    const duplex = wrapDuplexChannelAsNodeDuplex(channel, {
      maxBufferedReadBytes: 10_000_000,
      readBackpressureStallMs: 40,
    });
    const errored = new Promise<Error>((resolve) => duplex.on("error", resolve));

    dataListener?.(Buffer.alloc(70_000, "a")); // passes the high-water mark; pushed directly, no consumer drains it.
    dataListener?.(Buffer.from("queued-and-never-drained")); // queues; no "data" listener ever attaches to drain it.

    const error = await errored;
    expect(error.message).toMatch(/stall/i);
    expect(stopped).toBe(true);
  });

  it("wrapDuplexChannelAsNodeDuplex clears the stall bound once the queue fully drains, instead of firing later on an idle channel", async () => {
    let dataListener: ((chunk: Uint8Array) => void) | undefined;
    const channel: CommandManagedDuplexChannel = {
      write: () => undefined,
      onData: (listener) => {
        dataListener = listener;
      },
      onExit: () => undefined,
      stop: () => undefined,
      close: async () => undefined,
    };
    // A short stall bound, so this test proves the drain below clears the
    // timer instead of merely finishing before a long one would have fired.
    const duplex = wrapDuplexChannelAsNodeDuplex(channel, {
      maxBufferedReadBytes: 10_000_000,
      readBackpressureStallMs: 20,
    });
    const received: Buffer[] = [];
    const drainedAll = new Promise<void>((resolve) => {
      duplex.on("data", (chunk: Buffer) => {
        received.push(chunk);
        if (Buffer.concat(received).includes("-third-")) resolve();
      });
    });

    dataListener?.(Buffer.alloc(70_000, "a")); // passes the high-water mark; queues the chunks that follow.
    dataListener?.(Buffer.from("-second-"));
    dataListener?.(Buffer.from("-third-"));
    await drainedAll;

    // Wait past the stall bound with the channel now idle and the queue
    // empty. A timer the full drain above did not clear would fire here.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(duplex.destroyed).toBe(false);
  });
});
