// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveRunForIssue } from "../api/heartbeats";
import { RunChatSurface } from "./RunChatSurface";

vi.mock("./IssueChatThread", () => ({
  IssueChatThread: () => <div data-testid="nux-thread">NUX thread</div>,
}));

const run: LiveRunForIssue = {
  id: "run-1",
  status: "running",
  agentId: "agent-1",
  agentName: "Agent",
  createdAt: new Date(0).toISOString(),
  startedAt: new Date(0).toISOString(),
  finishedAt: null,
} as LiveRunForIssue;

function act(callback: () => void) {
  flushSync(callback);
}

async function renderSurface() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<RunChatSurface run={run} transcript={[]} hasOutput={false} />);
  });
  return {
    container,
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("RunChatSurface thread presentation", () => {
  it("renders the graduated issue thread without a chat-flag branch", async () => {
    const { container, cleanup } = await renderSurface();
    expect(container.querySelector('[data-testid="nux-thread"]')).not.toBeNull();
    await cleanup();
  });
});
