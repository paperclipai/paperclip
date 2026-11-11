// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { queryKeys } from "@/lib/queryKeys";
import { UI_LAYOUT_SAVE_RETRY_DELAYS_MS, useUiLayout } from "./useUiLayout";

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
  vi.useRealTimers();
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
    expect(uiLayoutsApi.save.mock.calls[0]![3].signal.aborted).toBe(true);

    await act(async () => releaseSave[1]!());
    await settle();
    await act(async () => releaseSave[0]!());
    await settle();
    expect(uiLayoutsApi.save).toHaveBeenCalledTimes(2);
    expect(current.stored).toEqual({ name: "latest" });
    expect(current.saveState).toBe("saved");

    await startSave("after");
    expect(uiLayoutsApi.save).toHaveBeenCalledTimes(3);
    expect(uiLayoutsApi.save.mock.calls[2]![2]).toEqual({ name: "after" });
  });

  it("reports a failed reset without offering to save again", async () => {
    uiLayoutsApi.reset.mockRejectedValueOnce(new Error("network down"));
    await render();
    await act(async () => current.reset());
    await settle();
    expect(current.saveState).toBe("error");
    expect(current.saveError).toBeNull();
    expect(current.resetting).toBe(false);
  });

  it("sends a debounced or staged layout with keepalive on pagehide when no save is in flight", async () => {
    await render();
    await act(async () => current.save({ name: "edited" }));
    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(uiLayoutsApi.save.mock.calls).toEqual([["company-1", "dashboard", { name: "edited" }, { keepalive: true }]]);
    await act(async () => releaseSave[0]!());
    await settle();
    expect(current.stored).toEqual({ name: "edited" });
    expect(current.saveState).toBe("saved");

    await act(async () => current.stage({ name: "viewport" }));
    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(uiLayoutsApi.save).toHaveBeenCalledTimes(2);
    expect(uiLayoutsApi.save.mock.calls[1]).toEqual(["company-1", "dashboard", { name: "viewport" }, { keepalive: true }]);
  });

  it("sends the save in flight again with keepalive on pagehide", async () => {
    await render();
    await startSave("only");
    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(uiLayoutsApi.save).toHaveBeenCalledTimes(2);
    expect(uiLayoutsApi.save.mock.calls[0]![3].signal.aborted).toBe(true);
    expect(uiLayoutsApi.save.mock.calls[1]).toEqual(["company-1", "dashboard", { name: "only" }, { keepalive: true }]);
  });

  it("keeps a failed save pending, reports the error and saves it on a manual retry", async () => {
    const rejected = new ApiError("Layout is not valid", 400, { error: "Layout is not valid" });
    uiLayoutsApi.save.mockRejectedValueOnce(rejected);
    await render();
    await startSave("kept");
    expect(current.saveState).toBe("error");
    expect(current.saveError).toBe(rejected);
    expect(uiLayoutsApi.save).toHaveBeenCalledTimes(1);

    await act(async () => current.retrySave());
    await settle();
    expect(uiLayoutsApi.save).toHaveBeenCalledTimes(2);
    expect(uiLayoutsApi.save.mock.calls[1]![2]).toEqual({ name: "kept" });
    await act(async () => releaseSave[0]!());
    await settle();
    expect(current.stored).toEqual({ name: "kept" });
    expect(current.saveState).toBe("saved");
    expect(current.saveError).toBeNull();
  });

  it("retries a save that failed for a transient reason a limited number of times", async () => {
    vi.useFakeTimers();
    const advance = async (ms: number) => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    };
    uiLayoutsApi.save.mockRejectedValue(new ApiError("Service unavailable", 503, null));
    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}><Harness /></QueryClientProvider>);
    });
    await advance(0);
    await act(async () => {
      current.save({ name: "offline" });
      current.flush();
    });
    await advance(0);
    expect(uiLayoutsApi.save).toHaveBeenCalledTimes(1);
    expect(current.saveState).toBe("error");

    let expected = 1;
    for (const delay of UI_LAYOUT_SAVE_RETRY_DELAYS_MS) {
      await advance(delay - 1);
      expect(uiLayoutsApi.save).toHaveBeenCalledTimes(expected);
      await advance(1);
      expected += 1;
      expect(uiLayoutsApi.save).toHaveBeenCalledTimes(expected);
      expect(uiLayoutsApi.save.mock.calls[expected - 1]![2]).toEqual({ name: "offline" });
    }
    await advance(10 * 60_000);
    expect(uiLayoutsApi.save).toHaveBeenCalledTimes(expected);
    expect(current.saveState).toBe("error");

    uiLayoutsApi.save.mockResolvedValue({ surface: "dashboard", schemaVersion: 1, layout: { name: "offline" }, updatedAt: null });
    await act(async () => current.retrySave());
    await advance(0);
    expect(uiLayoutsApi.save).toHaveBeenCalledTimes(expected + 1);
    expect(current.saveState).toBe("saved");
    expect(current.stored).toEqual({ name: "offline" });
  });
});
