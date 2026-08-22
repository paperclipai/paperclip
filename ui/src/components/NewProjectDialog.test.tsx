// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewProjectDialog } from "./NewProjectDialog";

const dialogState = vi.hoisted(() => ({
  newProjectOpen: true,
  closeNewProject: vi.fn(),
}));

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1",
  selectedCompany: {
    id: "company-1",
    name: "Paperclip",
    status: "active",
    // brandColor intentionally omitted: mock fixtures must stay token-gate-clean
    issuePrefix: "PAP",
  },
}));

const mockProjectsApi = vi.hoisted(() => ({
  create: vi.fn(),
  createWorkspace: vi.fn(),
}));

const mockGoalsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockAccessApi = vi.hoisted(() => ({
  listUserDirectory: vi.fn(),
}));

const mockAssetsApi = vi.hoisted(() => ({
  uploadImage: vi.fn(),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => dialogState,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../api/projects", () => ({
  projectsApi: mockProjectsApi,
}));

vi.mock("../api/goals", () => ({
  goalsApi: mockGoalsApi,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/access", () => ({
  accessApi: mockAccessApi,
}));

vi.mock("../api/assets", () => ({
  assetsApi: mockAssetsApi,
}));

vi.mock("./MarkdownEditor", async () => {
  const React = await import("react");
  return {
    MarkdownEditor: React.forwardRef<
      { focus: () => void },
      { value: string; onChange?: (value: string) => void; placeholder?: string }
    >(function MarkdownEditorMock({ value, onChange, placeholder }, ref) {
      React.useImperativeHandle(ref, () => ({
        focus: () => undefined,
      }));
      return (
        <textarea
          aria-label={placeholder ?? "Description"}
          value={value}
          onChange={(event) => onChange?.(event.target.value)}
        />
      );
    }),
  };
});

vi.mock("./PathInstructionsModal", () => ({
  ChoosePathButton: () => null,
}));

// Mock only the dialog shell so DialogContent keeps forwarding className; the inner
// Popover/StatusBadge/Button render fine in jsdom without user input. Tooltip is
// mocked because Radix Tooltip requires a TooltipProvider wrapper.
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div data-testid="dialog-root">{children}</div> : null,
  DialogContent: ({
    children,
    showCloseButton: _showCloseButton,
    ...props
  }: ComponentProps<"div"> & { showCloseButton?: boolean }) => (
    <div data-testid="dialog-content" {...props}>
      {children}
    </div>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void | Promise<void>): void | Promise<void> {
  let result: unknown;
  flushSync(() => {
    result = callback();
  });
  return result && typeof (result as Promise<void>).then === "function"
    ? (result as Promise<void>).then(() => undefined)
    : undefined;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function classes(el: Element | null): string[] {
  return Array.from(el?.classList ?? []);
}

describe("NewProjectDialog viewport overflow fix", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    dialogState.newProjectOpen = true;
    dialogState.closeNewProject.mockReset();
    mockProjectsApi.create.mockReset();
    mockProjectsApi.createWorkspace.mockReset();
    mockGoalsApi.list.mockReset();
    mockAgentsApi.list.mockReset();
    mockAccessApi.listUserDirectory.mockReset();
    mockAssetsApi.uploadImage.mockReset();
    mockGoalsApi.list.mockResolvedValue([]);
    mockAgentsApi.list.mockResolvedValue([]);
    mockAccessApi.listUserDirectory.mockResolvedValue({ users: [] });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderDialog() {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <NewProjectDialog />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    return root;
  }

  it("caps the dialog height and pins header + footer so tall content scrolls in the middle only", async () => {
    const root = await renderDialog();

    const content = container.querySelector('[data-testid="dialog-content"]');
    expect(content).not.toBeNull();

    // DialogContent is capped to the viewport-aware token and laid out as a flex
    // column with overflow clipped at the shell.
    const contentClassList = classes(content);
    expect(contentClassList).toContain("max-h-(--sz-calc-16)");
    expect(contentClassList).toContain("overflow-hidden");
    expect(contentClassList).toContain("flex");
    expect(contentClassList).toContain("flex-col");
    expect(contentClassList).toContain("p-0");
    expect(contentClassList).toContain("gap-0");

    // Exactly one direct child is the scrollable middle; it is the ONLY element
    // allowed to scroll.
    const directChildren = Array.from(content?.children ?? []);
    expect(directChildren.length).toBe(3);

    const [header, scrollable, footer] = directChildren;

    // Header and footer are pinned (shrink-0) so they never leave the viewport.
    expect(classes(header)).toContain("shrink-0");
    expect(header?.textContent).toContain("New project");
    expect(classes(footer)).toContain("shrink-0");
    expect(footer?.textContent).toContain("Create project");

    // The middle owns the vertical overflow: it shrinks (min-h-0) and grows to
    // fill (flex-1) while scrolling internally.
    expect(classes(scrollable)).toContain("min-h-0");
    expect(classes(scrollable)).toContain("flex-1");
    expect(classes(scrollable)).toContain("overflow-y-auto");
    expect(scrollable?.querySelector('input[placeholder="Project name"]')).not.toBeNull();
    expect(scrollable?.querySelector('textarea[aria-label="Add description..."]')).not.toBeNull();
    // The footer button lives OUTSIDE the scrollable region, so it stays visible.
    expect(scrollable?.textContent).not.toContain("Create project");

    act(() => root.unmount());
  });

  it("grows to the expanded width when the expand toggle is used", async () => {
    const root = await renderDialog();

    const content = container.querySelector('[data-testid="dialog-content"]');
    expect(classes(content)).toContain("sm:max-w-lg");

    const expandButton = container.querySelector('button svg.lucide-maximize-2')?.closest("button");
    await act(async () => {
      expandButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(classes(container.querySelector('[data-testid="dialog-content"]'))).toContain("sm:max-w-2xl");

    act(() => root.unmount());
  });
});
