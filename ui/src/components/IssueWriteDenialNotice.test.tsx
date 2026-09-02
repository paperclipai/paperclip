// @vitest-environment node

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ISSUE_WRITE_DENIAL_CODES } from "@paperclipai/shared";
import { IssueWriteDenialNotice } from "./IssueWriteDenialNotice";
import { issueWriteDenialForActivity } from "../lib/issue-write-denial-activity";

describe("IssueWriteDenialNotice", () => {
  it("answers all three plan §6 obligations for every code", () => {
    for (const code of ISSUE_WRITE_DENIAL_CODES) {
      const html = renderToStaticMarkup(<IssueWriteDenialNotice code={code} />);
      expect(html, code).toContain("Who can act:");
      expect(html, code).toContain("Try this:");
      expect(html, code).toContain(`data-denial-code="${code}"`);
    }
  });

  it("names the boundary that fired alongside the title", () => {
    const html = renderToStaticMarkup(
      <IssueWriteDenialNotice
        code="issue_write_not_visible"
        context={{ actorLabel: "Fable", issueIdentifier: "TASK-482" }}
      />,
    );

    expect(html).toContain("Issue visibility");
    expect(html).toContain("TASK-482");
    expect(html).toContain("Fable");
    // The workaround the incident had to discover is now stated outright.
    expect(html).toContain("child issue");
  });

  it("tones a run lock as transient rather than a permission wall", () => {
    const lock = renderToStaticMarkup(
      <IssueWriteDenialNotice
        code="issue_write_assignee_run_lock"
        context={{ assigneeLabel: "CodexCoder" }}
      />,
    );
    expect(lock).toContain('data-denial-tone="lock"');
    expect(lock).toContain("Comment instead");

    const wall = renderToStaticMarkup(
      <IssueWriteDenialNotice code="issue_write_not_visible" />,
    );
    expect(wall).toContain('data-denial-tone="boundary"');
  });

  it("shows the cap and attempt count on a rate denial", () => {
    const html = renderToStaticMarkup(
      <IssueWriteDenialNotice
        code="cross_issue_influence_cap_exceeded"
        context={{ cap: 20, count: 21, actorLabel: "Fable" }}
      />,
    );
    expect(html).toContain('data-denial-tone="cap"');
    expect(html).toContain("20");
    expect(html).toContain("attempt 21");
  });
});

describe("issueWriteDenialForActivity", () => {
  it("maps the cap-rejected activity event onto the cap denial", () => {
    const result = issueWriteDenialForActivity(
      "issue.cross_issue_influence_cap_rejected",
      { identifier: "TASK-482", cap: 20, count: 21, enforceAt: "2026-08-11T00:00:00.000Z" },
      { actorLabel: "Fable" },
    );

    expect(result?.code).toBe("cross_issue_influence_cap_exceeded");
    expect(result?.context).toMatchObject({
      actorLabel: "Fable",
      issueIdentifier: "TASK-482",
      cap: 20,
      count: 21,
    });
  });

  it("maps a rejected attribution spoof", () => {
    expect(issueWriteDenialForActivity("issue.attribution_spoof_rejected", { identifier: "TASK-1" })?.code)
      .toBe("issue_write_attribution_spoof_rejected");
  });

  it("ignores activity actions that are not denials", () => {
    expect(issueWriteDenialForActivity("issue.updated", {})).toBeNull();
    expect(issueWriteDenialForActivity("issue.comment_added", {})).toBeNull();
    // An observed (allowed) cross-issue write is not a denial.
    expect(issueWriteDenialForActivity("issue.cross_issue_influence_observed", {})).toBeNull();
  });

  it("tolerates missing or malformed details", () => {
    const result = issueWriteDenialForActivity("issue.attribution_spoof_rejected", null);
    expect(result?.context).toMatchObject({ issueIdentifier: null, cap: null, count: null });

    const bad = issueWriteDenialForActivity("issue.cross_issue_influence_cap_rejected", {
      identifier: 42,
      cap: "twenty",
    });
    expect(bad?.context.issueIdentifier).toBeNull();
    expect(bad?.context.cap).toBeNull();
  });
});
