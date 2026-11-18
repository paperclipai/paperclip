// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DifficultyRoutingConfig } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AgentDifficultyRoutingFields } from "./AgentDifficultyRoutingFields";

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

const efforts = (model: string) => model === "big"
  ? [{ id: "", label: "Auto" }, { id: "low", label: "Low" }, { id: "max", label: "Max" }]
  : [{ id: "", label: "Auto" }, { id: "low", label: "Low" }];

function render(value: DifficultyRoutingConfig, onChange = vi.fn()) {
  flushSync(() => root.render(
    <TooltipProvider>
      <AgentDifficultyRoutingFields value={value} onChange={onChange}
        models={[{ id: "big", label: "Big" }, { id: "small", label: "Small" }]} agentModel="small" effortOptionsForModel={efforts} />
    </TooltipProvider>,
  ));
  return onChange;
}

function select(label: string, value: string) {
  const element = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  element.value = value;
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("AgentDifficultyRoutingFields", () => {
  it("hides tier rows until enabled and turns routing on", () => {
    const onChange = render({ enabled: false, tiers: {} });
    expect(container.querySelectorAll("select")).toHaveLength(0);
    container.querySelector<HTMLButtonElement>("[role=switch]")!.click();
    expect(onChange).toHaveBeenCalledWith({ enabled: true, tiers: {} });
  });

  it("edits a tier and drops an effort the new model does not support", () => {
    const onChange = render({ enabled: true, tiers: { L3: { model: "big", effort: "max" } } });
    expect(container.querySelectorAll("select")).toHaveLength(8);
    select("L1 (Simple) effort", "low");
    expect(onChange).toHaveBeenLastCalledWith({ enabled: true, tiers: { L1: { effort: "low" }, L3: { model: "big", effort: "max" } } });
    select("L3 (Hard) model", "small");
    expect(onChange).toHaveBeenLastCalledWith({ enabled: true, tiers: { L3: { model: "small" } } });
    select("Escalation model", "big");
    expect(onChange).toHaveBeenLastCalledWith({ enabled: true, tiers: { L3: { model: "big", effort: "max" } }, escalation: { model: "big" } });
  });
});
