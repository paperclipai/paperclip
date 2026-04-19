// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_HELP_PROMPT } from "../lib/agent-help-request";
import { AskAgentsForHelpDialog, type AskAgentsForHelpAgent } from "./AskAgentsForHelpDialog";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function renderDialog(node: ReactNode, container: HTMLDivElement) {
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return root;
}

function agents(): AskAgentsForHelpAgent[] {
  return [
    {
      id: "agent-1",
      name: "Builder Agent",
      status: "active",
      title: "Engineer",
    },
    {
      id: "agent-2",
      name: "Research Agent",
      status: "idle",
      capabilities: "Finds context",
    },
    {
      id: "agent-3",
      name: "Former Agent",
      status: "terminated",
    },
  ];
}

describe("AskAgentsForHelpDialog", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.replaceChildren();
  });

  it("lists active agents and excludes terminated agents", () => {
    const root = renderDialog(
      <AskAgentsForHelpDialog
        open
        issueTitle="Human-owned task"
        agents={agents()}
        onOpenChange={() => undefined}
        onSubmit={async () => undefined}
      />,
      container,
    );

    expect(document.body.textContent).toContain("Builder Agent");
    expect(document.body.textContent).toContain("Research Agent");
    expect(document.body.textContent).not.toContain("Former Agent");

    act(() => {
      root.unmount();
    });
  });

  it("submits a mention comment without reassignment data", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    const root = renderDialog(
      <AskAgentsForHelpDialog
        open
        issueTitle="Human-owned task"
        agents={agents()}
        onOpenChange={onOpenChange}
        onSubmit={onSubmit}
      />,
      container,
    );

    await act(async () => {
      const builderButton = Array.from(document.body.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Builder Agent"),
      );
      builderButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    await act(async () => {
      const submitButton = Array.from(document.body.querySelectorAll("button")).find(
        (button) => button.textContent === "Ask agents",
      );
      submitButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(onSubmit).toHaveBeenCalledWith(
      `[@Builder Agent](agent://agent-1)\n\n${DEFAULT_AGENT_HELP_PROMPT}`,
    );
    expect(JSON.stringify(onSubmit.mock.calls[0])).not.toContain("assigneeAgentId");
    expect(JSON.stringify(onSubmit.mock.calls[0])).not.toContain("assigneeUserId");
    expect(onOpenChange).toHaveBeenCalledWith(false);

    act(() => {
      root.unmount();
    });
  });
});
