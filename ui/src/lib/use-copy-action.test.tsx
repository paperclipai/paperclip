// @vitest-environment jsdom

import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider, useToastState } from "../context/ToastContext";
import { useCopyAction, useCopyToast } from "./use-copy-action";

const writeText = vi.fn<(text: string) => Promise<void>>();

vi.mock("./clipboard", () => ({
  copyTextToClipboard: (text: string) => writeText(text),
}));

let container: HTMLDivElement;
let root: Root | null = null;

function render(node: React.ReactNode) {
  act(() => {
    root!.render(<StrictMode>{node}</StrictMode>);
  });
}

function buttonByText(text: string) {
  return Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === text,
  );
}

async function clickCopy(label = "Copy") {
  await act(async () => {
    buttonByText(label)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function InlineCopy() {
  const { copied, failed, copy } = useCopyAction(1000);
  return (
    <button type="button" onClick={() => void copy("secret-value")}>
      {copied ? "Copied" : failed ? "Copy failed" : "Copy"}
    </button>
  );
}

function ToastCopy() {
  const copyWithToast = useCopyToast();
  const toasts = useToastState();
  return (
    <>
      <button type="button" onClick={() => void copyWithToast("secret-value", "Message copied")}>
        Copy
      </button>
      <ul>
        {toasts.map((toast) => (
          <li key={toast.id} data-tone={toast.tone}>
            {toast.title}
          </li>
        ))}
      </ul>
    </>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  writeText.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  vi.useRealTimers();
});

describe("useCopyAction", () => {
  it("confirms only after the clipboard write resolves", async () => {
    let resolveWrite: (() => void) | undefined;
    writeText.mockReturnValue(new Promise<void>((resolve) => { resolveWrite = resolve; }));
    render(<InlineCopy />);

    await clickCopy();
    // The write is still in flight: claiming success here would be a lie.
    expect(buttonByText("Copied")).toBeUndefined();

    await act(async () => { resolveWrite?.(); });
    expect(buttonByText("Copied")).toBeDefined();
    expect(writeText).toHaveBeenCalledWith("secret-value");
  });

  it("reports a rejected write as a failure, never as copied", async () => {
    writeText.mockRejectedValue(new Error("Clipboard unavailable"));
    render(<InlineCopy />);

    await clickCopy();

    expect(buttonByText("Copy failed")).toBeDefined();
    expect(buttonByText("Copied")).toBeUndefined();
  });

  it("returns to rest after the reset delay", async () => {
    writeText.mockResolvedValue(undefined);
    render(<InlineCopy />);

    await clickCopy();
    expect(buttonByText("Copied")).toBeDefined();

    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(buttonByText("Copy")).toBeDefined();
  });

  it("shows the newest click's outcome when an older write resolves late", async () => {
    // Clipboard writes can settle out of order. Whatever the reader clicked
    // last is what the control has to report — a stale failure must not
    // overwrite a fresh success.
    let failFirst: ((reason: Error) => void) | undefined;
    writeText.mockReturnValueOnce(
      new Promise<void>((_resolve, reject) => { failFirst = reject; }),
    );
    writeText.mockResolvedValue(undefined);
    render(<InlineCopy />);

    await clickCopy();
    expect(buttonByText("Copy")).toBeDefined();

    // Second click resolves immediately and takes over the display.
    await clickCopy();
    expect(buttonByText("Copied")).toBeDefined();

    // Now the first write finally rejects. It is no longer in charge.
    await act(async () => { failFirst?.(new Error("Clipboard unavailable")); });
    expect(buttonByText("Copied")).toBeDefined();
    expect(buttonByText("Copy failed")).toBeUndefined();

    // And the stale click cannot reset the control out from under the new one.
    await act(async () => { vi.advanceTimersByTime(999); });
    expect(buttonByText("Copied")).toBeDefined();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(buttonByText("Copy")).toBeDefined();
  });
});

describe("useCopyToast", () => {
  it("raises a success toast once the write resolves", async () => {
    writeText.mockResolvedValue(undefined);
    render(<ToastProvider><ToastCopy /></ToastProvider>);

    await clickCopy();

    const toast = container.querySelector("li");
    expect(toast?.textContent).toBe("Message copied");
    expect(toast?.getAttribute("data-tone")).toBe("success");
  });

  it("raises an error toast instead of claiming success", async () => {
    writeText.mockRejectedValue(new Error("Clipboard unavailable"));
    render(<ToastProvider><ToastCopy /></ToastProvider>);

    await clickCopy();

    const toast = container.querySelector("li");
    expect(toast?.textContent).toContain("copy to clipboard");
    expect(toast?.getAttribute("data-tone")).toBe("error");
  });
});
