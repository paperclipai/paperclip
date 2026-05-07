import { describe, expect, it } from "vitest";
import {
  chunkHasNonStallOutput,
  codexUpstreamKeepaliveLinePrefix,
  createCodexUpstreamKeepalive,
  findCodexUpstreamStreamSignal,
  isCodexUpstreamStreamSignal,
} from "./upstream-keepalive.js";

// Fixture lines extracted from the EIG-281 run-log (b988ba64) — they shape the
// real upstream-stream-stall behaviour the keepalive must defend against.
const EIG_281_STALL_LINES = [
  // seq 5 — the rmcp fatal that started the silence window
  "worker quit with fatal: Client error: HTTP request failed: HTTP error: status code: 401 (Unauthorized) for url: https://chatgpt.com/backend-api/wham/apps, when send initialized notification",
  // seq 7 / seq 9 — codex SSE reconnect lines (when they finally surface)
  "error: Reconnecting... 2/5 (stream disconnected before completion: Connection reset by peer (os error 54))",
  "Reconnecting... 3/5",
  // seq 13 — rollout-thread-not-found stderr right at the recovery boundary
  "failed to record rollout items: thread 019dfec9-3e5d-7f90-8d38-1c71dbca858a not found",
  // models-manager refresh timeout (seq 2 / seq 6)
  "codex_models_manager: failed to refresh available models: timeout",
];

const EIG_281_NORMAL_LINES = [
  JSON.stringify({ type: "thread.started", thread_id: "019dfec9-3e5d-7f90-8d38-1c71dbca858a" }),
  JSON.stringify({ type: "turn.started" }),
  JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "no work — empty inbox" },
  }),
  JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 671000, output_tokens: 2000 },
  }),
];

type Captured = { stream: "stdout" | "stderr"; chunk: string };

function makeFakeTimer() {
  type Entry = { handler: () => void; intervalMs: number; nextDueAt: number };
  let current = 0;
  const entries = new Map<symbol, Entry>();
  return {
    now: () => current,
    setIntervalImpl: (handler: () => void, intervalMs: number) => {
      const handle = Symbol("interval");
      entries.set(handle, {
        handler,
        intervalMs,
        nextDueAt: current + intervalMs,
      });
      return handle;
    },
    clearIntervalImpl: (handle: unknown) => {
      if (typeof handle === "symbol") entries.delete(handle);
    },
    advance: (ms: number) => {
      const target = current + ms;
      // Fire any intervals whose next-due timestamp falls inside the window.
      // Loop because handlers can advance/clear other entries.
      while (true) {
        let nextHandle: symbol | null = null;
        let nextDueAt = Number.POSITIVE_INFINITY;
        for (const [handle, entry] of entries) {
          if (entry.nextDueAt <= target && entry.nextDueAt < nextDueAt) {
            nextHandle = handle;
            nextDueAt = entry.nextDueAt;
          }
        }
        if (nextHandle == null) break;
        const entry = entries.get(nextHandle);
        if (!entry) break;
        current = entry.nextDueAt;
        entry.nextDueAt = current + entry.intervalMs;
        entry.handler();
      }
      current = target;
    },
    activeCount: () => entries.size,
  };
}

function makeController(opts: {
  intervalMs: number;
  maxEmits?: number;
  captured: Captured[];
  fake: ReturnType<typeof makeFakeTimer>;
}) {
  return createCodexUpstreamKeepalive({
    intervalMs: opts.intervalMs,
    maxEmits: opts.maxEmits,
    emit: (stream, chunk) => {
      opts.captured.push({ stream, chunk });
    },
    setIntervalImpl: opts.fake.setIntervalImpl,
    clearIntervalImpl: opts.fake.clearIntervalImpl,
    now: opts.fake.now,
  });
}

describe("isCodexUpstreamStreamSignal / findCodexUpstreamStreamSignal", () => {
  it.each(EIG_281_STALL_LINES)("matches EIG-281 stall fixture: %s", (line) => {
    expect(isCodexUpstreamStreamSignal(line)).toBe(true);
    expect(findCodexUpstreamStreamSignal(line)).not.toBeNull();
  });

  it.each(EIG_281_NORMAL_LINES)("does not match normal codex JSONL line: %s", (line) => {
    expect(isCodexUpstreamStreamSignal(line)).toBe(false);
    expect(findCodexUpstreamStreamSignal(line)).toBeNull();
  });

  it("never re-detects its own keepalive output as a signal", () => {
    const sample =
      `${codexUpstreamKeepaliveLinePrefix()} (last signal: "Reconnecting... 3/5"; keepalive #4 at 2026-05-07T22:24:00.000Z)`;
    expect(isCodexUpstreamStreamSignal(sample)).toBe(false);
    expect(findCodexUpstreamStreamSignal(sample)).toBeNull();
  });

  it("scans multi-line chunks for the first signal", () => {
    const chunk = `prelude line\n${EIG_281_STALL_LINES[1]}\nfollow-up`;
    expect(findCodexUpstreamStreamSignal(chunk)).toMatch(/Reconnecting\.\.\. 2\/5/);
  });

  it("truncates very long signal lines", () => {
    const long = `Reconnecting... 4/5 ${"x".repeat(500)}`;
    const found = findCodexUpstreamStreamSignal(long);
    expect(found).not.toBeNull();
    expect(found!.length).toBeLessThanOrEqual(241);
    expect(found!.endsWith("…")).toBe(true);
  });
});

describe("chunkHasNonStallOutput", () => {
  it("treats normal codex JSONL output as non-stall", () => {
    expect(chunkHasNonStallOutput(EIG_281_NORMAL_LINES.join("\n"))).toBe(true);
  });

  it("treats a chunk that is purely stall-signal lines as not-non-stall", () => {
    expect(chunkHasNonStallOutput(EIG_281_STALL_LINES.join("\n"))).toBe(false);
  });

  it("ignores keepalive lines when checking for non-stall output", () => {
    expect(
      chunkHasNonStallOutput(
        `${codexUpstreamKeepaliveLinePrefix()} (last signal: "x"; keepalive #1 at 2026-01-01T00:00:00.000Z)`,
      ),
    ).toBe(false);
  });

  it("returns false for empty / whitespace chunks", () => {
    expect(chunkHasNonStallOutput("")).toBe(false);
    expect(chunkHasNonStallOutput("   \n\n  ")).toBe(false);
  });
});

describe("createCodexUpstreamKeepalive", () => {
  it("emits a periodic keepalive after a stall signal and stops on real output", () => {
    const captured: Captured[] = [];
    const fake = makeFakeTimer();
    const ctrl = makeController({ intervalMs: 30_000, captured, fake });

    expect(ctrl.active).toBe(false);

    // Observe the EIG-281 rmcp fatal — should activate the keepalive.
    ctrl.observe("stderr", `${EIG_281_STALL_LINES[0]}\n`);
    expect(ctrl.active).toBe(true);
    expect(ctrl.lastSignal).toContain("worker quit with fatal");
    expect(captured.length).toBe(0);

    // Simulate ~2h of upstream silence — the keepalive should emit roughly once
    // per intervalMs and keep emitting throughout the stall.
    fake.advance(2 * 60 * 60 * 1000);
    expect(captured.length).toBe(240);
    for (const entry of captured) {
      expect(entry.stream).toBe("stdout");
      expect(entry.chunk.startsWith(codexUpstreamKeepaliveLinePrefix())).toBe(true);
      expect(entry.chunk).toContain("worker quit with fatal");
    }

    // Codex finally produces a real agent_message — the keepalive should stop.
    ctrl.observe("stdout", `${EIG_281_NORMAL_LINES[2]}\n`);
    expect(ctrl.active).toBe(false);
    expect(ctrl.lastSignal).toBeNull();

    const tally = captured.length;
    fake.advance(60_000);
    expect(captured.length).toBe(tally);
  });

  it("re-activates if a new stall signal arrives after recovery", () => {
    const captured: Captured[] = [];
    const fake = makeFakeTimer();
    const ctrl = makeController({ intervalMs: 1_000, captured, fake });

    ctrl.observe("stderr", `${EIG_281_STALL_LINES[0]}\n`);
    fake.advance(2_000);
    expect(captured.length).toBe(2);

    ctrl.observe("stdout", `${EIG_281_NORMAL_LINES[0]}\n`);
    expect(ctrl.active).toBe(false);

    ctrl.observe("stderr", `${EIG_281_STALL_LINES[2]}\n`);
    expect(ctrl.active).toBe(true);
    fake.advance(2_000);
    expect(captured.length).toBe(4);
  });

  it("ignores its own emitted keepalive lines (no self-loop)", () => {
    const captured: Captured[] = [];
    const fake = makeFakeTimer();
    const ctrl = makeController({ intervalMs: 1_000, captured, fake });

    ctrl.observe("stderr", `${EIG_281_STALL_LINES[1]}\n`);
    fake.advance(1_500);
    expect(captured.length).toBeGreaterThanOrEqual(1);

    // Re-observing the keepalive's own output must not deactivate or re-arm.
    const ownLine = captured[0]!.chunk;
    ctrl.observe("stdout", ownLine);
    expect(ctrl.active).toBe(true);
    expect(ctrl.lastSignal).toMatch(/Reconnecting/);
  });

  it("respects maxEmits ceiling", () => {
    const captured: Captured[] = [];
    const fake = makeFakeTimer();
    const ctrl = makeController({ intervalMs: 100, maxEmits: 3, captured, fake });

    ctrl.observe("stderr", `${EIG_281_STALL_LINES[3]}\n`);
    fake.advance(10_000);
    expect(captured.length).toBe(3);
    expect(ctrl.emitCount).toBe(3);
    expect(ctrl.active).toBe(false);
  });

  it("intervalMs <= 0 disables emission entirely", () => {
    const captured: Captured[] = [];
    const fake = makeFakeTimer();
    const ctrl = makeController({ intervalMs: 0, captured, fake });

    ctrl.observe("stderr", `${EIG_281_STALL_LINES[0]}\n`);
    expect(ctrl.active).toBe(false);
    fake.advance(60_000);
    expect(captured.length).toBe(0);
  });

  it("stop() clears the timer and ignores subsequent observations", () => {
    const captured: Captured[] = [];
    const fake = makeFakeTimer();
    const ctrl = makeController({ intervalMs: 1_000, captured, fake });

    ctrl.observe("stderr", `${EIG_281_STALL_LINES[0]}\n`);
    fake.advance(1_000);
    expect(captured.length).toBe(1);

    ctrl.stop();
    expect(fake.activeCount()).toBe(0);

    ctrl.observe("stderr", `${EIG_281_STALL_LINES[1]}\n`);
    fake.advance(60_000);
    expect(captured.length).toBe(1);
    expect(ctrl.active).toBe(false);
  });

  it("does not deactivate on empty / whitespace chunks", () => {
    const captured: Captured[] = [];
    const fake = makeFakeTimer();
    const ctrl = makeController({ intervalMs: 1_000, captured, fake });

    ctrl.observe("stderr", `${EIG_281_STALL_LINES[0]}\n`);
    expect(ctrl.active).toBe(true);

    ctrl.observe("stdout", "");
    ctrl.observe("stdout", "   \n");
    expect(ctrl.active).toBe(true);
  });
});
