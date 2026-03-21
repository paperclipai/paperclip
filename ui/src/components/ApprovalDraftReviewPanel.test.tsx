// @vitest-environment node

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "../context/ThemeContext";
import { ApprovalDraftReviewPanel, getApprovalDraftText } from "./ApprovalDraftReviewPanel";

function renderPanel(status: string, draftText: string | null) {
  return renderToStaticMarkup(
    <ThemeProvider>
      <ApprovalDraftReviewPanel
        draftText={draftText}
        status={status}
        onApprove={() => {}}
        onNeedsEdits={() => {}}
        onReject={() => {}}
      />
    </ThemeProvider>,
  );
}

describe("getApprovalDraftText", () => {
  it("prefers explicit draft text fields", () => {
    expect(
      getApprovalDraftText({
        draft: "Draft A",
        plan: "Plan B",
      }),
    ).toBe("Draft A");
  });

  it("falls back to nested draftContent.body", () => {
    expect(
      getApprovalDraftText({
        draftContent: {
          body: "Nested draft",
        },
      }),
    ).toBe("Nested draft");
  });
});

describe("ApprovalDraftReviewPanel", () => {
  it("shows full draft content and review actions when pending", () => {
    const html = renderPanel("pending", "# Strategy Draft\n\nLong body.");
    expect(html).toContain("Full draft preview");
    expect(html).toContain("Strategy Draft");
    expect(html).toContain("Approve");
    expect(html).toContain("Needs edits");
    expect(html).toContain("Reject");
  });

  it("hides actions for resolved approvals", () => {
    const html = renderPanel("approved", "Already resolved");
    expect(html).not.toContain(">Approve<");
    expect(html).toContain("already resolved");
  });

  it("shows a fallback message when no draft text exists", () => {
    const html = renderPanel("pending", null);
    expect(html).toContain("No draft content was provided");
  });
});
