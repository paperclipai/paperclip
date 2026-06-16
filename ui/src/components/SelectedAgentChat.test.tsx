// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import {
  SelectedAgentChatView,
  resolveDefaultChatTarget,
} from "./SelectedAgentChat";
import type { IssueChatComment } from "../lib/issue-chat-messages";

// Stub the heavy thread renderer so the View's own wiring (identity header,
// switcher, error/loading states, send pass-through) is what we assert.
vi.mock("./IssueChatThread", () => ({
  IssueChatThread: (props: { emptyMessage?: string; onAdd: (b: string) => Promise<void> }) => (
    <div data-testid="issue-chat-thread">
      <span data-testid="empty-message">{props.emptyMessage}</span>
      <button type="button" data-testid="send" onClick={() => void props.onAdd("hello")}>
        send
      </button>
    </div>
  ),
}));

function makeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-x",
    companyId: "company-1",
    name: "Agent X",
    urlKey: "agent-x",
    role: "engineer",
    title: null,
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_code",
    adapterConfig: {},
    runtimeConfig: {} as Agent["runtimeConfig"],
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: {} as Agent["permissions"],
    lastHeartbeatAt: null,
    ...overrides,
  } as Agent;
}

const ceo = makeAgent({ id: "agent-ceo", name: "Sarah", role: "ceo" });
const eng = makeAgent({ id: "agent-eng", name: "Dev", role: "engineer" });
const terminated = makeAgent({ id: "agent-dead", name: "Zed", status: "terminated" });

describe("resolveDefaultChatTarget", () => {
  it("defaults to the CEO", () => {
    expect(resolveDefaultChatTarget([eng, ceo])?.id).toBe("agent-ceo");
  });
  it("honors a preferred agent when present", () => {
    expect(resolveDefaultChatTarget([eng, ceo], "agent-eng")?.id).toBe("agent-eng");
  });
  it("skips terminated preferred and falls back to CEO", () => {
    expect(resolveDefaultChatTarget([ceo, eng, terminated], "agent-dead")?.id).toBe("agent-ceo");
  });
  it("falls back to first active agent when there is no CEO", () => {
    expect(resolveDefaultChatTarget([terminated, eng])?.id).toBe("agent-eng");
  });
  it("returns null for an empty roster", () => {
    expect(resolveDefaultChatTarget([])).toBeNull();
  });
});

describe("SelectedAgentChatView", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  function render(node: ReactNode) {
    flushSync(() => root.render(node));
  }

  function countText(text: string, needle: string): number {
    return text.split(needle).length - 1;
  }

  it("renders the real selected-agent identity in the header", () => {
    render(
      <SelectedAgentChatView
        agents={[ceo, eng]}
        targetAgentId={ceo.id}
        comments={[]}
        onSend={async () => {}}
      />,
    );
    expect(container.textContent).toContain("Sarah");
    expect(container.textContent).toContain("CEO");
    // No board-concierge persona leaks into the surface.
    expect(container.textContent?.toLowerCase()).not.toContain("concierge");
  });

  it("uses the left-side selector as the selected-agent identity without repeating the role", () => {
    render(
      <SelectedAgentChatView
        agents={[ceo, eng]}
        targetAgentId={ceo.id}
        comments={[]}
        onSend={async () => {}}
        onTargetAgentChange={() => {}}
      />,
    );

    const header = container.querySelector(
      '[data-testid="selected-agent-chat-header"]',
    ) as HTMLDivElement | null;
    const switcher = header?.querySelector('[aria-label="Choose chat agent"]');
    expect(switcher).not.toBeNull();
    expect(switcher?.textContent).toContain("Sarah");
    expect(countText(switcher?.textContent ?? "", "CEO")).toBe(1);
    expect(header?.textContent).toBe(switcher?.textContent);
  });

  it("pads the chat body to align with the selected-agent header", () => {
    render(
      <SelectedAgentChatView
        agents={[ceo]}
        targetAgentId={ceo.id}
        comments={[]}
        onSend={async () => {}}
      />,
    );

    const body = container.querySelector(
      '[data-testid="selected-agent-chat-body"]',
    ) as HTMLDivElement | null;
    expect(body).not.toBeNull();
    expect(body?.className).toContain("px-4");
    expect(body?.className).toContain("pt-3");
    expect(body?.className).toContain("pb-4");
  });

  it("shows a loading indicator while the first fetch is in flight", () => {
    render(
      <SelectedAgentChatView agents={[ceo]} targetAgentId={ceo.id} comments={[]} loading onSend={async () => {}} />,
    );
    expect(container.querySelector('[aria-label="Loading conversation"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="issue-chat-thread"]')).toBeNull();
  });

  it("surfaces a delivery error with a Try again affordance", () => {
    const onRetry = vi.fn();
    render(
      <SelectedAgentChatView
        agents={[ceo]}
        targetAgentId={ceo.id}
        comments={[]}
        errorText="Could not deliver."
        onRetry={onRetry}
        onSend={async () => {}}
      />,
    );
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Could not deliver.");
    const retry = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Try again",
    );
    expect(retry).toBeTruthy();
    flushSync(() => retry!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("passes a target-specific empty message and pipes sends through", async () => {
    const onSend = vi.fn(async () => {});
    render(
      <SelectedAgentChatView agents={[ceo]} targetAgentId={ceo.id} comments={[]} onSend={onSend} />,
    );
    expect(container.querySelector('[data-testid="empty-message"]')?.textContent).toContain(
      "Sarah",
    );
    const send = container.querySelector('[data-testid="send"]') as HTMLButtonElement;
    flushSync(() => send.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await Promise.resolve();
    expect(onSend).toHaveBeenCalledWith("hello");
  });

  it("offers the switcher only when more than one agent is invokable", () => {
    render(
      <SelectedAgentChatView agents={[ceo]} targetAgentId={ceo.id} comments={[]} onSend={async () => {}} onTargetAgentChange={() => {}} />,
    );
    expect(container.querySelector('[aria-label="Choose chat agent"]')).toBeNull();

    render(
      <SelectedAgentChatView
        agents={[ceo, eng]}
        targetAgentId={ceo.id}
        comments={[] as IssueChatComment[]}
        onSend={async () => {}}
        onTargetAgentChange={() => {}}
      />,
    );
    expect(container.querySelector('[aria-label="Choose chat agent"]')).not.toBeNull();
  });
});
