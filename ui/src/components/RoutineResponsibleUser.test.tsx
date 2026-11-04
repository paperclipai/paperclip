// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
  principalId: `user-${name.toLowerCase()}`, status: "active" as const,
  user: { id: `user-${name.toLowerCase()}`, name, email: `${name.toLowerCase()}@example.test`, image: null },
}));

describe("RoutineResponsibleUser", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;

  beforeEach(() => {
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
    expect(document.querySelector('[role="option"]')).toBeNull();
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
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not load people");
  });
});
