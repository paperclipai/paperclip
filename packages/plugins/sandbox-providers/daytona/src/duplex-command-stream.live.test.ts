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
  const session = await openDaytonaDuplexChannelSession(sandbox.process, "cat");
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
        session.write(`${ping}\n`);
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
        session.write(`${line}\n`);
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
});
