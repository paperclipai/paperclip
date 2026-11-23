// @vitest-environment jsdom

import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { MemoryRouter } from "@/lib/router";
import { TaskChatProtocolCard } from "./TaskChatProtocolCard";
import type { TaskChatProtocolItem } from "./task-chat-model";

function proposal(output: string): TaskChatProtocolItem {
  return {
    id: "run-1:provider:plan_proposal:toolu_plan:0",
    kind: "protocol",
    surface: "provider_activity",
    family: "plan_proposal",
    eventType: "plan.proposed",
    status: "completed",
    title: "Plan",
    summary: "Proposed a plan",
    details: [],
    steps: [],
    links: [],
    children: [],
    output,
  };
}

describe("TaskChatProtocolCard plan proposal", () => {
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
  });

  function render(item: TaskChatProtocolItem) {
    act(() => root.render(<MemoryRouter><ThemeProvider><TaskChatProtocolCard item={item} /></ThemeProvider></MemoryRouter>));
  }

  it("keeps a completed plan proposal readable behind its one-line record", () => {
    render(proposal("# Stop duplicates\n\n1. Add a unique index\n2. Upsert on the event id"));
    const card = container.querySelector("[data-testid='task-chat-plan-proposal']");
    expect(card?.tagName).toBe("DETAILS");
    expect(card?.textContent).toContain("Proposed a plan · Stop duplicates");
    expect(container.querySelector("[data-testid='task-chat-plan-proposal-body']")?.textContent)
      .toContain("Upsert on the event id");
  });

  it("keeps images in a harness-written plan inert", () => {
    render(proposal("# Plan\n\n![tracking](https://tracker.example/pixel.png)\n\n1. Ship"));
    const body = container.querySelector("[data-testid='task-chat-plan-proposal-body']");
    expect(body?.querySelector("img[src='https://tracker.example/pixel.png']")).toBeNull();
  });
});
