import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@paperclipai/plugin-sdk/ui", () => {
  return {
    useHostNavigation: () => ({
      resolveHref: (to: string) => to,
      navigate: () => {},
      linkProps: (to: string) => ({ href: to, onClick: () => {} }),
    }),
    usePluginAction: () => vi.fn(async () => ({ ok: true })),
    IssueRow: ({ issue, trailingMeta, className }: { issue: { identifier?: string | null; title: string }; trailingMeta?: ReactNode; className?: string }) => (
      <a data-plugin-issue-row={issue.identifier ?? ""} className={className} href={`/issues/${issue.identifier ?? ""}`}>{issue.identifier} {issue.title} {trailingMeta}</a>
    ),
    usePluginData: () => ({ data: null, loading: false, error: null, refresh: () => {} }),
    usePluginToast: () => vi.fn(),
    useHostLocation: () => ({ pathname: "/PAP/briefs", search: "", hash: "" }),
    usePluginStream: () => ({ events: [], lastEvent: null, connecting: false, connected: false, error: null, close: () => {} }),
  };
});

import { renderToStaticMarkup } from "react-dom/server";
import { BriefCardView } from "../../src/ui/app.js";
import { makeCard, makeSnapshot, makeTaskRow } from "./fixtures.js";

function renderCard(card: ReturnType<typeof makeCard>): string {
  return renderToStaticMarkup(<BriefCardView card={card} onChanged={() => {}} />);
}

describe("BriefCardView", () => {
  it("renders title, summary text, and host issue rows for source rows", () => {
    const card = makeCard({
      title: "Briefs plugin planning",
      state: "live",
      snapshot: makeSnapshot({
        summaryParagraph: "Phase 5 page UI in flight; deterministic data is done.",
        taskRows: [
          makeTaskRow({ identifier: "PAP-9963", titleLine: "Wire briefing page UI", rightTag: "in_progress" }),
          makeTaskRow({ identifier: "PAP-9961", titleLine: "Deterministic card service", rightTag: "done" }),
        ],
      }),
    });
    const html = renderCard(card);

    expect(html).toContain("Briefs plugin planning");
    expect(html).toContain("Wire briefing page UI");
    expect(html).toContain("Deterministic card service");
    expect(html).toContain("PAP-9963");
    expect(html).toContain("PAP-9961");
    expect(html).toContain('data-plugin-issue-row="PAP-9963"');
    expect(html).toContain("data-briefs-summary");
    expect(html).not.toContain("data-briefs-state-badge");
    expect(html).not.toContain("data-briefs-row-tag");
  });

  it("does not invent a descriptive summary when model summary fallback was used", () => {
    const card = makeCard({
      title: "Cost dashboard improvements",
      state: "live",
      summaryStatus: "fallback",
      snapshot: makeSnapshot({
        summaryParagraph: null,
        summaryStatus: "fallback",
        summaryFailureReason: "budget_capped",
        taskRows: [makeTaskRow({ identifier: "PAP-8500", titleLine: "Wire cost chart filters", rightTag: "in_progress" })],
      }),
    });
    const html = renderCard(card);

    expect(html).toContain("data-briefs-summary");
    expect(html).toContain("Briefing Analyst has not generated this summary yet.");
    expect(html).not.toContain("This brief tracks");
    expect(html).not.toContain("Next:");
    expect(html).not.toContain("data-briefs-summary-fallback");
    expect(html).not.toContain("Summary unavailable");
    expect(html).not.toContain("Summary skipped to stay under budget");
  });

  it("dedupes repeated issue rows before rendering", () => {
    const sharedIssueId = "issue-duplicate";
    const card = makeCard({
      snapshot: makeSnapshot({
        taskRows: [
          makeTaskRow({ issueId: sharedIssueId, identifier: "PAP-8500", titleLine: "Older work note", eventAt: "2026-05-22T08:00:00.000Z" }),
          makeTaskRow({ issueId: sharedIssueId, identifier: "PAP-8500", titleLine: "Latest work note", eventAt: "2026-05-22T10:00:00.000Z" }),
        ],
      }),
    });
    const html = renderCard(card);

    expect(html.match(/data-plugin-issue-row="PAP-8500"/g)).toHaveLength(1);
    expect(html).toContain("Latest work note");
    expect(html).not.toContain("Older work note");
  });

  it("does not render tree-specific blocker annotations", () => {
    const card = makeCard({
      title: "Sandbox runner",
      state: "blocked",
      snapshot: makeSnapshot({
        summaryParagraph: "External blocker present.",
        taskRows: [
          makeTaskRow({ identifier: "PAP-1", titleLine: "Out-of-tree blocker", rightTag: "blocked", isIntraTreeBlocked: false }),
          makeTaskRow({ identifier: "PAP-2", titleLine: "Intra-tree blocker", rightTag: "blocked", isIntraTreeBlocked: true }),
        ],
      }),
    });
    const html = renderCard(card);
    const matches = html.match(/aria-label="intra-tree blocker"/g) ?? [];
    expect(matches.length).toBe(0);
    expect(html).not.toContain("more in tree");
    expect(html).not.toContain("Open tree");
  });

  it("renders pin button reflecting card pinned state", () => {
    const pinned = makeCard({ pinned: true });
    expect(renderCard(pinned)).toMatch(/aria-label="Unpin card"/);
    const unpinned = makeCard({ pinned: false });
    expect(renderCard(unpinned)).toMatch(/aria-label="Pin card"/);
  });

  it("renders a dismiss action and removes issue-row bottom dividers", () => {
    const card = makeCard();
    const html = renderCard(card);

    expect(html).toContain('aria-label="Dismiss briefing card"');
    expect(html).toContain("Dismiss");
    expect(html).toContain("!border-b-0");
  });
});
