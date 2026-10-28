// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { PROMPT_INJECTION_DEFAULT_MODEL, type PromptInjectionPreventionSettings, type PromptInjectionTestResult } from "@paperclipai/shared";
import { PromptInjectionPreventionSettingsSection, PromptInjectionPreventionSettingsView } from "./PromptInjectionPreventionSettings";
import { choices as allChoices } from "../../../storybook/support/decision-models/fixtures";
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-storybook" }) }));
const api = vi.hoisted(() => ({ settings: vi.fn(), models: vi.fn(), update: vi.fn(), test: vi.fn() }));
vi.mock("@/api/prompt-injection-prevention", () => ({ promptInjectionPreventionApi: api }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const choices = allChoices.filter(c => c.provider === "openrouter");
const empty: PromptInjectionPreventionSettings = { companyId: "company-storybook", enabled: false, connectionId: null, grantId: null, model: PROMPT_INJECTION_DEFAULT_MODEL };
const configured = { ...empty, enabled: true, connectionId: choices[0]!.id, grantId: choices[0]!.grantId };
const passed: PromptInjectionTestResult = { passed: true, samples: [] };
async function mount(settings = empty, available = choices, result: PromptInjectionTestResult | null = null) {
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const onSave = vi.fn(), onTest = vi.fn(), onDraftChange = vi.fn();
  const render = async (next = settings, nextChoices = available, error: string | null = null) => act(async () => root.render(<MemoryRouter><PromptInjectionPreventionSettingsView settings={next} choices={nextChoices} result={result} error={error} onSave={onSave} onTest={onTest} onDraftChange={onDraftChange} /></MemoryRouter>));
  await render();
  return { container, render, onSave, onTest, onDraftChange,
    click: async (label: string) => act(async () => { [...container.querySelectorAll("button")].find(b => b.textContent?.includes(label))!.click(); }),
    close: () => { act(() => root.unmount()); container.remove(); } };
}
it("prefills the default, keeps drafts on refetch/failure, and persists only after Save", async () => {
  const f = await mount(); try {
    await f.click("Company OpenRouter"); expect(f.onSave).not.toHaveBeenCalled();
    expect(f.container.querySelector<HTMLInputElement>("input[list]")?.value).toBe(PROMPT_INJECTION_DEFAULT_MODEL);
    await f.render({ ...empty }, choices, "Save failed");
    expect(f.container.textContent).toContain("Save failed"); expect(f.container.textContent).toContain("Save changes before testing");
    await f.click("Save prompt injection settings"); expect(f.onSave).toHaveBeenCalledWith({ enabled: true, connectionId: choices[0]!.id, grantId: choices[0]!.grantId, model: PROMPT_INJECTION_DEFAULT_MODEL });
    await f.render({ ...configured }); expect(f.container.textContent).not.toContain("Save changes before testing");
  } finally { f.close(); }
});
it("preserves a custom model across connection switches and clears previous test results on edits", async () => {
  const second = { ...choices[0]!, id: "10000000-0000-4000-8000-000000000009", grantId: "20000000-0000-4000-8000-000000000009", name: "Second OpenRouter" };
  const f = await mount({ ...configured, model: "custom/model" }, [...choices, second], passed); try {
    expect(f.container.textContent).toContain("Both model checks passed");
    const before = f.onDraftChange.mock.calls.length;
    await f.click("Second OpenRouter");
    expect(f.container.querySelector<HTMLInputElement>("input[list]")?.value).toBe("custom/model");
    expect(f.container.textContent).not.toContain("Both model checks passed"); expect(f.onDraftChange.mock.calls.length).toBeGreaterThan(before);
    await f.click("Save prompt injection settings"); expect(f.onSave.mock.calls[0][0].model).toBe("custom/model");
    await f.render({ ...empty, companyId: "other-company" }); expect(f.container.textContent).not.toContain("Save changes before testing");
  } finally { f.close(); }
});
it("can disable or clear a deleted connection without selecting a replacement", async () => {
  const f = await mount(configured, []); try {
    expect(f.container.textContent).toContain("saved connection is unavailable");
    const toggle = f.container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    await act(async () => toggle.click()); await f.click("Save prompt injection settings");
    expect(f.onSave.mock.calls[0][0]).toMatchObject({ enabled: false, connectionId: configured.connectionId });
    await f.click("Clear selection"); await f.click("Save prompt injection settings");
    expect(f.onSave.mock.calls[1][0]).toMatchObject({ enabled: false, connectionId: null, grantId: null });
  } finally { f.close(); }
});
it("renders provider fallback as a failed model test", async () => {
  const f = await mount(configured, choices, { passed: false, samples: [{ name: "Benign", expectedViolation: false, actualViolation: null, passed: false, durationMs: 10000, reason: "timeout" }] });
  try { expect(f.container.querySelector('[role="alert"]')?.textContent).toContain("Model checks did not pass"); expect(f.container.textContent).toContain("built-in detection is the fallback"); } finally { f.close(); }
});

it("recovers from a settings load error without hiding the retry action", async () => {
  const container = document.createElement("div"), root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let rejectLoad!: (reason: Error) => void;
  api.settings.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectLoad = reject; }));
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter><PromptInjectionPreventionSettingsSection companyId={empty.companyId} /></MemoryRouter></QueryClientProvider>));
    expect(container.textContent).toContain("Loading prompt injection settings");
    await act(async () => { rejectLoad(new Error("offline")); await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not load");
    api.settings.mockResolvedValueOnce({ canManage: true, settings: empty, choices: [] });
    await act(async () => { [...container.querySelectorAll("button")].find(b => b.textContent === "Try again")!.click(); await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(container.textContent).toContain("Add a shared OpenRouter API connection");
  } finally { act(() => root.unmount()); client.clear(); }
});

it("keeps a selected draft after an API save failure and allows retry", async () => {
  const container = document.createElement("div"), root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["prompt-injection-prevention", empty.companyId], { canManage: true, settings: empty, choices });
  api.settings.mockResolvedValue({ canManage: true, settings: empty, choices });
  api.models.mockResolvedValue([]);
  api.update.mockRejectedValueOnce(new Error("Save unavailable"));
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter><PromptInjectionPreventionSettingsSection companyId={empty.companyId} /></MemoryRouter></QueryClientProvider>));
    const click = async (label: string) => act(async () => { [...container.querySelectorAll("button")].find(b => b.textContent?.includes(label))!.click(); await new Promise(resolve => setTimeout(resolve, 20)); });
    await click("Company OpenRouter");
    await click("Save prompt injection settings");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Save unavailable");
    expect(container.querySelector<HTMLInputElement>("input[list]")?.value).toBe(PROMPT_INJECTION_DEFAULT_MODEL);
    expect(container.textContent).toContain("Save changes before testing");
    api.update.mockResolvedValueOnce(configured);
    await click("Save prompt injection settings");
    expect(client.getQueryData(["prompt-injection-prevention", empty.companyId])).toMatchObject({ settings: configured });
    expect(container.textContent).not.toContain("Save changes before testing");
  } finally { act(() => root.unmount()); client.clear(); }
});
