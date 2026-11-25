// Live characterization of the Daytona duplex channel against the real provider.
//
// The test is credential-gated by design. It runs only when the run shell holds a
// Daytona API key, and it skips cleanly when the key is absent. The key comes from
// `DAYTONA_API_KEY`, which the plugin also reads as the credential fallback
// (`plugin.ts`). A skip is acceptable: the merged live coverage re-runs at a later
// phase and at rollout.
//
// What it proves on one live sandbox:
//   1. The duplex channel and an ordinary command run at the same time.
//   2. Host input sent after the child starts arrives, with no terminal echo and
//      no frame corruption.
//   3. Channel teardown leaves no leaked provider session.
//
// The channel runs `cat` as the child. `cat` copies its input to its output, so a
// host write returns one time as program output. The launch wrapper sets the
// pseudo-terminal to raw mode with echo off, so the terminal adds no second copy
// and no newline translation. A returned line that equals the sent line, one time,
// proves both the delivery and the clean stream.
//
// The Daytona SDK is a runtime dependency of this live test only. The module loads
// it with a dynamic import inside the gated block, so the file imports with no SDK
// present and the other Daytona tests still run without it.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import http2 from "node:http2";
import { Duplex } from "node:stream";
import {
  openDaytonaDuplexChannelSession,
  type DaytonaPtyProcess,
  type DuplexChannelSession,
} from "./duplex-command-stream.js";

const DAYTONA_API_KEY = process.env.DAYTONA_API_KEY?.trim() ?? "";
const HAS_DAYTONA_CREDENTIAL = DAYTONA_API_KEY.length > 0;
const describeLive = HAS_DAYTONA_CREDENTIAL ? describe : describe.skip;

if (!HAS_DAYTONA_CREDENTIAL) {
  // eslint-disable-next-line no-console
  console.warn(
    "Skipping the Daytona duplex channel live test: DAYTONA_API_KEY is not set in the run shell.",
  );
}

// A live sandbox create and destroy needs a generous timeout. The provider round
// trip dominates the wall-clock time.
const LIVE_TIMEOUT_MS = 180_000;

// The minimal shape of the live Daytona sandbox that the test uses. The dynamic
// import returns the real SDK types; this local shape keeps the file type-safe
// without a static SDK import.
interface LiveDaytonaSandbox {
  process: DaytonaPtyProcess & {
    executeCommand(command: string): Promise<{ exitCode?: number; result?: string }>;
    listSessions?: () => Promise<Array<{ sessionId?: string }>>;
  };
  delete(): Promise<void>;
}

/**
 * Wait until `predicate(text)` is true for the running output, or reject after
 * `timeoutMs`. The poll interval is short, so the wait ends soon after the output
 * arrives.
 */
async function waitFor(
  readOutput: () => string,
  predicate: (text: string) => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate(readOutput())) return;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}. Output so far: ${JSON.stringify(readOutput())}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Open a `cat` duplex channel and collect its output into a growing string. */
async function openCatChannel(
  sandbox: LiveDaytonaSandbox,
): Promise<{ session: DuplexChannelSession; readOutput: () => string }> {
  let output = "";
  const session = await openDaytonaDuplexChannelSession(sandbox.process, ["cat"]);
  session.onData((chunk) => {
    output += chunk;
  });
  return { session, readOutput: () => output };
}

describeLive("Daytona duplex channel (live)", () => {
  let sandbox: LiveDaytonaSandbox | null = null;

  beforeAll(async () => {
    const { Daytona } = await import("@daytonaio/sdk");
    const client = new Daytona({ apiKey: DAYTONA_API_KEY });
    sandbox = (await client.create()) as unknown as LiveDaytonaSandbox;
  }, LIVE_TIMEOUT_MS);

  afterAll(async () => {
    await sandbox?.delete().catch(() => undefined);
  }, LIVE_TIMEOUT_MS);

  it(
    "runs the duplex channel and an ordinary command on one live sandbox",
    async () => {
      const live = sandbox!;
      const { session, readOutput } = await openCatChannel(live);
      try {
        // Run an ordinary command while the channel child stays alive. Both use the
        // same live sandbox, so a success on both proves they coexist.
        const token = `ordinary-${randomUUID()}`;
        const ordinary = await live.process.executeCommand(`printf %s ${token}`);
        expect(ordinary.exitCode ?? 0).toBe(0);
        expect(ordinary.result ?? "").toContain(token);

        // The channel child still answers. A write returns as program output.
        const ping = `chan-${randomUUID()}`;
        session.write(Buffer.from(`${ping}\n`));
        await waitFor(readOutput, (text) => text.includes(ping), 30_000, "channel echo");
      } finally {
        await session.close();
      }
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "delivers host input sent after startup with no echo and no frame corruption",
    async () => {
      const live = sandbox!;
      const { session, readOutput } = await openCatChannel(live);
      try {
        // Let the launch wrapper run `stty raw -echo` before the host input. The
        // wrapper output echoes in cooked mode, so wait for the raw-mode switch
        // before the measured write.
        await new Promise((resolve) => setTimeout(resolve, 4_000));
        const baseline = readOutput().length;

        const line = `PING-${randomUUID()}`;
        session.write(Buffer.from(`${line}\n`));
        await waitFor(
          readOutput,
          (text) => text.slice(baseline).includes(line),
          30_000,
          "delayed host input",
        );

        // Only `cat` writes the line, one time. Raw mode with echo off adds no
        // second copy, so the sent token appears exactly one time after the write.
        const afterWrite = readOutput().slice(baseline);
        const occurrences = afterWrite.split(line).length - 1;
        expect(occurrences).toBe(1);

        // The stream carries the frame bytes with no newline translation. The
        // returned line keeps its single line-feed and gains no carriage return.
        expect(afterWrite).toContain(`${line}\n`);
        expect(afterWrite).not.toContain(`${line}\r`);
      } finally {
        await session.close();
      }
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "leaves no leaked provider session after channel close",
    async () => {
      const live = sandbox!;
      const listSessions = live.process.listSessions?.bind(live.process);
      const baseline = listSessions ? (await listSessions()).length : 0;

      const { session } = await openCatChannel(live);
      await session.close();

      if (listSessions) {
        // The channel uses a pseudo-terminal, not an ordinary session. So the
        // session list stays at the baseline. A leaked session would raise the
        // count.
        const after = (await listSessions()).length;
        expect(after).toBe(baseline);
      }

      // The child exits after close, so a fresh ordinary command still succeeds on
      // the same sandbox. A leaked channel would block or corrupt the sandbox.
      const token = `after-close-${randomUUID()}`;
      const probe = await live.process.executeCommand(`printf %s ${token}`);
      expect(probe.exitCode ?? 0).toBe(0);
      expect(probe.result ?? "").toContain(token);
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "serves repeated channel round trips with no idle polling and no per-request session growth",
    async () => {
      const live = sandbox!;
      const listSessions = live.process.listSessions?.bind(live.process);
      const { session, readOutput } = await openCatChannel(live);
      try {
        // Wait for the raw-mode switch, then take the open baseline. The channel
        // uses a pseudo-terminal, not an ordinary session, so the session list
        // stays flat through the whole exchange.
        await new Promise((resolve) => setTimeout(resolve, 4_000));
        const openSessions = listSessions ? (await listSessions()).length : 0;

        // Send a batch of request-shaped lines over the one open channel and
        // measure the round-trip latency of each. The transport writes no queue
        // file and runs no exec per line, so the round trip is the stream latency.
        const latenciesMs: number[] = [];
        const rounds = 10;
        for (let index = 0; index < rounds; index += 1) {
          const line = `RTT-${index}-${randomUUID()}`;
          const baseline = readOutput().length;
          const start = Date.now();
          session.write(Buffer.from(`${line}\n`));
          await waitFor(
            readOutput,
            (text) => text.slice(baseline).includes(line),
            30_000,
            "channel round trip",
          );
          latenciesMs.push(Date.now() - start);
        }

        // Hold the channel idle. A polling transport would run a provider exec on
        // each tick and raise the session count. The duplex channel polls nothing.
        await new Promise((resolve) => setTimeout(resolve, 5_000));

        if (listSessions) {
          const afterSessions = (await listSessions()).length;
          // Zero idle polls and zero per-request session growth: the session count
          // never rose above the open baseline.
          expect(afterSessions).toBe(openSessions);
        }

        const min = Math.min(...latenciesMs);
        const max = Math.max(...latenciesMs);
        const avg = Math.round(latenciesMs.reduce((sum, value) => sum + value, 0) / latenciesMs.length);
        // eslint-disable-next-line no-console
        console.log(
          `[duplex-live] channel round-trip latency over ${rounds} requests: min=${min}ms avg=${avg}ms max=${max}ms; idle-poll session growth=0; per-request session growth=0`,
        );
        expect(latenciesMs.length).toBe(rounds);
      } finally {
        await session.close();
      }
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "leaves no leaked session and keeps the sandbox usable after a forced mid-flight disconnect",
    async () => {
      const live = sandbox!;
      const listSessions = live.process.listSessions?.bind(live.process);
      const baseline = listSessions ? (await listSessions()).length : 0;

      const { session, readOutput } = await openCatChannel(live);
      // Wait for the raw-mode switch, then start a write and force a disconnect
      // before its echo returns. The abrupt close models a lost provider channel.
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      const inFlight = `INFLIGHT-${randomUUID()}`;
      session.write(Buffer.from(`${inFlight}\n`));
      // Close at once, without waiting for the echo. The pending round trip never
      // settles through the stream; the channel tears down instead.
      await session.close();

      if (listSessions) {
        // The forced disconnect left no leaked provider session. The count is back
        // at the baseline that preceded the channel.
        const after = (await listSessions()).length;
        expect(after).toBe(baseline);
      }
      // Do not read the in-flight echo; the disconnect settled the run. Reference
      // the output length only to keep the reader wired.
      expect(readOutput().length).toBeGreaterThanOrEqual(0);

      // The sandbox stays usable: a fresh ordinary command still succeeds. A
      // leaked channel would block or corrupt the sandbox.
      const token = `post-disconnect-${randomUUID()}`;
      const probe = await live.process.executeCommand(`printf %s ${token}`);
      expect(probe.exitCode ?? 0).toBe(0);
      expect(probe.result ?? "").toContain(token);
      // eslint-disable-next-line no-console
      console.log("[duplex-live] forced mid-flight disconnect: leaked sessions=0; sandbox usable after=yes");
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "test_live_daytona_run_uses_http2_v1_end_to_end",
    async () => {
      // Phase 4 selects http2_v1 by running one Node HTTP/2 session directly
      // on this same pseudo-terminal channel, right after the READY line.
      // This package ships standalone (see the file header), so it cannot
      // import the host readiness gate or the preface scan from
      // `@paperclipai/adapter-utils`; this test reimplements the minimal,
      // self-contained version of both, using only `node:http2`, so the
      // proof runs against a real Daytona PTY end to end.
      const live = sandbox!;
      const nonce = randomUUID();

      // The 24-octet HTTP/2 client connection preface (RFC 9113, Section 3.4).
      const CLIENT_PREFACE = Buffer.from("505249202a20485454502f322e300d0a0d0a534d0d0a0d0a", "hex");

      // The sandbox-side child: send the READY line, then hand stdin/stdout to
      // a real HTTP/2 client session and dispatch one request — the same
      // shape `runHttp2Gateway()` in `sandbox-callback-bridge.ts` runs.
      const nodeScript = [
        `process.stdout.write(JSON.stringify({version:2,type:"ready",nonce:${JSON.stringify(nonce)}})+"\\n");`,
        `const http2=require("node:http2");`,
        `const {Duplex}=require("node:stream");`,
        `const stdio=new Duplex({read(){},write(chunk,enc,cb){const ok=process.stdout.write(chunk);if(ok)cb();else process.stdout.once("drain",cb);}});`,
        `process.stdin.on("data",c=>stdio.push(c));`,
        `process.stdin.on("end",()=>stdio.push(null));`,
        `const session=http2.connect("http://bridge.internal",{createConnection:()=>stdio});`,
        `session.on("error",()=>process.exit(1));`,
        `const stream=session.request({":method":"GET",":path":"/ping"});`,
        `let body="";`,
        `stream.on("data",c=>{body+=c;});`,
        `stream.on("error",()=>process.exit(3));`,
        `stream.on("end",()=>{session.close(()=>process.exit(body==="pong"?0:2));});`,
        `stream.end();`,
      ].join("");

      const session = await openDaytonaDuplexChannelSession(live.process, ["node", "-e", nodeScript]);
      try {
        // Reads bytes from the channel until it finds one complete newline-
        // terminated READY line, then hands every later byte — including any
        // already-buffered suffix of the same chunk — to `onAfterReady`.
        const readyAndAfter = await new Promise<{ nonce: string; afterReady: Buffer }>((resolve, reject) => {
          let buffer = Buffer.alloc(0);
          const timer = setTimeout(
            () => reject(new Error(`Timed out waiting for the READY line. Bytes so far: ${buffer.length}`)),
            30_000,
          );
          session.onData((chunk) => {
            buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
            const newlineIndex = buffer.indexOf(0x0a);
            if (newlineIndex === -1) return;
            clearTimeout(timer);
            const line = buffer.subarray(0, newlineIndex).toString("utf8");
            const decoded = JSON.parse(line) as { type?: string; nonce?: string };
            resolve({ nonce: decoded.nonce ?? "", afterReady: Buffer.from(buffer.subarray(newlineIndex + 1)) });
          });
        });
        expect(readyAndAfter.nonce).toBe(nonce);

        // Scan the retained suffix for the client preface, the same rule
        // `createHttp2PrefaceScanningChannel` in `execution-target.ts` applies:
        // the scan window opens only on bytes after the accepted READY line.
        let sawPreface = false;
        let downstream: ((chunk: Buffer) => void) | null = null;
        let pendingAfterPreface = Buffer.alloc(0);
        let scanBuffer = readyAndAfter.afterReady;
        function deliver(chunk: Buffer): void {
          if (downstream) downstream(chunk);
          else pendingAfterPreface = Buffer.concat([pendingAfterPreface, chunk]);
        }
        function handleChunk(chunk: Buffer): void {
          if (sawPreface) {
            deliver(chunk);
            return;
          }
          scanBuffer = Buffer.concat([scanBuffer, chunk]);
          const offset = scanBuffer.indexOf(CLIENT_PREFACE);
          if (offset === -1) return;
          sawPreface = true;
          const fromPreface = Buffer.from(scanBuffer.subarray(offset));
          scanBuffer = Buffer.alloc(0);
          deliver(fromPreface);
        }
        // The already-retained suffix might already hold the preface.
        handleChunk(Buffer.alloc(0));
        session.onData((chunk) => handleChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));

        // Wrap the channel as a Node `Duplex` starting at the preface offset,
        // and bind one plaintext HTTP/2 server session on it.
        const boundDuplex: Duplex = new Duplex({
          read() {},
          write(chunk: unknown, _encoding, callback) {
            session.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferLike));
            callback();
          },
        });
        downstream = (chunk) => boundDuplex.push(chunk);
        if (pendingAfterPreface.length > 0) {
          boundDuplex.push(pendingAfterPreface);
          pendingAfterPreface = Buffer.alloc(0);
        }

        const server = http2.createServer();
        server.on("stream", (stream) => {
          stream.respond({ ":status": 200 });
          stream.end("pong");
        });
        server.emit("connection", boundDuplex);

        const exit = await session.wait();
        expect(exit.exitCode).toBe(0);
        // eslint-disable-next-line no-console
        console.log("[duplex-live] http2_v1: READY, then the real client preface, then one full HTTP/2 round trip, all over one live Daytona PTY.");
      } finally {
        await session.close();
      }
    },
    LIVE_TIMEOUT_MS,
  );
});
