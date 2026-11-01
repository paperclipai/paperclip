// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoordinatorWorkspaceSetting } from "./CoordinatorWorkspaceSetting";

const mocks = vi.hoisted(() => ({
  getExperimental: vi.fn(), updateExperimental: vi.fn(), access: vi.fn(), setEnabled: vi.fn(),
  enabled: false, hidden: new Set<string>(),
}));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: mocks.getExperimental, updateExperimental: mocks.updateExperimental } }));
vi.mock("@/api/access", () => ({ accessApi: { getCurrentBoardAccess: mocks.access } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompany: { id: "company" } }) }));
vi.mock("@/hooks/useHiddenSettings", () => ({ useHiddenSettings: () => ({ hidden: mocks.hidden, loaded: true }) }));
vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({ useCoordinatorWorkspaceEnabled: () => ({
  enabled: mocks.enabled, loaded: true, userId: "person", error: null, isSaving: false, setEnabled: mocks.setEnabled,
}) }));

describe("Coordinator workspace prerequisite", () => {
  let container: HTMLDivElement, root: Root, client: QueryClient;
  beforeEach(() => {
    vi.clearAllMocks(); mocks.enabled = false; mocks.hidden.clear();
    mocks.getExperimental.mockResolvedValue({ enableAgentChat: false });
    mocks.access.mockResolvedValue({ userId: "person", source: "session", isInstanceAdmin: true });
    mocks.setEnabled.mockResolvedValue(undefined);
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(() => { flushSync(() => root.unmount()); client.clear(); container.remove(); });
  async function mount() {
    flushSync(() => root.render(<QueryClientProvider client={client}><CoordinatorWorkspaceSetting /></QueryClientProvider>));
    for (let i = 0; i < 10; i++) await new Promise(resolve => window.setTimeout(resolve, 0));
    flushSync(() => {});
  }
  it("links an administrator to the separate capability without enabling it with the preference", async () => {
    await mount();
    expect(container.textContent).toContain("Agent Chat is off");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("#experimental-enableAgentChat");
    flushSync(() => container.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    expect(mocks.setEnabled).toHaveBeenCalledWith("company", true);
    expect(mocks.updateExperimental).not.toHaveBeenCalled();
  });
  it("keeps turning the personal workspace off available to a non-admin", async () => {
    mocks.enabled = true;
    mocks.access.mockResolvedValue({ userId: "person", source: "session", isInstanceAdmin: false });
    await mount();
    expect(container.textContent).toContain("Ask an administrator");
    expect(container.querySelector("a")).toBeNull();
    flushSync(() => container.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    expect(mocks.setEnabled).toHaveBeenCalledWith("company", false);
  });
  it.each(["managed", "hidden"])("does not offer an editable link for %s controls", async kind => {
    if (kind === "managed") mocks.getExperimental.mockResolvedValue({ enableAgentChat: false, managedKeys: { enableAgentChat: { managed: true } } });
    else mocks.hidden.add("instance.experimental.enableAgentChat");
    await mount();
    expect(container.textContent).toContain("managed by your hosting provider");
    expect(container.querySelector("a")).toBeNull();
  });
  it("does not invent disabled capability state or block personal settings after a capability read error", async () => {
    mocks.getExperimental.mockRejectedValue(new Error("Unavailable"));
    await mount();
    expect(container.textContent).not.toContain("Agent Chat is off");
    expect(container.querySelector<HTMLButtonElement>('[role="switch"]')!.disabled).toBe(false);
    expect(mocks.access).not.toHaveBeenCalled();
  });
});
