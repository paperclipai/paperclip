// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewGoalDialog } from "./NewGoalDialog";

const dialogState = vi.hoisted(() => ({
  newGoalOpen: true,
  newGoalDefaults: {} as Record<string, unknown>,
  closeNewGoal: vi.fn(),
}));

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1",
  selectedCompany: {
    id: "company-1",
    name: "Paperclip",
  },
}));

const mockGoalsApi = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
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

vi.mock("../api/goals", () => ({
  goalsApi: mockGoalsApi,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
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

vi.mock("./StatusBadge", () => ({
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

vi.mock("./AgentIconPicker", () => ({
  AgentIcon: () => null,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children, showCloseButton: _showCloseButton, ...props }: ComponentProps<"div"> & { showCloseButton?: boolean }) => <div {...props}>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, type = "button", ...props }: ComponentProps<"button">) => (
    <button type={type} onClick={onClick} {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function click(element: Element | null | undefined) {
  element && (element as HTMLButtonElement).click();
}

function renderDialog(container: HTMLDivElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <NewGoalDialog />
      </QueryClientProvider>,
    );
  });
  return { root, queryClient };
}

describe("NewGoalDialog", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    dialogState.newGoalOpen = true;
    dialogState.newGoalDefaults = {};
    dialogState.closeNewGoal.mockReset();
    mockGoalsApi.list.mockReset();
    mockGoalsApi.create.mockReset();
    mockAgentsApi.list.mockReset();
    mockAssetsApi.uploadImage.mockReset();
    mockGoalsApi.list.mockResolvedValue([]);
    mockGoalsApi.create.mockResolvedValue({ id: "goal-1" });
    mockAgentsApi.list.mockResolvedValue([
      { id: "agent-1", name: "CEO", icon: "crown", status: "idle" },
      { id: "agent-2", name: "CTO", icon: "wrench", status: "idle" },
    ]);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container.remove();
    root = null;
  });

  it("includes ownerAgentId in the create payload when an owner is selected", async () => {
    ({ root } = renderDialog(container));
    await flush();

    const titleInput = container.querySelector('input[placeholder="Goal title"]') as HTMLInputElement | null;
    expect(titleInput).toBeTruthy();

    await act(async () => {
      setInputValue(titleInput!, "SailAds MVP Boundary");
    });

    const ownerButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === "CEO");
    expect(ownerButton).toBeTruthy();

    await act(async () => {
      click(ownerButton);
    });

    const createButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Create goal"));
    expect(createButton).toBeTruthy();

    await act(async () => {
      click(createButton);
    });
    await flush();

    expect(mockGoalsApi.create).toHaveBeenCalledWith("company-1", expect.objectContaining({
      title: "SailAds MVP Boundary",
      status: "planned",
      level: "task",
      ownerAgentId: "agent-1",
    }));
  });
});
