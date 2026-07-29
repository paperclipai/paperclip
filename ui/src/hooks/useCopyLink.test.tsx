// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToastState, type ToastItem } from "../context/ToastContext";
import { useCopyLink } from "./useCopyLink";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("useCopyLink", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let copyLink: ((path: string) => void) | null = null;
  let toasts: ToastItem[] = [];

  function Harness() {
    copyLink = useCopyLink();
    toasts = useToastState();
    return null;
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <ToastProvider>
          <Harness />
        </ToastProvider>,
      );
    });
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    copyLink = null;
    toasts = [];
    container.remove();
    vi.unstubAllGlobals();
  });

  function stubClipboard(writeText: (text: string) => Promise<void>) {
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    return writeText;
  }

  it("copies the absolute URL and pushes a success toast", async () => {
    const writeText = stubClipboard(vi.fn().mockResolvedValue(undefined));

    await act(async () => {
      copyLink!("/goals/g-1");
    });

    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/goals/g-1`);
    expect(toasts).toContainEqual(
      expect.objectContaining({ title: "Link copied", tone: "success" }),
    );
  });

  it("pushes an error toast when the clipboard write is rejected", async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error("denied")));

    await act(async () => {
      copyLink!("/goals/g-1");
    });

    expect(toasts).toContainEqual(
      expect.objectContaining({ title: "Copy failed", tone: "error" }),
    );
  });

  it("does not throw when used outside a ToastProvider", async () => {
    const writeText = stubClipboard(vi.fn().mockResolvedValue(undefined));

    let bareCopyLink: ((path: string) => void) | null = null;
    function BareHarness() {
      bareCopyLink = useCopyLink();
      return null;
    }
    const bareContainer = document.createElement("div");
    document.body.appendChild(bareContainer);
    const bareRoot = createRoot(bareContainer);
    act(() => {
      bareRoot.render(<BareHarness />);
    });

    await act(async () => {
      expect(() => bareCopyLink!("/goals/g-1")).not.toThrow();
    });
    expect(writeText).toHaveBeenCalled();

    act(() => {
      bareRoot.unmount();
    });
    bareContainer.remove();
  });
});
