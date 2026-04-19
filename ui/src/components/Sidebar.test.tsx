// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";

const dialogState = vi.hoisted(() => ({
  openNewIssue: vi.fn(),
}));

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1",
  selectedCompany: {
    id: "company-1",
    name: "Comandero",
    issuePrefix: "COM",
    brandColor: "#22c55e",
  },
}));

const inboxBadgeState = vi.hoisted(() => ({
  inbox: 0,
  failedRuns: 0,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: [] }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => dialogState,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../hooks/useInboxBadge", () => ({
  useInboxBadge: () => inboxBadgeState,
}));

vi.mock("./SidebarSection", () => ({
  SidebarSection: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("./SidebarNavItem", () => ({
  SidebarNavItem: ({ label }: { label: string }) => <div>{label}</div>,
}));

vi.mock("./SidebarProjects", () => ({
  SidebarProjects: () => null,
}));

vi.mock("./SidebarAgents", () => ({
  SidebarAgents: () => null,
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotOutlet: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("Sidebar", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    dialogState.openNewIssue.mockReset();
  });

  afterEach(() => {
    container.remove();
  });

  it("renders the Orchestrero brand lockup above the selected company context", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<Sidebar />);
    });

    expect(container.textContent).toContain("Orchestrero");
    expect(container.textContent).toContain("Comandero");

    const mark = container.querySelector('img[alt="Orchestrero mark"]');
    expect(mark?.getAttribute("src")).toBe("/orchestrero-mark.png");

    act(() => {
      root.unmount();
    });
  });
});
