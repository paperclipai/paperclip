// @vitest-environment jsdom
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

describe("GitHub code review bot routing", () => {
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
