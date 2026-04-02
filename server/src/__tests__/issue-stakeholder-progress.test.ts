import { describe, expect, it } from "vitest";
import {
  buildIssueStakeholderProgressSlackMessage,
  selectIssueStakeholderProgressEvent,
  type IssueStakeholderProgressIssueSnapshot,
} from "../services/issue-stakeholder-progress.js";

function makeIssue(
  overrides: Partial<IssueStakeholderProgressIssueSnapshot> = {},
): IssueStakeholderProgressIssueSnapshot {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    identifier: "THEA-3",
    title: "Implement Slack stakeholder progress notifications",
    status: "in_progress",
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    createdByUserId: "local-board",
    ...overrides,
  };
}

describe("issue stakeholder progress notifications", () => {
  it("selects done when an issue transitions to done", () => {
    expect(
      selectIssueStakeholderProgressEvent(
        makeIssue({ status: "in_progress" }),
        makeIssue({ status: "done" }),
      ),
    ).toBe("done");
  });

  it("selects blocked when an issue transitions to blocked", () => {
    expect(
      selectIssueStakeholderProgressEvent(
        makeIssue({ status: "todo" }),
        makeIssue({ status: "blocked" }),
      ),
    ).toBe("blocked");
  });

  it("selects returned_to_requester when the issue is handed back to the creator", () => {
    expect(
      selectIssueStakeholderProgressEvent(
        makeIssue({ assigneeAgentId: "agent-1", assigneeUserId: null, createdByUserId: "local-board" }),
        makeIssue({ status: "in_review", assigneeAgentId: null, assigneeUserId: "local-board", createdByUserId: "local-board" }),
      ),
    ).toBe("returned_to_requester");
  });

  it("ignores non-signal updates", () => {
    expect(
      selectIssueStakeholderProgressEvent(
        makeIssue({ title: "Old title" }),
        makeIssue({ title: "New title" }),
      ),
    ).toBeNull();
  });

  it("builds a Slack payload with a cleaned summary and deep link", () => {
    const payload = buildIssueStakeholderProgressSlackMessage({
      event: "blocked",
      issue: makeIssue({ status: "blocked" }),
      comment: "## Blocked\n\n- Waiting on [THEA-1](/THEA/issues/THEA-1)\n- Need webhook access",
      assigneeLabel: "Engineering Manager",
      baseUrl: "http://paperclip.test",
    });

    expect(payload.text).toContain("THEA-3");
    expect(payload.text).toContain("http://paperclip.test/THEA/issues/THEA-3");
    expect(payload.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "section",
          text: expect.objectContaining({
            text: expect.stringContaining("<http://paperclip.test/THEA/issues/THEA-3|THEA-3>"),
          }),
        }),
        expect.objectContaining({
          type: "section",
          text: expect.objectContaining({
            text: expect.stringContaining("Waiting on THEA-1 Need webhook access"),
          }),
        }),
      ]),
    );
  });

  it("omits the Slack issue link when no absolute base url is available", () => {
    const previousPublicUrl = process.env.PAPERCLIP_PUBLIC_URL;
    const previousApiUrl = process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_PUBLIC_URL;
    delete process.env.PAPERCLIP_API_URL;

    try {
      const payload = buildIssueStakeholderProgressSlackMessage({
        event: "done",
        issue: makeIssue({ status: "done" }),
        assigneeLabel: "Engineering Manager",
      });

      expect(payload.text).not.toContain("/THEA/issues/THEA-3");
      expect(payload.blocks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "section",
            text: expect.objectContaining({
              text: expect.not.stringContaining("</THEA/issues/THEA-3|THEA-3>"),
            }),
          }),
        ]),
      );
    } finally {
      if (previousPublicUrl === undefined) {
        delete process.env.PAPERCLIP_PUBLIC_URL;
      } else {
        process.env.PAPERCLIP_PUBLIC_URL = previousPublicUrl;
      }
      if (previousApiUrl === undefined) {
        delete process.env.PAPERCLIP_API_URL;
      } else {
        process.env.PAPERCLIP_API_URL = previousApiUrl;
      }
    }
  });
});
