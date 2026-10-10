// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@/api/client";
import { decisionModelsApi } from "@/api/decision-models";
import { DecisionModelSettingsSection, DecisionModelSettingsView } from "./DecisionModelSettings";
import { choices, configured, result } from "../../../storybook/stories/decision-models/fixtures";

vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-storybook" }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("consumes an added connection once and preserves a later choice across refetches", async () => {
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container), onSave = vi.fn();
  const settings = { ...configured, allowBackground: false };
  const render = (refreshed = false) => <MemoryRouter><DecisionModelSettingsView settings={{ ...settings }}
    choices={choices.map(row => ({ ...row, name: refreshed ? `${row.name} refreshed` : row.name }))}
    newlyConnectedId={choices[0]!.id} onSave={onSave} onTest={vi.fn()} onAdd={vi.fn()} /></MemoryRouter>;
  try {
    await act(async () => root.render(render()));
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent?.includes("Company OpenRouter"))!.click());
    await act(async () => root.render(render(true)));
    expect(container.querySelector('[aria-pressed="true"]')?.textContent).toContain("Company OpenRouter refreshed");
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Save decision model")!.click());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ connectionId: choices[1]!.id, grantId: choices[1]!.grantId, allowBackground: false }));
  } finally { act(() => root.unmount()); container.remove(); }
});

it("clears test feedback when another manager changes the saved configuration", async () => {
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const key = ["decision-model", configured.companyId];
  client.setQueryData(key, { canManage: true, settings: configured, choices });
  const test = vi.spyOn(decisionModelsApi, "test").mockResolvedValue(result);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter>
      <DecisionModelSettingsSection companyId={configured.companyId} />
    </MemoryRouter></QueryClientProvider>));
    await act(async () => {
      [...container.querySelectorAll("button")].find(button => button.textContent === "Run test")!.click();
      await new Promise(resolve => setTimeout(resolve, 10));
    });
    expect(container.textContent).toContain("Decision model is working");
    await act(async () => {
      client.setQueryData(key, { canManage: true, settings: { ...configured, enabled: false }, choices });
      await new Promise(resolve => setTimeout(resolve, 10));
    });
    expect(container.textContent).not.toContain("Decision model is working");
    await act(async () => {
      client.setQueryData(key, { canManage: true, settings: configured, choices });
      await new Promise(resolve => setTimeout(resolve, 10));
    });
    expect(container.textContent).not.toContain("Decision model is working");
  } finally { act(() => root.unmount()); client.clear(); test.mockRestore(); container.remove(); }
});

it("keeps loaded decision settings on screen when a refetch fails transiently", async () => {
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const key = ["decision-model", configured.companyId];
  client.setQueryData(key, { canManage: true, settings: configured, choices });
  const settings = vi.spyOn(decisionModelsApi, "settings").mockRejectedValue(
    new ApiError("Paperclip is restarting.", 503, { error: "tenant_app_unavailable" }),
  );
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter>
      <DecisionModelSettingsSection companyId={configured.companyId} />
    </MemoryRouter></QueryClientProvider>));
    expect(container.textContent).toContain("Enable decisions");
    await act(async () => {
      await client.invalidateQueries({ queryKey: key });
      await new Promise(resolve => setTimeout(resolve, 10));
    });
    expect(settings).toHaveBeenCalled();
    expect(container.textContent).toContain("Enable decisions");
    expect(container.querySelector('[data-query-view="error"]')).toBeNull();
    expect(container.textContent).not.toContain("Paperclip is restarting.");
    expect(container.textContent).not.toContain("tenant_app_unavailable");
  } finally { act(() => root.unmount()); client.clear(); settings.mockRestore(); container.remove(); }
});

it("shows readable copy and Retry when decision settings fail to load", async () => {
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const settings = vi.spyOn(decisionModelsApi, "settings")
    .mockRejectedValueOnce(new ApiError("Boom", 500, { error: "Boom" }))
    .mockResolvedValue({ canManage: true, settings: configured, choices });
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter>
      <DecisionModelSettingsSection companyId={configured.companyId} />
    </MemoryRouter></QueryClientProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(container.querySelector('[data-query-view="error"]')).not.toBeNull();
    expect(container.textContent).toContain("Couldn't load decision settings");
    expect(container.textContent).not.toContain("Enable decisions");
    const retry = [...container.querySelectorAll("button")].find(button => button.textContent === "Retry");
    expect(retry, "Retry button").toBeTruthy();
    await act(async () => {
      retry!.click();
      await new Promise(resolve => setTimeout(resolve, 10));
    });
    expect(container.textContent).toContain("Enable decisions");
    expect(container.querySelector('[data-query-view="error"]')).toBeNull();
  } finally { act(() => root.unmount()); client.clear(); settings.mockRestore(); container.remove(); }
});
