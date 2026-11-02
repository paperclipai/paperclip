// @vitest-environment jsdom

import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ScheduleEditor,
  buildCron,
  getScheduleCronValidation,
  parseCronToPreset,
} from "./ScheduleEditor";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness({
  initial,
  onChange,
  onValidityChange,
}: {
  initial: string;
  onChange?: (value: string) => void;
  onValidityChange?: (valid: boolean) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <ScheduleEditor
      value={value}
      onValidityChange={onValidityChange}
      onChange={(cron) => {
        setValue(cron);
        onChange?.(cron);
      }}
    />
  );
}

function typeCron(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function act(callback: () => void) {
  flushSync(callback);
}

describe("ScheduleEditor cron helpers", () => {
  it("classifies unknown valid 5-field cron expressions as custom", () => {
    expect(parseCronToPreset("0 8-18/2 * * 1-5").preset).toBe("custom");
    expect(getScheduleCronValidation("0 8-18/2 * * 1-5").valid).toBe(true);
  });

  it("still recognizes supported presets and emits their expected cron", () => {
    expect(parseCronToPreset("0 10 * * 1-5")).toMatchObject({
      preset: "weekdays",
      hour: "10",
      minute: "0",
    });
    expect(buildCron("weekdays", "8", "15", "1", "1")).toBe("15 8 * * 1-5");
  });

  it("reports partial cron edits as invalid without treating them as presets", () => {
    const validation = getScheduleCronValidation("0 8-18/2 *");
    expect(validation.valid).toBe(false);
    expect(validation.message).toContain("5 fields");
  });
});

describe("ScheduleEditor", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  function cronInput() {
    return container.querySelector<HTMLInputElement>('input[aria-label="Cron expression"]');
  }

  it("renders unknown valid cron expressions in Custom with the original text", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<Harness initial="0 8-18/2 * * 1-5" />);
    });

    expect(container.textContent).toContain("Custom (cron)");
    expect(cronInput()?.value).toBe("0 8-18/2 * * 1-5");
    expect(container.textContent).toContain("Valid cron.");

    act(() => root.unmount());
  });

  it("keeps Custom open while partial edits and pasted valid cron values round-trip through parent state", () => {
    const onChange = vi.fn();
    const onValidityChange = vi.fn();
    const root = createRoot(container);
    act(() => {
      root.render(
        <Harness
          initial="0 8-18/2 * * 1-5"
          onChange={onChange}
          onValidityChange={onValidityChange}
        />,
      );
    });

    act(() => {
      typeCron(cronInput()!, "0 8-18/2 *");
    });
    expect(cronInput()?.value).toBe("0 8-18/2 *");
    expect(cronInput()?.getAttribute("aria-invalid")).toBe("true");
    expect(container.textContent).toContain("Use exactly 5 fields");
    expect(onChange).not.toHaveBeenCalledWith("0 8-18/2 *");
    expect(onValidityChange).toHaveBeenLastCalledWith(false);

    act(() => {
      typeCron(cronInput()!, "0 8-18/2 * * 1-5");
    });
    expect(cronInput()?.value).toBe("0 8-18/2 * * 1-5");
    expect(cronInput()?.getAttribute("aria-invalid")).toBe("false");
    expect(onChange).toHaveBeenLastCalledWith("0 8-18/2 * * 1-5");
    expect(onValidityChange).toHaveBeenLastCalledWith(true);

    act(() => root.unmount());
  });
});
