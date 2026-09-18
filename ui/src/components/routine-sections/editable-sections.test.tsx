// @vitest-environment jsdom

import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TriggersSection } from "./editable-sections";
import {
  RoutineDetailContext,
  createDefaultNewTrigger,
  type NewTriggerDraft,
  type RoutineDetailContextValue,
  type SecretMessage,
} from "./context";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../MarkdownEditor", () => ({
  MarkdownEditor: () => null,
}));

function act(callback: () => void) {
  flushSync(callback);
}

function buttonByText(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!button) throw new Error(`Button not found: ${label}`);
  return button as HTMLButtonElement;
}

function typeCron(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function Harness({ createMutate, secretMessage }: { createMutate: ReturnType<typeof vi.fn>; secretMessage?: SecretMessage }) {
  const [newTrigger, setNewTrigger] = useState<NewTriggerDraft>({
    ...createDefaultNewTrigger(),
    cronExpression: "0 8-18/2 * * 1-5",
  });

  const value = {
    routine: {
      id: "routine-1",
      triggers: [],
    },
    newTrigger,
    setNewTrigger,
    secretMessage,
    copySecretValue: vi.fn(),
    setSecretMessage: vi.fn(),
    createTrigger: {
      isPending: false,
      mutate: createMutate,
    },
    updateTrigger: { mutate: vi.fn() },
    deleteTrigger: { mutate: vi.fn() },
    rotateTrigger: { mutate: vi.fn() },
  } as unknown as RoutineDetailContextValue;

  return (
    <RoutineDetailContext.Provider value={value}>
      <TriggersSection />
    </RoutineDetailContext.Provider>
  );
}

describe("TriggersSection", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("offers an enabled webhook option in the trigger picker", () => {
    const root = createRoot(container);
    act(() => root.render(<Harness createMutate={vi.fn()} />));
    act(() => buttonByText(container, "New trigger").click());
    const kind = container.querySelector('[role="combobox"]')!;
    act(() => kind.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    const webhook = [...document.querySelectorAll('[role="option"]')].find((option) => option.textContent === "webhook");
    expect(webhook).toBeTruthy();
    expect(webhook?.getAttribute("aria-disabled")).not.toBe("true");
    act(() => root.unmount());
  });

  it("shows one-time webhook credentials on the trigger setup screen", () => {
    const root = createRoot(container);
    act(() => root.render(<Harness createMutate={vi.fn()} secretMessage={{
      title: "Webhook trigger created",
      entries: [{ webhookUrl: "https://paperclip.example/api/routine-triggers/public/test/fire", webhookSecret: "one-time-secret" }],
    }} />));
    expect((container.querySelector('input[aria-label="New webhook secret"]') as HTMLInputElement).value).toBe("one-time-secret");
    expect(container.textContent).toContain("Save this now");
    expect(buttonByText(container, "Done")).toBeTruthy();
    act(() => root.unmount());
  });

  it("closes the add-trigger composer and resets the draft after a successful create", () => {
    const createMutate = vi.fn((_variables, options?: { onSuccess?: () => void }) => {
      options?.onSuccess?.();
    });
    const root = createRoot(container);

    act(() => {
      root.render(<Harness createMutate={createMutate} />);
    });

    act(() => {
      buttonByText(container, "New trigger").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector('input[aria-label="Cron expression"]')).not.toBeNull();

    act(() => {
      buttonByText(container, "Add trigger").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(createMutate).toHaveBeenCalledTimes(1);
    expect(container.querySelector('input[aria-label="Cron expression"]')).toBeNull();
    expect(buttonByText(container, "New trigger")).not.toBeNull();

    act(() => {
      buttonByText(container, "New trigger").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector('input[aria-label="Cron expression"]')).toBeNull();
    expect(container.textContent).toContain("Every day");

    act(() => root.unmount());
  });

  it("disables add trigger while the custom cron draft is invalid locally", () => {
    const createMutate = vi.fn();
    const root = createRoot(container);

    act(() => {
      root.render(<Harness createMutate={createMutate} />);
    });

    act(() => {
      buttonByText(container, "New trigger").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const input = container.querySelector<HTMLInputElement>('input[aria-label="Cron expression"]');
    expect(input).not.toBeNull();
    expect(buttonByText(container, "Add trigger").disabled).toBe(false);

    act(() => {
      typeCron(input!, "0 8-18/2 *");
    });

    expect(input?.value).toBe("0 8-18/2 *");
    expect(container.textContent).toContain("Use exactly 5 fields");
    expect(buttonByText(container, "Add trigger").disabled).toBe(true);

    act(() => {
      buttonByText(container, "Add trigger").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(createMutate).not.toHaveBeenCalled();

    act(() => root.unmount());
  });
});
