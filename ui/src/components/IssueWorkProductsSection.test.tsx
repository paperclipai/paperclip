import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { IssueWorkProduct } from "@paperclipai/shared";
import {
  IssueWorkProductsSection,
  getHermesExecutionDetails,
  sortIssueWorkProductsForDisplay,
} from "./IssueWorkProductsSection";

function workProduct(overrides: Partial<IssueWorkProduct>): IssueWorkProduct {
  return {
    id: overrides.id ?? "wp-1",
    companyId: "company-1",
    projectId: null,
    issueId: "issue-1",
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: "artifact",
    provider: "custom",
    externalId: null,
    title: "Work product",
    url: null,
    status: "active",
    reviewState: "none",
    isPrimary: false,
    healthStatus: "unknown",
    summary: null,
    metadata: null,
    createdByRunId: null,
    createdAt: new Date("2026-04-30T00:00:00Z"),
    updatedAt: new Date("2026-04-30T00:00:00Z"),
    ...overrides,
  };
}

describe("IssueWorkProductsSection", () => {
  it("prioritizes Hermes Kanban execution products and extracts task metadata", () => {
    const generic = workProduct({
      id: "generic",
      provider: "github",
      title: "Pull request",
      updatedAt: new Date("2026-05-01T01:00:00Z"),
    });
    const hermes = workProduct({
      id: "hermes",
      provider: "hermes-kanban",
      type: "preview_url",
      title: "Hermes Kanban board",
      url: "https://hermes-workspace.tail54e18.ts.net/kanban/tasks/root-1",
      summary: "Launch complete",
      metadata: {
        rootTaskId: "root-1",
        childTaskIds: ["child-1", "child-2"],
        statusSummary: "2 tasks running",
      },
      updatedAt: new Date("2026-04-30T01:00:00Z"),
    });

    expect(sortIssueWorkProductsForDisplay([generic, hermes]).map((product) => product.id)).toEqual([
      "hermes",
      "generic",
    ]);
    expect(getHermesExecutionDetails(hermes)).toEqual({
      rootTaskId: "root-1",
      childTaskCount: 2,
      statusSummary: "2 tasks running",
    });
  });

  it("renders Hermes execution links, rollup details, generic products, and an empty state", () => {
    const html = renderToStaticMarkup(
      <IssueWorkProductsSection
        products={[
          workProduct({
            id: "hermes-board",
            provider: "hermes-kanban",
            type: "preview_url",
            title: "Hermes Kanban board",
            url: "https://hermes-workspace.tail54e18.ts.net/kanban/tasks/root-1",
            metadata: {
              rootTaskId: "root-1",
              childTaskIds: ["child-1", "child-2"],
              statusSummary: "Blocked waiting on API token scope",
            },
          }),
          workProduct({
            id: "doc",
            provider: "paperclip",
            type: "document",
            title: "MVP notes",
            summary: "Operator handoff",
          }),
        ]}
      />,
    );

    expect(html).toContain('data-hermes-execution-panel="true"');
    expect(html).toContain('data-hermes-execution-readout="1 Hermes"');
    expect(html).toContain("Hermes execution");
    expect(html).toContain("Hermes Kanban board");
    expect(html).toContain("https://hermes-workspace.tail54e18.ts.net/kanban/tasks/root-1");
    expect(html).toContain("Root task");
    expect(html).toContain("root-1");
    expect(html).toContain("Child tasks");
    expect(html).toContain("2");
    expect(html).toContain("Blocked waiting on API token scope");
    expect(html).toContain("MVP notes");
    expect(html).toContain("bg-[color-mix(in_srgb,var(--accent)_20%,var(--card))]");
    expect(html).toContain("bg-[color-mix(in_srgb,var(--accent)_18%,var(--card))]");
    expect(html).toContain("bg-[color-mix(in_srgb,var(--foreground)_5%,var(--card))]");
    expect(html).toContain("font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-[var(--text-display)]");
    expect(html).toContain("border-l-[3px] border-[var(--event-accent)]");
    expect(html).toContain("font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--text-display)]");
    expect(html).not.toContain("status-live-bg");
    expect(html).not.toContain("status-live-fg");
    expect(html).not.toContain("linear-gradient");
    expect(html).not.toContain("rounded-full");

    const emptyHtml = renderToStaticMarkup(<IssueWorkProductsSection products={[]} />);
    expect(emptyHtml).toContain('data-hermes-execution-panel="true"');
    expect(emptyHtml).toContain("No Hermes execution links yet");
  });
});
