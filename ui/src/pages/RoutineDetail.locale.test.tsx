// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { i18n, t } from "@/i18n";
import { ApiError, apiErrorFromResponse } from "../api/api-error";
import { describeError } from "../api/errors";
import { describeUiError, localizeUiError } from "../lib/localized-ui-error";
import { ToastProvider, useToastState, type ToastItem } from "../context/ToastContext";
import { ToastViewport } from "../components/ToastViewport";
import { RoutineDetail } from "./RoutineDetail";
import { RoutineDetail as ProductionRoutineDetail } from "./RoutineDetail.production";

// Retain real mutation hooks/callbacks and toast delivery, while holding reads
// loading so unrelated section editors do not mount.
const harness = vi.hoisted(() => ({
  mutations: [] as { mutateAsync: (input?: unknown) => Promise<unknown> }[],
  operation: vi.fn(), setBreadcrumbs: vi.fn(),
}));
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...actual, useQuery: () => ({ data: undefined }),
    useMutation: (...args: Parameters<typeof actual.useMutation>) => {
      const mutation = actual.useMutation(...args);
      harness.mutations.push(mutation);
      return mutation;
    },
  };
});
vi.mock("../api/routines", () => ({ routinesApi: {
  update: (...args: unknown[]) => harness.operation(...args),
  run: (...args: unknown[]) => harness.operation(...args),
  createTrigger: (...args: unknown[]) => harness.operation(...args),
  updateTrigger: (...args: unknown[]) => harness.operation(...args),
  deleteTrigger: (...args: unknown[]) => harness.operation(...args),
  rotateTriggerSecret: (...args: unknown[]) => harness.operation(...args),
} }));
vi.mock("@/lib/router", async () => await import("react-router-dom"));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "raw-company" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: harness.setBreadcrumbs }) }));
vi.mock("../hooks/useStreamlinedUiEnabled", () => ({ useStreamlinedUiEnabled: () => ({ enabled: true }) }));
vi.mock("../components/QueryView", () => ({ useQueryView: () => ({ kind: "loading" }), QueryErrorState: () => null }));
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 0));
vi.stubGlobal("cancelAnimationFrame", clearTimeout);
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
let host: HTMLDivElement;
let stored: ToastItem[];
function ObserveToasts() { stored = useToastState(); return null; }
let Page = RoutineDetail;
async function mount() {
  vi.useFakeTimers();
  await i18n.changeLanguage("en");
  harness.mutations.length = 0;
  harness.operation.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  await act(async () => root.render(
    <QueryClientProvider client={client}><MemoryRouter initialEntries={["/routines/raw-routine"]}>
      <ToastProvider><Routes><Route path="/routines/:routineId" element={<Page />} /></Routes>
        <ObserveToasts /><ToastViewport />
      </ToastProvider>
    </MemoryRouter></QueryClientProvider>,
  ));
}
afterEach(async () => {
  await act(async () => root?.unmount()); client?.clear(); document.body.innerHTML = "";
  vi.useRealTimers(); await i18n.changeLanguage("en");
});
const operations = [
  [1, "save", "failedToSaveRoutine_34cf35", "saveTheRoutine_0cd92f", undefined],
  [2, "run", "routineRunFailed_296c7c", "startTheRoutineRun_b7d489", undefined],
  [3, "status", "failedToUpdateRoutine_658553", "updateTheRoutine_b91df2", "paused"],
  [4, "create trigger", "failedToAddTrigger_3c4a07", "createTheTrigger_800ccc", undefined],
  [5, "update trigger", "failedToUpdateTrigger_4707ca", "updateTheTrigger_4347d3", { id: "raw-trigger", patch: { label: "Raw label" } }],
  [6, "delete trigger", "failedToDeleteTrigger_86096d", "deleteTheTrigger_03274f", "raw-trigger"],
  [7, "rotate secret", "failedToRotateWebhookSecret_1caaab", "rotateTheWebhookSecret_1c6f8b", "raw-trigger"],
] as const;
describe.each([["standard", RoutineDetail], ["production", ProductionRoutineDetail]] as const)("%s routine toasts", (_name, Component) => {
  beforeEach(() => { Page = Component; });
  for (const kind of ["generic", "localized", "raw"] as const) {
    it.each(operations)(`keeps ${kind} %s/%s errors live without replay or timer reset`, async (index, _name, title, action, input) => {
      await mount();
      const cause = kind === "generic" ? apiErrorFromResponse(new Response("", { status: 403 }), { error: "forbidden" })
        : kind === "localized" ? localizeUiError(new Error("Upload did not return a file URL"), { key: "final-boundary:missingFileUrl" })
        : new Error("Routine run failed"); // Deliberate collision with product copy.
      const original = Object.getOwnPropertyDescriptors(cause);
      harness.operation.mockRejectedValue(cause);
      await act(async () => { await harness.mutations[index].mutateAsync(input).catch(() => {}); });
      expect(stored).toHaveLength(1);
      const item = stored[0]; const node = host.querySelector("li"); const before = node?.textContent;
      expect(node?.textContent).toContain(t(`work:copy.${title}`));
      expect(item.presentation?.error?.cause).toBe(cause);
      const storedCopy = {
        title: t(`work:copy.${title}`),
        body: describeError(cause, { action: t(`work:copy.${action}`) }).body,
        tone: "error",
      };
      expect(item).toMatchObject(storedCopy);
      const calls = harness.operation.mock.calls.slice();
      await act(async () => { vi.advanceTimersByTime(1000); await i18n.changeLanguage("zh-CN"); });
      expect(host.querySelector("li")).toBe(node); expect(stored[0]).toBe(item);
      expect(stored[0]).toMatchObject(storedCopy);
      expect(node?.textContent).toContain(t(`work:copy.${title}`));
      expect(node?.textContent).toContain(describeUiError(cause, { key: `work:copy.${action}` }).body);
      expect(node?.textContent).not.toBe(before);
      if (kind === "raw") expect(node?.textContent).toContain("Routine run failed");
      await act(async () => { await i18n.changeLanguage("en"); });
      expect(node?.textContent).toBe(before); expect(Object.getOwnPropertyDescriptors(cause)).toEqual(original);
      expect(harness.operation.mock.calls).toEqual(calls); expect(harness.operation).toHaveBeenCalledTimes(1);
      // A second identical failure still dedupes after the locale round trip,
      // without replacing the item or extending its original lifetime.
      await act(async () => { await harness.mutations[index].mutateAsync(input).catch(() => {}); });
      expect(harness.operation).toHaveBeenCalledTimes(2);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toBe(item);
      await act(async () => { vi.advanceTimersByTime(item.ttlMs - 1000); });
      expect(stored).toHaveLength(0);
    });
  }
  it("keeps save-conflict copy live instead of substituting a generic error", async () => {
    await mount();
    harness.operation.mockRejectedValue(new ApiError("Raw revision conflict", 409, { revisionId: "raw-revision" }));
    await act(async () => { await harness.mutations[1].mutateAsync().catch(() => {}); });
    const item = stored[0]; const node = host.querySelector("li"); const before = node?.textContent;
    const storedCopy = {
      title: t("work:copy.routineChanged_cd400e"),
      body: t("work:copy.someoneElseUpdatedThisRoutineReloadToSeeThe_be054f"),
      tone: "warn",
    };
    expect(item).toMatchObject(storedCopy);
    expect(item.presentation?.error).toBeUndefined();
    await act(async () => { await i18n.changeLanguage("zh-CN"); });
    expect(node?.textContent).toContain(t("work:copy.routineChanged_cd400e"));
    expect(node?.textContent).toContain(t("work:copy.someoneElseUpdatedThisRoutineReloadToSeeThe_be054f"));
    expect(node?.textContent).not.toContain("Raw revision conflict"); expect(node?.textContent).not.toBe(before);
    expect(stored[0]).toBe(item); expect(host.querySelector("li")).toBe(node);
    expect(stored[0]).toMatchObject(storedCopy);
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(node?.textContent).toBe(before); expect(harness.operation).toHaveBeenCalledTimes(1);
  });

});
