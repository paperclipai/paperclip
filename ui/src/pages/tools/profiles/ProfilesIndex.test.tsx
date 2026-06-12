// @vitest-environment jsdom

import { act } from "react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ToolProfileSummary, ToolProfileWithDetails } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigate = vi.hoisted(() => vi.fn());
const profilesData = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => navigate,
  Link: ({ to, children }: { to: string; children: unknown }) => createElement("a", { href: to }, children as never),
}));

vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ pushToast: vi.fn() }) }));

vi.mock("../ProfilesTab", () => ({ EffectiveAgentPanel: () => createElement("div", null, "resolver") }));

vi.mock("@/api/tools", () => ({ toolsApi: {} }));

vi.mock("./useProfilesData", () => ({ useProfilesData: () => profilesData.current }));

import { ProfilesIndex } from "./ProfilesIndex";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function summary(partial: Partial<ToolProfileSummary>): ToolProfileSummary {
  return {
    accessMode: "selected",
    allowedToolCount: 0,
    allowedApplicationCount: 0,
    excludedToolCount: 0,
    totalToolCount: 0,
    assignmentCount: 0,
    appliesToAgentCount: 0,
    isCompanyDefault: false,
    ...partial,
  };
}

function profile(partial: Partial<ToolProfileWithDetails> & { name: string }): ToolProfileWithDetails {
  return {
    id: partial.id ?? partial.name,
    companyId: "c1",
    profileKey: "k",
    description: null,
    status: "active",
    defaultAction: "deny",
    newToolsReviewedAt: null,
    metadata: null,
    createdAt: new Date("2026-06-10T00:00:00Z"),
    updatedAt: new Date("2026-06-10T00:00:00Z"),
    entries: [],
    bindings: [],
    summary: summary({}),
    ...partial,
  } as ToolProfileWithDetails;
}

function setData(profiles: ToolProfileWithDetails[]) {
  profilesData.current = {
    profiles: { isLoading: false, isError: false, data: { profiles }, refetch: vi.fn() },
    agents: { data: [] },
  };
}

describe("ProfilesIndex", () => {
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

  async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ProfilesIndex companyId="c1" />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });
  }

  it("renders a row per profile with the friendly Allows and Assigned columns", async () => {
    setData([
      profile({ name: "Everyday work", summary: summary({ allowedToolCount: 9, allowedApplicationCount: 3, appliesToAgentCount: 2 }) }),
      profile({ name: "Company baseline", summary: summary({ accessMode: "all_except", excludedToolCount: 2, isCompanyDefault: true }) }),
    ]);
    await render();

    expect(container.textContent).toContain("Everyday work");
    expect(container.textContent).toContain("9 tools · 3 apps");
    expect(container.textContent).toContain("2 agents");
    expect(container.textContent).toContain("All except 2 tools");
    expect(container.textContent).toContain("Company default");
  });

  it("flags an unassigned profile as having no effect", async () => {
    setData([profile({ name: "Orphan" })]);
    await render();
    expect(container.textContent).toContain("Not assigned yet");
    expect(container.textContent).toContain("has no effect");
  });

  it("offers a Resume affordance on draft rows", async () => {
    setData([profile({ name: "Half-built", status: "draft" })]);
    await render();
    expect(container.textContent).toContain("Draft");
    expect(container.textContent).toContain("Resume");
  });

  it("shows archived profiles only after switching to the Archived filter", async () => {
    setData([profile({ name: "Old one", status: "archived" })]);
    await render();
    expect(container.textContent).not.toContain("Old one");
    expect(container.textContent).toContain("Create your first access profile");

    const archived = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Archived"));
    await act(async () => {
      archived?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Old one");
    expect(container.textContent).toContain("Archived");
  });

  it("shows the step-1 template cards as the empty state", async () => {
    setData([]);
    await render();
    expect(container.textContent).toContain("Read-only");
    expect(container.textContent).toContain("Everyday work");
    expect(container.textContent).toContain("Start from scratch");
  });

  it("navigates to the wizard from New profile", async () => {
    setData([profile({ name: "Anything" })]);
    await render();
    const newBtn = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("New profile"));
    await act(async () => {
      newBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(navigate).toHaveBeenCalledWith("/apps/advanced/profiles/new");
  });
});
