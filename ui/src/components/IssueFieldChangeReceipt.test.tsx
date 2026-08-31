// @vitest-environment node

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ActivityEvent } from "@paperclipai/shared";
import { IssueFieldChangeReceipt } from "./IssueFieldChangeReceipt";

function event(overrides: Partial<ActivityEvent> = {}) {
  return {
    action: "issue.updated",
    details: null,
    responsibleUserId: null,
    ...overrides,
  } as Pick<ActivityEvent, "action" | "details" | "responsibleUserId">;
}

describe("IssueFieldChangeReceipt", () => {
  it("shows before and after for each changed field", () => {
    const html = renderToStaticMarkup(
      <IssueFieldChangeReceipt
        event={event({
          details: {
            changes: {
              status: { from: "todo", to: "in_progress" },
              priority: { from: "medium", to: "high" },
            },
          },
        })}
      />,
    );

    expect(html).toContain("Status");
    expect(html).toContain("todo");
    expect(html).toContain("in progress");
    expect(html).toContain("Priority");
    expect(html).toContain("high");
    expect(html).toContain('data-testid="issue-change-row-status"');
  });

  it("names the responsible user and the authorization reason", () => {
    const html = renderToStaticMarkup(
      <IssueFieldChangeReceipt
        event={event({
          responsibleUserId: "user-1",
          details: {
            changes: { status: { from: "todo", to: "done" } },
            authorizationReason: "allow_visible_issue_write",
          },
        })}
        resolveUserLabel={() => "Dotta"}
      />,
    );

    expect(html).toContain("Dotta");
    expect(html).toContain("authorized by default-open write on a visible task");
  });

  it("resolves an assignee change to agent names", () => {
    const html = renderToStaticMarkup(
      <IssueFieldChangeReceipt
        event={event({
          details: {
            changes: {
              assigneeAgentId: {
                from: "3108ef8e-5ed0-41d9-b561-6b41c41b8545",
                to: "6670e11b-91d3-4429-82e0-436b88b51808",
              },
            },
          },
        })}
        resolveAgentLabel={(id) =>
          id.startsWith("3108") ? "ClaudeCoder" : "UXDesigner"}
      />,
    );

    expect(html).toContain("Assignee");
    expect(html).toContain("ClaudeCoder");
    expect(html).toContain("UXDesigner");
  });

  it("marks server-truncated long text as a preview", () => {
    const html = renderToStaticMarkup(
      <IssueFieldChangeReceipt
        event={event({
          details: {
            changes: { description: { from: "old", to: "new", updated: true } },
          },
        })}
      />,
    );

    expect(html).toContain("Description");
    expect(html).toContain("preview");
  });

  it("renders a board edit's receipt the same way as an agent's", () => {
    // Plan §3b: audit is required for human PATCHes too, not only agent ones.
    const html = renderToStaticMarkup(
      <IssueFieldChangeReceipt
        event={event({
          details: {
            changes: { title: { from: "Old title", to: "New title" } },
            authorizationReason: "allow_board_actor",
          },
        })}
      />,
    );

    expect(html).toContain("Title");
    expect(html).toContain("authorized by board actor");
  });

  it("renders nothing for events with no receipt", () => {
    expect(renderToStaticMarkup(<IssueFieldChangeReceipt event={event()} />)).toBe("");
    // Pre-receipt rows carried loose fields but no `changes` receipt.
    expect(renderToStaticMarkup(
      <IssueFieldChangeReceipt event={event({ details: { status: "done" } })} />,
    )).toBe("");
  });

  it("still explains authorization when only a reason was recorded", () => {
    const html = renderToStaticMarkup(
      <IssueFieldChangeReceipt
        event={event({ details: { authorizationReason: "allow_self" } })}
      />,
    );
    expect(html).toContain("authorized by own task");
  });
});
