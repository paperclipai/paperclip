// @vitest-environment jsdom

import { act as reactAct } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ISSUE_THREAD_INTERACTION_KINDS as INTERACTION_KINDS,
  type InteractionResolverGovernance,
} from "@paperclipai/shared";
import {
  GOVERNANCE_UNSET,
  InteractionGovernancePanel,
  applyGovernanceChange,
  toGovernanceSelectValue,
} from "./InteractionGovernancePanel";
import { TooltipProvider } from "./ui/tooltip";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  if (typeof reactAct === "function") {
    await reactAct(callback);
    return;
  }
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

function renderPanel(governance: InteractionResolverGovernance = {}, onChange = vi.fn()) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <TooltipProvider>
        <InteractionGovernancePanel governance={governance} onChange={onChange} />
      </TooltipProvider>,
    );
  });
  return { host: container, onChange };
}

/** Exact visible text of a closed select trigger (the chevron contributes none). */
function triggerText(host: HTMLElement, testId: string): string {
  const trigger = host.querySelector(`[data-testid="${testId}"]`);
  expect(trigger).toBeTruthy();
  return (trigger?.textContent ?? "").replace(/\s+/g, " ").trim();
}

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  container?.remove();
  root = null;
  container = null;
});

describe("InteractionGovernancePanel", () => {
  it("presents Anyone as the visible default for a company with no overrides", () => {
    const { host } = renderPanel();

    const defaultSelect = host.querySelector('[data-testid="governance-request_confirmation-default"]');
    expect(defaultSelect?.textContent).toContain("Anyone (default)");
    const cap = host.querySelector('[data-testid="governance-request_confirmation-cap"]');
    expect(cap?.textContent).toContain("No cap");
  });

  it("describes the open default without presenting it as board-required", () => {
    const { host } = renderPanel();
    const copy = host.textContent ?? "";

    expect(copy).toContain("Thread interactions are open by default");
    expect(copy).toContain("the board or any agent, including the one that asked");
    expect(copy).not.toContain("Board only");
    expect(copy).not.toContain("always require the board");
    // Governed tool approvals keep their human-only guarantee.
    expect(copy).toContain("Tool-approval confirmations always stay");
    expect(copy).toContain("Human only");
  });

  it("shows a stored narrowing override on the matching row", () => {
    const { host } = renderPanel({
      request_confirmation: { defaultPolicy: "human_only", cap: "not_creator" },
    });

    expect(
      host.querySelector('[data-testid="governance-request_confirmation-default"]')?.textContent,
    ).toContain("Human only");
    expect(
      host.querySelector('[data-testid="governance-request_confirmation-cap"]')?.textContent,
    ).toContain("Anyone except creator");
    // Untouched kinds still read as open.
    expect(
      host.querySelector('[data-testid="governance-suggest_tasks-default"]')?.textContent,
    ).toContain("Anyone (default)");
  });

  /**
   * PAP-17297: an empty `<SelectValue />` lets Radix portal the selected
   * option's whole subtree — label *and* effect sentence — into the closed
   * trigger, where `line-clamp-1` clipped it. `toContain` assertions cannot see
   * that, so these check the trigger's exact text.
   */
  it("shows only the complete selected label in a closed trigger", () => {
    const { host } = renderPanel();

    for (const kind of INTERACTION_KINDS) {
      expect(triggerText(host, `governance-${kind}-default`)).toBe("Anyone (default)");
      expect(triggerText(host, `governance-${kind}-cap`)).toBe("No cap");
    }
  });

  it("keeps a narrowed trigger free of the option effect sentence", () => {
    const { host } = renderPanel({
      request_confirmation: { defaultPolicy: "human_only", cap: "not_creator" },
    });

    expect(triggerText(host, "governance-request_confirmation-default")).toBe("Human only");
    expect(triggerText(host, "governance-request_confirmation-cap")).toBe("Anyone except creator");
    // The effect prose belongs to the option list, never the trigger.
    expect(host.textContent).not.toContain("New cards wait for a person on the board");
    expect(host.textContent).not.toContain("narrowed to exclude its creator");
    expect(host.textContent).not.toContain("New cards are open");
  });

  it("still offers the effect sentence inside the open option list", async () => {
    const { host } = renderPanel();
    const trigger = host.querySelector<HTMLElement>(
      '[data-testid="governance-request_confirmation-default"]',
    );
    expect(trigger).toBeTruthy();

    await act(() => {
      trigger?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });

    const listbox = document.querySelector('[data-slot="select-content"]');
    const listText = listbox?.textContent ?? "";
    expect(listText).toContain("Anyone (default)");
    expect(listText).toContain(
      "New cards are open — the board or any agent can respond, including the one that asked.",
    );
    expect(listText).toContain("New cards wait for a person on the board. Agents are turned away.");
    // Each option keeps a label-only typeahead value so keyboard search does not
    // match the effect prose.
    expect(
      Array.from(listbox?.querySelectorAll('[data-slot="select-item"]') ?? []).length,
    ).toBe(3);
    // Reflow guard: the popover is capped so long prose wraps instead of
    // stretching past a narrow viewport.
    expect(listbox?.className).toContain("max-w-(--sz-280px)");
  });

  it("renders a select for every interaction kind", () => {
    const { host } = renderPanel();
    expect(host.querySelectorAll('[data-testid$="-default"]')).toHaveLength(
      INTERACTION_KINDS.length,
    );
    expect(host.querySelectorAll('[data-testid$="-cap"]')).toHaveLength(
      INTERACTION_KINDS.length,
    );
  });

  it("surfaces a save failure", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <TooltipProvider>
          <InteractionGovernancePanel
            governance={{}}
            onChange={vi.fn()}
            errorMessage="Failed to save interaction governance"
          />
        </TooltipProvider>,
      );
    });
    expect(container.textContent).toContain("Failed to save interaction governance");
  });
});

describe("toGovernanceSelectValue", () => {
  it("treats an absent override as the open default", () => {
    expect(toGovernanceSelectValue(undefined)).toBe(GOVERNANCE_UNSET);
  });

  it("treats a stored open audience — canonical or legacy alias — as the default", () => {
    expect(toGovernanceSelectValue("anyone")).toBe(GOVERNANCE_UNSET);
    expect(toGovernanceSelectValue("board_or_agents")).toBe(GOVERNANCE_UNSET);
  });

  it("canonicalizes stored narrowing values, including the legacy board_only alias", () => {
    expect(toGovernanceSelectValue("not_creator")).toBe("not_creator");
    expect(toGovernanceSelectValue("human_only")).toBe("human_only");
    expect(toGovernanceSelectValue("board_only")).toBe("human_only");
  });
});

describe("applyGovernanceChange", () => {
  it("stores a narrowing override", () => {
    expect(applyGovernanceChange({}, "request_confirmation", "defaultPolicy", "human_only")).toEqual({
      request_confirmation: { defaultPolicy: "human_only" },
    });
  });

  it("clears the override when the open default is re-selected", () => {
    const current: InteractionResolverGovernance = {
      request_confirmation: { defaultPolicy: "human_only" },
    };
    expect(
      applyGovernanceChange(current, "request_confirmation", "defaultPolicy", GOVERNANCE_UNSET),
    ).toEqual({});
    // Immutable: the caller's map is untouched.
    expect(current.request_confirmation?.defaultPolicy).toBe("human_only");
  });

  it("keeps a sibling field when only one is cleared", () => {
    const current: InteractionResolverGovernance = {
      request_confirmation: { defaultPolicy: "human_only", cap: "not_creator" },
    };
    expect(applyGovernanceChange(current, "request_confirmation", "cap", GOVERNANCE_UNSET)).toEqual({
      request_confirmation: { defaultPolicy: "human_only" },
    });
  });
});
