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
