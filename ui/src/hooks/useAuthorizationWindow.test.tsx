// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthorizationWindow } from "./useAuthorizationWindow";

const prepare = vi.hoisted(() => vi.fn());
const save = vi.hoisted(() => vi.fn());
vi.mock("@/lib/oauthHandoff", () => ({ prepareOAuthNavigation: prepare, savePendingCloudHandoff: save }));
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function renderHook(_hook: typeof useAuthorizationWindow) {
  const result = {} as { current: ReturnType<typeof useAuthorizationWindow> };
  function Harness() { result.current = useAuthorizationWindow(); return result.current.fallback; }
  act(() => root.render(<Harness />));
  return { result };
}

function windowStub() {
  return { closed: false, opener: window, location: { assign: vi.fn() }, focus: vi.fn(), close: vi.fn(), sessionStorage: {} };
}
describe("connector authorization windows", () => {
  it("reserves synchronously and navigates the reserved window after preparation", async () => {
    const popup = windowStub();
    const open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    prepare.mockResolvedValue({ kind: "authorization", url: "https://provider.example/authorize" });
    const { result } = renderHook(useAuthorizationWindow);
    act(() => result.current.reserve());
    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(popup.location.assign).not.toHaveBeenCalled();
    await act(() => result.current.open("https://provider.example/authorize"));
    expect(popup.location.assign).toHaveBeenCalledWith("https://provider.example/authorize");
    expect(popup.opener).toBeNull();
  });
  it("offers a real new-tab link when a popup is blocked", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    prepare.mockResolvedValue({ kind: "authorization", url: "https://provider.example/authorize" });
    const { result } = renderHook(useAuthorizationWindow);
    act(() => result.current.reserve());
    await act(() => result.current.open("https://provider.example/authorize"));
    const link = container.querySelector("a");
    expect(link?.textContent).toBe("Open sign-in in a new tab");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });
  it("closes the blank window when URL validation or handoff fails", async () => {
    const popup = windowStub();
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    prepare.mockRejectedValue(new Error("Invalid authorization address"));
    const { result } = renderHook(useAuthorizationWindow);
    act(() => result.current.reserve());
    await act(async () => { await expect(result.current.open("javascript:alert(1)")).rejects.toThrow("Invalid authorization address"); });
    expect(popup.close).toHaveBeenCalled();
    expect(result.current.fallback).toBeNull();
  });
  it("stores reauthentication state in the new window, never in a link without that state", async () => {
    const popup = windowStub();
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    prepare.mockResolvedValue({ kind: "reauthentication", url: "/cloud/connections/reauth" });
    const { result } = renderHook(useAuthorizationWindow);
    act(() => result.current.reserve());
    await act(() => result.current.open({ authorizationUrl: "", handoff: { kind: "paperclip_cloud", session: "saved-handoff-session" } }));
    expect(save).toHaveBeenCalledWith("saved-handoff-session", popup.sessionStorage);
    expect(result.current.fallback).toBeNull();
  });
});
