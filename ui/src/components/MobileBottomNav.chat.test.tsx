// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileBottomNav } from "./MobileBottomNav";

const flags = vi.hoisted(() => ({ coordinator: false }));
const setSidebarOpen = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({ useCoordinatorWorkspaceEnabled: () => ({ enabled: flags.coordinator }) }));
vi.mock("@/hooks/useCoordinatorAttentionCount", () => ({ useCoordinatorAttentionCount: () => 0 }));
vi.mock("@/hooks/useAgentChatEnabled", () => ({ useAgentChatEnabled: () => ({ enabled: true }) }));
vi.mock("@/hooks/useCombinedInboxTasksEnabled", () => ({ useCombinedInboxTasksEnabled: () => ({ enabled: true }) }));
vi.mock("@/hooks/useInboxBadge", () => ({ useInboxBadge: () => ({ inbox: 0 }) }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company", selectedCompany: { issuePrefix: "PAP" } }) }));
vi.mock("@/context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: vi.fn() }) }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ setSidebarOpen }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let currentPath = "";
function PathProbe() {
  currentPath = useLocation().pathname;
  return null;
}

describe.each([
  ["default bar", false],
  ["coordinator bar", true],
])("MobileBottomNav Chat button (%s)", (_name, coordinator) => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    flags.coordinator = coordinator;
    setSidebarOpen.mockClear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(() => root.unmount());
    host.remove();
  });

  async function render(path: string, chatListInDrawer: boolean) {
    await act(() => root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/:companyPrefix/*" element={<><MobileBottomNav visible chatListInDrawer={chatListInDrawer} /><PathProbe /></>} />
        </Routes>
      </MemoryRouter>,
    ));
  }

  function tapChat() {
    const chat = [...host.querySelectorAll("a")].find((link) => link.textContent === "Chat");
    expect(chat?.getAttribute("href")).toBe("/PAP/chats");
    act(() => chat!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
  }

  it("opens the agent chats list when a chat is already open", async () => {
    await render("/PAP/chats/ceo", true);
    tapChat();
    expect(setSidebarOpen).toHaveBeenCalledWith(true);
    expect(currentPath).toBe("/PAP/chats/ceo");
  });

  it("still navigates to Chat from another page", async () => {
    await render("/PAP/issues", false);
    tapChat();
    expect(setSidebarOpen).not.toHaveBeenCalled();
    expect(currentPath).toBe("/PAP/chats");
  });
});
