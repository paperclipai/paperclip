// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newSignInTabStub, stubSignInTabOpener, type SignInTabStub } from "@/fixtures/signInTabFixture";
import { useAuthorizationWindow, type AuthorizationWindow } from "./authorizationWindow";

const navigateTopLevelMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/browserNavigation", () => ({ navigateTopLevel: navigateTopLevelMock }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let captured: AuthorizationWindow | null = null;

function Harness({ kind }: { kind?: "tab" | "popup" }) {
  captured = useAuthorizationWindow(kind);
  return null;
}

describe("useAuthorizationWindow", () => {
  let container: HTMLDivElement;
  let signInTab: SignInTabStub;

  function render(kind?: "tab" | "popup") {
    const root = createRoot(container);
    flushSync(() => root.render(<Harness kind={kind} />));
    return captured!;
  }

  beforeEach(() => {
    captured = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    signInTab = newSignInTabStub();
  });

  afterEach(() => {
    container.remove();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("claims a plain tab and sends the authorization URL to it", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(signInTab as unknown as Window);
    const authorization = render();

    authorization.reserve();
    // No feature string: a feature string would make this a popup window.
    expect(open).toHaveBeenCalledWith("about:blank", "paperclip-connection-oauth", undefined);

    expect(authorization.open("https://provider.example.test/authorize")).toBe(true);
    expect(signInTab.location.assign).toHaveBeenCalledWith("https://provider.example.test/authorize");
    expect(signInTab.focus).toHaveBeenCalled();
  });

  it("claims a sized popup for a dialog host", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(signInTab as unknown as Window);
    render("popup").reserve();

    expect(open).toHaveBeenCalledWith(
      "about:blank",
      "paperclip-connection-oauth",
      "popup,width=720,height=760,resizable=yes,scrollbars=yes",
    );
  });

  it("reuses a claim instead of stacking up a second tab", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(signInTab as unknown as Window);
    const authorization = render();

    authorization.reserve();
    authorization.reserve();

    expect(open).toHaveBeenCalledTimes(1);
  });

  it("claims again once the operator has closed the first tab", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(signInTab as unknown as Window);
    const authorization = render();

    authorization.reserve();
    signInTab.closed = true;
    authorization.reserve();

    expect(open).toHaveBeenCalledTimes(2);
  });

  it("opens the URL directly when nothing was claimed ahead of it", () => {
    stubSignInTabOpener(signInTab);
    const authorization = render();

    expect(authorization.open("https://provider.example.test/authorize")).toBe(true);
    expect(signInTab.location.href).toBe("https://provider.example.test/authorize");
  });

  it("reports a blocked browser so the caller can offer a real link instead", () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const authorization = render();

    authorization.reserve();

    expect(authorization.open("https://provider.example.test/authorize")).toBe(false);
    expect(navigateTopLevelMock).not.toHaveBeenCalled();
  });

  it("navigateTo prepares the claimed tab before sending it on its way", () => {
    vi.spyOn(window, "open").mockReturnValue(signInTab as unknown as Window);
    const authorization = render();
    const prepare = vi.fn();

    authorization.reserve();
    authorization.navigateTo("https://provider.example.test/authorize", prepare);

    expect(prepare).toHaveBeenCalledWith(signInTab);
    expect(signInTab.location.assign).toHaveBeenCalledWith("https://provider.example.test/authorize");
    expect(navigateTopLevelMock).not.toHaveBeenCalled();
  });

  it("navigateTo falls back to this window, and prepares it, when the tab was blocked", () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const authorization = render();
    const prepare = vi.fn();

    authorization.reserve();
    authorization.navigateTo("https://provider.example.test/authorize", prepare);

    expect(prepare).toHaveBeenCalledWith(window);
    expect(navigateTopLevelMock).toHaveBeenCalledWith("https://provider.example.test/authorize");
  });

  it("forgets a claim so a real link can own the navigation", () => {
    vi.spyOn(window, "open").mockReturnValue(signInTab as unknown as Window);
    const authorization = render();

    authorization.reserve();
    authorization.forget();

    expect(authorization.current()).toBeNull();
    expect(signInTab.close).not.toHaveBeenCalled();
  });

  it("closes the claimed tab and drops it", () => {
    vi.spyOn(window, "open").mockReturnValue(signInTab as unknown as Window);
    const authorization = render();

    authorization.reserve();
    authorization.close();

    expect(signInTab.close).toHaveBeenCalled();
    expect(authorization.current()).toBeNull();
  });
});
