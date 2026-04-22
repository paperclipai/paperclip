// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IssueAssigneeIcon } from "./IssueAssigneeIcon";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function renderIcon(
  props: ComponentProps<typeof IssueAssigneeIcon>,
  container: HTMLDivElement,
): Root {
  const root = createRoot(container);
  act(() => {
    root.render(<IssueAssigneeIcon {...props} />);
  });
  return root;
}

describe("IssueAssigneeIcon", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container.remove();
  });

  it("renders the default bot marker for an agent without a configured icon", () => {
    root = renderIcon(
      {
        issue: { assigneeAgentId: "agent-1", assigneeUserId: null },
        agents: [{ id: "agent-1", name: "Build Agent", icon: null }],
      },
      container,
    );

    const marker = container.querySelector('[aria-label="Assigned to Build Agent"]');
    expect(marker?.getAttribute("title")).toBe("Assigned to Build Agent");
    expect(marker?.querySelector("svg.lucide-bot")).not.toBeNull();
    expect(marker?.textContent).not.toContain("BA");
  });

  it("preserves a configured agent icon", () => {
    root = renderIcon(
      {
        issue: { assigneeAgentId: "agent-1", assigneeUserId: null },
        agents: [{ id: "agent-1", name: "Build Agent", icon: "code" }],
      },
      container,
    );

    expect(container.querySelector('[aria-label="Assigned to Build Agent"] svg.lucide-code')).not.toBeNull();
    expect(container.querySelector("svg.lucide-bot")).toBeNull();
  });

  it("keeps the human avatar treatment for user-assigned issues", () => {
    root = renderIcon(
      {
        issue: { assigneeAgentId: null, assigneeUserId: "board-user" },
        currentUserId: "board-user",
      },
      container,
    );

    const marker = container.querySelector('[aria-label="Assigned to You"]');
    expect(marker?.textContent).toBe("ME");
    expect(marker?.querySelector("svg.lucide-bot")).toBeNull();
  });

  it("renders nothing for unassigned issues", () => {
    root = renderIcon(
      {
        issue: { assigneeAgentId: null, assigneeUserId: null },
      },
      container,
    );

    expect(container.innerHTML).toBe("");
  });
});
