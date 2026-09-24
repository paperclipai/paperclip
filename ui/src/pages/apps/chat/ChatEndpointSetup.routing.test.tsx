// @vitest-environment jsdom
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatEndpointSetup } from "./ChatEndpointSetup";

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

describe("GitHub connection purpose routing", () => {
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
  async function click(label: string) {
    const button = [...container.querySelectorAll("button")].find((node) =>
      node.textContent?.includes(label),
    );
    expect(button).toBeDefined();
    await act(async () => {
      button!.click();
    });
  }
  it("offers personal/tool connections from the catalog instead of forcing bot setup", async () => {
    render("provider=github&toolHref=%2Fapps%2Fconnect%3Fsource%3Dgithub");
    expect(container.textContent).toContain("Choose how to connect");
    expect(container.textContent).not.toContain("GitHub bot setup");
    await click("Use this connection as an agent tool");
    expect(container.querySelector("output")?.textContent).toBe(
      "/apps/connect?source=github",
    );
  });
  it("opens the bot wizard when chat is chosen and preserves the agent preselection", async () => {
    render("provider=github&agentId=agent-a");
    await click("Chat with an agent");
    expect(container.textContent).toContain("GitHub bot setup");
    expect(container.querySelector("output")?.textContent).toContain(
      "agentId=agent-a&purpose=chat",
    );
  });
  it.each([
    "purpose=chat",
    "resume=endpoint-a",
    "resume=endpoint-a&reconnect=1",
  ])("opens direct or resumed bot setup for %s", (search) => {
    render(`provider=github&${search}`);
    expect(container.textContent).toContain("GitHub bot setup");
    expect(container.textContent).not.toContain("Choose how to connect");
  });
});
