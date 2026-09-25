import { describe, expect, it } from "vitest";

import {
  CROSS_ISSUE_RUN_CONTEXT_REASONS,
  ISSUE_WRITE_DENIAL_CODES,
  describeIssueWriteDenial,
  isIssueWriteDenialCode,
  issueWriteDenialApiMessage,
  issueWriteDenialCodeForResponsibleUserDenial,
  issueWriteDenialResponse,
  type CrossIssueRunContextReason,
} from "./issue-write-denial.js";

describe("describeIssueWriteDenial", () => {
  it("answers all three plan §6 obligations for every code", () => {
    for (const code of ISSUE_WRITE_DENIAL_CODES) {
      const copy = describeIssueWriteDenial(code);
      expect(copy.code, code).toBe(code);
      // Boundary that fired, who can act, sanctioned path — none may be empty.
      expect(copy.boundary.trim().length, code).toBeGreaterThan(0);
      expect(copy.whoCanAct.trim().length, code).toBeGreaterThan(0);
      expect(copy.sanctionedPath.trim().length, code).toBeGreaterThan(0);
      expect(copy.title.trim().length, code).toBeGreaterThan(0);
      expect(copy.description.trim().length, code).toBeGreaterThan(0);
    }
  });

  it("never leaks a raw id or placeholder when labels are unknown", () => {
    for (const code of ISSUE_WRITE_DENIAL_CODES) {
      const copy = describeIssueWriteDenial(code);
      const prose = `${copy.description} ${copy.whoCanAct} ${copy.sanctionedPath}`;
      expect(prose, code).not.toMatch(/undefined|null/);
      // Unknown labels degrade to generic nouns, never a bare id.
      expect(prose, code).toMatch(/this task|this agent|the current assignee|the responsible user/);
    }
  });

  it("keeps the boundary free of parentheses and distinct from the title", () => {
    for (const code of ISSUE_WRITE_DENIAL_CODES) {
      const copy = describeIssueWriteDenial(code, { cap: 20 });
      // Surfaces render the boundary inside their own parens — nesting stutters.
      expect(copy.boundary, code).not.toMatch(/[()]/);
      // A title echoed verbatim as its own boundary reads as a mistake.
      expect(copy.boundary.toLowerCase(), code).not.toBe(copy.title.toLowerCase());
    }
  });

  it("names the actor, assignee, and task when they are known", () => {
    const copy = describeIssueWriteDenial("issue_write_not_visible", {
      actorLabel: "Fable",
      assigneeLabel: "CodexCoder",
      issueIdentifier: "TASK-482",
    });
    expect(copy.description).toContain("TASK-482");
    expect(copy.description).toContain("Fable");
    expect(copy.whoCanAct).toContain("CodexCoder");
  });

  it("points a visibility denial at the sanctioned child-issue path", () => {
    const copy = describeIssueWriteDenial("issue_write_not_visible");
    // The incident detour was discovering exactly this workaround.
    expect(copy.sanctionedPath).toContain("child issue");
  });

  it("frames the per-run cap as a rate backstop, not a permission decision", () => {
    const copy = describeIssueWriteDenial("cross_issue_influence_cap_exceeded", {
      cap: 20,
      count: 21,
      actorLabel: "Fable",
    });
    expect(copy.status).toBe(429);
    expect(copy.tone).toBe("cap");
    expect(copy.boundary).toContain("20");
    expect(copy.description).toContain("attempt 21");
    expect(copy.description).toContain("still allowed");
    expect(copy.sanctionedPath).toContain("next heartbeat");
  });

  it("defaults the cap to the shipped limit when context omits it", () => {
    const copy = describeIssueWriteDenial("cross_issue_influence_cap_exceeded");
    expect(copy.boundary).toContain("20");
    expect(copy.description).not.toContain("attempt");
  });

  it("gives the run-context denial a copy-pasteable fix", () => {
    const copy = describeIssueWriteDenial("cross_issue_influence_run_context_required");
    expect(copy.sanctionedPath).toContain("X-Paperclip-Run-Id");
    expect(copy.sanctionedPath).toContain("PAPERCLIP_RUN_ID");
  });

  it("tells a spoof attempt that the write itself was fine", () => {
    const copy = describeIssueWriteDenial("issue_write_attribution_spoof_rejected", {
      actorLabel: "Fable",
      responsibleUserName: "Dotta",
    });
    expect(copy.status).toBe(422);
    expect(copy.whoCanAct).toContain("Fable");
    expect(copy.sanctionedPath).toContain("Dotta");
    expect(copy.sanctionedPath).toContain("onBehalfOfUserId");
  });

  it("routes a run lock to comments, which stay open", () => {
    const copy = describeIssueWriteDenial("issue_write_assignee_run_lock", {
      assigneeLabel: "CodexCoder",
    });
    expect(copy.status).toBe(409);
    expect(copy.tone).toBe("lock");
    expect(copy.sanctionedPath).toContain("Comment instead");
    expect(copy.sanctionedPath).toContain("CodexCoder");
  });

  it("reuses responsible-user ceiling copy and keeps on-behalf-of terminology", () => {
    const ceiling = describeIssueWriteDenial("issue_write_responsible_user_ceiling", {
      responsibleUserName: "Dotta",
      issueIdentifier: "TASK-517",
    });
    expect(ceiling.title).toBe("Responsible user not authorized");
    expect(ceiling.description).toContain("on behalf");
    expect(ceiling.description).toContain("TASK-517");
    expect(ceiling.description).not.toContain("impersonat");
    expect(ceiling.whoCanAct).toContain("Dotta");

    const unavailable = describeIssueWriteDenial("issue_write_responsible_user_unavailable", {
      responsibleUserName: "Dotta",
    });
    expect(unavailable.title).toBe("Responsible user unavailable");
    expect(unavailable.sanctionedPath).toContain("blocked");
  });

  it("falls back to generic phrasing when the responsible user is unknown", () => {
    const copy = describeIssueWriteDenial("issue_write_responsible_user_ceiling");
    expect(copy.description).toContain("the responsible user");
  });
});

describe("issueWriteDenialCodeForResponsibleUserDenial", () => {
  it("bridges both authorization-layer ceiling codes", () => {
    expect(issueWriteDenialCodeForResponsibleUserDenial("RESPONSIBLE_USER_UNAUTHORIZED"))
      .toBe("issue_write_responsible_user_ceiling");
    expect(issueWriteDenialCodeForResponsibleUserDenial("RESPONSIBLE_USER_UNAVAILABLE"))
      .toBe("issue_write_responsible_user_unavailable");
  });
});

describe("isIssueWriteDenialCode", () => {
  it("accepts shipped codes and rejects everything else", () => {
    expect(isIssueWriteDenialCode("issue_write_not_visible")).toBe(true);
    expect(isIssueWriteDenialCode("RESPONSIBLE_USER_UNAUTHORIZED")).toBe(false);
    expect(isIssueWriteDenialCode(null)).toBe(false);
    expect(isIssueWriteDenialCode(undefined)).toBe(false);
    expect(isIssueWriteDenialCode("")).toBe(false);
  });
});

describe("issueWriteDenialApiMessage", () => {
  it("keeps boundary, who-can-act, and sanctioned path in the flattened error", () => {
    const copy = describeIssueWriteDenial("issue_write_not_visible", {
      actorLabel: "Fable",
      issueIdentifier: "TASK-482",
    });
    const message = issueWriteDenialApiMessage(copy);
    expect(message).toContain(copy.boundary);
    expect(message).toContain("Who can act:");
    expect(message).toContain("Try this:");
    expect(message).toContain(copy.sanctionedPath);
  });
});

describe("issueWriteDenialResponse", () => {
  it("pairs the status with a machine-readable details payload", () => {
    const { status, body } = issueWriteDenialResponse("cross_issue_influence_cap_exceeded", {
      cap: 20,
      count: 21,
    });
    expect(status).toBe(429);
    expect(body.details.code).toBe("cross_issue_influence_cap_exceeded");
    expect(body.details.boundary).toContain("20");
    expect(body.error).toContain("Who can act:");
  });

  it("uses the status each code declares", () => {
    expect(issueWriteDenialResponse("issue_write_assignee_run_lock").status).toBe(409);
    expect(issueWriteDenialResponse("issue_write_attribution_spoof_rejected").status).toBe(422);
    expect(issueWriteDenialResponse("issue_write_not_visible").status).toBe(403);
  });
});

/**
 * The run-context copy used to be emitted without knowing why the gate refused.
 * The gate resolves the run, company and agent *before* it can report an
 * unbound target, so a caller in that state is provably already carrying a
 * valid run id — and the shipped remedy ("send `X-Paperclip-Run-Id` and
 * retry") was a step that could not change the response. Measured: bare and
 * header'd POSTs return byte-identical 403 bodies. Nothing tied the message to
 * its effect, so nothing caught it, and an operator who followed the advice
 * correctly concluded the write was impossible.
 *
 * The invariant below is the tie: for every reason, the sanctioned path must
 * name the mechanism that reason actually requires, and must not offer the
 * mechanism that reason has already ruled out.
 */
const HEADER_REMEDY = "X-Paperclip-Run-Id";

/** Which mechanism each reason's condition is actually cleared by. */
const REMEDY_FOR_REASON: Record<CrossIssueRunContextReason, "header" | "checkout"> = {
  // The run id did not arrive at all, or not as a uuid: the header is the fix.
  malformed_run_id: "header",
  // The run does not exist, or is not this agent's: sending it is still the fix.
  run_not_found: "header",
  // The run is already found, company-matched and agent-matched. Only the
  // target binding is missing, and only `checkout` establishes it.
  no_context_source_and_target_unbound: "checkout",
};

describe("cross-issue run-context denial copy, per reason", () => {
  it("declares a remedy for every reason the gate can report", () => {
    expect([...CROSS_ISSUE_RUN_CONTEXT_REASONS].sort()).toEqual(
      Object.keys(REMEDY_FOR_REASON).sort(),
    );
  });

  it.each(CROSS_ISSUE_RUN_CONTEXT_REASONS)(
    "names the mechanism %s actually requires, and not the other one",
    (reason) => {
      const { body } = issueWriteDenialResponse("cross_issue_influence_run_context_required", {
        reason,
        issueIdentifier: "TASK-482",
      });
      const { sanctionedPath } = body.details;

      if (REMEDY_FOR_REASON[reason] === "checkout") {
        expect(sanctionedPath).toContain("POST /api/issues/{issueId}/checkout");
        expect(sanctionedPath).not.toContain(`Send the \`${HEADER_REMEDY}\``);
      } else {
        expect(sanctionedPath).toContain(HEADER_REMEDY);
        expect(sanctionedPath).not.toContain("checkout");
      }
    },
  );

  it("does not tell an already-identified run that its run id is the problem", () => {
    const copy = describeIssueWriteDenial("cross_issue_influence_run_context_required", {
      reason: "no_context_source_and_target_unbound",
      issueIdentifier: "TASK-482",
    });

    expect(copy.title).toMatch(/not bound/i);
    expect(copy.description).not.toMatch(/valid run/i);
    // Only the run-id reasons are allowed to claim the run is unknown.
    for (const reason of ["malformed_run_id", "run_not_found"] as const) {
      expect(
        describeIssueWriteDenial("cross_issue_influence_run_context_required", { reason })
          .description,
      ).toMatch(/valid run/i);
    }
  });

  it("leaves the run-id copy byte-identical, including the no-reason default", () => {
    const before = describeIssueWriteDenial("cross_issue_influence_run_context_required");
    for (const reason of ["malformed_run_id", "run_not_found"] as const) {
      expect(
        describeIssueWriteDenial("cross_issue_influence_run_context_required", { reason }),
      ).toEqual(before);
    }
    expect(before.sanctionedPath).toContain(HEADER_REMEDY);
  });

  it("tells an owned task to check out rather than to resend the header", () => {
    const { body } = issueWriteDenialResponse("cross_issue_influence_run_context_required", {
      reason: "no_context_source_and_target_unbound",
      issueIdentifier: "TASK-482",
      targetOwnedByAnotherAgent: false,
    });

    expect(body.details.sanctionedPath).toContain("POST /api/issues/{issueId}/checkout");
    expect(body.details.whoCanAct).toContain("TASK-482");
    expect(body.error).toContain(HEADER_REMEDY);
  });

  it("routes another agent's task to a child issue or a reassignment, and names the 409", () => {
    const { body } = issueWriteDenialResponse("cross_issue_influence_run_context_required", {
      reason: "no_context_source_and_target_unbound",
      issueIdentifier: "TASK-482",
      assigneeLabel: "Hermes",
      targetOwnedByAnotherAgent: true,
    });

    // One actionable message, not a 403 followed by an unannotated 409.
    expect(body.error).toContain("TASK-482");
    expect(body.error).toContain("Hermes");
    expect(body.error).toContain("child issue");
    expect(body.error).toContain("reassign");
    expect(body.error).toContain("409");
    expect(body.details.whoCanAct).toContain("Hermes");
    // A target that is not the caller's is not reachable by checkout, so the
    // sanctioned path must not send the operator down that door.
    expect(body.details.sanctionedPath).not.toContain("POST /api/issues/{issueId}/checkout");
  });

  it("falls back to nouns rather than printing raw uids", () => {
    const owned = issueWriteDenialResponse("cross_issue_influence_run_context_required", {
      reason: "no_context_source_and_target_unbound",
    });
    expect(owned.body.error).toContain("this task");
    expect(owned.body.details.whoCanAct).toContain("this agent");

    const unowned = issueWriteDenialResponse("cross_issue_influence_run_context_required", {
      reason: "no_context_source_and_target_unbound",
      targetOwnedByAnotherAgent: true,
    });
    expect(unowned.body.error).toContain("this task");
    expect(unowned.body.details.whoCanAct).toContain("the current assignee");
  });

  it("leaves the status and tone alone; only the prose varies by reason", () => {
    // The gate's status and tone are contractual for the surface that renders
    // them, so a reason may change the sentences and nothing else.
    for (const reason of CROSS_ISSUE_RUN_CONTEXT_REASONS) {
      const copy = describeIssueWriteDenial("cross_issue_influence_run_context_required", { reason });
      expect(copy.status).toBe(403);
      expect(copy.tone).toBe("boundary");
      expect(copy.code).toBe("cross_issue_influence_run_context_required");
    }
  });
});
