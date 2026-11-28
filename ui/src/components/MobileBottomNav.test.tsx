// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileBottomNav } from "./MobileBottomNav";

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { issuePrefix: "PAP" } }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => ({ openNewIssue: vi.fn() }),
}));

vi.mock("@/hooks/useAgentChatEnabled", () => ({
  useAgentChatEnabled: () => ({ enabled: false }),
}));

vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({
  useCoordinatorWorkspaceEnabled: () => ({ enabled: true }),
}));

vi.mock("@/hooks/useCombinedInboxTasksEnabled", () => ({
  useCombinedInboxTasksEnabled: () => ({ enabled: false }),
}));

vi.mock("@/hooks/useCompanyHomePath", () => ({
  useCompanyHomePath: () => ({ path: "/dashboard" }),
}));

vi.mock("@/hooks/useResponsibilitiesEnabled", () => ({
  useResponsibilitiesEnabled: () => ({ enabled: false }),
}));

vi.mock("../hooks/useInboxBadge", () => ({
  useInboxBadge: () => ({ inbox: 96 }),
}));

vi.mock("@/hooks/useCoordinatorAttentionCount", () => ({
  useCoordinatorAttentionCount: () => 96,
}));

describe("MobileBottomNav", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    container.remove();
  });

  it("anchors the unread badge to the top-right edge so two-digit counts expand outward without covering the icon center", () => {
    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <MemoryRouter initialEntries={["/PAP/issues"]}>
          <MobileBottomNav visible />
        </MemoryRouter>,
      );
    });

    const badge = container.querySelector('[data-slot="mobile-nav-badge"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe("96");
    expect(badge?.className).toContain("left-3");
    expect(badge?.className).not.toContain("-right-2");
  });
});
