// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PriorityIcon } from "./PriorityIcon";
import { act as reactAct } from "react";
import { setLocale } from "@/i18n";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

describe("PriorityIcon picker", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;

  beforeEach(() => {
    setLocale("en");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container.remove();
    document.body.innerHTML = "";
    setLocale("en");
  });

  it("opens the real popover and selects a priority", async () => {
    const onChange = vi.fn();
    await act(async () => root?.render(<PriorityIcon priority="medium" onChange={onChange} />));

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Change priority (current: Medium)"]',
    );
    expect(trigger).not.toBeNull();

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const highOption = [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "High");
    expect(highOption).not.toBeUndefined();

    await act(async () => {
      highOption?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith("high");
  });

  it("updates the open priority picker in Russian but emits the raw priority", async () => {
    const onChange = vi.fn();
    await reactAct(async () => root?.render(<PriorityIcon priority="medium" onChange={onChange} />));
    await reactAct(async () => container.querySelector("button")!.click());
    await reactAct(async () => setLocale("ru"));
    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("Изменить приоритет (сейчас: Средний)");
    expect(onChange).not.toHaveBeenCalled();
    const high = Array.from(document.body.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Высокий")!;
    await reactAct(async () => high.click());
    expect(onChange).toHaveBeenCalledExactlyOnceWith("high");
  });
});
