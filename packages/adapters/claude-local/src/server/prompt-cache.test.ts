import { describe, expect, it, vi } from "vitest";
import {
  buildClaudePromptBundleKeyWithSwapRetry,
  SKILLS_SOURCE_UNAVAILABLE_ERROR_CODE,
  SkillsSourceUnavailableError,
  transientSkillsSourceFsErrorCode,
} from "./prompt-cache.js";

function fsError(code: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: simulated`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

const noopLog = vi.fn(async () => {});

describe("transientSkillsSourceFsErrorCode", () => {
  it("recognizes worktree-swap FS error codes", () => {
    for (const code of ["EPERM", "EACCES", "ENOENT", "EBUSY"]) {
      expect(transientSkillsSourceFsErrorCode(fsError(code))).toBe(code);
    }
  });

  it("ignores unrelated errors", () => {
    expect(transientSkillsSourceFsErrorCode(fsError("EROFS"))).toBeNull();
    expect(transientSkillsSourceFsErrorCode(new Error("plain"))).toBeNull();
    expect(transientSkillsSourceFsErrorCode(null)).toBeNull();
  });
});

describe("buildClaudePromptBundleKeyWithSwapRetry", () => {
  const input = { skills: [], instructionsContents: null, onLog: noopLog };

  it("returns the freshly computed key when the source is readable", async () => {
    const computeKey = vi.fn(async () => "cachekey-abc");
    const key = await buildClaudePromptBundleKeyWithSwapRetry(input, { computeKey });
    expect(key).toBe("cachekey-abc");
    expect(computeKey).toHaveBeenCalledTimes(1);
  });

  it("rides out a brief swap: retries transient FS errors then returns the real key", async () => {
    let calls = 0;
    const computeKey = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw fsError("EPERM");
      return "recovered-key";
    });
    const sleep = vi.fn(async () => {});
    const key = await buildClaudePromptBundleKeyWithSwapRetry(input, {
      computeKey,
      sleep,
      retryBudgetMs: 30_000,
      initialDelayMs: 1,
    });
    // Never returns a stale/empty hash — it recomputes the whole key each time.
    expect(key).toBe("recovered-key");
    expect(computeKey).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("raises the dedicated retryable error once the retry budget is exhausted", async () => {
    // Deterministic virtual clock so the budget elapses without real waiting.
    let clock = 0;
    const now = () => clock;
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const computeKey = vi.fn(async () => {
      clock += 1;
      throw fsError("EPERM");
    });
    const err = await buildClaudePromptBundleKeyWithSwapRetry(input, {
      computeKey,
      sleep,
      now,
      retryBudgetMs: 100,
      initialDelayMs: 25,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(SkillsSourceUnavailableError);
    expect((err as SkillsSourceUnavailableError).code).toBe(SKILLS_SOURCE_UNAVAILABLE_ERROR_CODE);
  });

  it("rethrows a non-transient error untouched (no masking as swap-unavailable)", async () => {
    const boom = new Error("genuine bug");
    const computeKey = vi.fn(async () => {
      throw boom;
    });
    await expect(
      buildClaudePromptBundleKeyWithSwapRetry(input, { computeKey }),
    ).rejects.toBe(boom);
    expect(computeKey).toHaveBeenCalledTimes(1);
  });
});
