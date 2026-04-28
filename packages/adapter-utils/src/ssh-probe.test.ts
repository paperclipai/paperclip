import { describe, expect, it } from "vitest";
import {
  findReachablePaperclipApiUrlOverSsh,
  type PaperclipApiProbeAttempt,
  type SingleProbeAttempt,
  type SingleProbeRunner,
  type SshConnectionConfig,
} from "./ssh.js";

const SSH_CONFIG: SshConnectionConfig = {
  host: "ssh.example.test",
  port: 22,
  username: "ssh-user",
  remoteWorkspacePath: "/srv/paperclip",
  privateKey: null,
  knownHosts: null,
  strictHostKeyChecking: false,
};

const NO_SLEEP = async () => undefined;

function makeProbeRunner(
  scripts: Record<string, Array<Partial<SingleProbeAttempt>>>,
): { run: SingleProbeRunner; calls: Array<{ healthUrl: string }> } {
  const cursors: Record<string, number> = {};
  const calls: Array<{ healthUrl: string }> = [];
  const run: SingleProbeRunner = async ({ healthUrl }) => {
    calls.push({ healthUrl });
    const series = scripts[healthUrl];
    if (!series) {
      throw new Error(`Test setup missing script for ${healthUrl}`);
    }
    const idx = cursors[healthUrl] ?? 0;
    cursors[healthUrl] = idx + 1;
    const stage = series[Math.min(idx, series.length - 1)] ?? {};
    return {
      exitCode: stage.exitCode ?? 0,
      httpStatus: stage.httpStatus ?? null,
      durationMs: stage.durationMs ?? 5,
      stderrTail: stage.stderrTail ?? null,
      sshError: stage.sshError ?? null,
    };
  };
  return { run, calls };
}

describe("findReachablePaperclipApiUrlOverSsh", () => {
  it("retries on 5xx and succeeds when the candidate recovers", async () => {
    const { run, calls } = makeProbeRunner({
      "https://api.example.test/api/health": [
        { exitCode: 0, httpStatus: 503 },
        { exitCode: 0, httpStatus: 503 },
        { exitCode: 0, httpStatus: 200 },
      ],
    });

    const result = await findReachablePaperclipApiUrlOverSsh({
      config: SSH_CONFIG,
      candidates: ["https://api.example.test"],
      attempts: 3,
      backoffMs: [0, 0],
      sleep: NO_SLEEP,
      runProbe: run,
    });

    expect(result.url).toBe("https://api.example.test");
    expect(result.attempts).toHaveLength(3);
    expect(result.attempts.map((a) => a.classification)).toEqual(["transient", "transient", "ok"]);
    expect(result.attempts[2]?.httpStatus).toBe(200);
    expect(calls).toHaveLength(3);
  });

  it("retries on curl network error (exit code != 0) until success", async () => {
    const { run } = makeProbeRunner({
      "https://api.example.test/api/health": [
        { exitCode: 28, httpStatus: null, sshError: "curl: timed out" },
        { exitCode: 0, httpStatus: 200 },
      ],
    });

    const result = await findReachablePaperclipApiUrlOverSsh({
      config: SSH_CONFIG,
      candidates: ["https://api.example.test"],
      attempts: 3,
      backoffMs: [0, 0],
      sleep: NO_SLEEP,
      runProbe: run,
    });

    expect(result.url).toBe("https://api.example.test");
    expect(result.attempts[0]?.classification).toBe("transient");
    expect(result.attempts[0]?.error).toContain("curl: timed out");
  });

  it("does not retry on permanent 4xx; moves to next candidate immediately", async () => {
    const { run, calls } = makeProbeRunner({
      "https://broken.example.test/api/health": [{ exitCode: 0, httpStatus: 404 }],
      "https://good.example.test/api/health": [{ exitCode: 0, httpStatus: 200 }],
    });

    const result = await findReachablePaperclipApiUrlOverSsh({
      config: SSH_CONFIG,
      candidates: ["https://broken.example.test", "https://good.example.test"],
      attempts: 3,
      backoffMs: [0, 0],
      sleep: NO_SLEEP,
      runProbe: run,
    });

    expect(result.url).toBe("https://good.example.test");
    // Exactly one attempt against the broken candidate (no retry on 4xx),
    // then one against the good candidate.
    expect(calls.map((c) => c.healthUrl)).toEqual([
      "https://broken.example.test/api/health",
      "https://good.example.test/api/health",
    ]);
    const broken = result.attempts.filter((a) => a.candidate === "https://broken.example.test");
    expect(broken).toHaveLength(1);
    expect(broken[0]?.classification).toBe("permanent");
  });

  it("retries on transient 408/429 (rate-limit-ish)", async () => {
    const { run } = makeProbeRunner({
      "https://api.example.test/api/health": [
        { exitCode: 0, httpStatus: 429 },
        { exitCode: 0, httpStatus: 200 },
      ],
    });

    const result = await findReachablePaperclipApiUrlOverSsh({
      config: SSH_CONFIG,
      candidates: ["https://api.example.test"],
      attempts: 2,
      backoffMs: [0],
      sleep: NO_SLEEP,
      runProbe: run,
    });

    expect(result.url).toBe("https://api.example.test");
    expect(result.attempts[0]?.classification).toBe("transient");
    expect(result.attempts[0]?.httpStatus).toBe(429);
  });

  it("returns null with full attempt detail when every candidate stays 5xx", async () => {
    const { run } = makeProbeRunner({
      "https://a.example.test/api/health": [{ exitCode: 0, httpStatus: 503, durationMs: 51, stderrTail: "upstream timed out" }],
      "https://b.example.test/api/health": [{ exitCode: 0, httpStatus: 502 }],
    });

    const result = await findReachablePaperclipApiUrlOverSsh({
      config: SSH_CONFIG,
      candidates: ["https://a.example.test", "https://b.example.test"],
      attempts: 2,
      backoffMs: [0],
      sleep: NO_SLEEP,
      runProbe: run,
    });

    expect(result.url).toBeNull();
    // 2 attempts per candidate × 2 candidates = 4 attempts.
    expect(result.attempts).toHaveLength(4);
    const byCandidate = (url: string) => result.attempts.filter((a) => a.candidate === url);
    expect(byCandidate("https://a.example.test")).toHaveLength(2);
    expect(byCandidate("https://b.example.test")).toHaveLength(2);
    const first = result.attempts[0]!;
    expect(first.candidate).toBe("https://a.example.test");
    expect(first.httpStatus).toBe(503);
    expect(first.durationMs).toBe(51);
    expect(first.stderrTail).toBe("upstream timed out");
    expect(first.error).toBe("HTTP 503");
  });

  it("short-circuits to a healthy preferredCandidate without probing the rest", async () => {
    const { run, calls } = makeProbeRunner({
      "https://cached.example.test/api/health": [{ exitCode: 0, httpStatus: 200 }],
      "https://other.example.test/api/health": [{ exitCode: 0, httpStatus: 200 }],
    });

    const result = await findReachablePaperclipApiUrlOverSsh({
      config: SSH_CONFIG,
      candidates: ["https://other.example.test"],
      preferredCandidate: "https://cached.example.test",
      attempts: 3,
      backoffMs: [0, 0],
      sleep: NO_SLEEP,
      runProbe: run,
    });

    expect(result.url).toBe("https://cached.example.test");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.healthUrl).toBe("https://cached.example.test/api/health");
  });

  it("falls through from a stale preferredCandidate to the candidate list", async () => {
    const { run, calls } = makeProbeRunner({
      "https://cached.example.test/api/health": [
        // The previously-cached URL is now down. Use up its full retry budget
        // (transient 503), then fall through.
        { exitCode: 0, httpStatus: 503 },
        { exitCode: 0, httpStatus: 503 },
      ],
      "https://other.example.test/api/health": [{ exitCode: 0, httpStatus: 200 }],
    });

    const result = await findReachablePaperclipApiUrlOverSsh({
      config: SSH_CONFIG,
      candidates: ["https://other.example.test"],
      preferredCandidate: "https://cached.example.test",
      attempts: 2,
      backoffMs: [0],
      sleep: NO_SLEEP,
      runProbe: run,
    });

    expect(result.url).toBe("https://other.example.test");
    expect(calls.map((c) => c.healthUrl)).toEqual([
      "https://cached.example.test/api/health",
      "https://cached.example.test/api/health",
      "https://other.example.test/api/health",
    ]);
    const stale = result.attempts.filter((a) => a.candidate === "https://cached.example.test");
    expect(stale).toHaveLength(2);
    expect(stale.every((a) => a.classification === "transient")).toBe(true);
  });

  it("dedupes preferredCandidate that's already in the candidate list (no double-probe)", async () => {
    const { run, calls } = makeProbeRunner({
      "https://api.example.test/api/health": [{ exitCode: 0, httpStatus: 200 }],
    });

    const result = await findReachablePaperclipApiUrlOverSsh({
      config: SSH_CONFIG,
      candidates: ["https://api.example.test"],
      preferredCandidate: "https://api.example.test",
      attempts: 2,
      backoffMs: [0],
      sleep: NO_SLEEP,
      runProbe: run,
    });

    expect(result.url).toBe("https://api.example.test");
    expect(calls).toHaveLength(1);
  });

  it("respects PAPERCLIP_RUNTIME_API_PROBE_ATTEMPTS env var", async () => {
    const previous = process.env.PAPERCLIP_RUNTIME_API_PROBE_ATTEMPTS;
    process.env.PAPERCLIP_RUNTIME_API_PROBE_ATTEMPTS = "5";
    try {
      const { run } = makeProbeRunner({
        "https://api.example.test/api/health": [
          { exitCode: 0, httpStatus: 503 },
          { exitCode: 0, httpStatus: 503 },
          { exitCode: 0, httpStatus: 503 },
          { exitCode: 0, httpStatus: 503 },
          { exitCode: 0, httpStatus: 200 },
        ],
      });

      const result = await findReachablePaperclipApiUrlOverSsh({
        config: SSH_CONFIG,
        candidates: ["https://api.example.test"],
        backoffMs: [0, 0, 0, 0],
        sleep: NO_SLEEP,
        runProbe: run,
      });

      expect(result.url).toBe("https://api.example.test");
      expect(result.attempts).toHaveLength(5);
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_RUNTIME_API_PROBE_ATTEMPTS;
      else process.env.PAPERCLIP_RUNTIME_API_PROBE_ATTEMPTS = previous;
    }
  });

  it("caps the entire candidate sweep at totalBudgetMs (BLO-1490)", async () => {
    // Two candidates, 5 attempts each, all transient. With a deterministic
    // clock advanced 20 ms per probe + sleep, total budget = 60 ms means we
    // get ~3 attempts before the budget cuts the sweep. Returns null with
    // the partial attempts trail intact.
    let nowMs = 0;
    const advanceClockBy = (ms: number): void => {
      nowMs += ms;
    };
    const { run } = makeProbeRunner({
      "https://a.example.test/api/health": [
        { exitCode: 0, httpStatus: 503 },
        { exitCode: 0, httpStatus: 503 },
        { exitCode: 0, httpStatus: 503 },
        { exitCode: 0, httpStatus: 503 },
        { exitCode: 0, httpStatus: 503 },
      ],
      "https://b.example.test/api/health": [
        { exitCode: 0, httpStatus: 503 },
        { exitCode: 0, httpStatus: 503 },
        { exitCode: 0, httpStatus: 503 },
        { exitCode: 0, httpStatus: 503 },
        { exitCode: 0, httpStatus: 503 },
      ],
    });

    const wrapped: typeof run = async (probeInput) => {
      // Each probe takes 15 ms of wall clock.
      advanceClockBy(15);
      return run(probeInput);
    };

    const result = await findReachablePaperclipApiUrlOverSsh({
      config: SSH_CONFIG,
      candidates: ["https://a.example.test", "https://b.example.test"],
      attempts: 5,
      backoffMs: [5, 5, 5, 5],
      sleep: async (ms) => {
        advanceClockBy(ms);
      },
      now: () => nowMs,
      totalBudgetMs: 60,
      runProbe: wrapped,
    });

    expect(result.url).toBeNull();
    // Probe 1 (15 ms elapsed), sleep 5 (20), probe 2 (35), sleep 5 (40),
    // probe 3 (55), sleep 5 (60) → next budget check sees 60 >= 60 → break.
    expect(result.attempts).toHaveLength(3);
    expect(result.attempts.every((a) => a.candidate === "https://a.example.test")).toBe(true);
  });

  it("uses jittered default backoff when no backoff array is supplied", async () => {
    // Don't actually sleep — just confirm that the function reaches into
    // randomBackoffMs (the spec'd 250–750 ms jitter source) when callers
    // don't pin a deterministic backoff array.
    let randomCalls = 0;
    const { run } = makeProbeRunner({
      "https://api.example.test/api/health": [
        { exitCode: 0, httpStatus: 503 },
        { exitCode: 0, httpStatus: 200 },
      ],
    });

    const result = await findReachablePaperclipApiUrlOverSsh({
      config: SSH_CONFIG,
      candidates: ["https://api.example.test"],
      attempts: 2,
      sleep: NO_SLEEP,
      runProbe: run,
      randomBackoffMs: () => {
        randomCalls++;
        return 0;
      },
    });

    expect(result.url).toBe("https://api.example.test");
    // Sampled exactly once: between attempt 1 (503) and attempt 2 (200).
    expect(randomCalls).toBe(1);
  });

  it("ignores a malformed PAPERCLIP_RUNTIME_API_PROBE_BACKOFF_MS_JSON instead of crashing", async () => {
    const previous = process.env.PAPERCLIP_RUNTIME_API_PROBE_BACKOFF_MS_JSON;
    process.env.PAPERCLIP_RUNTIME_API_PROBE_BACKOFF_MS_JSON = "{not json[";
    try {
      const { run } = makeProbeRunner({
        "https://api.example.test/api/health": [{ exitCode: 0, httpStatus: 200 }],
      });

      // A malformed knob should NOT cause acquireRunLease to crash. Probing
      // should still complete using the default backoff schedule.
      const result = await findReachablePaperclipApiUrlOverSsh({
        config: SSH_CONFIG,
        candidates: ["https://api.example.test"],
        sleep: NO_SLEEP,
        runProbe: run,
      });

      expect(result.url).toBe("https://api.example.test");
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_RUNTIME_API_PROBE_BACKOFF_MS_JSON;
      else process.env.PAPERCLIP_RUNTIME_API_PROBE_BACKOFF_MS_JSON = previous;
    }
  });

  it("filters invalid candidates without throwing", async () => {
    const { run, calls } = makeProbeRunner({
      "https://valid.example.test/api/health": [{ exitCode: 0, httpStatus: 200 }],
    });

    const result = await findReachablePaperclipApiUrlOverSsh({
      config: SSH_CONFIG,
      candidates: ["", "not a url", "ftp://wrong.scheme/", "https://valid.example.test"],
      attempts: 1,
      backoffMs: [],
      sleep: NO_SLEEP,
      runProbe: run,
    });

    expect(result.url).toBe("https://valid.example.test");
    expect(calls).toHaveLength(1);
  });

  it("classifies attempt fields exactly as the orchestrator expects (acceptance line shape)", async () => {
    // Acceptance criterion: the thrown error on full failure includes
    // per-candidate { candidate, status, durationMs } lines.
    const { run } = makeProbeRunner({
      "https://api.example.test/api/health": [{ exitCode: 0, httpStatus: 503, durationMs: 47 }],
    });

    const result = await findReachablePaperclipApiUrlOverSsh({
      config: SSH_CONFIG,
      candidates: ["https://api.example.test"],
      attempts: 1,
      backoffMs: [],
      sleep: NO_SLEEP,
      runProbe: run,
    });

    expect(result.url).toBeNull();
    const attempt: PaperclipApiProbeAttempt = result.attempts[0]!;
    expect(attempt.candidate).toBe("https://api.example.test");
    expect(attempt.httpStatus).toBe(503);
    expect(attempt.durationMs).toBe(47);
  });
});
