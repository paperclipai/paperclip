import { describe, expect, it } from "vitest";
import {
  WAKE_EQUIVALENCE_PAYLOAD_KEY,
  WAKE_REQUEST_COALESCE_WINDOW_MS,
  buildWakeEquivalenceFingerprint,
  decideEquivalentWakeCoalescing,
  formatBlockerState,
  readWakeEquivalenceStamp,
  readWakeRequestIssueScope,
  selectCoalesceTarget,
  stampWakeEquivalencePayload,
  stripWakeEquivalencePayload,
  wakeRequestCoalesceExemption,
  type StoredWakeEquivalence,
  type WakeEquivalenceMaterial,
} from "./wake-request-coalescing.js";

const NOW = new Date("2026-09-24T16:00:00.000Z");

function material(overrides: Partial<WakeEquivalenceMaterial> = {}): WakeEquivalenceMaterial {
  return {
    companyId: "company-1",
    agentId: "agent-1",
    issueId: "issue-1",
    ownerAgentId: "agent-1",
    issueStatus: "in_progress",
    issueStatusVersion: 3,
    blockerState: formatBlockerState({
      known: true,
      ready: true,
      unresolvedBlockerIssueIds: [],
      blockedTransitionAt: null,
    }),
    payload: { mutation: "comment", commentId: "comment-1" },
    ...overrides,
  };
}

function stored(overrides: Partial<StoredWakeEquivalence> = {}): StoredWakeEquivalence {
  const fingerprint = buildWakeEquivalenceFingerprint(material());
  return {
    id: "wake-1",
    companyId: "company-1",
    agentId: "agent-1",
    issueId: "issue-1",
    status: "queued",
    requestedAt: new Date(NOW.getTime() - 1_000),
    fingerprint,
    runId: "run-1",
    coalescedCount: 0,
    ...overrides,
  };
}

describe("wake request equivalence", () => {
  it("coalesces a duplicate pending wake inside the window", () => {
    const fingerprint = buildWakeEquivalenceFingerprint(material());
    const decision = decideEquivalentWakeCoalescing({
      now: NOW,
      incomingFingerprint: fingerprint,
      incoming: { companyId: "company-1", agentId: "agent-1", issueId: "issue-1" },
      candidate: stored(),
    });
    expect(decision).toEqual({ coalesce: true, relation: "equivalent_pending" });
  });

  it("does not let a completed wake absorb a later request", () => {
    const fingerprint = buildWakeEquivalenceFingerprint(material());
    const decision = decideEquivalentWakeCoalescing({
      now: NOW,
      incomingFingerprint: fingerprint,
      incoming: { companyId: "company-1", agentId: "agent-1", issueId: "issue-1" },
      candidate: stored({ status: "completed", requestedAt: new Date(NOW.getTime() - 1_000) }),
    });
    expect(decision).toEqual({ coalesce: false });
  });

  it("admits a wake once the bounded window has passed", () => {
    const fingerprint = buildWakeEquivalenceFingerprint(material());
    const decision = decideEquivalentWakeCoalescing({
      now: NOW,
      incomingFingerprint: fingerprint,
      incoming: { companyId: "company-1", agentId: "agent-1", issueId: "issue-1" },
      candidate: stored({
        requestedAt: new Date(NOW.getTime() - WAKE_REQUEST_COALESCE_WINDOW_MS - 1),
      }),
    });
    expect(decision).toEqual({ coalesce: false });
  });

  it.each([
    ["owner", material({ ownerAgentId: "agent-2" })],
    ["status", material({ issueStatus: "todo" })],
    ["status version", material({ issueStatusVersion: 4 })],
    ["blockers", material({
      blockerState: formatBlockerState({
        known: true,
        ready: false,
        unresolvedBlockerIssueIds: ["blocker-1"],
        blockedTransitionAt: "2026-09-24T15:00:00.000Z",
      }),
    })],
    ["payload", material({ payload: { mutation: "comment", commentId: "comment-2" } })],
    ["payload head sha", material({ payload: { mutation: "comment", commentId: "comment-1", headSha: "fff" } })],
  ])("still wakes when %s changes", (_label, changed) => {
    const decision = decideEquivalentWakeCoalescing({
      now: NOW,
      incomingFingerprint: buildWakeEquivalenceFingerprint(changed),
      incoming: { companyId: "company-1", agentId: "agent-1", issueId: "issue-1" },
      candidate: stored(),
    });
    expect(decision).toEqual({ coalesce: false });
  });

  it("treats equivalent sources with the same material payload as one wake", () => {
    const comment = buildWakeEquivalenceFingerprint(material({
      payload: { commentId: "c1", mutation: "comment", requestedAt: "t1", issueId: "issue-1" },
    }));
    const replay = buildWakeEquivalenceFingerprint(material({
      payload: { mutation: "comment", issueId: "issue-1", commentId: "c1", requestedAt: "t2" },
    }));
    expect(comment).toBe(replay);
  });

  it("keeps a changed child-completion payload distinct from a comment wake", () => {
    const comment = buildWakeEquivalenceFingerprint(material());
    const child = buildWakeEquivalenceFingerprint(material({
      payload: { completedChildIssueId: "child-1", childIssueIds: ["child-1"] },
    }));
    expect(comment).not.toBe(child);
  });

  it.each([
    ["company", { companyId: "company-2" }],
    ["agent", { agentId: "agent-2" }],
    ["issue", { issueId: "issue-2" }],
  ] as const)("does not cross the %s boundary", (_label, scope) => {
    const fingerprint = buildWakeEquivalenceFingerprint(material());
    const decision = decideEquivalentWakeCoalescing({
      now: NOW,
      incomingFingerprint: fingerprint,
      incoming: { companyId: "company-1", agentId: "agent-1", issueId: "issue-1", ...scope },
      candidate: stored(),
    });
    expect(decision).toEqual({ coalesce: false });
  });

  it("does not coalesce explicit user wakes or failure retries", () => {
    expect(wakeRequestCoalesceExemption({
      manualUserWake: true,
      blockerStateKnown: true,
    })).toBe("explicit_user_wake");
    expect(wakeRequestCoalesceExemption({
      requestedByActorType: "user",
      triggerDetail: "manual",
      blockerStateKnown: true,
    })).toBe("explicit_user_wake");
    expect(wakeRequestCoalesceExemption({
      failedRunId: "run-failed",
      blockerStateKnown: true,
    })).toBe("retry_after_failure");
    expect(wakeRequestCoalesceExemption({
      wakeReason: "retry_failed_run",
      blockerStateKnown: true,
    })).toBe("retry_after_failure");
    expect(wakeRequestCoalesceExemption({
      allowRunCoalescing: false,
      blockerStateKnown: true,
    })).toBe("run_coalescing_disabled");
    expect(wakeRequestCoalesceExemption({ blockerStateKnown: false })).toBe("unknown_blocker_state");
  });

  it("stores only the fingerprint stamp and strips it from prompt payloads", () => {
    const fingerprint = buildWakeEquivalenceFingerprint(material());
    const stamped = stampWakeEquivalencePayload(
      { commentId: "c1", token: "secret", issueId: "other-issue" },
      { v: 1, fingerprint, issueId: "issue-1" },
    );
    expect(readWakeEquivalenceStamp(stamped)?.fingerprint).toBe(fingerprint);
    expect(stamped.issueId).toBe("issue-1");
    expect(readWakeRequestIssueScope({
      [WAKE_EQUIVALENCE_PAYLOAD_KEY]: { v: 1, fingerprint, issueId: "issue-1" },
      issueId: "other-issue",
    })).toBe("issue-1");
    expect(readWakeRequestIssueScope({ mutation: "comment" })).toBeNull();
    expect(stripWakeEquivalencePayload(stamped)).toEqual({
      commentId: "c1",
      token: "secret",
      issueId: "issue-1",
    });
    expect(JSON.stringify(readWakeEquivalenceStamp(stamped))).not.toContain("secret");
  });
});

describe("concurrent duplicate admission", () => {
  it("lets one winner queue and coalesces the racing duplicates onto that run", async () => {
    const fingerprint = buildWakeEquivalenceFingerprint(material());
    const rows: StoredWakeEquivalence[] = [];
    let chain = Promise.resolve();
    const admit = () => {
      const run = chain.then(() => {
        const match = selectCoalesceTarget(
          { companyId: "company-1", agentId: "agent-1", issueId: "issue-1", fingerprint },
          rows,
          NOW,
        );
        if (match) {
          match.target.coalescedCount += 1;
          rows.push(stored({
            id: `coalesced-${rows.length}`,
            status: "coalesced",
            fingerprint,
            runId: match.target.runId,
            requestedAt: NOW,
          }));
          return { coalesced: true, runId: match.target.runId };
        }
        rows.push(stored({ id: "wake-winner", fingerprint, requestedAt: NOW }));
        return { coalesced: false, runId: "run-1" };
      });
      chain = run.then(() => undefined, () => undefined);
      return run;
    };

    const results = await Promise.all(Array.from({ length: 8 }, () => admit()));
    expect(results.filter((result) => !result.coalesced)).toHaveLength(1);
    expect(new Set(results.map((result) => result.runId))).toEqual(new Set(["run-1"]));
    expect(rows[0]?.coalescedCount).toBe(7);
  });
});
