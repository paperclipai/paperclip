// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FolderPicker } from "./FolderPicker";

const listFilesystemMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/access", () => ({
  accessApi: {
    listFilesystem: (path?: string) => listFilesystemMock(path),
  },
}));

vi.mock("./PathInstructionsModal", () => ({
  PathInstructionsModal: () => null,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    open,
    children,
  }: {
    open: boolean;
    children: ReactNode;
  }) => (open ? <div data-testid="dialog-root">{children}</div> : null),
  DialogContent: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  DialogHeader: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  DialogTitle: ({ children, className }: { children: ReactNode; className?: string }) => (
    <h2 className={className}>{children}</h2>
  ),
  DialogDescription: ({ children, className }: { children: ReactNode; className?: string }) => (
    <p className={className}>{children}</p>
  ),
  DialogFooter: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function setNativeInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  const previous = input.value;
  setter?.call(input, value);
  const tracker = (input as HTMLInputElement & { _valueTracker?: { setValue: (next: string) => void } })._valueTracker;
  tracker?.setValue(previous);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function flushAnimationFrame() {
  await act(async () => {
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)));
  });
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

function renderWithQueryClient(node: ReactNode, container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        {node}
      </QueryClientProvider>,
    );
  });

  return { root, queryClient };
}

function findButton(container: HTMLDivElement, label: string) {
  return Array.from(container.querySelectorAll("button")).find((button) =>
    button.textContent?.includes(label),
  ) ?? null;
}

describe("FolderPicker", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    listFilesystemMock.mockReset();
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("navigates nested folders and returns the selected absolute path", async () => {
    listFilesystemMock.mockImplementation(async (path?: string) => {
      if (!path) {
        return {
          path: "",
          parent: null,
          entries: [
            { name: "/Users", isDir: true, isSymlink: false },
          ],
        };
      }
      if (path === "/Users") {
        return {
          path: "/Users",
          parent: "/",
          entries: [
            { name: "neeraj", isDir: true, isSymlink: false },
          ],
        };
      }
      if (path === "/Users/neeraj") {
        return {
          path: "/Users/neeraj",
          parent: "/Users",
          entries: [
            { name: "workspace", isDir: true, isSymlink: false },
          ],
        };
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    const onSelect = vi.fn();
    ({ root } = renderWithQueryClient(
      <FolderPicker open onOpenChange={() => undefined} onSelect={onSelect} />,
      container,
    ));

    await waitForAssertion(() => {
      expect(findButton(container, "/Users")).not.toBeNull();
    });

    act(() => {
      findButton(container, "/Users")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(listFilesystemMock).toHaveBeenCalledWith("/Users");
      expect(findButton(container, "neeraj")).not.toBeNull();
    });

    act(() => {
      findButton(container, "neeraj")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(listFilesystemMock).toHaveBeenCalledWith("/Users/neeraj");
      expect(container.textContent).toContain("/Users/neeraj");
    });

    act(() => {
      findButton(container, "Select this folder")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("/Users/neeraj");
  });

  it("supports keyboard navigation through the folder list", async () => {
    listFilesystemMock.mockResolvedValue({
      path: "/Users",
      parent: "/",
      entries: [
        { name: "alpha", isDir: true, isSymlink: false },
        { name: "beta", isDir: true, isSymlink: false },
      ],
    });

    ({ root } = renderWithQueryClient(
      <FolderPicker open onOpenChange={() => undefined} value="/Users" onSelect={vi.fn()} />,
      container,
    ));

    await waitForAssertion(() => {
      expect(findButton(container, "alpha")).not.toBeNull();
      expect(findButton(container, "beta")).not.toBeNull();
    });

    const input = container.querySelector<HTMLInputElement>("#folder-picker-path");
    expect(input).not.toBeNull();

    act(() => {
      input?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    await flushAnimationFrame();

    const alphaButton = findButton(container, "alpha");
    expect(document.activeElement).toBe(alphaButton);

    act(() => {
      alphaButton?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    await flushAnimationFrame();

    expect(document.activeElement).toBe(findButton(container, "beta"));
  });

  it("renders API errors and still allows manual path selection", async () => {
    listFilesystemMock.mockRejectedValue(new Error("Access denied"));

    const onSelect = vi.fn();
    ({ root } = renderWithQueryClient(
      <FolderPicker open onOpenChange={() => undefined} value="/root" onSelect={onSelect} />,
      container,
    ));

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Could not load folders");
      expect(container.textContent).toContain("Access denied");
    });

    const input = container.querySelector<HTMLInputElement>("#folder-picker-path");
    expect(input).not.toBeNull();

    act(() => {
      setNativeInputValue(input!, "/tmp/paperclip");
    });

    act(() => {
      findButton(container, "Select this folder")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onSelect).toHaveBeenCalledWith("/tmp/paperclip");
  });
});
