// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactGroupCard } from "./ArtifactGroupCard";
import type { CompanyArtifact, CompanyArtifactGroup } from "@/api/artifacts";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: null, selectedCompanyId: "company-1" }),
}));

function sampleArtifact(overrides: Partial<CompanyArtifact> = {}): CompanyArtifact {
  return {
    id: "artifact-1",
    source: "attachment",
    mediaKind: "image",
    title: "Hero shot",
    previewText: null,
    contentType: "image/png",
    contentPath: "/files/hero.png",
    openPath: "/files/hero.png",
    downloadPath: "/files/hero.png?download=1",
    issue: { id: "issue-1", identifier: "PAP-42", title: "Ship launch" },
    project: null,
    createdByAgent: null,
    updatedAt: "2026-06-01T00:00:00.000Z",
    href: "/PAP/issues/PAP-42#attachment-1",
    ...overrides,
  } as CompanyArtifact;
}

function sampleGroup(overrides: Partial<CompanyArtifactGroup> = {}): CompanyArtifactGroup {
  return {
    id: "task:issue-1",
    groupBy: "task",
    issue: { id: "issue-1", identifier: "PAP-42", title: "Ship launch" },
    title: "Ship launch",
    count: 3,
    mediaKinds: ["image"],
    previewArtifacts: [sampleArtifact()],
    updatedAt: "2026-06-01T00:00:00.000Z",
    href: "/PAP/artifacts?groupBy=task&groupIssueId=issue-1",
    ...overrides,
  };
}

function render(group: CompanyArtifactGroup, to = "?groupBy=task&groupIssueId=issue-1") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(
      <MemoryRouter>
        <ArtifactGroupCard group={group} to={to} />
      </MemoryRouter>,
    );
  });
  return { container, root };
}

describe("ArtifactGroupCard", () => {
  let mounted: { container: HTMLElement; root: ReturnType<typeof createRoot> } | null = null;

  beforeEach(() => {
    mounted = null;
  });

  afterEach(() => {
    if (mounted) {
      flushSync(() => mounted!.root.unmount());
      mounted.container.remove();
      mounted = null;
    }
  });

  it("shows a stack effect and plural count when count > 1", () => {
    mounted = render(sampleGroup({ count: 3 }));
    const card = mounted.container.querySelector('[data-testid="artifact-group-card"]') as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.getAttribute("data-stacked")).toBe("true");
    expect(card.getAttribute("data-count")).toBe("3");
    // Two decorative stack layers sit behind the card.
    expect(mounted.container.querySelectorAll('[data-testid="artifact-stack-layer"]').length).toBe(2);
    expect(mounted.container.textContent).toContain("3 artifacts");
  });

  it("omits the stack effect and uses singular count when count === 1", () => {
    mounted = render(sampleGroup({ count: 1 }));
    const card = mounted.container.querySelector('[data-testid="artifact-group-card"]') as HTMLElement;
    expect(card.getAttribute("data-stacked")).toBe("false");
    expect(card.getAttribute("data-count")).toBe("1");
    expect(mounted.container.querySelectorAll('[data-testid="artifact-stack-layer"]').length).toBe(0);
    expect(mounted.container.textContent).toContain("1 artifact");
    expect(mounted.container.textContent).not.toContain("1 artifacts");
  });

  it("links to the provided stack destination and shows the task subject", () => {
    mounted = render(sampleGroup());
    const anchor = mounted.container.querySelector("a") as HTMLAnchorElement;
    expect(anchor).not.toBeNull();
    expect(anchor.getAttribute("href")).toContain("groupIssueId=issue-1");
    expect(mounted.container.textContent).toContain("PAP-42");
    expect(mounted.container.textContent).toContain("Ship launch");
  });

  it("renders the first preview artifact image", () => {
    mounted = render(sampleGroup());
    const img = mounted.container.querySelector("img") as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.getAttribute("src")).toBe("/files/hero.png");
  });

  it("falls back to a placeholder when there are no preview artifacts", () => {
    mounted = render(sampleGroup({ previewArtifacts: [] }));
    expect(mounted.container.querySelector("img")).toBeNull();
    const card = mounted.container.querySelector('[data-testid="artifact-group-card"]') as HTMLElement;
    expect(card).not.toBeNull();
  });
});
