// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { HarnessPoolMemberV2 } from "@paperclipai/shared";
import { AgentRuntimeConfigSections } from "./AgentRuntimeConfigSections";
import { HarnessPoolRuntimeFields } from "./ai-connections/HarnessPoolRuntimeFields";
import { TooltipProvider } from "./ui/tooltip";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
afterEach(() => document.body.replaceChildren());
const cases = [
  { harness: "claude_code", runner: "legacy", adapter: "claude_local", profile: { provider: "acpx", acpxAgent: "claude" }, settings: { engine: "auto", permissionMode: "deny-all", mode: "oneshot" }, labels: ["Execution engine", "ACP permissions", "ACP session mode", "Skip permissions"] },
  { harness: "codex", runner: "legacy", adapter: "codex_local", profile: { provider: "codex" }, settings: { engine: "auto", fastMode: true }, labels: ["Execution engine", "ACP session mode", "Fast mode", "Bypass sandbox"] },
  { harness: "claude_code", runner: "paperclip", adapter: "paperclip_runner", profile: { provider: "acpx", acpxAgent: "claude" }, settings: { acpxPermissionMode: "approve-reads", lifecycleMode: "warm" }, labels: ["Permission mode", "Runner lifecycle"] },
  { harness: "codex", runner: "paperclip", adapter: "paperclip_runner", profile: { provider: "codex" }, settings: { lifecycleMode: "warm" }, labels: ["Runner lifecycle"] },
] as const;
it.each(cases)("reuses actual $adapter controls and Run Policy disclosure for $harness $runner", async test => {
  const initial = { id: "member", harness: { type: test.harness }, runner: test.runner, model: "gpt-6.1-sol", adapterConfig: { ...test.settings, timeoutSec: 12 } } as Omit<HarnessPoolMemberV2, "connection">;
  let direct: Record<string, unknown> = {}, member = initial;
  function Form() {
    const [config, setConfig] = useState<Record<string, unknown>>({ ...initial.adapterConfig, ...test.profile, model: initial.model });
    const [poolMember, setMember] = useState(initial);
    direct = config; member = poolMember;
    return <TooltipProvider>
      <div data-side="direct"><AgentRuntimeConfigSections fieldProps={{ mode: "edit", isCreate: false, adapterType: test.adapter, config, values: null, set: null, models: [], hideModel: true, hideRunnerHarness: true, hideInstructionsFile: true, eff: (_group, _key, fallback) => fallback, mark: (_group, key, value) => setConfig(previous => ({ ...previous, [key]: value })) }} /></div>
      <div data-side="pool"><HarnessPoolRuntimeFields member={poolMember} onChange={patch => setMember(previous => ({ ...previous, ...patch }))} /></div>
    </TooltipProvider>;
  }
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<Form />));
    const sides = [host.querySelector('[data-side="direct"]')!, host.querySelector('[data-side="pool"]')!];
    for (const side of sides) {
      const disclosure = [...side.querySelectorAll("button")].find(button => button.textContent?.trim() === "Advanced Run Policy")!;
      expect(disclosure.getAttribute("aria-expanded")).toBe("false");
      await act(async () => disclosure.click());
      expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    }
    function control(side: Element, label: string) {
      const input = side.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
      expect(input, label).toBeTruthy();
      return { tag: input.tagName, role: input.getAttribute("role"), className: input.className, text: input.textContent, value: input instanceof HTMLInputElement || input instanceof HTMLSelectElement ? input.value : null, checked: input.getAttribute("aria-checked") };
    }
    for (const label of [...test.labels, "Timeout (sec)", "Interrupt grace period (sec)"]) expect(control(sides[1]!, label)).toEqual(control(sides[0]!, label));
    const pool = sides[1]!;
    expect(pool.textContent).not.toContain("ACP state directory");
    expect(pool.textContent).not.toContain("Local Claude skills and plugins");
    if (test.harness === "claude_code" && test.runner === "legacy") {
      const advanced=[...pool.querySelectorAll("button")].find(button=>button.textContent?.trim()==="Advanced")!;
      await act(async()=>advanced.click());
      expect(pool.textContent).toContain("Local Claude skills and plugins");
    }
    expect(pool.textContent).not.toContain("ACP server command");
    expect(pool.querySelector('[aria-label="Harness"]')).toBeNull();
    expect(pool.querySelector('[aria-label="Model"]')).toBeNull();
    expect([...pool.querySelectorAll("button")].some(button => button.textContent?.trim() === "Advanced")).toBe(test.harness === "claude_code" && test.runner === "legacy");
    if (test.harness === "codex" && test.runner === "legacy") expect(pool.textContent).toContain("Fast mode consumes credits/tokens much faster");
    for (const side of sides) {
      const timeout = side.querySelector<HTMLInputElement>('[aria-label="Timeout (sec)"]')!;
      await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(timeout, "33"); timeout.dispatchEvent(new Event("input", { bubbles: true })); });
    }
    expect(direct.timeoutSec).toBe(33); expect(member.adapterConfig?.timeoutSec).toBe(33);
    expect(member.model).toBe(initial.model); expect(member.adapterConfig).not.toHaveProperty("provider"); expect(member.adapterConfig).not.toHaveProperty("model");
  } finally { await act(async () => root.unmount()); host.remove(); }
});
