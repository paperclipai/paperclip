// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { savePendingCloudHandoff } from "@/lib/oauthHandoff";
import { PaperclipCloudOAuthHandoffPage } from "./PaperclipCloudOAuthHandoff";

const navigateTopLevel = vi.hoisted(() => vi.fn());
const SESSION = "cloud_session_abcdefghijklmnop";

vi.mock("@/lib/browserNavigation", () => ({
  navigateTopLevel: (url: string) => navigateTopLevel(url),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.sessionStorage.clear();
  navigateTopLevel.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("PaperclipCloudOAuthHandoffPage", () => {
  it("keeps a tenant loading state visible until the provider URL is ready", async () => {
    savePendingCloudHandoff(SESSION);
    let complete: ((response: Response) => void) | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise((resolve) => {
      complete = resolve;
    }));

    await act(async () => root.render(<PaperclipCloudOAuthHandoffPage />));
    expect(container.textContent).toContain("Preparing secure sign-in");
    expect(navigateTopLevel).not.toHaveBeenCalled();

    await act(async () => {
      complete?.(Response.json({ authorizationUrl: "https://provider.example.test/authorize" }));
    });
    await flushReact();

    expect(navigateTopLevel).toHaveBeenCalledWith("https://provider.example.test/authorize");
    expect(window.sessionStorage.length).toBe(0);
  });

  it("keeps terminal handoff failures in Paperclip instead of opening confirmation", async () => {
    savePendingCloudHandoff(SESSION);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      error: "SESSION_NOT_AVAILABLE",
    }, { status: 404 }));

    await act(async () => root.render(<PaperclipCloudOAuthHandoffPage />));
    await flushReact();

    expect(container.textContent).toContain("Sign-in couldn’t continue");
    expect(container.textContent).toContain("This sign-in expired. Start the connection again.");
    expect(navigateTopLevel).not.toHaveBeenCalled();
  });

  it("does not loop when recent-login recovery remains stale", async () => {
    savePendingCloudHandoff(SESSION);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      error: "RECENT_LOGIN_REQUIRED",
      reauthenticationUrl: `${window.location.origin}/cloud/connections/reauth?session=${SESSION}`,
    }, { status: 401 }));

    await act(async () => root.render(<PaperclipCloudOAuthHandoffPage />));
    await flushReact();

    expect(container.textContent).toContain("Paperclip couldn’t refresh this sign-in. Try again to continue.");
    expect(navigateTopLevel).not.toHaveBeenCalled();
  });
});
