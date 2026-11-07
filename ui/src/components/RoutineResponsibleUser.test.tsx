// @vitest-environment jsdom
import { i18n } from "@/i18n";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { RoutineDetail } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accessApi } from "@/api/access";
import { ApiError } from "@/api/client";
import { routinesApi } from "@/api/routines";
import { queryKeys } from "@/lib/queryKeys";
import { RoutineResponsibleUser } from "./RoutineResponsibleUser";

const routine = {
  id: "routine-1", companyId: "company-1", responsibleUserId: "user-alex",
  latestRevisionId: "revision-1", canChangeResponsibleUser: true,
} as RoutineDetail;
const users = ["Alex", "Sam"].map((name) => ({
  principalId: `user-${name.toLowerCase()}`, status: "active" as const, membershipRole: "member" as const,
  user: { id: `user-${name.toLowerCase()}`, name, email: `${name.toLowerCase()}@example.test`, image: null },
}));

describe("RoutineResponsibleUser", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    HTMLElement.prototype.scrollIntoView = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    vi.spyOn(accessApi, "listUserDirectory").mockResolvedValue({ users });
    vi.spyOn(routinesApi, "update").mockResolvedValue({ ...routine, responsibleUserId: "user-sam" });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    await i18n.changeLanguage("en");
    container.remove();
    client.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function render(value = routine) {
    await act(async () => root.render(<QueryClientProvider client={client}><RoutineResponsibleUser routine={value} /></QueryClientProvider>));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  }

  async function selectSam() {
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.includes("Sam"));
    expect(option).toBeDefined();
    await act(async () => option!.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  }

  it("switches responsibility labels to Chinese while preserving names and submitted IDs", async () => {
    await render();
    await act(async () => { await i18n.changeLanguage("zh-CN"); });
    expect(container.textContent).toContain("负责人");
    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("更改负责人：Alex");
    await selectSam();
    expect(routinesApi.update).toHaveBeenCalledWith("routine-1", { responsibleUserId: "user-sam", baseRevisionId: "revision-1" });
  });

  it("shows the person and inheritance rules to read-only viewers", async () => {
    await render({ ...routine, canChangeResponsibleUser: false });
    expect(container.textContent).toContain("Alex");
    expect(container.textContent).toContain("Automatic tasks use this person. Manual runs use the person who starts them.");
    expect(container.querySelector("button")).toBeNull();
  });

  it("saves only responsibility and its base revision, then refreshes routine data", async () => {
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await render();
    await selectSam();
    expect(routinesApi.update).toHaveBeenCalledWith("routine-1", { responsibleUserId: "user-sam", baseRevisionId: "revision-1" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.routines.detail("routine-1") });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.routines.revisions("routine-1") });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.routines.activity("company-1", "routine-1") });
    expect(document.querySelector('[role="option"]')).toBeNull();
  });

  it("keeps the picker disabled until the saved detail is refreshed, then uses the new revision", async () => {
    let resolveRefresh!: (value: RoutineDetail) => void;
    const refresh = new Promise<RoutineDetail>((resolve) => { resolveRefresh = resolve; });
    const saved = { ...routine, responsibleUserId: "user-sam", latestRevisionId: "revision-2" };
    vi.mocked(routinesApi.update).mockResolvedValue(saved);
    function Detail() {
      const detail = useQuery({
        queryKey: queryKeys.routines.detail(routine.id),
        queryFn: () => refresh,
        initialData: routine,
        staleTime: Infinity,
      });
      return <RoutineResponsibleUser routine={detail.data} />;
    }
    await act(async () => root.render(<QueryClientProvider client={client}><Detail /></QueryClientProvider>));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    await selectSam();
    expect(container.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
    expect(container.textContent).toContain("Saving…");
    await act(async () => resolveRefresh(saved));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(container.querySelector<HTMLButtonElement>("button")?.disabled).toBe(false);
    expect(container.textContent).toContain("Sam");
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    const alex = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.includes("Alex"));
    await act(async () => alex!.click());
    expect(routinesApi.update).toHaveBeenLastCalledWith(routine.id, { responsibleUserId: "user-alex", baseRevisionId: "revision-2" });
  });

  it("does not save when the current person is selected", async () => {
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.includes("Alex"));
    await act(async () => option!.click());
    expect(routinesApi.update).not.toHaveBeenCalled();
  });

  it.each([403, 409])("keeps the saved person and shows the %s failure", async (status) => {
    vi.mocked(routinesApi.update).mockRejectedValue(new ApiError("Missing permission: tasks:assign", status, null));
    await render();
    await selectSam();
    expect(container.textContent).toContain("Alex");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(status === 409 ? "Reload before changing responsibility" : "Missing permission");
  });

  it("shows an unavailable person without inventing a name and permits repair", async () => {
    await render({ ...routine, responsibleUserId: "former-user" });
    expect(container.textContent).toContain("Unavailable user");
    await selectSam();
    expect(routinesApi.update).toHaveBeenCalledWith(routine.id, expect.objectContaining({ responsibleUserId: "user-sam" }));
  });

  it("disables the picker and explains a directory failure", async () => {
    vi.mocked(accessApi.listUserDirectory).mockRejectedValue(new Error("Unavailable"));
    await render();
    expect(container.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Unavailable");
    expect(container.textContent).toContain("Retry");
  });

  it("keeps a cached person visible without a local alert during a transient directory failure", async () => {
    await render();
    vi.mocked(accessApi.listUserDirectory).mockRejectedValue(new ApiError("tenant_app_unavailable", 503, { error: "tenant_app_unavailable" }));
    await act(async () => client.invalidateQueries({ queryKey: queryKeys.access.companyUserDirectory(routine.companyId) }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(container.textContent).toContain("Alex");
    expect(container.querySelector<HTMLButtonElement>("button")?.disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
