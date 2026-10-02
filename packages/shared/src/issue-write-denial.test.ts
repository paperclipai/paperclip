import { describe, expect, it } from "vitest";

import {
  ISSUE_WRITE_DENIAL_CODES,
  describeIssueWriteDenial,
  isIssueWriteDenialCode,
  issueWriteDenialApiMessage,
  issueWriteDenialCodeForResponsibleUserDenial,
  issueWriteDenialResponse,
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

  it("does not send an unscoped run back to resend the header it already sent", () => {
    // The header is honoured; an on-demand run's `contextSnapshot` is what is empty, and
    // no caller can populate it. Offering the header alone read as "retry this" and cost
    // agents retry loops plus a wrong read of their own permissions (#13078).
    const copy = describeIssueWriteDenial("cross_issue_influence_run_context_required");
    expect(copy.sanctionedPath).toContain("unscoped");
    expect(copy.sanctionedPath).toContain("cannot help");
    // The two channels this denial never gated, so the agent stops concluding it is mute.
    expect(copy.sanctionedPath).toContain("documents");
    expect(copy.description).toContain("no issue scope");
  });

  it("tells a caller whose run header never reached the server to send it", () => {
    const copy = describeIssueWriteDenial("cross_issue_influence_run_context_required", {
      runHeaderPresent: false,
    });
    expect(copy.sanctionedPath).toContain("Send the `X-Paperclip-Run-Id` header");
    expect(copy.sanctionedPath).toContain("PAPERCLIP_RUN_ID");
    // Absent is the one branch where re-sending is the fix, so never call it futile.
    expect(copy.sanctionedPath).not.toContain("cannot help");
    // The server cannot tell "never sent" from "stripped in transit", so it names both.
    expect(copy.sanctionedPath).toContain("sandbox-bridge header allowlist");
    expect(copy.description).toContain("No `X-Paperclip-Run-Id` header reached the server");
  });

  it("stops advising the header once the server has seen it arrive", () => {
    // Regression (#12118): a probe agent confirmed with `curl -v` that the header was
    // on the wire, read advice it had already satisfied, invented a wrong root cause
    // and ended its heartbeat. Observed presence must change the advice, not just the
    // refusal — and it must still name the ownership path #13078 added.
    const copy = describeIssueWriteDenial("cross_issue_influence_run_context_required", {
      runHeaderPresent: true,
    });
    expect(copy.sanctionedPath).not.toContain("Send the `X-Paperclip-Run-Id` header");
    expect(copy.sanctionedPath).toContain("already arrived, so re-sending it cannot help");
    expect(copy.sanctionedPath).toContain("sandbox-bridge header allowlist");
    expect(copy.sanctionedPath).toContain("assigned to you or checked out by this run");
    expect(copy.sanctionedPath).toContain("documents");
    expect(copy.description).toContain("did reach the server");
  });

  it("keeps one code, boundary, status and tone across all three run-context branches", () => {
    // Callers and tests match on `code`; only the human-facing copy may differ.
    const branches = [undefined, false, true].map((runHeaderPresent) =>
      describeIssueWriteDenial("cross_issue_influence_run_context_required", {
        runHeaderPresent,
      }),
    );
    for (const branch of branches) {
      expect(branch.code).toBe("cross_issue_influence_run_context_required");
      expect(branch.boundary).toBe(branches[0].boundary);
      expect(branch.status).toBe(branches[0].status);
      expect(branch.tone).toBe(branches[0].tone);
      expect(branch.whoCanAct).toBe(branches[0].whoCanAct);
    }
    // ...and the copy genuinely differs, or the branch bought nothing.
    expect(new Set(branches.map((branch) => branch.sanctionedPath)).size).toBe(3);
    expect(new Set(branches.map((branch) => branch.description)).size).toBe(3);
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
