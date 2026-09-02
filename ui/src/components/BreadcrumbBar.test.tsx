// @vitest-environment jsdom

import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BreadcrumbProvider, useBreadcrumbs } from "../context/BreadcrumbContext";
import { BreadcrumbBar } from "./BreadcrumbBar";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false, toggleSidebar: vi.fn() }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { issuePrefix: "PAP" } }),
}));

vi.mock("@/plugins/slots", () => ({
  usePluginSlots: () => ({ slots: [] }),
  PluginSlotOutlet: () => null,
}));

vi.mock("@/plugins/launchers", () => ({
  usePluginLaunchers: () => ({ launchers: [] }),
  PluginLauncherOutlet: () => null,
}));

function TaskBreadcrumbs({ onOpen }: { onOpen: () => void }) {
  const { setBreadcrumbs, setBreadcrumbToolbar } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([
      { label: "Tasks", href: "/tasks" },
      { label: "Keep the panel launcher available", identifier: "PAP-16679" },
    ]);
    setBreadcrumbToolbar(
      <button type="button" aria-label="Show task side panel" onClick={onOpen}>
        Show panel
      </button>,
    );
    return () => setBreadcrumbToolbar(null);
  }, [onOpen, setBreadcrumbToolbar, setBreadcrumbs]);

  return <BreadcrumbBar />;
}

describe("BreadcrumbBar", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders a page toolbar in the same persistent row as the task breadcrumb", async () => {
    const onOpen = vi.fn();
    await act(async () => {
      root.render(
        <BreadcrumbProvider>
          <TaskBreadcrumbs onOpen={onOpen} />
        </BreadcrumbProvider>,
      );
    });

    const launcher = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show task side panel"]',
    );
    expect(launcher).not.toBeNull();
    expect(launcher?.closest(".h-12")?.textContent).toContain("PAP-16679");

    act(() => launcher?.click());
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
