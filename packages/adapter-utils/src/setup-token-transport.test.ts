import { describe, expect, it } from "vitest";
import {
  createSetupTokenPtyTransport,
  type SetupTokenPtySession,
} from "./setup-token-transport.js";

// The Enter byte the terminal login UI reads to submit the browser code. The
// login runner appends this byte to the code. The transport forwards the bytes
// unchanged, so the pseudo-terminal receives the code and then the Enter byte.
const ENTER = "\r";

/**
 * A fake pseudo-terminal session. It records each input write, drives the output
 * stream on demand, and records the stop and the close. The tests use it in
 * place of a real pseudo-terminal, so the transport runs with no sandbox.
 */
function createFakePtySession(): SetupTokenPtySession & {
  writes: string[];
  emit: (chunk: string) => void;
  finish: (exitCode: number | null) => void;
  killed: number;
  closed: number;
  // Resolves when the transport registers the output listener. The session
  // streams only after it opens, so a test waits on this before it drives the
  // output or stops the child.
  ready: Promise<void>;
} {
  const writes: string[] = [];
  let listener: ((chunk: string) => void) | null = null;
  let resolveWait: ((value: { exitCode: number | null }) => void) | null = null;
  const waitPromise = new Promise<{ exitCode: number | null }>((resolve) => {
    resolveWait = resolve;
  });
  let markReady: (() => void) | null = null;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  let killed = 0;
  let closed = 0;
  return {
    ready,
    onData(next: (chunk: string) => void): void {
      listener = next;
      markReady?.();
    },
    write(data: string): void {
      writes.push(data);
    },
    wait(): Promise<{ exitCode: number | null }> {
      return waitPromise;
    },
    kill(): void {
      killed += 1;
    },
    async close(): Promise<void> {
      closed += 1;
    },
    // Test control below. The transport never reads these fields.
    emit(chunk: string): void {
      listener?.(chunk);
    },
    finish(exitCode: number | null): void {
      resolveWait?.({ exitCode });
    },
    get writes(): string[] {
      return writes;
    },
    get killed(): number {
      return killed;
    },
    get closed(): number {
      return closed;
    },
  };
}

describe("createSetupTokenPtyTransport", () => {
  it("delivers delayed input to the process", async () => {
    const session = createFakePtySession();
    const transport = createSetupTokenPtyTransport(async () => session);

    const started = transport.start("claude setup-token", () => {});
    await session.ready;
    // The input arrives after the start and after the first output, so the
    // transport delivers it to the running process, not before it.
    session.emit("... the url below to sign in ...");
    transport.write("ABCD");
    session.finish(0);
    await started;

    expect(session.writes).toEqual(["ABCD"]);
  });

  it("returns incremental terminal output to the runner", async () => {
    const session = createFakePtySession();
    const received: string[] = [];
    const transport = createSetupTokenPtyTransport(async () => session);

    const started = transport.start("claude setup-token", (chunk) => {
      received.push(chunk);
    });
    await session.ready;

    // Each output chunk reaches the runner as the pseudo-terminal emits it, not
    // as one final batch at the end.
    session.emit("first ");
    expect(received).toEqual(["first "]);
    session.emit("second");
    expect(received).toEqual(["first ", "second"]);

    session.finish(0);
    await started;
  });

  it("delivers the Enter byte after the browser code", async () => {
    const session = createFakePtySession();
    const transport = createSetupTokenPtyTransport(async () => session);

    const started = transport.start("claude setup-token", () => {});
    await session.ready;
    // The runner writes the code plus the Enter byte in one write. The transport
    // forwards the bytes unchanged, so the code comes first and the Enter byte
    // comes last.
    transport.write("WXYZ" + ENTER);
    session.finish(0);
    await started;

    const delivered = session.writes.join("");
    expect(delivered).toBe("WXYZ" + ENTER);
    expect(delivered.endsWith(ENTER)).toBe(true);
    expect(delivered.indexOf("WXYZ")).toBeLessThan(delivered.lastIndexOf(ENTER));
  });

  it("resolves start with the child exit code", async () => {
    const session = createFakePtySession();
    const transport = createSetupTokenPtyTransport(async () => session);

    const started = transport.start("claude setup-token", () => {});
    session.finish(7);

    await expect(started).resolves.toEqual({ exitCode: 7 });
  });

  it("stops the child with a direct kill", async () => {
    const session = createFakePtySession();
    const transport = createSetupTokenPtyTransport(async () => session);

    const started = transport.start("claude setup-token", () => {});
    await session.ready;
    transport.stop();
    expect(session.killed).toBe(1);

    session.finish(null);
    await started;
  });

  it("disposes the session resources", async () => {
    const session = createFakePtySession();
    const transport = createSetupTokenPtyTransport(async () => session);

    const started = transport.start("claude setup-token", () => {});
    session.finish(0);
    await started;

    await transport.dispose();
    expect(session.closed).toBe(1);
  });

  it("stays safe when stop and dispose run before start", async () => {
    const session = createFakePtySession();
    const transport = createSetupTokenPtyTransport(async () => session);

    // The runner may stop or dispose before it starts the child. The transport
    // must not throw, and it must not open a session for a run it already stopped.
    transport.stop();
    await transport.dispose();

    expect(session.killed).toBe(0);
    expect(session.closed).toBe(0);
  });

  it("kills a session that opens after an early stop", async () => {
    const session = createFakePtySession();
    let resolveOpen!: () => void;
    const openGate = new Promise<void>((resolve) => {
      resolveOpen = resolve;
    });
    const transport = createSetupTokenPtyTransport(async () => {
      await openGate;
      return session;
    });

    const started = transport.start("claude setup-token", () => {});
    // The stop arrives while the session is still opening. The transport must
    // kill the child as soon as the session exists.
    transport.stop();
    resolveOpen();
    session.finish(null);
    await started;

    expect(session.killed).toBe(1);
  });

  it("buffers input that arrives before the session opens", async () => {
    const session = createFakePtySession();
    let resolveOpen!: () => void;
    const openGate = new Promise<void>((resolve) => {
      resolveOpen = resolve;
    });
    const transport = createSetupTokenPtyTransport(async () => {
      await openGate;
      return session;
    });

    const started = transport.start("claude setup-token", () => {});
    transport.write("EARLY" + ENTER);
    expect(session.writes).toEqual([]);

    resolveOpen();
    // Let the pending open resolve and flush the buffered input.
    await Promise.resolve();
    await Promise.resolve();
    expect(session.writes).toEqual(["EARLY" + ENTER]);

    session.finish(0);
    await started;
  });
});
