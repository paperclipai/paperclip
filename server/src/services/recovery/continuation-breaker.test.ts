import { describe, expect, it } from "vitest";
import {
  CONTINUATION_BREAKER_DEFAULTS,
  breakerRunFromRow,
  decideContinuationBreaker,
  isZeroCostProcessLost,
  resolveContinuationBreakerConfig,
  zcplStreakFromRuns,
  type BreakerRun,
} from "./continuation-breaker.js";

const CFG = CONTINUATION_BREAKER_DEFAULTS; // N=4, base=30s, cap=5m

function run(overrides: Partial<BreakerRun> = {}): BreakerRun {
  return {
    status: "failed",
    errorCode: "process_lost",
    usageJson: null,
    secretManifest: null,
    ...overrides,
  };
}

describe("continuation-breaker matcher (trip-wire truth table)", () => {
  it("process_lost + null usage + null manifest => TRUE", () => {
    expect(isZeroCostProcessLost(run())).toBe(true);
  });

  it("process_lost + null usage + empty manifest => TRUE", () => {
    expect(isZeroCostProcessLost(run({ secretManifest: [] }))).toBe(true);
  });

  it("process_lost + null usage + all-success manifest => TRUE", () => {
    expect(
      isZeroCostProcessLost(run({ secretManifest: [{ outcome: "success" }, { outcome: "success" }] })),
    ).toBe(true);
  });

  it("process_lost + a failed secret in manifest => FALSE (auth defect, not startup loss)", () => {
    expect(
      isZeroCostProcessLost(run({ secretManifest: [{ outcome: "success" }, { outcome: "failure" }] })),
    ).toBe(false);
  });

  it("paid run (non-null usage) => FALSE — CEO hard constraint, load-bearing guard", () => {
    expect(isZeroCostProcessLost(run({ usageJson: { input_tokens: 10, output_tokens: 5 } }))).toBe(false);
  });

  it("non-process_lost stop => FALSE", () => {
    expect(isZeroCostProcessLost(run({ status: "cancelled", errorCode: "user_cancel" }))).toBe(false);
    expect(isZeroCostProcessLost(run({ status: "succeeded", errorCode: null }))).toBe(false);
  });

  it("adapter_failed (a different transient class) => FALSE", () => {
    expect(isZeroCostProcessLost(run({ errorCode: "adapter_failed" }))).toBe(false);
  });
});

describe("breakerRunFromRow — real heartbeat_runs shape", () => {
  it("reads the secret manifest from contextSnapshot.paperclipSecrets.manifest", () => {
    const mapped = breakerRunFromRow({
      status: "failed",
      errorCode: "process_lost",
      usageJson: null,
      contextSnapshot: { paperclipSecrets: { manifest: [{ outcome: "success" }] } },
    });
    expect(isZeroCostProcessLost(mapped)).toBe(true);
  });

  it("a failed manifest entry from a raw row disqualifies the match", () => {
    const mapped = breakerRunFromRow({
      status: "failed",
      errorCode: "process_lost",
      usageJson: null,
      contextSnapshot: { paperclipSecrets: { manifest: [{ outcome: "failure" }] } },
    });
    expect(isZeroCostProcessLost(mapped)).toBe(false);
  });

  it("absent contextSnapshot / no paperclipSecrets => clean (no secrets recorded) => TRUE", () => {
    // null snapshot or a snapshot without paperclipSecrets is a positive "no secrets" signal.
    expect(isZeroCostProcessLost(breakerRunFromRow({ status: "failed", errorCode: "process_lost", usageJson: null, contextSnapshot: null }))).toBe(true);
    expect(isZeroCostProcessLost(breakerRunFromRow({ status: "failed", errorCode: "process_lost", usageJson: null, contextSnapshot: { issueId: "x" } }))).toBe(true);
  });

  it("UNREADABLE manifest is NOT counted clean (conservative — no false trips)", () => {
    // Malformed snapshot: cannot confirm the absence of a failed secret.
    const garbage = breakerRunFromRow({ status: "failed", errorCode: "process_lost", usageJson: null, contextSnapshot: "nope" });
    expect(garbage.secretManifestUnreadable).toBe(true);
    expect(isZeroCostProcessLost(garbage)).toBe(false);
    // paperclipSecrets present but manifest is not an array.
    const badManifest = breakerRunFromRow({ status: "failed", errorCode: "process_lost", usageJson: null, contextSnapshot: { paperclipSecrets: { manifest: "oops" } } });
    expect(badManifest.secretManifestUnreadable).toBe(true);
    expect(isZeroCostProcessLost(badManifest)).toBe(false);
    // paperclipSecrets is a non-object.
    expect(isZeroCostProcessLost(breakerRunFromRow({ status: "failed", errorCode: "process_lost", usageJson: null, contextSnapshot: { paperclipSecrets: 42 } }))).toBe(false);
  });

  it("a malformed manifest ENTRY is treated as failure (not dropped) => FALSE", () => {
    const mapped = breakerRunFromRow({
      status: "failed",
      errorCode: "process_lost",
      usageJson: null,
      contextSnapshot: { paperclipSecrets: { manifest: [{ outcome: "success" }, "bogus"] } },
    });
    expect(isZeroCostProcessLost(mapped)).toBe(false);
  });

  it("explicit secretManifestUnreadable flag short-circuits the matcher", () => {
    expect(isZeroCostProcessLost({ status: "failed", errorCode: "process_lost", usageJson: null, secretManifest: null, secretManifestUnreadable: true })).toBe(false);
  });
});

describe("zcplStreakFromRuns — consecutive-at-head walk (plan §3 reset rule)", () => {
  it("counts consecutive matches newest-first", () => {
    expect(zcplStreakFromRuns([run(), run(), run()])).toBe(3);
  });

  it("a paid run at the head resets the streak to 0", () => {
    expect(zcplStreakFromRuns([run({ usageJson: { output_tokens: 1 } }), run(), run()])).toBe(0);
  });

  it("stops at the first non-match (older matches do not count)", () => {
    // newest-first [match, non-match, match] => streak breaks at the non-match => 1
    expect(zcplStreakFromRuns([run(), run({ status: "succeeded", errorCode: null }), run()])).toBe(1);
  });

  it("empty history => 0", () => {
    expect(zcplStreakFromRuns([])).toBe(0);
  });
});

describe("decideContinuationBreaker — backoff/trip math (plan §4)", () => {
  it("streak 0 is inert (no backoff to apply)", () => {
    expect(decideContinuationBreaker(0, CFG)).toMatchObject({ verdict: "would-backoff", wouldDelayMs: 0, tripped: false });
  });

  it("exponential backoff below N: 30s, 60s, 120s", () => {
    expect(decideContinuationBreaker(1, CFG).wouldDelayMs).toBe(30_000);
    expect(decideContinuationBreaker(2, CFG).wouldDelayMs).toBe(60_000);
    expect(decideContinuationBreaker(3, CFG).wouldDelayMs).toBe(120_000);
  });

  it("caps the backoff at capMs", () => {
    const cfg = { ...CFG, N: 100, capMs: 300_000 };
    expect(decideContinuationBreaker(20, cfg).wouldDelayMs).toBe(300_000);
  });

  it("trips at streak >= N with verdict would-trip", () => {
    expect(decideContinuationBreaker(4, CFG)).toMatchObject({ verdict: "would-trip", tripped: true, wouldDelayMs: 0 });
    expect(decideContinuationBreaker(9, CFG)).toMatchObject({ verdict: "would-trip", tripped: true });
  });
});

describe("storm replay sim — enforce math collapses the retry storm", () => {
  it("64 consecutive zero-cost process_lost runs would trip once at N and thereafter stay tripped", () => {
    const history = Array.from({ length: 64 }, () => run());
    const streak = zcplStreakFromRuns(history);
    expect(streak).toBe(64);
    const decision = decideContinuationBreaker(streak, CFG);
    expect(decision.verdict).toBe("would-trip");
    // Before N the retries back off (30s,60s,120s) instead of the recorded no-backoff hammer.
    expect(decideContinuationBreaker(1, CFG).wouldDelayMs).toBe(30_000);
    expect(decideContinuationBreaker(3, CFG).wouldDelayMs).toBe(120_000);
  });

  it("paid-retry regression: an interleaved paid run zeroes the streak so the breaker never trips", () => {
    const history = [run(), run({ usageJson: { output_tokens: 42 } }), run(), run(), run(), run()];
    expect(zcplStreakFromRuns(history)).toBe(1);
    expect(decideContinuationBreaker(zcplStreakFromRuns(history), CFG).tripped).toBe(false);
  });
});

describe("config resolution — default is shadow (behavior-neutral)", () => {
  it("defaults to shadow mode, N=4", () => {
    const cfg = resolveContinuationBreakerConfig();
    expect(cfg.mode).toBe("shadow");
    expect(cfg.N).toBe(4);
    expect(cfg.enabled).toBe(true);
  });
});
