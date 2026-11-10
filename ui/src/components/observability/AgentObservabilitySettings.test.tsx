// @vitest-environment jsdom
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DEFAULT_AGENT_OBSERVABILITY_CAPTURE, type AgentObservabilitySettings } from "@paperclipai/shared";
import { AgentObservabilitySettingsView, type AgentObservabilitySettingsViewProps } from "./AgentObservabilitySettings";

let root: Root, element: HTMLDivElement;
const saved: AgentObservabilitySettings = {
  companyId: "10000000-0000-4000-8000-000000000001", revision: "20000000-0000-4000-8000-000000000001",
  enabled: false, destination: { provider: "braintrust", projectId: "30000000-0000-4000-8000-000000000001" },
  capture: { ...DEFAULT_AGENT_OBSERVABILITY_CAPTURE }, credentialsConfigured: true, headerNames: ["authorization"], updatedAt: "2026-10-19T12:00:00Z", lastTest: null,
};
const onSave = vi.fn();
const props = (overrides: Partial<AgentObservabilitySettingsViewProps> = {}): AgentObservabilitySettingsViewProps => ({ companyId: saved.companyId, settings: saved, onSave, onTest: vi.fn(), onRemove: vi.fn(), ...overrides });
async function render(value: AgentObservabilitySettingsViewProps) {
  // Company changes erase credential drafts in an effect; settle its updates
  // before inspecting the new company's controls.
  await act(async () => root.render(<TooltipProvider><AgentObservabilitySettingsView {...value} /></TooltipProvider>));
}
function button(text: string) { return [...element.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === text)!; }
function fill(selector: string, value: string) {
  const input = element.querySelector<HTMLInputElement>(selector)!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function click(node: HTMLElement) { act(() => node.click()); }
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); element = document.createElement("div"); document.body.append(element); root = createRoot(element); onSave.mockReset(); });
afterEach(() => { act(() => root.unmount()); element.remove(); vi.unstubAllGlobals(); });
it("keeps saved credentials write-only and erases a cancelled replacement", async () => {
  await render(props()); expect(element.querySelector('input[type="password"]')).toBeNull();
  click(button("Replace API key")); fill('input[type="password"]', "secret-input-canary");
  click(button("Cancel")); expect(element.querySelector('input[type="password"]')).toBeNull();
  expect(onSave).not.toHaveBeenCalled(); expect(element.innerHTML).not.toContain("secret-input-canary");
});
it("retains the saved key when enabling and includes the saved revision", async () => {
  await render(props()); click(element.querySelector('[role="switch"][aria-label="Enable export"]')!); click(button("Save changes"));
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: saved.revision, enabled: true, credentials: { mode: "keep" } }));
});
it("can disable export after the saved key has been removed", async () => {
  await render(props({ settings: { ...saved, enabled: true, credentialsConfigured: false } }));
  click(button("Disable export"));
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: saved.revision, enabled: false, credentials: { mode: "keep" } }));
});
it("sends a complete custom header set without fetching retained values", async () => {
  const custom: AgentObservabilitySettings = { ...saved, destination: { provider: "otlp", endpointBaseUrl: "https://collector.example/otel" }, headerNames: ["authorization", "x-remove"] };
  await render(props({ settings: custom })); click(element.querySelector('button[aria-label="Remove x-remove"]')!); click(button("Save changes"));
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ credentials: { mode: "replace", headers: [{ name: "authorization" }] } }));
});
it("preserves an unsaved secret on conflict, prevents resubmission, then clears on reload", async () => {
  const reload = vi.fn(); await render(props()); click(button("Replace API key")); fill('input[type="password"]', "draft-secret-canary");
  await render(props({ conflict: true, error: "Another administrator changed these settings", onReload: reload }));
  expect(element.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("draft-secret-canary");
  expect(button("Save changes").disabled).toBe(true); click(button("Reload saved settings")); expect(reload).toHaveBeenCalledOnce();
  expect(element.querySelector('input[type="password"]')).toBeNull();
});
it("preserves a draft when a background read finds another administrator's revision", async () => {
  await render(props()); click(button("Replace API key")); fill('input[type="password"]', "background-draft-canary");
  fill('#agent-observability-project', "30000000-0000-4000-8000-000000000002");
  const newer = { ...saved, revision: "20000000-0000-4000-8000-000000000002", enabled: true };
  await render(props({ settings: newer }));
  expect(element.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("background-draft-canary");
  expect(element.querySelector<HTMLInputElement>('#agent-observability-project')!.value).toBe("30000000-0000-4000-8000-000000000002");
  expect(button("Save changes").disabled).toBe(true);
  expect(element.textContent).toContain("Another administrator changed these settings");
  click(button("Reload saved settings"));
  expect(element.querySelector('input[type="password"]')).toBeNull();
  expect(element.querySelector<HTMLInputElement>('#agent-observability-project')!.value).toBe(saved.destination.provider === "braintrust" ? saved.destination.projectId : "");
  expect(element.querySelector('[role="switch"]')!.getAttribute("aria-checked")).toBe("true");
});
it("erases entered credentials after an explicitly accepted save", async () => {
  await render(props({ resetKey: 0 })); click(button("Replace API key")); fill('input[type="password"]', "saved-draft-canary");
  click(button("Save changes")); expect(onSave).toHaveBeenCalledOnce();
  await render(props({ settings: { ...saved, revision: "20000000-0000-4000-8000-000000000003" }, resetKey: 1 }));
  expect(element.querySelector('input[type="password"]')).toBeNull();
  expect(element.textContent).not.toContain("Another administrator");
});
it("requires re-entry of saved custom headers when the endpoint origin changes", async () => {
  const custom: AgentObservabilitySettings = { ...saved, destination: { provider: "otlp", endpointBaseUrl: "https://collector.example/otel" }, headerNames: ["authorization"] };
  await render(props({ settings: custom }));
  fill('#agent-observability-endpoint', "https://another.example/otel"); click(button("Save changes"));
  expect(onSave).not.toHaveBeenCalled(); expect(element.textContent).toContain("Re-enter every header value");
  fill('input[type="password"]', "new-origin-credential"); click(button("Save changes"));
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ credentials: { mode: "replace", headers: [{ name: "authorization", value: "new-origin-credential" }] } }));
});
it("erases the previous company draft and receipt when company changes", async () => {
  await render(props()); click(button("Replace API key")); fill('input[type="password"]', "old-company-secret-canary");
  await render(props({ companyId: "another-company", settings: null }));
  expect(element.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
  expect(element.querySelector<HTMLInputElement>('#agent-observability-project')!.value).toBe("");
  expect(element.querySelector('[role="switch"]')!.getAttribute("aria-checked")).toBe("false");
});
it("hides form controls without management access", async () => {
  await render(props({ canManage: false, settings: null })); expect(element.querySelector("input")).toBeNull(); expect(element.textContent).toContain("Manage connections permission is required");
});
