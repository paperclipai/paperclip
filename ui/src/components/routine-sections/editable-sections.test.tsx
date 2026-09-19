// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoutineDetail, RoutineTrigger } from "@paperclipai/shared";
import { BreadcrumbProvider } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { TriggersSection } from "./editable-sections";
import { RoutineDetailContext, type RoutineDetailContextValue, type SecretMessage } from "./context";

const api = vi.hoisted(() => ({ get: vi.fn(), createTrigger: vi.fn(), updateTrigger: vi.fn() }));
vi.mock("@/api/routines", () => ({ routinesApi: api }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false, setSidebarOpen: vi.fn() }) }));
vi.mock("../MarkdownEditor", () => ({ MarkdownEditor: () => null }));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let routine: RoutineDetail;
function button(label: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label);
  if (!found) throw new Error(`Button not found: ${label}`);
  return found;
}
async function click(label: string) { await act(async () => button(label).click()); }
async function choose(label: string) {
  const option = [...container.querySelectorAll("label")].find((item) => item.textContent?.includes(label));
  expect(option).toBeTruthy();
  await act(async () => option!.click());
}
function Harness({ secretMessage, contextRoutine }: { secretMessage?: SecretMessage; contextRoutine?: RoutineDetail }) {
  const { data } = useQuery({ queryKey: queryKeys.routines.detail(routine.id), queryFn: api.get });
  const value = { routine: contextRoutine ?? data ?? routine, routineId: routine.id, companyId: routine.companyId, secretMessage, setSecretMessage: vi.fn() } as unknown as RoutineDetailContextValue;
  return <RoutineDetailContext.Provider value={value}><TriggersSection /></RoutineDetailContext.Provider>;
}
async function render(secretMessage?: SecretMessage, contextRoutine?: RoutineDetail) {
  await act(async () => root.render(<MemoryRouter initialEntries={["/routines/routine-1/triggers"]}>
    <QueryClientProvider client={client}><BreadcrumbProvider><Harness secretMessage={secretMessage} contextRoutine={contextRoutine} /></BreadcrumbProvider></QueryClientProvider>
  </MemoryRouter>));
}
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  routine = { id: "routine-1", companyId: "company-1", title: "Verify deployment", status: "active", triggers: [] } as unknown as RoutineDetail;
  api.get.mockImplementation(async () => routine);
  api.createTrigger.mockImplementation(async (_id, input) => {
    const trigger = { id: "trigger-1", enabled: true, webhookUrl: "https://paperclip.example/api/routine-triggers/public/0123456789abcdef01234567/fire", ...input } as RoutineTrigger;
    routine = { ...routine, triggers: [...routine.triggers, trigger] };
    return { trigger, secretMaterial: { webhookUrl: trigger.webhookUrl, webhookSecret: "one-time-secret" } };
  });
  api.updateTrigger.mockImplementation(async (id, patch) => {
    routine = { ...routine, triggers: routine.triggers.map((trigger) => trigger.id === id ? { ...trigger, ...patch } : trigger) };
    return routine.triggers.find((trigger) => trigger.id === id);
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
});

describe("TriggersSection", () => {
  it("offers schedule and webhook choices before creating a trigger", async () => {
    await render();
    await click("Add trigger");
    expect(button("Continue").disabled).toBe(true);
    expect(container.textContent).toContain("On a schedule");
    await choose("When another app sends a webhook");
    expect(button("Continue").disabled).toBe(false);
    expect(api.createTrigger).not.toHaveBeenCalled();
  });

  it("creates a pending webhook, shows credentials, and activates only when setup finishes", async () => {
    await render();
    await click("Add trigger");
    await choose("When another app sends a webhook");
    await click("Continue");
    expect(api.createTrigger).toHaveBeenCalledWith("routine-1", { kind: "webhook", signingMode: "bearer", setupPending: true });
    expect(container.textContent).toContain("Bearer one-time-secret");
    expect(button("Copy for your agent")).toBeTruthy();
    expect(JSON.stringify(Object.values(sessionStorage))).not.toContain("one-time-secret");
    await click("Check connection");
    expect(container.textContent).toContain("This won’t start the routine");
    expect(api.updateTrigger).not.toHaveBeenCalled();
    await click("Finish without checking");
    expect(api.updateTrigger).toHaveBeenCalledWith("trigger-1", { setupPending: false });
    expect(button("Add trigger")).toBeTruthy();
    expect(container.textContent).not.toContain("one-time-secret");
  });

  it("warns about private URLs without blocking webhook setup or completion", async () => {
    routine.triggers = [{ id: "trigger-1", kind: "webhook", enabled: true, setupPending: true, signingMode: "bearer", webhookUrl: "https://paperclip.internal/webhook" }] as RoutineTrigger[];
    await render();
    await click("Resume setup");
    expect(container.textContent).toContain("This webhook URL appears to be private");
    expect(container.querySelector('a[href="https://docs.paperclip.ing/reference/deploy/https/"]')).not.toBeNull();
    expect(button("Check connection").disabled).toBe(false);
    await click("Check connection");
    expect(container.textContent).toContain("This webhook URL appears to be private");
    expect(button("Finish without checking").disabled).toBe(false);
    await click("Finish without checking");
    expect(api.updateTrigger).toHaveBeenCalledWith("trigger-1", { setupPending: false });
    await click("Edit webhook");
    expect(container.textContent).toContain("This webhook URL appears to be private");
  });

  it("shows polled connection results even when routine context is stale", async () => {
    routine.triggers = [{ id: "trigger-1", kind: "webhook", enabled: true, setupPending: true, signingMode: "bearer", webhookUrl: "https://paperclip.example/webhook" }] as RoutineTrigger[];
    await render(undefined, routine);
    await click("Resume setup");
    await click("Check connection");
    expect(container.textContent).toContain("Waiting to verify");
    for (const status of ["rejected", "received"] as const) {
      routine = { ...routine, triggers: [{ ...routine.triggers[0], lastWebhookDelivery: { status, test: true, receivedAt: new Date().toISOString() } }] };
      await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.routines.detail(routine.id) }); });
      await vi.waitFor(() => expect(container.textContent).toContain(status === "received" ? "Authentication passed. No routine run or task was created." : "Go back to Connect your app, update the key"));
    }
    expect(button("Finish setup")).toBeTruthy();
  });

  it("shows restored one-time credentials on the triggers screen", async () => {
    await render({ title: "Webhook key restored", entries: [{ webhookUrl: "https://paperclip.example/webhook", webhookSecret: "restored-secret" }] });
    expect(container.textContent).toContain("restored-secret");
    expect(container.querySelector('[aria-label="Copy Secret key"]')).not.toBeNull();
    expect(button("Done")).toBeTruthy();
  });

  it("creates a schedule on confirmation and starts a fresh wizard afterward", async () => {
    await render();
    await click("Add trigger");
    await choose("On a schedule");
    await click("Continue");
    await click("Review schedule");
    expect(api.createTrigger).not.toHaveBeenCalled();
    await click("Add schedule");
    expect(api.createTrigger).toHaveBeenCalledWith("routine-1", expect.objectContaining({ kind: "schedule", cronExpression: "0 9 * * 1-5" }));
    await click("Add trigger");
    expect(button("Continue").disabled).toBe(true);
  });

  it("blocks saving an invalid custom cron in the inline schedule editor", async () => {
    routine.triggers = [{ id: "schedule-1", kind: "schedule", enabled: true, cronExpression: "0 8-18/2 * * 1-5", timezone: "UTC" }] as RoutineTrigger[];
    await render();
    await click("Edit schedule");
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Cron expression"]')!;
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "0 8-18/2 *");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).toContain("Use exactly 5 fields");
    expect(button("Save schedule").disabled).toBe(true);
    expect(api.updateTrigger).not.toHaveBeenCalled();
  });
});
