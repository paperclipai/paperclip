// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatConnectionPurpose, ChatEndpointSetup } from "./ChatEndpointSetup";

vi.mock("@/lib/router", async () => import("react-router-dom"));
vi.mock("./GitHubChatSetup", () => ({
  GitHubChatSetup: () => <p>GitHub bot setup</p>,
}));
vi.mock("@/components/chat/ChatSetupNavigation", () => ({
  ChatSetupNavigation: () => null,
}));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

function Location() {
  const location = useLocation();
  return (
    <output>
      {location.pathname}
      {location.search}
    </output>
  );
}

describe("Chat connector setup routing", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });
  function render(search: string) {
    flushSync(() =>
      root.render(
        <MemoryRouter initialEntries={[`/apps/chat/connect?${search}`]}>
          <Routes>
            <Route path="/apps/chat/connect" element={<ChatEndpointSetup />} />
            <Route path="/apps/connect" element={<p>Personal connection</p>} />
          </Routes>
          <Location />
        </MemoryRouter>,
      ),
    );
  }
  it("keeps both chooser actions usable with decorative identity icons", () => {
    const onChat = vi.fn();
    const onTools = vi.fn();
    flushSync(() => root.render(
      <ChatConnectionPurpose provider="slack" onChat={onChat} onTools={onTools} />,
    ));
    const buttons = Array.from(container.querySelectorAll("button"));
    const chat = buttons.find(button => button.textContent?.includes("Chat with an agent"))!;
    const tools = buttons.find(button => button.textContent?.includes("Use this connection as an agent tool"))!;
    expect(chat.querySelector('[data-slot="agent-avatar"][aria-hidden="true"]')).not.toBeNull();
    expect(chat.querySelector("img")?.getAttribute("alt")).toBe("");
    expect(tools.querySelector('[aria-hidden="true"] svg')).not.toBeNull();
    expect(chat.getAttribute("type")).toBe("button");
    expect(tools.getAttribute("type")).toBe("button");
    chat.focus();
    expect(document.activeElement).toBe(chat);
    flushSync(() => chat.click());
    expect(onChat).toHaveBeenCalledOnce();
    expect(onTools).not.toHaveBeenCalled();
    tools.focus();
    expect(document.activeElement).toBe(tools);
    flushSync(() => tools.click());
    expect(onTools).toHaveBeenCalledOnce();
    expect(onChat).toHaveBeenCalledOnce();
  });
  it.each([
    "",
    "agentId=agent-a",
    "toolHref=%2Fapps%2Fconnect%3Fsource%3Dgithub",
    "purpose=chat",
    "resume=endpoint-a",
    "resume=endpoint-a&reconnect=1",
  ])("opens direct or resumed bot setup for %s", (search) => {
    render(`provider=github&${search}`);
    expect(container.textContent).toContain("GitHub bot setup");
    expect(container.textContent).not.toContain("Choose how to connect");
    expect(container.querySelector("output")?.textContent).toBe(`/apps/chat/connect?provider=github&${search}`);
  });
});
