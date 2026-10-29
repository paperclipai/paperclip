// @vitest-environment jsdom

import type { KeyboardEventHandler, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";
import { queryKeys } from "../lib/queryKeys";

function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> | undefined;
  flushSync(() => {
    result = callback();
  });
  return result;
}

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
  listLabels: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockProjectsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
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
const locationState = vi.hoisted(() => ({
  location: { pathname: "/", search: "", hash: "" },
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => navigateState.navigate,
  useLocation: () => locationState.location,
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

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../api/auth", () => ({
  authApi: mockAuthApi,
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

function renderWithQueryClient(
  node: ReactNode,
  container: HTMLDivElement,
  seedQueryClient?: (queryClient: QueryClient) => void,
) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  seedQueryClient?.(queryClient);

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
    mockIssuesApi.listLabels.mockReset();
    mockAgentsApi.list.mockReset();
    mockProjectsApi.list.mockReset();
    mockInstanceSettingsApi.getExperimental.mockReset();
    mockAuthApi.getSession.mockReset();
    navigateState.navigate.mockReset();
    locationState.location.pathname = "/";
    locationState.location.search = "";
    locationState.location.hash = "";
    mockIssuesApi.list.mockResolvedValue([]);
    mockIssuesApi.listLabels.mockResolvedValue([]);
    mockAgentsApi.list.mockResolvedValue([]);
    mockProjectsApi.list.mockResolvedValue([]);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableExperimentalFileViewer: false,
    });
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "user-1" }, session: { userId: "user-1" } });
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

  it("hides the issue file viewer command by default", async () => {
    locationState.location.pathname = "/issues/PAP-1";
    const { root } = renderWithQueryClient(<CommandPalette />, container);

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Create new task");
    });
    expect(container.textContent).not.toContain("Open file in this issue");

    act(() => {
      root.unmount();
    });
  });

  it("shows the issue file viewer command when the experimental flag is enabled", async () => {
    locationState.location.pathname = "/issues/PAP-1";
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableExperimentalFileViewer: true,
    });
    const { root } = renderWithQueryClient(
      <CommandPalette />,
      container,
      (queryClient) => {
        queryClient.setQueryData(queryKeys.instance.experimentalSettings, {
          enableExperimentalFileViewer: true,
        });
      },
    );

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Open file in this issue");
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
      expect(navigateState.navigate).toHaveBeenCalledWith("/search?q=auth+flake");
    });

    act(() => {
      root.unmount();
    });
  });

  it("promotes matching projects above the Tasks group when typing", async () => {
    const projects = [
      { id: "p1", urlKey: "mobile", name: "Mobile App", description: "iOS client", archivedAt: null },
      { id: "p2", urlKey: "billing", name: "Billing Service", description: null, archivedAt: null },
    ];
    mockProjectsApi.list.mockResolvedValue(projects);
    mockIssuesApi.list.mockImplementation((_companyId: string, opts?: { q?: string }) =>
      Promise.resolve(opts?.q ? [{ id: "i1", identifier: "ENG-9", title: "Fix login" }] : []),
    );

    const { root } = renderWithQueryClient(<CommandPalette />, container, (queryClient) => {
      // Seed the caches so the already-loaded data is available synchronously —
      // this harness's flush model doesn't reliably propagate fresh async fetches.
      queryClient.setQueryData(queryKeys.projects.list("company-1"), projects);
      queryClient.setQueryData(queryKeys.issues.search("company-1", "mob", undefined, 10), [
        { id: "i1", identifier: "ENG-9", title: "Fix login" },
      ]);
    });

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    });

    const input = container.querySelector('input[aria-label="Command search"]') as HTMLInputElement;
    act(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      nativeSetter.call(input, "mob");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await waitForAssertion(() => {
      const match = container.querySelector('button[data-testid="command-project-match"]');
      expect(match).not.toBeNull();
      expect(match!.textContent).toContain("Mobile App");
    });

    // Non-matching project is excluded from the typeahead results.
    expect(container.textContent).not.toContain("Billing Service");

    // The promoted project renders above the fold — before the Tasks group.
    await waitForAssertion(() => {
      const text = container.textContent ?? "";
      expect(text).toContain("Fix login");
      expect(text.indexOf("Mobile App")).toBeLessThan(text.indexOf("Fix login"));
    });

    // Selecting the promoted project navigates to its URL.
    act(() => {
      container
        .querySelector('button[data-testid="command-project-match"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitForAssertion(() => {
      expect(navigateState.navigate).toHaveBeenCalledWith("/projects/mobile");
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

  it("renders quick-filter chips and inserts them into the palette query", async () => {
    const { root } = renderWithQueryClient(<CommandPalette />, container);

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    });

    await waitForAssertion(() => {
      const chips = Array.from(container.querySelectorAll('button[data-testid="command-filter-chip"]'));
      expect(chips.map((chip) => chip.textContent)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("assignee:me"),
          expect.stringContaining("is:open"),
          expect.stringContaining("updated:>7d"),
        ]),
      );
    });

    act(() => {
      container.querySelector('button[data-testid="command-filter-chip"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const input = container.querySelector('input[aria-label="Command search"]') as HTMLInputElement;
    await waitForAssertion(() => {
      expect(input.value).toBe("assignee:me");
    });

    act(() => {
      root.unmount();
    });
  });

  it("parses operators for lightweight issue search but keeps filters for command-enter handoff", async () => {
    mockIssuesApi.list.mockResolvedValue([]);
    const { root } = renderWithQueryClient(<CommandPalette />, container);

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    });

    const input = container.querySelector('input[aria-label="Command search"]') as HTMLInputElement;
    act(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      nativeSetter.call(input, "auth status:blocked updated:>7d");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(mockIssuesApi.list).toHaveBeenCalledWith("company-1", {
        q: "auth",
        limit: 10,
        includeRoutineExecutions: true,
      });
    });

    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(navigateState.navigate).toHaveBeenCalledWith("/search?q=auth&status=blocked&updatedWithin=7d");
    });

    act(() => {
      root.unmount();
    });
  });

});
