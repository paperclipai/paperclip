// @vitest-environment jsdom

import { act, type AnchorHTMLAttributes, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/router", () => ({
  Link: ({
    to,
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode; replace?: boolean }) => {
    const { replace: _replace, ...rest } = props as Record<string, unknown>;
    return (
      <a href={to} {...(rest as AnchorHTMLAttributes<HTMLAnchorElement>)}>
        {children}
      </a>
    );
  },
}));

import { RoutineSubSidebar } from "./RoutineSubSidebar";
import type { RoutineSectionKey } from "./routine-sections/context";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

function renderSidebar(overrides?: {
  activeSection?: RoutineSectionKey;
  dirty?: RoutineSectionKey[];
  hasLiveRun?: boolean;
  onNavigate?: (section: RoutineSectionKey) => void;
}) {
  const dirty = new Set(overrides?.dirty ?? []);
  const onNavigate = overrides?.onNavigate ?? vi.fn();
  act(() => {
    root.render(
      <RoutineSubSidebar
        activeSection={overrides?.activeSection ?? "overview"}
        hrefFor={(section) => `/routines/r1/${section}`}
        isSectionDirty={(section) => dirty.has(section)}
        hasLiveRun={overrides?.hasLiveRun ?? false}
        onNavigate={onNavigate}
      />,
    );
  });
  return { onNavigate };
}

describe("RoutineSubSidebar", () => {
  it("renders all eight sections grouped under ROUTINE and OPERATE", () => {
    renderSidebar();
    const links = Array.from(container.querySelectorAll("a"));
    const labels = links.map((link) => link.textContent?.trim());
    expect(labels).toEqual([
      "Overview",
      "Triggers",
      "Variables",
      "Secrets",
      "Delivery",
      "Runs",
      "Activity",
      "History",
    ]);
    const groupLabels = Array.from(container.querySelectorAll("p")).map((p) => p.textContent);
    expect(groupLabels).toContain("Routine");
    expect(groupLabels).toContain("Operate");
  });

  it("marks the active section with aria-current=page", () => {
    renderSidebar({ activeSection: "secrets" });
    const active = container.querySelector('a[aria-current="page"]');
    expect(active?.textContent?.trim()).toBe("Secrets");
  });

  it("links each section to its section URL", () => {
    renderSidebar();
    const variables = Array.from(container.querySelectorAll("a")).find(
      (link) => link.textContent?.trim() === "Variables",
    );
    expect(variables?.getAttribute("href")).toBe("/routines/r1/variables");
  });

  it("shows a dirty marker only on dirty editable sections", () => {
    renderSidebar({ dirty: ["overview", "delivery"] });
    const dirtyMarkers = container.querySelectorAll('[aria-label="Unsaved changes"]');
    expect(dirtyMarkers.length).toBe(2);
  });

  it("fires onNavigate when a section is clicked", () => {
    const { onNavigate } = renderSidebar();
    const triggers = Array.from(container.querySelectorAll("a")).find(
      (link) => link.textContent?.trim() === "Triggers",
    ) as HTMLAnchorElement;
    act(() => {
      triggers.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onNavigate).toHaveBeenCalledWith("triggers");
  });
});
