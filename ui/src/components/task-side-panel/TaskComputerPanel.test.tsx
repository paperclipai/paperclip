// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computersApi } from "@/api/computers";
import { TaskComputerPanel } from "./TaskComputerPanel";

vi.mock("@/api/computers", () => ({ computersApi: {
  connect: vi.fn(), presence: vi.fn(), disconnect: vi.fn(async () => {}), preview: vi.fn(),
} }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const owner = { computerId: "computer", ownerId: "viewer", generation: 1 };
const now = new Date("2026-10-10T12:00:00Z");
const viewer = () => ({ viewerUrl: "https://viewer.example/#private-token", expiresAt: new Date(now.getTime() + 120_000).toISOString(), owner });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
let root: Root, host: HTMLDivElement, hidden = false, paneVisible = true, unmounted = false;
async function render(props: { issueId?: string; environmentId?: string; active?: boolean } = {}) {
  await act(async () => root.render(<TaskComputerPanel issueId={props.issueId ?? "task-a"} environmentId={props.environmentId ?? "environment-a"} active={props.active ?? true} />));
}
async function connect() {
  const button = Array.from(host.querySelectorAll("button")).find(item => item.textContent === "Connect");
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}
async function tick(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function unmount() { await act(async () => root.unmount()); unmounted = true; }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now); vi.clearAllMocks(); hidden = false; paneVisible = true; unmounted = false;
  vi.mocked(computersApi.connect).mockResolvedValue(viewer());
  vi.mocked(computersApi.presence).mockImplementation(async () => viewer());
  vi.mocked(computersApi.disconnect).mockResolvedValue(undefined);
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => hidden ? "hidden" : "visible" });
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  Object.defineProperty(Element.prototype, "checkVisibility", { configurable: true, value: () => paneVisible });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { if (!unmounted) await unmount(); host.remove(); delete (Element.prototype as { checkVisibility?: unknown }).checkVisibility; vi.restoreAllMocks(); vi.useRealTimers(); });

describe("Computer connection lifetime", () => {
  it("connects only after the explicit action and keeps credentials in the iframe with no referrer", async () => {
    await render(); await tick(60_000);
    expect(computersApi.connect).not.toHaveBeenCalled();
    expect(computersApi.presence).not.toHaveBeenCalled();
    expect(host.querySelector("iframe")).toBeNull();
    await connect();
    expect(computersApi.connect).toHaveBeenCalledWith("task-a", "environment-a");
    const iframe = host.querySelector("iframe")!;
    expect(iframe.src).toBe(viewer().viewerUrl);
    expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("does not renew while inactive or hidden and expires the stale credential without another connect", async () => {
    await render(); await connect();
    const renewals = vi.mocked(computersApi.presence).mock.calls.length;
    await render({ active: false }); await tick(30_000);
    expect(computersApi.presence).toHaveBeenCalledTimes(renewals);
    hidden = true;
    await render({ active: true }); await tick(30_000);
    expect(computersApi.presence).toHaveBeenCalledTimes(renewals);
    await tick(60_000);
    expect(host.querySelector("iframe")).toBeNull();
    expect(host.textContent).toContain("connection expired");
    expect(computersApi.disconnect).toHaveBeenCalledWith("task-a", "environment-a", owner);
    expect(computersApi.connect).toHaveBeenCalledTimes(1);
  });

  it("does not keep the computer alive while its selected pane is collapsed", async () => {
    await render(); await connect();
    const renewals = vi.mocked(computersApi.presence).mock.calls.length;
    paneVisible = false;
    await tick(30_000);
    expect(computersApi.presence).toHaveBeenCalledTimes(renewals);
    paneVisible = true;
    await tick(30_000);
    expect(computersApi.presence).toHaveBeenCalledTimes(renewals + 1);
  });

  it("revalidates when returning to a visible tab and clears an expired server hold", async () => {
    await render(); await connect(); await render({ active: false });
    vi.mocked(computersApi.presence).mockRejectedValueOnce(new Error("Connect again"));
    await render({ active: true });
    expect(host.querySelector("iframe")).toBeNull();
    expect(host.textContent).toContain("Connect again");
    expect(computersApi.disconnect).toHaveBeenCalledWith("task-a", "environment-a", owner);
  });

  it.each(["issue", "environment"])("retires a late connect for an old %s without showing its desktop", async change => {
    const pending = deferred<ReturnType<typeof viewer>>();
    vi.mocked(computersApi.connect).mockReturnValueOnce(pending.promise);
    await render(); await connect();
    expect(host.textContent).toContain("Connecting");
    await render(change === "issue" ? { issueId: "task-b" } : { environmentId: "environment-b" });
    expect(host.textContent).not.toContain("Connecting");
    await act(async () => pending.resolve(viewer()));
    expect(host.querySelector("iframe")).toBeNull();
    expect(computersApi.disconnect).toHaveBeenCalledWith("task-a", "environment-a", owner);
  });

  it("retires connections resolved after unmount", async () => {
    const pending = deferred<ReturnType<typeof viewer>>();
    vi.mocked(computersApi.connect).mockReturnValueOnce(pending.promise);
    await render(); await connect(); await unmount();
    await act(async () => pending.resolve(viewer()));
    expect(computersApi.disconnect).toHaveBeenCalledWith("task-a", "environment-a", owner);
  });

  it("retires a connected owner on unmount even when its presence response is pending", async () => {
    const pending = deferred<ReturnType<typeof viewer>>();
    vi.mocked(computersApi.presence).mockReturnValueOnce(pending.promise);
    await render(); await connect(); await unmount();
    expect(computersApi.disconnect).toHaveBeenCalledWith("task-a", "environment-a", owner);
    await act(async () => pending.resolve(viewer()));
    expect(host.querySelector("iframe")).toBeNull();
  });
});
