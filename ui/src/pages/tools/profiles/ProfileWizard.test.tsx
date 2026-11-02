// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ToolCatalogEntry, ToolProfileWithDetails } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigate = vi.hoisted(() => vi.fn());
const api = vi.hoisted(() => ({
  createProfile: vi.fn(),
  updateProfile: vi.fn(),
  bindProfile: vi.fn(),
  unbindProfile: vi.fn(),
}));
const profilesData = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("@/lib/router", () => ({
  useNavigate: () => navigate,
  Link: ({ to, children }: { to: string; children: unknown }) => createElement("a", { href: to }, children as never),
}));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ pushToast: vi.fn() }) }));
vi.mock("@/api/tools", () => ({ toolsApi: api }));
vi.mock("./useProfilesData", () => ({ useProfilesData: () => profilesData.current }));

import { ProfileWizard } from "./ProfileWizard";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function tool(id: string, toolName: string): ToolCatalogEntry {
  return {
    id,
    toolName,
    title: toolName,
    description: null,
    applicationId: "app1",
    connectionId: "conn1",
    isReadOnly: true,
    isWrite: false,
    isDestructive: false,
    riskLevel: "read",
  } as ToolCatalogEntry;
}

const APP_GROUP = {
  appKey: "app1",
  applicationId: "app1",
  connectionId: "conn1",
  name: "Gmail",
  tools: [tool("t1", "gmail.read"), tool("t2", "gmail.send")],
};

function setData(profiles: ToolProfileWithDetails[] = []) {
  profilesData.current = {
    appGroups: [APP_GROUP],
    catalog: APP_GROUP.tools,
    catalogLoading: false,
    profiles: { isLoading: false, data: { profiles } },
    agents: { data: [{ id: "a1", name: "Sage" }] },
  };
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ProfileWizard", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    api.createProfile.mockResolvedValue({ id: "new-1", metadata: null, bindings: [] });
    api.updateProfile.mockResolvedValue({ id: "new-1", metadata: null, bindings: [] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render(props: { profileId?: string; initialTemplate?: "everyday" }) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ProfileWizard companyId="c1" {...props} />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });
  }

  it("creates a draft and advances to Choose tools on Continue", async () => {
    setData([]);
    await render({ initialTemplate: "everyday" });

    const nameInput = container.querySelector("#profile-name") as HTMLInputElement;
    await act(async () => {
      setNativeValue(nameInput, "Everyday work");
      await Promise.resolve();
    });

    const continueBtn = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Continue");
    await act(async () => {
      continueBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.createProfile).toHaveBeenCalledTimes(1);
    const [, input] = api.createProfile.mock.calls[0];
    expect(input.status).toBe("draft");
    expect(input.name).toBe("Everyday work");
    // Step 2 is now visible.
    expect(container.textContent).toContain("New tools that appear later");
  });

  it("resumes a draft at the first unfinished step", async () => {
    const draft: ToolProfileWithDetails = {
      id: "d1",
      companyId: "c1",
      profileKey: "everyday",
      name: "Everyday work",
      description: null,
      status: "draft",
      defaultAction: "deny",
      newToolsReviewedAt: null,
      metadata: { wizard: { lastCompletedStep: 1, template: "everyday" } },
      createdAt: new Date(),
      updatedAt: new Date(),
      entries: [],
      bindings: [],
      summary: {
        accessMode: "selected",
        allowedToolCount: 0,
        allowedApplicationCount: 0,
        excludedToolCount: 0,
        totalToolCount: 0,
        assignmentCount: 0,
        appliesToAgentCount: 0,
        isCompanyDefault: false,
      },
    };
    setData([draft]);
    await render({ profileId: "d1" });

    // lastCompletedStep 1 -> resume on step 2 (Choose tools), not step 1.
    expect(container.textContent).toContain("New tools that appear later");
    expect(container.querySelector("#profile-name")).toBeNull();
  });
});
