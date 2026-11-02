// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToastProvider, useToastActions, useToastState } from "./ToastContext";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("ToastContext", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("does not rerender action-only consumers when toast state changes", () => {
    const root = createRoot(container);
    let actionOnlyRenderCount = 0;
    let pushToastRef: ((input: { title: string }) => string | null) | null = null;
    let clearToastsRef: (() => void) | null = null;

    function ActionOnlyConsumer() {
      actionOnlyRenderCount += 1;
      const { pushToast, clearToasts } = useToastActions();
      pushToastRef = pushToast;
      clearToastsRef = clearToasts;
      return null;
    }

    function ToastCount() {
      const toasts = useToastState();
      return <div data-testid="toast-count">{String(toasts.length)}</div>;
    }

    act(() => {
      root.render(
        <ToastProvider>
          <ActionOnlyConsumer />
          <ToastCount />
        </ToastProvider>,
      );
    });

    expect(actionOnlyRenderCount).toBe(1);
    expect(container.querySelector('[data-testid="toast-count"]')?.textContent).toBe("0");

    act(() => {
      pushToastRef?.({ title: "Saved" });
    });

    expect(actionOnlyRenderCount).toBe(1);
    expect(container.querySelector('[data-testid="toast-count"]')?.textContent).toBe("1");

    act(() => {
      clearToastsRef?.();
    });

    expect(actionOnlyRenderCount).toBe(1);
    expect(container.querySelector('[data-testid="toast-count"]')?.textContent).toBe("0");

    act(() => {
      root.unmount();
    });
  });

  it("shows one toast when distinct events render the same text", () => {
    const root = createRoot(container);
    let pushToastRef: ((input: { title: string; body?: string; dedupeKey?: string }) => string | null) | null = null;

    function Consumer() {
      pushToastRef = useToastActions().pushToast;
      const toasts = useToastState();
      return <div data-testid="toast-count">{String(toasts.length)}</div>;
    }

    act(() => {
      root.render(<ToastProvider><Consumer /></ToastProvider>);
    });

    const results: Array<string | null> = [];
    act(() => {
      results.push(pushToastRef!({ title: "Ada run succeeded", dedupeKey: "run-status:one:succeeded" }));
      results.push(pushToastRef!({ title: "Ada run succeeded", dedupeKey: "run-status:two:succeeded" }));
      results.push(pushToastRef!({ title: "Ada run succeeded", body: "Trigger: comment", dedupeKey: "run-status:three:succeeded" }));
    });

    expect(results[1]).toBeNull();
    expect(results[2]).not.toBeNull();
    expect(container.querySelector('[data-testid="toast-count"]')?.textContent).toBe("2");

    act(() => {
      root.unmount();
    });
  });
});
