// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_OBSERVABILITY_CAPTURE, type AgentObservabilitySettings } from "@paperclipai/shared";
import { i18n, t } from "@/i18n";
import { TooltipProvider } from "./ui/tooltip";
import { AgentObservabilitySettingsView } from "./observability/AgentObservabilitySettings";
import { PromptInjectionPreventionSettingsView } from "./prompt-injection-prevention/PromptInjectionPreventionSettings";
import { AllowedProjectsEditor } from "./AllowedProjectsEditor";
import { choices as allChoices } from "../../storybook/support/decision-models/fixtures";

vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-storybook" }) }));
let root: Root, host: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); await i18n.changeLanguage("en"); vi.unstubAllGlobals(); });
async function render(node: ReactNode) { await act(async () => root.render(<MemoryRouter><TooltipProvider>{node}</TooltipProvider></MemoryRouter>)); }
async function locale(language: string) { await act(async () => { await i18n.changeLanguage(language); }); }
function button(text: string) { const node = [...host.querySelectorAll<HTMLButtonElement>("button")].find(n => n.textContent === text); expect(node, text).toBeDefined(); return node!; }
async function click(node: HTMLElement) { await act(async () => node.click()); }
async function fill(node: HTMLInputElement, value: string) { await act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
  node.dispatchEvent(new Event("input", { bubbles: true }));
}); }

it("keeps an OTLP draft and reactive validation without replaying save/test/remove on EN/RU/EN", async () => {
  const settings: AgentObservabilitySettings = {
    companyId: "10000000-0000-4000-8000-000000000001", revision: "20000000-0000-4000-8000-000000000001",
    enabled: false, destination: { provider: "otlp", endpointBaseUrl: "https://collector.example/otel" },
    capture: { ...DEFAULT_AGENT_OBSERVABILITY_CAPTURE }, credentialsConfigured: true, headerNames: ["authorization"], updatedAt: "2026-10-19T12:00:00Z", lastTest: null,
  };
  const onSave = vi.fn(), onTest = vi.fn(), onRemove = vi.fn();
  await render(<AgentObservabilitySettingsView companyId={settings.companyId} settings={settings} onSave={onSave} onTest={onTest} onRemove={onRemove} />);
  const endpoint = host.querySelector<HTMLInputElement>("#agent-observability-endpoint")!;
  const secret = host.querySelector<HTMLInputElement>('input[type="password"]')!;
  await fill(endpoint, "https://new-collector.example/otel");
  await click(button("Save changes"));
  for (const language of ["ru", "en", "ru"]) {
    await locale(language);
    expect(host.querySelector("#agent-observability-endpoint")).toBe(endpoint);
    expect(endpoint.value).toBe("https://new-collector.example/otel");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(t("oct26Settings.observability.freshHeaders"));
    expect(secret.getAttribute("aria-label")).toBe(t("oct26Settings.observability.headerValueFor", { name: "authorization" }));
  }
  await fill(secret, "synthetic-{{RAW}}-credential");
  await locale("en");
  expect(host.querySelector('input[type="password"]')).toBe(secret);
  expect(secret.value).toBe("synthetic-{{RAW}}-credential");
  expect(onSave).not.toHaveBeenCalled(); expect(onTest).not.toHaveBeenCalled(); expect(onRemove).not.toHaveBeenCalled();
  await click(button("Save changes"));
  expect(onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    expectedRevision: settings.revision, destination: { provider: "otlp", endpointBaseUrl: "https://new-collector.example/otel" },
    credentials: { mode: "replace", headers: [{ name: "authorization", value: "synthetic-{{RAW}}-credential" }] },
  }));
});

it("retains a model draft and raw provider diagnostics without replaying connection effects", async () => {
  const choices = allChoices.filter(c => c.provider === "openrouter");
  const settings = { companyId: "company-storybook", enabled: true, connectionId: choices[0]!.id, grantId: choices[0]!.grantId, model: "raw/model" };
  const onSave = vi.fn(), onTest = vi.fn(), onDraftChange = vi.fn(), onConnectionChange = vi.fn();
  await render(<PromptInjectionPreventionSettingsView settings={settings} choices={choices} error="Provider {{RAW}} diagnostic" onSave={onSave} onTest={onTest} onDraftChange={onDraftChange} onConnectionChange={onConnectionChange} />);
  const input = host.querySelector<HTMLInputElement>("input[list]")!;
  await fill(input, "draft/{{MODEL}}");
  const drafts = onDraftChange.mock.calls.length, connections = onConnectionChange.mock.calls.length;
  for (const language of ["ru", "en", "ru", "en"]) {
    await locale(language);
    expect(host.querySelector("input[list]")).toBe(input); expect(input.value).toBe("draft/{{MODEL}}");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Provider {{RAW}} diagnostic");
    expect(host.textContent).toContain(t("oct26Settings.injection.description"));
    expect(onDraftChange).toHaveBeenCalledTimes(drafts); expect(onConnectionChange).toHaveBeenCalledTimes(connections);
    expect(onSave).not.toHaveBeenCalled(); expect(onTest).not.toHaveBeenCalled();
  }
  await click(button("Save prompt injection settings"));
  expect(onSave).toHaveBeenCalledExactlyOnceWith({ enabled: true, connectionId: settings.connectionId, grantId: settings.grantId, model: "draft/{{MODEL}}" });
});

it("keeps project selections and a local save failure reactive without replaying a mutation", async () => {
  const save = vi.fn().mockRejectedValue(null);
  await render(<AllowedProjectsEditor projects={[{ id: "project-raw", name: "Project {{RAW}}" }]} projectIds={[]} canManage agentName="Agent {{RAW}}" onSave={save} />);
  await click(button("Add project"));
  await click(document.querySelector<HTMLElement>('[role="checkbox"][aria-label="Project {{RAW}}"]')!);
  await click([...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "Done")!);
  await click(button("Save project access"));
  for (const language of ["ru", "en", "ru", "en"]) {
    await locale(language);
    expect(host.textContent).toContain("Project {{RAW}}");
    expect(host.textContent).toContain(t("oct26Settings.projects.accessNotice", { count: 1, name: "Agent {{RAW}}" }));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(t("oct26Settings.projects.saveError"));
    expect(button(t("oct26Settings.projects.trySaveAgain")).disabled).toBe(false);
    expect(save).toHaveBeenCalledExactlyOnceWith(["project-raw"]);
  }
});

it.each([[1, "агент"], [2, "агента"], [5, "агентов"], [21, "агент"]])("retains the Russian agent count %i", async (count, noun) => {
  await locale("ru");
  expect(t("oct26Settings.roster.agentCount", { count })).toBe(`${count} ${noun}`);
});
