// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveRunForIssue } from "../api/heartbeats";
import { RunChatSurface } from "./RunChatSurface";

/**
 * PAP-139: RunChatSurface (embedded run chat in ActiveAgentsPanel /
 * LiveRunWidget) selects the thread variant by the Conference Room Chat
 * experimental flag — NUX thread when ON, the frozen master fork when OFF.
 */

const conferenceRoomChatFlag = vi.hoisted(() => ({ enabled: true }));
vi.mock("../hooks/useConferenceRoomChatEnabled", () => ({
  useConferenceRoomChatEnabled: () => ({ enabled: conferenceRoomChatFlag.enabled, loaded: true }),
}));

vi.mock("./IssueChatThread", () => ({
  IssueChatThread: () => <div data-testid="nux-thread">NUX thread</div>,
}));

vi.mock("./IssueChatThreadClassic", () => ({
  IssueChatThreadClassic: () => <div data-testid="classic-thread">Classic thread</div>,
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

async function renderSurface() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<RunChatSurface run={run} transcript={[]} hasOutput={false} />);
  });
  return {
    container,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

afterEach(() => {
  conferenceRoomChatFlag.enabled = true;
  document.body.innerHTML = "";
});

describe("RunChatSurface thread variant selection (PAP-139)", () => {
  it("renders the NUX thread when the Conference Room Chat flag is on", async () => {
    const { container, cleanup } = await renderSurface();
    expect(container.querySelector('[data-testid="nux-thread"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="classic-thread"]')).toBeNull();
    await cleanup();
  });

  it("renders the frozen master fork when the flag is off", async () => {
    conferenceRoomChatFlag.enabled = false;
    const { container, cleanup } = await renderSurface();
    expect(container.querySelector('[data-testid="classic-thread"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="nux-thread"]')).toBeNull();
    await cleanup();
  });
});
