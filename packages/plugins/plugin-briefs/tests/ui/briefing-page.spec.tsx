import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { BriefCard } from "../../src/contracts.js";
import { gallery } from "./fixtures.js";

type PageData = {
  cards: BriefCard[];
  fetchedAt: string;
};

let mockPageData: PageData = {
  cards: [],
  fetchedAt: "2026-05-22T10:00:00.000Z",
};

vi.mock("@paperclipai/plugin-sdk/ui", () => {
  return {
    ManagedRoutinesList: ({ routines }: { routines: Array<{ title: string }> }) => (
      <div data-managed-routines-list>{routines.map((routine) => routine.title).join("|")}</div>
    ),
    IssueRow: ({ issue, trailingMeta }: { issue: { identifier?: string | null; title: string }; trailingMeta?: ReactNode }) => (
      <a data-plugin-issue-row={issue.identifier ?? ""} href={`/issues/${issue.identifier ?? ""}`}>{issue.identifier} {issue.title} {trailingMeta}</a>
    ),
    useHostNavigation: () => ({
      resolveHref: (to: string) => to,
      navigate: () => {},
      linkProps: (to: string) => ({ href: to, onClick: () => {} }),
    }),
    useHostContext: () => ({
      companyId: "company-1",
      companyPrefix: "PAP",
      projectId: null,
      entityId: null,
      entityType: null,
      userId: "user-1",
    }),
    usePluginAction: () => vi.fn(async () => ({ ok: true })),
    usePluginData: (key: string) => {
      if (key === "page") {
        return { data: mockPageData, loading: false, error: null, refresh: () => {} };
      }
      if (key === "settings") {
        return {
          data: {
            managedAgent: {
              status: "resolved",
              agentId: "agent-1",
              agent: { id: "agent-1", name: "Briefing Analyst", status: "paused", adapterType: "codex_local", icon: "newspaper" },
            },
            managedProject: {
              status: "resolved",
              projectId: "project-1",
              project: { id: "project-1", name: "Briefs", status: "in_progress", color: "#0f766e" },
            },
            managedSkills: [
              { status: "resolved", skillId: "skill-1", resourceKey: "briefs-discover-cards", skill: { id: "skill-1", name: "Briefs Discover Cards" } },
              { status: "resolved", skillId: "skill-2", resourceKey: "briefs-update-cards", skill: { id: "skill-2", name: "Briefs Update Cards" } },
            ],
            managedRoutines: [
              {
                status: "resolved",
                routineId: "routine-1",
                resourceKey: "briefs-discover-cards",
                routine: { id: "routine-1", title: "Discover Briefing cards for {{userId}}", status: "paused", projectId: "project-1", assigneeAgentId: "agent-1" },
              },
              {
                status: "resolved",
                routineId: "routine-2",
                resourceKey: "briefs-update-cards",
                routine: { id: "routine-2", title: "Update Briefing cards for {{userId}}", status: "paused", projectId: "project-1", assigneeAgentId: "agent-1" },
              },
            ],
            preferences: {
              companyId: "company-1",
              userId: "user-1",
              cadence: "hourly",
              retentionDays: 7,
              doneRetentionHours: 72,
              staleAfterDays: 7,
              maxUnpinnedCards: 30,
              scope: "user",
            },
            agentOptions: [{ id: "agent-1", name: "Briefing Analyst", icon: "newspaper" }],
            projectOptions: [{ id: "project-1", name: "Briefs", color: "#0f766e" }],
          },
          loading: false,
          error: null,
          refresh: () => {},
        };
      }
      return { data: null, loading: false, error: null, refresh: () => {} };
    },
    usePluginToast: () => vi.fn(),
    useHostLocation: () => ({ pathname: "/PAP/briefs", search: "", hash: "" }),
    usePluginStream: () => ({ events: [], lastEvent: null, connecting: false, connected: false, error: null, close: () => {} }),
  };
});

import { renderToStaticMarkup } from "react-dom/server";
import { BriefingPage, SettingsPage, SidebarLink } from "../../src/ui/app.js";

const hostContext = {
  companyId: "company-1",
  companyPrefix: "PAP",
  projectId: null,
  entityId: null,
  entityType: null,
  userId: "user-1",
} as const;

function renderPage(cards: BriefCard[]): string {
  mockPageData = { cards, fetchedAt: "2026-05-22T10:00:00.000Z" };
  return renderToStaticMarkup(<BriefingPage context={hostContext as never} />);
}

describe("BriefingPage", () => {
  it("renders a single sorted briefing list instead of section tabs", () => {
    const html = renderPage(gallery());

    expect(html).toContain("data-briefs-list");
    expect(html).toContain("data-briefs-card-grid");
    expect(html).toContain("grid-template-columns:repeat(2, minmax(0, 1fr))");
    expect(html).toContain("Recent work and next steps");
    expect(html).not.toContain("data-briefs-mobile-tabs");
    expect(html).not.toContain("data-briefs-section");
    expect(html).not.toContain("data-briefs-legend");
    expect(html).not.toContain("Needs your attention");
    expect(html).not.toContain("Recently done &amp; stale");
  });

  it("does not write UI-generated summaries when model summary fallback was used", () => {
    const html = renderPage(gallery());

    expect(html).toContain("Cost dashboard improvements");
    expect(html).toContain("Briefing Analyst has not generated this summary yet.");
    expect(html).not.toContain("This brief tracks");
    expect(html).not.toContain("Next:");
    expect(html).not.toContain("Summary unavailable");
    expect(html).not.toContain("Summary skipped to stay under budget");
  });

  it("renders issue rows with the host IssueRow bridge and no custom state chips", () => {
    const html = renderPage(gallery());

    expect(html).toContain('data-plugin-issue-row="PAP-9963"');
    expect(html).toContain("Wire briefing page UI");
    expect(html).not.toContain("data-briefs-state-badge");
    expect(html).not.toContain("data-briefs-row-tag");
    expect(html).not.toContain("Open tree");
    expect(html).not.toContain("more in tree");
  });

  it("keeps the dashboard header lean", () => {
    const html = renderPage(gallery());

    expect(html).toContain("data-briefs-page-header");
    expect(html).toContain("data-briefs-page-meta");
    expect(html).toContain('aria-label="Briefing settings"');
    expect(html).toContain("/PAP/instance/settings/plugins/paperclipai.plugin-briefs");
    expect(html).not.toContain("Preferences");
    expect(html).not.toContain("Durable cards for areas of work");
  });

  it("renders the empty state without rendering the briefing list", () => {
    const html = renderPage([]);
    expect(html).not.toContain("data-briefs-list");
    expect(html).toContain("No briefs yet");
  });
});

describe("SidebarLink", () => {
  it("renders the Briefing sidebar entry with an icon, company route, and no badge count", () => {
    const html = renderToStaticMarkup(<SidebarLink context={hostContext as never} />);

    expect(html).toContain("Briefing");
    expect(html).toContain('href="/briefs"');
    expect(html).toContain("data-briefs-sidebar-icon");
    expect(html).toContain("color:currentColor");
    expect(html).not.toContain("briefs need your attention");
  });
});

describe("SettingsPage", () => {
  it("renders managed resource status and routine controls", () => {
    const html = renderToStaticMarkup(<SettingsPage context={hostContext as never} />);

    expect(html).toContain("Managed resources");
    expect(html).toContain("Dashboard settings");
    expect(html).toContain("Maximum unpinned cards");
    expect(html).toContain("Mark stale after days");
    expect(html).toContain("Briefing Analyst");
    expect(html).toContain("data-managed-routines-list");
    expect(html).toContain("Discover Briefing cards");
  });
});
