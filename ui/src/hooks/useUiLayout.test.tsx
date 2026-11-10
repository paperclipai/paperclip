// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { useUiLayout } from "./useUiLayout";

const uiLayoutsApi = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), reset: vi.fn() }));

vi.mock("@/api/auth", () => ({ authApi: { getSession: async () => ({ user: { id: "user-1" } }) } }));
vi.mock("@/api/uiLayouts", () => ({ uiLayoutsApi }));
vi.mock("../api/uiLayouts", () => ({ uiLayoutsApi }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Layout = { name: string };
type Preference = { surface: string; schemaVersion: number | null; layout: Layout | null; updatedAt: null };

const resolve = (raw: unknown) => raw as Layout;
const empty: Preference = { surface: "dashboard", schemaVersion: null, layout: null, updatedAt: null };

let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let current: ReturnType<typeof useUiLayout<Layout>>;
let order: string[];
let releaseSave: Array<() => void>;

function Harness() {
  current = useUiLayout<Layout>({ companyId: "company-1", surface: "dashboard", resolve });
  return null;
}

async function settle() {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 0));
  });
}

async function render() {
  await act(async () => {
    root.render(<QueryClientProvider client={queryClient}><Harness /></QueryClientProvider>);
  });
  await settle();
}

async function startSave(name: string) {
  await act(async () => {
    current.save({ name });
    current.flush();
  });
  await settle();
}

beforeEach(() => {
  order = [];
  releaseSave = [];
  for (const fn of Object.values(uiLayoutsApi)) fn.mockReset();
  uiLayoutsApi.get.mockResolvedValue(empty);
  uiLayoutsApi.save.mockImplementation((_companyId: string, surface: string, layout: Layout) =>
    new Promise((done) => {
      order.push(`put ${layout.name} start`);
      releaseSave.push(() => {
        order.push(`put ${layout.name} end`);
        done({ surface, schemaVersion: 1, layout, updatedAt: null });
      });
    }));
  uiLayoutsApi.reset.mockImplementation(async () => {
    order.push("delete");
    return empty;
  });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(queryKeys.auth.session, { user: { id: "user-1" } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  queryClient.clear();
});

describe("useUiLayout", () => {
  it("sends a reset after the save in flight and keeps the reset result", async () => {
    await render();
    await startSave("custom");
    expect(order).toEqual(["put custom start"]);

    await act(async () => current.reset());
    await settle();
    expect(uiLayoutsApi.reset).not.toHaveBeenCalled();

    await act(async () => releaseSave[0]!());
    await settle();
    expect(order).toEqual(["put custom start", "put custom end", "delete"]);
    expect(current.stored).toBeNull();
    expect(queryClient.getQueryData<Preference>(queryKeys.uiLayouts.mine("company-1", "dashboard"))?.layout).toBeNull();
    expect(current.saveState).toBe("idle");
  });

  it("sends one reset for a repeated reset and keeps the edit that follows", async () => {
    let releaseReset!: () => void;
    uiLayoutsApi.reset.mockImplementation(() =>
      new Promise((done) => {
        order.push("delete");
        releaseReset = () => done(empty);
      }));
    await render();

    await act(async () => current.reset());
    await settle();
    expect(current.resetting).toBe(true);
    await act(async () => current.reset());
    await settle();
    await act(async () => releaseReset());
    await settle();
    expect(current.resetting).toBe(false);

    await startSave("edited");
    await act(async () => releaseSave[0]!());
    await settle();
    expect(order).toEqual(["delete", "put edited start", "put edited end"]);
    expect(uiLayoutsApi.reset).toHaveBeenCalledTimes(1);
    expect(current.stored).toEqual({ name: "edited" });
    expect(current.saveState).toBe("saved");
  });

  it("keeps saving after the account changes while a save is in flight", async () => {
    await render();
    await startSave("first");
    expect(uiLayoutsApi.save).toHaveBeenCalledTimes(1);

    await act(async () => {
      queryClient.setQueryData(queryKeys.auth.session, { user: { id: "user-2" } });
    });
    await act(async () => releaseSave[0]!());
    await settle();

    await startSave("second");
    expect(uiLayoutsApi.save).toHaveBeenCalledTimes(2);
    expect(uiLayoutsApi.save.mock.calls[1]![2]).toEqual({ name: "second" });
  });

  it("sends the pending layout on pagehide while a save is in flight", async () => {
    await render();
    await startSave("first");
    await act(async () => current.save({ name: "latest" }));

    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(uiLayoutsApi.save).toHaveBeenCalledTimes(2);
    expect(uiLayoutsApi.save.mock.calls[1]).toEqual(["company-1", "dashboard", { name: "latest" }, { keepalive: true }]);

    await act(async () => {
      releaseSave[0]!();
      releaseSave[1]!();
    });
    await settle();
    expect(uiLayoutsApi.save).toHaveBeenCalledTimes(2);
  });
});
