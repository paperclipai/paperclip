// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAssignmentProfile } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AgentAutoAssignmentFields } from "./AgentAutoAssignmentFields";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  document.body.innerHTML = "";
});

function render(value: AgentAssignmentProfile, onChange = vi.fn()) {
  flushSync(() => root.render(
    <TooltipProvider>
      <AgentAutoAssignmentFields value={value} onChange={onChange} />
    </TooltipProvider>,
  ));
  return onChange;
}

function type(label: string, text: string) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
}

function select(label: string, value: string) {
  const element = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  element.value = value;
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("AgentAutoAssignmentFields", () => {
  it("hides the fields until enabled and turns assignment on", () => {
    const onChange = render({ enabled: false, capabilities: [] });
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector("select")).toBeNull();
    container.querySelector<HTMLButtonElement>("[role=switch]")!.click();
    expect(onChange).toHaveBeenCalledWith({ enabled: true, capabilities: [] });
  });

  it("saves capabilities as tags and sets or clears quality", () => {
    const onChange = render({ enabled: true, capabilities: ["sql"], quality: 2 });
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Capabilities"]')!.value).toBe("sql");
    type("Capabilities", "SQL, Frontend , ,docs");
    expect(onChange).toHaveBeenLastCalledWith({ enabled: true, capabilities: ["sql", "frontend", "docs"], quality: 2 });
    select("Quality", "5");
    expect(onChange).toHaveBeenLastCalledWith({ enabled: true, capabilities: ["sql"], quality: 5 });
    select("Quality", "");
    expect(onChange).toHaveBeenLastCalledWith({ enabled: true, capabilities: ["sql"] });
  });
});
