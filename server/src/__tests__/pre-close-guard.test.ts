/**
 * §7.10.3 Pre-close guard test matrix — QUA-2575
 *
 * Each test case is a permanent canary for the structured active-blocker model.
 * Prose token scanning is advisory only; structured state is the sole hard-block source.
 */

import { describe, expect, it } from "vitest";
import {
  BUILTIN_GUARD_TOKENS,
  evaluateGuard,
  findMatchedGuardTokens,
  stripGuardExclusions,
} from "../services/pre-close-guard.js";

// ---------------------------------------------------------------------------
// Helper: clean structured state (no hard blockers)
// ---------------------------------------------------------------------------

const CLEAN_STATE = {
  unresolvedBlockerCount: 0,
  openChildCount: 0,
  hasPendingConfirmation: false,
  hasActiveRecoveryAction: false,
};

// ---------------------------------------------------------------------------
// stripGuardExclusions (advisory prose pre-processor)
// ---------------------------------------------------------------------------

describe("stripGuardExclusions", () => {
  it("removes fenced code blocks", () => {
    const text = "some text\n```\nunresolved\n```\nafter";
    expect(stripGuardExclusions(text)).not.toContain("unresolved");
    expect(stripGuardExclusions(text)).toContain("after");
  });

  it("removes inline code", () => {
    expect(stripGuardExclusions("call `unresolved` state")).not.toContain("unresolved");
  });

  it("removes blockquote lines", () => {
    const result = stripGuardExclusions("> unresolved issue noted\nactual content");
    expect(result).not.toContain("unresolved");
    expect(result).toContain("actual content");
  });

  it("preserves plain prose", () => {
    expect(stripGuardExclusions("the issue is unresolved")).toContain("unresolved");
  });
});

// ---------------------------------------------------------------------------
// Acceptance criteria test matrix (QUA-2575 §Acceptance criteria)
// ---------------------------------------------------------------------------

describe("QUA-2575 acceptance criteria — structured hard blocks", () => {
  // AC-1: Open structured blocker + clean prose → BLOCK (true positive)
  it("AC-1: open blockedBy link blocks despite clean prose", () => {
    const result = evaluateGuard({
      state: { ...CLEAN_STATE, unresolvedBlockerCount: 1 },
      advisory: { allText: "Implementation complete. All tests green." },
    });
    expect(result.decision).toBe("blocked");
    expect((result as { blockedBy: string[] }).blockedBy).toContain("open_blockedby_links");
  });

  // AC-2: No structured blocker + thread prose contains "blocked on …" → ALLOW
  it("AC-2: 'blocked on' in historical prose does not block when state is clean", () => {
    const result = evaluateGuard({
      state: CLEAN_STATE,
      advisory: {
        allText: "Earlier we were blocked on the DB migration, which is now resolved.",
      },
    });
    expect(result.decision).toBe("pass");
  });

  // AC-3: No structured blocker + description/code-block quotes "awaiting approval" → ALLOW
  it("AC-3: 'awaiting approval' inside a code block is not a hard block", () => {
    const result = evaluateGuard({
      state: CLEAN_STATE,
      advisory: {
        allText: "See example:\n```\nawaiting approval\n```\nAll done now.",
      },
    });
    expect(result.decision).toBe("pass");
  });

  // AC-4a: Open child issue → BLOCK
  it("AC-4a: open child issue blocks terminal close", () => {
    const result = evaluateGuard({
      state: { ...CLEAN_STATE, openChildCount: 2 },
    });
    expect(result.decision).toBe("blocked");
    expect((result as { blockedBy: string[] }).blockedBy).toContain("open_child_issues");
  });

  // AC-4b: Pending confirmation → BLOCK
  it("AC-4b: pending request_confirmation blocks terminal close", () => {
    const result = evaluateGuard({
      state: { ...CLEAN_STATE, hasPendingConfirmation: true },
    });
    expect(result.decision).toBe("blocked");
    expect((result as { blockedBy: string[] }).blockedBy).toContain("pending_confirmation");
  });

  // AC-5: PR merged + CI green + sign-off + no structured blockers + no pending confirmation → ALLOW
  it("AC-5: clean structured state allows close even with advisory prose tokens", () => {
    const result = evaluateGuard({
      state: CLEAN_STATE,
      advisory: {
        allText: "PR merged. CI green. Sign-off recorded. This was once unresolved but is now done.",
      },
    });
    // advisory token "unresolved" matched — but decision is still "pass"
    expect(result.decision).toBe("pass");
  });

  // AC-6: guardAcknowledge on an advisory → ALLOW + acknowledged flag set
  it("AC-6: guardAcknowledge on advisory token allows close and records acknowledgment", () => {
    const result = evaluateGuard({
      state: CLEAN_STATE,
      advisory: {
        allText: "Mechanism: auto-escalates if still unresolved past SLA.",
        acknowledgedTokens: ["unresolved"],
        acknowledgedReason: "False positive: SLA mechanism description, not pending work",
      },
    });
    expect(result.decision).toBe("pass");
    const pass = result as { decision: "pass"; advisory?: { acknowledged: boolean } };
    expect(pass.advisory?.acknowledged).toBe(true);
  });

  // AC-7: Comment with no structural change on done issue — status unchanged.
  // (This is enforced at the route layer, not the guard service. The guard only runs on
  // terminal-status PATCH. A comment-only PATCH never reaches this code path.)
  // We document the invariant by verifying the guard itself cannot cause a reopen:
  it("AC-7: guard evaluates to pass when state is clean (cannot cause a status reopen)", () => {
    const result = evaluateGuard({ state: CLEAN_STATE });
    expect(result.decision).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// Multiple hard blockers can stack
// ---------------------------------------------------------------------------

describe("stacked hard blockers", () => {
  it("reports all active hard-block reasons", () => {
    const result = evaluateGuard({
      state: {
        unresolvedBlockerCount: 1,
        openChildCount: 3,
        hasPendingConfirmation: true,
        hasActiveRecoveryAction: true,
      },
    });
    expect(result.decision).toBe("blocked");
    const r = result as { blockedBy: string[] };
    expect(r.blockedBy).toContain("open_blockedby_links");
    expect(r.blockedBy).toContain("open_child_issues");
    expect(r.blockedBy).toContain("pending_confirmation");
    expect(r.blockedBy).toContain("active_recovery_action");
  });
});

// ---------------------------------------------------------------------------
// guardAcknowledge is advisory-only — cannot dismiss structured hard blockers
// ---------------------------------------------------------------------------

describe("guardAcknowledge is advisory-only", () => {
  it("guardAcknowledge does NOT unblock a structured hard blocker", () => {
    const result = evaluateGuard({
      state: { ...CLEAN_STATE, unresolvedBlockerCount: 1 },
      advisory: {
        allText: "blocked on infra ticket",
        acknowledgedTokens: ["blocked on"],
        acknowledgedReason: "prose only",
      },
    });
    // Hard blocker wins regardless of guardAcknowledge
    expect(result.decision).toBe("blocked");
    expect((result as { blockedBy: string[] }).blockedBy).toContain("open_blockedby_links");
  });

  it("partial advisory acknowledgment: unacknowledged token appears in advisory", () => {
    const result = evaluateGuard({
      state: CLEAN_STATE,
      advisory: {
        allText: "This was unresolved, now awaiting verification from DA.",
        acknowledgedTokens: ["unresolved"],
        acknowledgedReason: "historical only",
      },
    });
    // Pass — but advisory shows partial acknowledgment (awaiting verification not acked)
    expect(result.decision).toBe("pass");
    const pass = result as { decision: "pass"; advisory?: { acknowledged: boolean; matchedTokens: string[] } };
    expect(pass.advisory?.acknowledged).toBe(false);
    expect(pass.advisory?.matchedTokens).toContain("awaiting verification");
  });
});

// ---------------------------------------------------------------------------
// Advisory prose scan details
// ---------------------------------------------------------------------------

describe("advisory prose scan", () => {
  it("no advisory tokens → clean pass with no advisory field", () => {
    const result = evaluateGuard({
      state: CLEAN_STATE,
      advisory: { allText: "All done. Tests pass." },
    });
    expect(result.decision).toBe("pass");
    expect((result as { advisory?: unknown }).advisory).toBeUndefined();
  });

  it("advisory prose matched → pass with advisory.matchedTokens", () => {
    const result = evaluateGuard({
      state: CLEAN_STATE,
      advisory: { allText: "This item had unresolved state earlier." },
    });
    expect(result.decision).toBe("pass");
    const pass = result as { advisory?: { matchedTokens: string[] } };
    expect(pass.advisory?.matchedTokens).toContain("unresolved");
  });

  it("advisory tokens inside blockquotes are stripped (advisory also respects exclusions)", () => {
    const result = evaluateGuard({
      state: CLEAN_STATE,
      advisory: { allText: "> blocked on the previous run\nNow resolved." },
    });
    expect(result.decision).toBe("pass");
    // "blocked on" is in a blockquote — stripped before advisory scan
    expect((result as { advisory?: unknown }).advisory).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// findMatchedGuardTokens (utility)
// ---------------------------------------------------------------------------

describe("findMatchedGuardTokens", () => {
  it("matches multi-word token", () => {
    expect(findMatchedGuardTokens("blocked on verification", BUILTIN_GUARD_TOKENS)).toContain("blocked on");
  });

  it("is case-insensitive", () => {
    expect(findMatchedGuardTokens("UNRESOLVED items remain", BUILTIN_GUARD_TOKENS)).toContain("unresolved");
  });

  it("does not match inside fenced code block", () => {
    const text = "description:\n```\nunresolved\n```\nend";
    expect(findMatchedGuardTokens(text, BUILTIN_GUARD_TOKENS)).not.toContain("unresolved");
  });
});

// ---------------------------------------------------------------------------
// QUA-4139 carve-out — recovery / liveness-escalation forced terminal close.
//
// The gate lives in the PATCH /issues/:id route (server/src/routes/issues.ts):
// a terminal close is allowed past a structured hard block ONLY when the actor
// is a human/Board user (actorType === "user") AND forceTerminal === true.
// Agents are ALWAYS subject to the guard — forceTerminal is ignored for them.
//
// This pure replica mirrors the exact route condition so the gate has a
// permanent canary independent of the (heavy) full-route harness.
// ---------------------------------------------------------------------------

type CarveOutOutcome =
  | { http: 409; blockedBy: string[] }
  | { http: 200; audit: { decision: "pass" | "forced"; blockedBy: string[]; forcedByActorId?: string } };

function resolveTerminalClose(args: {
  guard: ReturnType<typeof evaluateGuard>;
  forceTerminal: boolean;
  actorType: "user" | "agent";
  actorId: string;
}): CarveOutOutcome {
  const { guard, forceTerminal, actorType, actorId } = args;
  // Exact route condition: forceTerminal honored only for human/Board actors.
  const forcedBypassAllowed = forceTerminal && actorType === "user";
  if (guard.decision === "blocked" && !forcedBypassAllowed) {
    return { http: 409, blockedBy: guard.blockedBy };
  }
  if (forcedBypassAllowed) {
    return {
      http: 200,
      audit: {
        decision: "forced",
        blockedBy: guard.decision === "blocked" ? guard.blockedBy : [],
        forcedByActorId: actorId,
      },
    };
  }
  return { http: 200, audit: { decision: "pass", blockedBy: [] } };
}

describe("QUA-4139 forceTerminal carve-out gate", () => {
  const blockedGuard = () =>
    evaluateGuard({ state: { ...CLEAN_STATE, unresolvedBlockerCount: 1 } });

  // (a) agent + forceTerminal:true + structured blocker → still 409
  it("(a) agent actor with forceTerminal cannot bypass a structured blocker → 409", () => {
    const outcome = resolveTerminalClose({
      guard: blockedGuard(),
      forceTerminal: true,
      actorType: "agent",
      actorId: "agent-123",
    });
    expect(outcome.http).toBe(409);
    expect((outcome as { blockedBy: string[] }).blockedBy).toContain("open_blockedby_links");
  });

  // (b) user + forceTerminal:true + structured blocker → passes (no 409) + audit shows forced
  it("(b) user actor with forceTerminal bypasses the structured blocker → 200, audit=forced", () => {
    const outcome = resolveTerminalClose({
      guard: blockedGuard(),
      forceTerminal: true,
      actorType: "user",
      actorId: "board",
    });
    expect(outcome.http).toBe(200);
    const ok = outcome as { http: 200; audit: { decision: string; blockedBy: string[]; forcedByActorId?: string } };
    expect(ok.audit.decision).toBe("forced");
    expect(ok.audit.blockedBy).toContain("open_blockedby_links");
    expect(ok.audit.forcedByActorId).toBe("board");
  });

  // (c) user WITHOUT forceTerminal + structured blocker → 409
  it("(c) user actor without forceTerminal is still subject to the guard → 409", () => {
    const outcome = resolveTerminalClose({
      guard: blockedGuard(),
      forceTerminal: false,
      actorType: "user",
      actorId: "board",
    });
    expect(outcome.http).toBe(409);
    expect((outcome as { blockedBy: string[] }).blockedBy).toContain("open_blockedby_links");
  });

  // (d) user + forceTerminal on a CLEAN state → 200, audit=forced with empty blockedBy
  it("(d) user actor with forceTerminal on clean state → 200, audit=forced, blockedBy=[]", () => {
    const outcome = resolveTerminalClose({
      guard: evaluateGuard({ state: CLEAN_STATE }),
      forceTerminal: true,
      actorType: "user",
      actorId: "board",
    });
    expect(outcome.http).toBe(200);
    const ok = outcome as { http: 200; audit: { decision: string; blockedBy: string[] } };
    expect(ok.audit.decision).toBe("forced");
    expect(ok.audit.blockedBy).toEqual([]);
  });

  // (e) agent on a clean state → normal pass (no forced record)
  it("(e) agent actor on clean state closes normally → 200, audit=pass", () => {
    const outcome = resolveTerminalClose({
      guard: evaluateGuard({ state: CLEAN_STATE }),
      forceTerminal: false,
      actorType: "agent",
      actorId: "agent-123",
    });
    expect(outcome.http).toBe(200);
    expect((outcome as { http: 200; audit: { decision: string } }).audit.decision).toBe("pass");
  });
});
