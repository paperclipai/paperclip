import { describe, expect, it } from "vitest";
import {
  buildPendingConfirmationHazard,
  buildSupersessionPointers,
  isOptedIntoCommentSupersession,
  pendingConfirmationHazardPlacement,
  proseAnswerWarning,
} from "./interaction-supersession-hazard";
import type { IssueThreadInteraction } from "./issue-thread-interactions";

/**
 * RBR-914 (AC4 of RBR-893). These cover the derivation only — the hazard is presentation, so the
 * assertions here are about what the board is told, never about what the server does.
 */

const COMPANY_ID = "company-rbr914";
const ISSUE_ID = "issue-rbr914";

function confirmation(
  overrides: Partial<IssueThreadInteraction> & { id: string },
): IssueThreadInteraction {
  return {
    companyId: COMPANY_ID,
    issueId: ISSUE_ID,
    kind: "request_confirmation",
    title: "Confirm the irreversible thing",
    summary: null,
    status: "pending",
    continuationPolicy: "wake_assignee",
    createdByAgentId: "agent-a",
    createdByUserId: null,
    resolvedByAgentId: null,
    resolvedByUserId: null,
    createdAt: new Date("2026-05-01T10:00:00.000Z"),
    updatedAt: new Date("2026-05-01T10:00:00.000Z"),
    resolvedAt: null,
    payload: { version: 1, prompt: "Delete every row?" },
    result: null,
    ...overrides,
  } as IssueThreadInteraction;
}

describe("buildPendingConfirmationHazard", () => {
  it("reports no hazard for a single pending confirmation", () => {
    expect(buildPendingConfirmationHazard([confirmation({ id: "a" })])).toBeNull();
  });

  it("reports no hazard when the second confirmation is already resolved", () => {
    const hazard = buildPendingConfirmationHazard([
      confirmation({ id: "a" }),
      confirmation({ id: "b", status: "accepted" }),
    ]);
    expect(hazard).toBeNull();
  });

  it("ignores non-confirmation kinds when counting coexistence", () => {
    // A pending question is not a contradictory irreversible instruction; only
    // confirmation-like kinds are (mirrors the server's REQUEST_CONFIRMATION_INTERACTION_KINDS).
    const hazard = buildPendingConfirmationHazard([
      confirmation({ id: "a" }),
      confirmation({
        id: "q",
        kind: "ask_user_questions",
        payload: { version: 1, questions: [] },
      } as Partial<IssueThreadInteraction> & { id: string }),
    ]);
    expect(hazard).toBeNull();
  });

  it("AC1: marks the newest of several coexisting pending confirmations", () => {
    const hazard = buildPendingConfirmationHazard([
      confirmation({ id: "old", createdAt: new Date("2026-05-01T10:00:00.000Z") }),
      confirmation({ id: "new", createdAt: new Date("2026-05-01T12:00:00.000Z") }),
      confirmation({
        id: "mid",
        kind: "request_checkbox_confirmation",
        createdAt: new Date("2026-05-01T11:00:00.000Z"),
        payload: { version: 1, prompt: "Pick", options: [] },
      } as Partial<IssueThreadInteraction> & { id: string }),
    ]);
    expect(hazard).not.toBeNull();
    expect(hazard!.newestId).toBe("new");
    expect(hazard!.pending.map((row) => row.id)).toEqual(["new", "mid", "old"]);
    expect(hazard!.newestIsAmbiguous).toBe(false);
  });

  it("AC1: refuses to name a newest when two asks share a timestamp", () => {
    const at = new Date("2026-05-01T10:00:00.000Z");
    const rows = [confirmation({ id: "a", createdAt: at }), confirmation({ id: "b", createdAt: at })];
    expect(buildPendingConfirmationHazard(rows)!.newestIsAmbiguous).toBe(true);
    // Guessing a winner is the RBR-823 defect, so no card claims to be newest.
    for (const row of rows) {
      expect(pendingConfirmationHazardPlacement(row, rows)!.isNewest).toBe(false);
    }
  });
});

describe("prose-answer risk (AC2)", () => {
  it("classifies a lone opted-in ask as expires_one and says which way it breaks", () => {
    const hazard = buildPendingConfirmationHazard([
      confirmation({ id: "opted", payload: { version: 1, prompt: "x", supersedeOnUserComment: true } }),
      confirmation({ id: "plain" }),
    ])!;
    expect(hazard.proseRisk).toBe("expires_one");
    expect(hazard.proseOptedIn.map((row) => row.id)).toEqual(["opted"]);
    const warning = proseAnswerWarning(hazard);
    expect(warning).toContain("not a safe way to answer one of them");
    expect(warning).toContain("expire that ask");
  });

  it("classifies two opted-in asks as expires_none_multiple_optins", () => {
    const hazard = buildPendingConfirmationHazard([
      confirmation({ id: "a", payload: { version: 1, prompt: "x", supersedeOnUserComment: true } }),
      confirmation({ id: "b", payload: { version: 1, prompt: "y", supersedeOnUserComment: true } }),
    ])!;
    expect(hazard.proseRisk).toBe("expires_none_multiple_optins");
    expect(proseAnswerWarning(hazard)).toContain("expires none of them rather than guessing");
  });

  it("classifies the post-RBR-875 default (nothing opted in) as expires_none", () => {
    const hazard = buildPendingConfirmationHazard([
      confirmation({ id: "a" }),
      confirmation({ id: "b" }),
    ])!;
    expect(hazard.proseRisk).toBe("expires_none");
    expect(hazard.proseOptedIn).toHaveLength(0);
    expect(proseAnswerWarning(hazard)).toContain("leave every ask pending");
  });

  it("counts opted-in asks of any supersedable kind, not just confirmations", () => {
    // A pending opted-in question IS at risk from a prose reply even though it does not itself
    // create the coexistence hazard — the warning must account for it or it is a lie.
    const hazard = buildPendingConfirmationHazard([
      confirmation({ id: "a" }),
      confirmation({ id: "b" }),
      confirmation({
        id: "q",
        kind: "ask_user_questions",
        payload: { version: 1, questions: [], supersedeOnUserComment: true },
      } as Partial<IssueThreadInteraction> & { id: string }),
    ])!;
    expect(hazard.proseOptedIn.map((row) => row.id)).toEqual(["q"]);
    expect(hazard.proseRisk).toBe("expires_one");
  });

  it("does not treat suggest_tasks as comment-supersedable", () => {
    const suggest = confirmation({
      id: "s",
      kind: "suggest_tasks",
      payload: { version: 1, tasks: [], supersedeOnUserComment: true },
    } as Partial<IssueThreadInteraction> & { id: string });
    expect(isOptedIntoCommentSupersession(suggest)).toBe(false);
  });
});

describe("pendingConfirmationHazardPlacement", () => {
  it("gives each coexisting card its position and its peers", () => {
    const rows = [
      confirmation({ id: "new", createdAt: new Date("2026-05-01T12:00:00.000Z") }),
      confirmation({ id: "old", createdAt: new Date("2026-05-01T10:00:00.000Z") }),
    ];
    const newest = pendingConfirmationHazardPlacement(rows[0]!, rows)!;
    expect(newest.isNewest).toBe(true);
    expect(newest.position).toBe(1);
    expect(newest.total).toBe(2);
    expect(newest.others.map((row) => row.id)).toEqual(["old"]);

    const older = pendingConfirmationHazardPlacement(rows[1]!, rows)!;
    expect(older.isNewest).toBe(false);
    expect(older.position).toBe(2);
    expect(older.others.map((row) => row.id)).toEqual(["new"]);
  });

  it("returns null for a card that is not part of the hazard", () => {
    const rows = [
      confirmation({ id: "a" }),
      confirmation({ id: "b" }),
      confirmation({ id: "settled", status: "accepted" }),
    ];
    expect(pendingConfirmationHazardPlacement(rows[2]!, rows)).toBeNull();
  });

  it("returns null when no sibling context was supplied", () => {
    const lone = confirmation({ id: "a" });
    expect(pendingConfirmationHazardPlacement(lone, [lone])).toBeNull();
  });
});

describe("buildSupersessionPointers (AC3)", () => {
  it("returns null when there is no declared relationship", () => {
    const row = confirmation({ id: "a" });
    expect(buildSupersessionPointers(row, [row])).toBeNull();
  });

  it("resolves a declared supersedesInteractionIds target to a label, status and anchor", () => {
    const target = confirmation({ id: "old", status: "expired", title: "Delete rows (v1)" });
    const replacement = confirmation({
      id: "new",
      title: "Delete rows (v2)",
      payload: { version: 1, prompt: "x", supersedesInteractionIds: ["old"] },
    });
    const pointers = buildSupersessionPointers(replacement, [target, replacement])!;
    expect(pointers.replaces).toHaveLength(1);
    expect(pointers.replaces[0]).toEqual({
      id: "old",
      label: "Delete rows (v1)",
      status: "expired",
      href: "#interaction-old",
    });
    expect(pointers.replacedBy).toBeNull();
  });

  it("surfaces the reverse pointer on the ask that was replaced", () => {
    const replacement = confirmation({ id: "new", title: "Delete rows (v2)" });
    const retired = confirmation({
      id: "old",
      status: "expired",
      result: {
        version: 1,
        outcome: "superseded_by_interaction",
        supersededByInteractionId: "new",
      },
    } as Partial<IssueThreadInteraction> & { id: string });
    const pointers = buildSupersessionPointers(retired, [retired, replacement])!;
    expect(pointers.replacedBy).toEqual({
      id: "new",
      label: "Delete rows (v2)",
      status: "pending",
      href: "#interaction-new",
    });
  });

  it("marks an off-thread target rather than emitting a dead anchor", () => {
    // Cross-issue supersession is legal server-side (same company), so the target may genuinely
    // not be in this thread's payload.
    const replacement = confirmation({
      id: "new",
      payload: { version: 1, prompt: "x", supersedesInteractionIds: ["elsewhere"] },
    });
    const pointers = buildSupersessionPointers(replacement, [replacement])!;
    expect(pointers.replaces[0]).toEqual({
      id: "elsewhere",
      label: null,
      status: null,
      href: null,
    });
  });

  it("falls back to a kind label when the superseded ask has no title", () => {
    const target = confirmation({ id: "old", title: null, kind: "request_item_verdicts" } as Partial<IssueThreadInteraction> & { id: string });
    const replacement = confirmation({
      id: "new",
      payload: { version: 1, prompt: "x", supersedesInteractionIds: ["old"] },
    });
    const pointers = buildSupersessionPointers(replacement, [target, replacement])!;
    expect(pointers.replaces[0]!.label).toBe("Item review request");
  });

  it("ignores non-string ids in a malformed payload", () => {
    const replacement = confirmation({
      id: "new",
      payload: { version: 1, prompt: "x", supersedesInteractionIds: [null, 3, "", "ok"] },
    } as Partial<IssueThreadInteraction> & { id: string });
    const pointers = buildSupersessionPointers(replacement, [replacement])!;
    expect(pointers.replaces.map((pointer) => pointer.id)).toEqual(["ok"]);
  });
});
