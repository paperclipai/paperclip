// @vitest-environment jsdom

import { act } from "react";
import type { KeyboardEventHandler, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1",
}));

const dialogState = vi.hoisted(() => ({
  openNewIssue: vi.fn(),
  openNewAgent: vi.fn(),
}));

const sidebarState = vi.hoisted(() => ({
  isMobile: false,
  setSidebarOpen: vi.fn(),
}));

const mockIssuesApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockProjectsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => dialogState,
  useDialogActions: () => dialogState,
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => sidebarState,
}));

const navigateState = vi.hoisted(() => ({
  navigate: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => navigateState.navigate,
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/projects", () => ({
  projectsApi: mockProjectsApi,
}));

vi.mock("./Identity", () => ({
  Identity: ({ name }: { name: string }) => <span>{name}</span>,
}));

vi.mock("@/components/ui/command", () => ({
  CommandDialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
  CommandEmpty: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandInput: ({
    value,
    onValueChange,
    onKeyDown,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
  }) => (
    <div>
      <input
        aria-label="Command search"
        value={value}
        onChange={(event) => onValueChange(event.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      <button type="button" aria-label="Set query" onClick={() => onValueChange("pull/3303")} />
    </div>
  ),
  CommandItem: ({
    children,
    onSelect,
    "data-testid": testId,
  }: {
    children: ReactNode;
    onSelect?: () => void;
    "data-testid"?: string;
  }) => (
    <button data-testid={testId} onClick={onSelect}>
      {children}
    </button>
  ),
  CommandList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandSeparator: () => <hr />,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await Promise.resolve();
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

describe("CommandPalette", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    dialogState.openNewIssue.mockReset();
    dialogState.openNewAgent.mockReset();
    sidebarState.setSidebarOpen.mockReset();
    mockIssuesApi.list.mockReset();
    mockAgentsApi.list.mockReset();
    mockProjectsApi.list.mockReset();
    navigateState.navigate.mockReset();
    mockIssuesApi.list.mockResolvedValue([]);
    mockAgentsApi.list.mockResolvedValue([]);
    mockProjectsApi.list.mockResolvedValue([]);
  });

  afterEach(() => {
    container.remove();
  });

  it("includes routine execution issues in search queries", async () => {
    const { root } = renderWithQueryClient(<CommandPalette />, container);

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    });

    const setQueryButton = container.querySelector('button[aria-label="Set query"]');
    expect(setQueryButton).not.toBeNull();

    act(() => {
      setQueryButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(mockIssuesApi.list).toHaveBeenCalledWith("company-1", {
        q: "pull/3303",
        limit: 10,
        includeRoutineExecutions: true,
      });
    });

    act(() => {
      root.unmount();
    });
  });

  it("offers a Search-all command when the query is non-empty and routes Enter to /search when no issues match", async () => {
    mockIssuesApi.list.mockResolvedValue([]);
    const { root } = renderWithQueryClient(<CommandPalette />, container);

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    });

    const input = container.querySelector('input[aria-label="Command search"]') as HTMLInputElement;
    expect(input).not.toBeNull();

    act(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      nativeSetter.call(input, "auth flake");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await waitForAssertion(() => {
      const searchAllButton = container.querySelector(
        'button[data-testid="command-search-all"]',
      ) as HTMLButtonElement | null;
      expect(searchAllButton).not.toBeNull();
      expect(searchAllButton!.textContent).toContain("auth flake");
    });

    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(navigateState.navigate).toHaveBeenCalledWith("/search?q=auth%20flake");
    });

    act(() => {
      root.unmount();
    });
  });

  it("navigates to /search when the user clicks the Search-all command", async () => {
    mockIssuesApi.list.mockResolvedValue([]);
    const { root } = renderWithQueryClient(<CommandPalette />, container);

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    });

    const input = container.querySelector('input[aria-label="Command search"]') as HTMLInputElement;
    act(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      nativeSetter.call(input, "deflake");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    let searchAllButton: HTMLButtonElement | null = null;
    await waitForAssertion(() => {
      searchAllButton = container.querySelector(
        'button[data-testid="command-search-all"]',
      ) as HTMLButtonElement | null;
      expect(searchAllButton).not.toBeNull();
    });

    act(() => {
      searchAllButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(navigateState.navigate).toHaveBeenCalledWith("/search?q=deflake");
    });

    act(() => {
      root.unmount();
    });
  });
});
