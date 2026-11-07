// @vitest-environment jsdom

import { act as reactAct, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
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

describe("mounted governance localization", () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let root: Root;
  let host: HTMLDivElement;
  const kinds = {
    en: ["Suggested tasks", "Ask user questions", "Confirmations", "Checkbox confirmations", "Item verdicts", "Connection requests"],
    "zh-CN": ["建议任务", "向用户提问", "确认请求", "勾选确认请求", "逐项判定", "连接请求"],
  };
  const copy = {
    en: {
      fields: ["Default policy", "Cap"],
      labels: [["Anyone (default)", "Anyone except creator", "Human only"], ["No cap", "Anyone except creator", "Human only"]],
      effects: [
        ["New cards are open — the board or any agent can respond, including the one that asked.", "New cards exclude the agent that created them, so the answer comes from someone else.", "New cards wait for a person on the board. Agents are turned away."],
        ["A request keeps whatever audience it asks for.", "Even a card that asks for Anyone is narrowed to exclude its creator.", "Every card of this kind waits for a person, whatever it asked for."],
      ],
    },
    "zh-CN": {
      fields: ["默认策略", "范围上限"],
      labels: [["任何人（默认）", "除创建者外的任何人", "仅限人员"], ["不设上限", "除创建者外的任何人", "仅限人员"]],
      effects: [
        ["新卡片默认向所有人开放：管理者或任何智能体均可响应，包括发起请求的智能体。", "新卡片不允许创建它的智能体响应，确保由其他人或智能体作答。", "新卡片仅等待管理端的人员响应，智能体不能响应。"],
        ["请求保留其指定的响应范围。", "即使卡片指定任何人均可响应，也会收窄范围，排除创建者。", "此类卡片一律等待人员响应，不受其原先指定的响应范围影响。"],
      ],
    },
  };

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    await i18n.changeLanguage("en");
  });

  async function language(locale: "en" | "zh-CN") {
    await act(async () => { await i18n.changeLanguage(locale); });
  }
  function trigger(kind: string, suffix: string) {
    const element = host.querySelector<HTMLButtonElement>(`[data-testid="governance-${kind}-${suffix}"]`);
    expect(element).toBeTruthy();
    return element!;
  }
  async function open(element: HTMLElement) {
    await act(async () => { element.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
    return document.querySelector<HTMLElement>('[role="listbox"]')!;
  }
  async function close(list: HTMLElement) {
    await act(async () => { list.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  }

  it("updates all six mounted kind rows, mobile labels and accessible combobox names in both directions without resetting a controlled draft", async () => {
    const onChange = vi.fn();
    function Draft() {
      const [governance, setGovernance] = useState<InteractionResolverGovernance>({ request_confirmation: { defaultPolicy: "human_only", cap: "not_creator" } });
      return <form><InteractionGovernancePanel governance={governance} onChange={(kind, field, value) => {
        onChange(kind, field, value);
        setGovernance(current => applyGovernanceChange(current, kind, field, value));
      }} /></form>;
    }
    await act(async () => root.render(<Draft />));
    const draftOptions = await open(trigger("suggest_tasks", "default"));
    await act(async () => {
      draftOptions.querySelectorAll<HTMLElement>('[role="option"]')[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledExactlyOnceWith("suggest_tasks", "defaultPolicy", "not_creator");
    onChange.mockClear();
    const retained = trigger("request_confirmation", "default");
    const initialValues = Array.from(host.querySelectorAll("select"), select => select.value);
    expect(initialValues).toHaveLength(12);
    expect(initialValues[0]).toBe("not_creator");
    for (const locale of ["en", "zh-CN", "en"] as const) {
      await language(locale);
      expect(host.querySelectorAll('[role="combobox"]')).toHaveLength(12);
      INTERACTION_KINDS.forEach((kind, index) => {
        const kindLabel = kinds[locale][index];
        expect(host.textContent).toContain(kindLabel);
        for (const [fieldIndex, suffix] of ["default", "cap"].entries()) {
          const button = trigger(kind, suffix);
          const aria = locale === "en"
            ? fieldIndex === 0 ? `Default resolver audience for ${kindLabel}` : `Resolver cap for ${kindLabel}`
            : fieldIndex === 0 ? `${kindLabel}的默认响应范围` : `${kindLabel}的响应范围上限`;
          expect(button.getAttribute("role")).toBe("combobox");
          expect(button.getAttribute("aria-label")).toBe(aria);
          expect(button.parentElement?.querySelector("span")?.textContent).toBe(copy[locale].fields[fieldIndex]);
          const selected = kind === "request_confirmation" ? fieldIndex === 0 ? 2 : 1 : kind === "suggest_tasks" && fieldIndex === 0 ? 1 : 0;
          expect(button.textContent).toBe(copy[locale].labels[fieldIndex][selected]);
        }
      });
      expect(trigger("request_confirmation", "default")).toBe(retained);
      expect(Array.from(host.querySelectorAll("select"), select => select.value)).toEqual(initialValues);
      expect(onChange).not.toHaveBeenCalled();
    }
  });

  it("updates every option and full effect message while open, preserving exact canonical values and change payloads", async () => {
    const onChange = vi.fn();
    function Draft() {
      const [governance, setGovernance] = useState<InteractionResolverGovernance>({});
      return <form><InteractionGovernancePanel governance={governance} onChange={(kind, field, value) => {
        onChange(kind, field, value);
        setGovernance(current => applyGovernanceChange(current, kind, field, value));
      }} /></form>;
    }
    await act(async () => root.render(<Draft />));
    for (const [fieldIndex, suffix] of ["default", "cap"].entries()) {
      const list = await open(trigger("request_confirmation", suffix));
      expect(list).toBeTruthy();
      for (const locale of ["en", "zh-CN", "en"] as const) {
        await language(locale);
        const options = Array.from(list.querySelectorAll('[role="option"]'));
        expect(options).toHaveLength(3);
        options.forEach((option, index) => {
          expect(option.textContent).toBe(copy[locale].labels[fieldIndex][index] + copy[locale].effects[fieldIndex][index]);
        });
        const selects = Array.from(host.querySelectorAll("select"));
        expect(selects.length).toBeGreaterThan(0);
        selects.forEach(select => expect(Array.from(select.options, option => option.value)).toEqual(["default", "not_creator", "human_only"]));
        expect(onChange).not.toHaveBeenCalled();
      }
      await close(list);
      for (const [index, value] of [[1, "not_creator"], [2, "human_only"], [0, "default"]] as const) {
        const choices = await open(trigger("request_confirmation", suffix));
        await act(async () => { choices.querySelectorAll<HTMLElement>('[role="option"]')[index].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
        expect(onChange).toHaveBeenLastCalledWith("request_confirmation", fieldIndex === 0 ? "defaultPolicy" : "cap", value);
        onChange.mockClear();
      }
    }
  });

});
