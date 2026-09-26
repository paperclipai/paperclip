import { vi, type Mock } from "vitest";

/**
 * Stand-in for the tab connector sign-in opens beside the page.
 *
 * jsdom has no `window.open`, so without this a test only ever exercises the
 * fallback Paperclip uses when a browser refuses the tab — which is a top-level
 * navigation, the very behaviour the new tab replaces.
 */
export type SignInTabStub = {
  closed: boolean;
  location: { href: string; assign: Mock<(url: string) => void> };
  focus: Mock<() => void>;
  close: Mock<() => void>;
};

export function newSignInTabStub(): SignInTabStub {
  const tab: SignInTabStub = {
    closed: false,
    location: {
      href: "about:blank",
      assign: vi.fn((url: string) => { tab.location.href = url; }),
    },
    focus: vi.fn(),
    close: vi.fn(() => { tab.closed = true; }),
  };
  return tab;
}

/**
 * Serve `stub` from `window.open`, recording the destination whichever way it
 * gets there: a tab reserved on the click is navigated by assigning its
 * location, while a flow that only learns it needs sign-in from the server's
 * response opens with the URL directly.
 */
export function stubSignInTabOpener(stub: SignInTabStub): void {
  vi.spyOn(window, "open").mockImplementation((url) => {
    if (typeof url === "string" && url !== "about:blank") stub.location.assign(url);
    return stub as unknown as Window;
  });
}
