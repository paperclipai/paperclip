import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUOTA_WAIT_LIMITS,
  classifyAdapterFamilyQuotaState,
  decideQuotaBlockedReleases,
  parseProviderQuotaResetHint,
  type AdapterFamilyQuotaVerdict,
  type AdapterFamilyRunSummary,
  type QuotaBlockedCandidate,
} from "./quota-wait.js";
import { classifyContinuationFailure } from "./service.js";

const NOW = new Date("2026-09-16T12:00:00.000Z");
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function summary(
  overrides: Partial<AdapterFamilyRunSummary> = {},
): AdapterFamilyRunSummary {
  return {
    family: "claude_local",
    lastSuccessAt: null,
    lastQuotaFailureAt: null,
    lastTerminalAt: null,
    successesAfterQuotaFailure: 0,
    resetHintUntil: null,
    ...overrides,
  };
}

function candidate(
  overrides: Partial<QuotaBlockedCandidate> = {},
): QuotaBlockedCandidate {
  return {
    issueId: "issue-1",
    identifier: "HELA-1",
    recoveryActionId: "action-1",
    returnOwnerAgentId: "agent-1",
    workFamily: "claude_local",
    failedAt: new Date(NOW.getTime() - 3 * HOUR),
    strandedSince: new Date(NOW.getTime() - 3 * HOUR),
    lastPromotedAt: null,
    ...overrides,
  };
}

function verdict(
  overrides: Partial<AdapterFamilyQuotaVerdict> = {},
): AdapterFamilyQuotaVerdict {
  return {
    family: "claude_local",
    state: "green",
    reason: "test",
    newestSuccessAt: new Date(NOW.getTime() - 10 * MINUTE),
    ...overrides,
  };
}

describe("classifyContinuationFailure", () => {
  it("treats a provider quota wall as a wait rather than a bounded retry", () => {
    // A quota wall lasts hours or days. Bounded transient retries burn out in
    // minutes and then escalate the issue to `blocked`, where nothing returns
    // it. `quota_wait` exists so the reconciler holds the issue instead.
    expect(
      classifyContinuationFailure({ errorCode: "provider_quota" } as never),
    ).toEqual({
      kind: "quota_wait",
      maxAttempts: 0,
      baseBackoffMs: 0,
      errorCode: "provider_quota",
    });
  });

  it("still classifies genuine transient infrastructure failures as transient", () => {
    expect(
      classifyContinuationFailure({
        errorCode: "claude_transient_upstream",
      } as never),
    ).toMatchObject({ kind: "transient_infra" });
  });
});

describe("parseProviderQuotaResetHint", () => {
  it("parses an absolute far-future reset date", () => {
    expect(
      parseProviderQuotaResetHint(
        "You've hit your usage limit. Try again at Sep 22nd, 2026 12:34 AM",
        NOW,
      ),
    ).toEqual(new Date("2026-09-22T00:34:00.000Z"));
  });

  it("parses a PM absolute reset date", () => {
    expect(
      parseProviderQuotaResetHint("try again at Oct 1, 2026 3:05 PM", NOW),
    ).toEqual(new Date("2026-10-01T15:05:00.000Z"));
  });

  it("resolves a wall clock reset to the next occurrence of that time", () => {
    // 6:10am has already passed at 12:00, so the hint means tomorrow.
    expect(
      parseProviderQuotaResetHint(
        "You've hit your session limit · resets 6:10am (UTC)",
        NOW,
      ),
    ).toEqual(new Date("2026-09-17T06:10:00.000Z"));
  });

  it("keeps a wall clock reset later today on the same day", () => {
    expect(
      parseProviderQuotaResetHint("resets 6pm (UTC)", NOW),
    ).toEqual(new Date("2026-09-16T18:00:00.000Z"));
  });

  it("rejects an impossible calendar date instead of rolling it over", () => {
    expect(
      parseProviderQuotaResetHint("try again at Feb 30th, 2026 1:00 AM", NOW),
    ).toBeNull();
  });

  it("returns null for text without a reset hint", () => {
    expect(parseProviderQuotaResetHint("provider quota exceeded", NOW)).toBeNull();
    expect(parseProviderQuotaResetHint(null, NOW)).toBeNull();
  });
});

describe("classifyAdapterFamilyQuotaState", () => {
  it("is green when enough fresh successes follow the quota failure", () => {
    expect(
      classifyAdapterFamilyQuotaState(
        summary({
          lastQuotaFailureAt: new Date(NOW.getTime() - 3 * HOUR),
          lastSuccessAt: new Date(NOW.getTime() - 10 * MINUTE),
          lastTerminalAt: new Date(NOW.getTime() - 10 * MINUTE),
          successesAfterQuotaFailure: 2,
        }),
        NOW,
      ),
    ).toMatchObject({ state: "green" });
  });

  it("is red when only one success follows the quota failure", () => {
    expect(
      classifyAdapterFamilyQuotaState(
        summary({
          lastQuotaFailureAt: new Date(NOW.getTime() - 3 * HOUR),
          lastSuccessAt: new Date(NOW.getTime() - 10 * MINUTE),
          lastTerminalAt: new Date(NOW.getTime() - 10 * MINUTE),
          successesAfterQuotaFailure: 1,
        }),
        NOW,
      ),
    ).toMatchObject({ state: "red" });
  });

  it("is red when the successes after the failure are stale", () => {
    expect(
      classifyAdapterFamilyQuotaState(
        summary({
          lastQuotaFailureAt: new Date(NOW.getTime() - 20 * HOUR),
          lastSuccessAt: new Date(NOW.getTime() - 10 * HOUR),
          lastTerminalAt: new Date(NOW.getTime() - 10 * HOUR),
          successesAfterQuotaFailure: 5,
        }),
        NOW,
      ),
    ).toMatchObject({ state: "red" });
  });

  it("is red while the quota failure outlives every success", () => {
    expect(
      classifyAdapterFamilyQuotaState(
        summary({
          lastQuotaFailureAt: new Date(NOW.getTime() - 5 * MINUTE),
          lastSuccessAt: new Date(NOW.getTime() - 2 * HOUR),
          lastTerminalAt: new Date(NOW.getTime() - 5 * MINUTE),
        }),
        NOW,
      ),
    ).toMatchObject({ state: "red" });
  });

  it("is red while the provider reset hint is still in the future", () => {
    // This is the codex September wall: silent family, but the provider said
    // the quota returns days from now. Hold, do not probe.
    expect(
      classifyAdapterFamilyQuotaState(
        summary({
          family: "codex_local",
          lastQuotaFailureAt: new Date(NOW.getTime() - 10 * HOUR),
          lastTerminalAt: new Date(NOW.getTime() - 10 * HOUR),
          resetHintUntil: new Date("2026-09-22T00:34:00.000Z"),
        }),
        NOW,
      ),
    ).toMatchObject({ state: "red" });
  });

  it("is dark when a silent family can no longer produce evidence", () => {
    expect(
      classifyAdapterFamilyQuotaState(
        summary({
          lastQuotaFailureAt: new Date(NOW.getTime() - 5 * HOUR),
          lastTerminalAt: new Date(NOW.getTime() - 5 * HOUR),
        }),
        NOW,
      ),
    ).toMatchObject({ state: "dark" });
  });

  it("stays red while a silent family has not been quiet long enough", () => {
    expect(
      classifyAdapterFamilyQuotaState(
        summary({
          lastQuotaFailureAt: new Date(NOW.getTime() - 10 * MINUTE),
          lastTerminalAt: new Date(NOW.getTime() - 10 * MINUTE),
        }),
        NOW,
      ),
    ).toMatchObject({ state: "red" });
  });

  it("is green when the window holds fresh successes and no quota failure", () => {
    expect(
      classifyAdapterFamilyQuotaState(
        summary({ lastSuccessAt: new Date(NOW.getTime() - 5 * MINUTE) }),
        NOW,
      ),
    ).toMatchObject({ state: "green" });
  });

  it("is dark when the window holds neither a quota failure nor a fresh success", () => {
    expect(
      classifyAdapterFamilyQuotaState(
        summary({ lastSuccessAt: new Date(NOW.getTime() - 10 * HOUR) }),
        NOW,
      ),
    ).toMatchObject({ state: "dark" });
  });
});

describe("decideQuotaBlockedReleases", () => {
  it("releases an issue whose family is green", () => {
    const { releases, holds } = decideQuotaBlockedReleases({
      candidates: [candidate()],
      families: new Map([["claude_local", verdict()]]),
      lastCanaryByFamily: new Map(),
      now: NOW,
    });

    expect(holds).toHaveLength(0);
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({ kind: "green" });
    expect(releases[0]?.candidate.issueId).toBe("issue-1");
  });

  it("never releases an issue whose family is still walled", () => {
    // The live September regression: a company-wide signal released codex
    // issues into a wall that stood for another six days.
    const { releases, holds } = decideQuotaBlockedReleases({
      candidates: [candidate({ workFamily: "codex_local" })],
      families: new Map([
        ["codex_local", verdict({ family: "codex_local", state: "red" })],
      ]),
      lastCanaryByFamily: new Map(),
      now: NOW,
    });

    expect(releases).toHaveLength(0);
    expect(holds[0]?.reason).toContain("red");
  });

  it("gates each adapter family independently", () => {
    // 16 September: claude_local was serving while codex_local was still down.
    const { releases } = decideQuotaBlockedReleases({
      candidates: [
        candidate({ issueId: "claude-issue", workFamily: "claude_local" }),
        candidate({ issueId: "codex-issue", workFamily: "codex_local" }),
      ],
      families: new Map([
        ["claude_local", verdict()],
        ["codex_local", verdict({ family: "codex_local", state: "red" })],
      ]),
      lastCanaryByFamily: new Map(),
      now: NOW,
    });

    expect(releases.map((release) => release.candidate.issueId)).toEqual([
      "claude-issue",
    ]);
  });

  it("releases exactly one canary for a dark family", () => {
    const { releases, holds } = decideQuotaBlockedReleases({
      candidates: [
        candidate({ issueId: "issue-1", strandedSince: new Date(NOW.getTime() - 5 * HOUR) }),
        candidate({ issueId: "issue-2", strandedSince: new Date(NOW.getTime() - 4 * HOUR) }),
        candidate({ issueId: "issue-3", strandedSince: new Date(NOW.getTime() - 3 * HOUR) }),
      ],
      families: new Map([["claude_local", verdict({ state: "dark" })]]),
      lastCanaryByFamily: new Map(),
      now: NOW,
    });

    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({ kind: "canary" });
    // Oldest strand wins the canary slot.
    expect(releases[0]?.candidate.issueId).toBe("issue-1");
    expect(holds).toHaveLength(2);
  });

  it("holds a dark family canary while its cooldown is running", () => {
    const { releases, holds } = decideQuotaBlockedReleases({
      candidates: [candidate()],
      families: new Map([["claude_local", verdict({ state: "dark" })]]),
      lastCanaryByFamily: new Map([
        ["claude_local", new Date(NOW.getTime() - HOUR)],
      ]),
      now: NOW,
    });

    expect(releases).toHaveLength(0);
    expect(holds[0]?.reason).toContain("canary cooldown");
  });

  it("applies the canary cooldown against the caller's family key, not the adapter type", () => {
    // The caller scopes family keys per company, because a quota wall belongs
    // to one company's provider account. Looking the cooldown up by the bare
    // adapter type would miss every entry and release a canary each tick.
    const scoped = (companyId: string) => `${companyId}:claude_local`;
    const { releases, holds } = decideQuotaBlockedReleases({
      candidates: [
        candidate({ issueId: "company-a-issue", workFamily: scoped("company-a") }),
        candidate({ issueId: "company-b-issue", workFamily: scoped("company-b") }),
      ],
      families: new Map([
        [scoped("company-a"), verdict({ state: "dark" })],
        [scoped("company-b"), verdict({ state: "dark" })],
      ]),
      // Only company A is inside its cooldown; company B may still probe.
      lastCanaryByFamily: new Map([
        [scoped("company-a"), new Date(NOW.getTime() - HOUR)],
      ]),
      now: NOW,
    });

    expect(releases.map((release) => release.candidate.issueId)).toEqual([
      "company-b-issue",
    ]);
    expect(holds[0]?.candidate.issueId).toBe("company-a-issue");
    expect(holds[0]?.reason).toContain("canary cooldown");
  });

  it("releases a canary again once the cooldown has elapsed", () => {
    const { releases } = decideQuotaBlockedReleases({
      candidates: [candidate()],
      families: new Map([["claude_local", verdict({ state: "dark" })]]),
      lastCanaryByFamily: new Map([
        ["claude_local", new Date(NOW.getTime() - 7 * HOUR)],
      ]),
      now: NOW,
    });

    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({ kind: "canary" });
  });

  it("holds an issue released within its own cooldown", () => {
    const { releases, holds } = decideQuotaBlockedReleases({
      candidates: [
        candidate({ lastPromotedAt: new Date(NOW.getTime() - 30 * MINUTE) }),
      ],
      families: new Map([["claude_local", verdict()]]),
      lastCanaryByFamily: new Map(),
      now: NOW,
    });

    expect(releases).toHaveLength(0);
    expect(holds[0]?.reason).toContain("issue cooldown");
  });

  it("holds an issue whose family evidence predates its own quota failure", () => {
    // The family recovered, then walled again and stranded this issue. The
    // older success proves nothing about the newer failure.
    const { releases, holds } = decideQuotaBlockedReleases({
      candidates: [candidate({ failedAt: new Date(NOW.getTime() - 5 * MINUTE) })],
      families: new Map([
        ["claude_local", verdict({ newestSuccessAt: new Date(NOW.getTime() - 30 * MINUTE) })],
      ]),
      lastCanaryByFamily: new Map(),
      now: NOW,
    });

    expect(releases).toHaveLength(0);
    expect(holds[0]?.reason).toContain("predates");
  });

  it("holds an issue with no return owner to hand the work back to", () => {
    // Releasing it would wake the recovery owner rather than the agent that
    // actually continues the work.
    const { releases, holds } = decideQuotaBlockedReleases({
      candidates: [candidate({ returnOwnerAgentId: null })],
      families: new Map([["claude_local", verdict()]]),
      lastCanaryByFamily: new Map(),
      now: NOW,
    });

    expect(releases).toHaveLength(0);
    expect(holds[0]?.reason).toContain("return owner");
  });

  it("holds an issue whose family has no run history in the window", () => {
    const { releases, holds } = decideQuotaBlockedReleases({
      candidates: [candidate({ workFamily: "kimi_local" })],
      families: new Map([["claude_local", verdict()]]),
      lastCanaryByFamily: new Map(),
      now: NOW,
    });

    expect(releases).toHaveLength(0);
    expect(holds[0]?.reason).toContain("no run history");
  });

  it("caps releases per tick so recovery does not arrive as a wave", () => {
    const candidates = Array.from({ length: 20 }, (_unused, index) =>
      candidate({
        issueId: `issue-${index}`,
        strandedSince: new Date(NOW.getTime() - (20 - index) * HOUR),
      }),
    );

    const { releases, holds } = decideQuotaBlockedReleases({
      candidates,
      families: new Map([["claude_local", verdict()]]),
      lastCanaryByFamily: new Map(),
      now: NOW,
    });

    expect(releases).toHaveLength(DEFAULT_QUOTA_WAIT_LIMITS.maxReleasesPerTick);
    expect(holds).toHaveLength(
      candidates.length - DEFAULT_QUOTA_WAIT_LIMITS.maxReleasesPerTick,
    );
    // Oldest strands drain first.
    expect(releases[0]?.candidate.issueId).toBe("issue-0");
  });

  it("releases the longest stranded issues first", () => {
    const { releases } = decideQuotaBlockedReleases({
      candidates: [
        candidate({ issueId: "recent", strandedSince: new Date(NOW.getTime() - HOUR) }),
        candidate({ issueId: "ancient", strandedSince: new Date(NOW.getTime() - 600 * HOUR) }),
      ],
      families: new Map([["claude_local", verdict()]]),
      lastCanaryByFamily: new Map(),
      now: NOW,
    });

    expect(releases.map((release) => release.candidate.issueId)).toEqual([
      "ancient",
      "recent",
    ]);
  });
});
