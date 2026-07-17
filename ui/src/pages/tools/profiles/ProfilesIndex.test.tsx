// @vitest-environment jsdom

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ToolProfileSummary, ToolProfileWithDetails } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigate = vi.hoisted(() => vi.fn());
const profilesData = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));
const api = vi.hoisted(() => ({
  updateProfile: vi.fn(),
  duplicateProfile: vi.fn(),
  deleteProfile: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => navigate,
  Link: ({ to, children }: { to: string; children: unknown }) => createElement("a", { href: to }, children as never),
}));

vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ pushToast: vi.fn() }) }));

vi.mock("../ProfilesTab", () => ({ EffectiveAgentPanel: () => createElement("div", null, "resolver") }));

vi.mock("@/api/tools", () => ({ toolsApi: api }));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open?: boolean; children: unknown }) => (open ? createElement("div", null, children as never) : null),
  SheetContent: ({ children }: { children: unknown }) => createElement("div", null, children as never),
  SheetHeader: ({ children }: { children: unknown }) => createElement("div", null, children as never),
  SheetTitle: ({ children }: { children: unknown }) => createElement("h2", null, children as never),
  SheetDescription: ({ children }: { children: unknown }) => createElement("p", null, children as never),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: unknown }) => createElement("div", null, children as never),
  DropdownMenuTrigger: ({ children }: { children: unknown }) => createElement("div", null, children as never),
  DropdownMenuContent: ({ children }: { children: unknown }) => createElement("div", null, children as never),
  DropdownMenuItem: ({
    children,
    className,
    onSelect,
  }: {
    children: unknown;
    className?: string;
    onSelect?: () => void;
  }) => createElement("button", { type: "button", className, onClick: onSelect }, children as never),
  DropdownMenuSeparator: () => createElement("hr"),
}));

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
    api.updateProfile.mockResolvedValue(profile({ name: "Updated" }));
    api.duplicateProfile.mockResolvedValue(profile({ name: "Copy" }));
    api.deleteProfile.mockResolvedValue({ deleted: true });
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render(props: Partial<Parameters<typeof ProfilesIndex>[0]> = {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root.render(
        <QueryClientProvider client={client}>
          <ProfilesIndex companyId="c1" {...props} />
        </QueryClientProvider>,
      );
    });
    await Promise.resolve();
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

  it("shows a new-tools chip in the Allows column", async () => {
    setData([
      profile({
        name: "Gmail",
        newToolsPendingCount: 3,
        summary: summary({ allowedToolCount: 4, allowedApplicationCount: 1, appliesToAgentCount: 1 }),
      }),
    ]);
    await render();

    expect(container.textContent).toContain("4 tools · 1 app");
    expect(container.textContent).toContain("3 new");
  });

  it("constrains long profile names to the Profile column", async () => {
    const longName = "A very long profile name that should truncate before it can overlap the Allows column";
    setData([
      profile({
        name: longName,
        summary: summary({ allowedToolCount: 4, allowedApplicationCount: 1 }),
      }),
    ]);
    await render();

    const table = container.querySelector("table");
    const profileButton = container.querySelector<HTMLButtonElement>(`button[title="${longName}"]`);

    expect(table?.className).toContain("table-fixed");
    expect(profileButton?.className).toContain("w-full");
    expect(profileButton?.className).toContain("truncate");
  });

  it("flags an unassigned profile as having no effect", async () => {
    setData([profile({ name: "Orphan" })]);
    await render();
    expect(container.textContent).toContain("Not assigned yet");
    expect(container.textContent).toContain("does not change access");
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
    flushSync(() => {
      archived?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await Promise.resolve();
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
    flushSync(() => {
      newBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await Promise.resolve();
    expect(navigate).toHaveBeenCalledWith("/apps/advanced/profiles/new");
  });

  it("uses the styled delete dialog from the row menu without native confirm", async () => {
    const confirm = vi.spyOn(window, "confirm");
    setData([profile({ id: "p-delete", name: "Everyday work", summary: summary({ assignmentCount: 2 }) })]);
    await render();

    const deleteItem = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Delete");
    flushSync(() => {
      deleteItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await Promise.resolve();

    expect(confirm).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Delete profile");
    expect(document.body.textContent).toContain("removes 2 assignments");
    expect(api.deleteProfile).not.toHaveBeenCalled();

    const dialogDelete = [...document.body.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent?.trim() === "Delete");
    flushSync(() => {
      dialogDelete?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await Promise.resolve();

    expect(api.deleteProfile).toHaveBeenCalledWith("p-delete");
  });

  it("blocks company-default delete from the row-menu dialog before the API call", async () => {
    const confirm = vi.spyOn(window, "confirm");
    setData([
      profile({
        id: "p-default",
        name: "Company baseline",
        summary: summary({ assignmentCount: 0, isCompanyDefault: true }),
      }),
    ]);
    await render();

    const deleteItem = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Delete");
    flushSync(() => {
      deleteItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await Promise.resolve();

    expect(confirm).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Reassign the company default to another profile before deleting it.");
    const dialogDelete = [...document.body.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent?.trim() === "Delete") as HTMLButtonElement | undefined;
    expect(dialogDelete?.disabled).toBe(true);
    expect(api.deleteProfile).not.toHaveBeenCalled();
  });

  it("uses the styled restore dialog from archived row menus", async () => {
    const confirm = vi.spyOn(window, "confirm");
    setData([profile({ id: "p-archived", name: "Old one", status: "archived" })]);
    await render({ initialStatusFilter: "archived" });

    const restoreItem = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Restore");
    flushSync(() => {
      restoreItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await Promise.resolve();

    expect(confirm).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Restore profile");

    const dialogRestore = [...document.body.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent?.trim() === "Restore");
    flushSync(() => {
      dialogRestore?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await Promise.resolve();

    expect(api.updateProfile).toHaveBeenCalledWith("p-archived", { status: "active" });
  });
});
