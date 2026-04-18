// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewProjectDialog } from "./NewProjectDialog";

const dialogState = vi.hoisted(() => ({
  newProjectOpen: true,
  newProjectDefaults: {} as Record<string, unknown>,
  closeNewProject: vi.fn(),
}));

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1",
  selectedCompany: {
    id: "company-1",
    name: "Paperclip",
    status: "active",
    brandColor: "#123456",
  },
}));

const mockAccessApi = vi.hoisted(() => ({
  listMyEffectivePermissions: vi.fn(),
}));

const mockDepartmentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockProjectsApi = vi.hoisted(() => ({
  create: vi.fn(),
  createWorkspace: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockGoalsApi = vi.hoisted(() => ({
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

vi.mock("../api/access", () => ({
  accessApi: mockAccessApi,
}));

vi.mock("../api/departments", () => ({
  departmentsApi: mockDepartmentsApi,
}));

vi.mock("../api/projects", () => ({
  projectsApi: mockProjectsApi,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/goals", () => ({
  goalsApi: mockGoalsApi,
}));

vi.mock("../api/assets", () => ({
  assetsApi: mockAssetsApi,
}));

vi.mock("./MarkdownEditor", async () => {
  const React = await import("react");
  return {
    MarkdownEditor: React.forwardRef<
      { focus: () => void },
      {
        value: string;
        onChange?: (value: string) => void;
        placeholder?: string;
        mentions?: Array<{ id: string; name: string }>;
      }
    >(function MarkdownEditorMock({ value, onChange, placeholder, mentions }, ref) {
      React.useImperativeHandle(ref, () => ({
        focus: () => undefined,
      }));
      return (
        <div>
          <textarea
            aria-label={placeholder ?? "Description"}
            value={value}
            onChange={(event) => onChange?.(event.target.value)}
          />
          <div data-testid="project-mentions">{(mentions ?? []).map((mention) => mention.name).join("|")}</div>
        </div>
      );
    }),
  };
});

vi.mock("./StatusBadge", () => ({
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

vi.mock("./PathInstructionsModal", () => ({
  ChoosePathButton: () => <button type="button">Choose path</button>,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({
    children,
    showCloseButton: _showCloseButton,
    onEscapeKeyDown: _onEscapeKeyDown,
    onPointerDownOutside: _onPointerDownOutside,
    ...props
  }: ComponentProps<"div"> & {
    showCloseButton?: boolean;
    onEscapeKeyDown?: (event: unknown) => void;
    onPointerDownOutside?: (event: unknown) => void;
  }) => <div {...props}>{children}</div>,
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

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
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
  throw lastError instanceof Error ? lastError : new Error("Assertion did not pass in time");
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function setTextInputValue(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
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
        <NewProjectDialog />
      </QueryClientProvider>,
    );
  });
  return { root };
}

describe("NewProjectDialog", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    dialogState.newProjectOpen = true;
    dialogState.newProjectDefaults = {};
    dialogState.closeNewProject.mockReset();
    mockAccessApi.listMyEffectivePermissions.mockResolvedValue([
      {
        permissionKey: "projects:manage",
        companyWide: true,
        departmentIds: [],
      },
    ]);
    mockDepartmentsApi.list.mockResolvedValue([]);
    mockProjectsApi.create.mockResolvedValue({
      id: "project-1",
      companyId: "company-1",
    });
    mockProjectsApi.createWorkspace.mockResolvedValue(null);
    mockAgentsApi.list.mockResolvedValue([]);
    mockGoalsApi.list.mockResolvedValue([]);
    mockAssetsApi.uploadImage.mockResolvedValue({ contentPath: "/uploads/project.png" });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("requires a department when project manage access is department-scoped", async () => {
    mockAccessApi.listMyEffectivePermissions.mockResolvedValue([
      {
        permissionKey: "projects:manage",
        companyWide: false,
        departmentIds: ["dept-1", "dept-2"],
      },
    ]);
    mockDepartmentsApi.list.mockResolvedValue([
      { id: "dept-1", companyId: "company-1", name: "Engineering", description: null, parentId: null, status: "active", sortOrder: 0, createdAt: "", updatedAt: "" },
      { id: "dept-2", companyId: "company-1", name: "Finance", description: null, parentId: null, status: "active", sortOrder: 1, createdAt: "", updatedAt: "" },
    ]);

    const { root } = renderDialog(container);
    await flush();

    const nameInput = container.querySelector("input[placeholder=\"Project name\"]") as HTMLInputElement;
    await act(async () => {
      setTextInputValue(nameInput, "Scoped project");
    });
    await flush();

    expect(container.textContent).toContain("Select a department to create this project.");
    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create project"));
    expect(submitButton?.hasAttribute("disabled")).toBe(true);

    act(() => root.unmount());
  });

  it("includes the scoped department in the create payload", async () => {
    mockAccessApi.listMyEffectivePermissions.mockResolvedValue([
      {
        permissionKey: "projects:manage",
        companyWide: false,
        departmentIds: ["dept-1"],
      },
    ]);
    mockDepartmentsApi.list.mockResolvedValue([
      { id: "dept-1", companyId: "company-1", name: "Engineering", description: null, parentId: null, status: "active", sortOrder: 0, createdAt: "", updatedAt: "" },
    ]);

    const { root } = renderDialog(container);
    await flush();

    const nameInput = container.querySelector("input[placeholder=\"Project name\"]") as HTMLInputElement;
    await act(async () => {
      setTextInputValue(nameInput, "Scoped project");
    });
    await flush();

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create project"));
    expect(submitButton).not.toBeUndefined();
    await waitForAssertion(() => {
      expect(submitButton?.hasAttribute("disabled")).toBe(false);
    });

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    await waitForAssertion(() => {
      expect(mockProjectsApi.create).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({
          name: "Scoped project",
          departmentId: "dept-1",
        }),
      );
    });

    act(() => root.unmount());
  });

  it("keeps submit disabled while scoped permissions are still loading", async () => {
    const permissions = createDeferred<Array<{
      permissionKey: string;
      companyWide: boolean;
      departmentIds: string[];
    }>>();
    mockAccessApi.listMyEffectivePermissions.mockReturnValue(permissions.promise);
    mockDepartmentsApi.list.mockResolvedValue([
      { id: "dept-1", companyId: "company-1", name: "Engineering", description: null, parentId: null, status: "active", sortOrder: 0, createdAt: "", updatedAt: "" },
    ]);

    const { root } = renderDialog(container);
    await flush();

    const nameInput = container.querySelector("input[placeholder=\"Project name\"]") as HTMLInputElement;
    await act(async () => {
      setTextInputValue(nameInput, "Scoped project");
    });
    await flush();

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create project"));
    expect(submitButton).not.toBeUndefined();
    expect(submitButton?.hasAttribute("disabled")).toBe(true);

    await act(async () => {
      permissions.resolve([
        {
          permissionKey: "projects:manage",
          companyWide: false,
          departmentIds: ["dept-1"],
        },
      ]);
    });

    await waitForAssertion(() => {
      expect(submitButton?.hasAttribute("disabled")).toBe(false);
    });

    act(() => root.unmount());
  });

  it("filters goal and mention candidates to the selected department scope", async () => {
    mockAccessApi.listMyEffectivePermissions.mockResolvedValue([
      {
        permissionKey: "projects:manage",
        companyWide: false,
        departmentIds: ["dept-1"],
      },
      {
        permissionKey: "org:view",
        companyWide: false,
        departmentIds: ["dept-1"],
      },
    ]);
    mockDepartmentsApi.list.mockResolvedValue([
      { id: "dept-1", companyId: "company-1", name: "Engineering", description: null, parentId: null, status: "active", sortOrder: 0, createdAt: "", updatedAt: "" },
      { id: "dept-2", companyId: "company-1", name: "Finance", description: null, parentId: null, status: "active", sortOrder: 1, createdAt: "", updatedAt: "" },
    ]);
    mockAgentsApi.list.mockResolvedValue([
      {
        id: "agent-1",
        companyId: "company-1",
        departmentId: "dept-1",
        name: "Eng Agent",
        status: "active",
        icon: "bot",
      },
      {
        id: "agent-2",
        companyId: "company-1",
        departmentId: "dept-2",
        name: "Finance Agent",
        status: "active",
        icon: "bot",
      },
    ]);
    mockGoalsApi.list.mockResolvedValue([
      {
        id: "goal-1",
        companyId: "company-1",
        title: "Ship engineering roadmap",
        description: null,
        level: "company",
        status: "active",
        parentId: null,
        ownerAgentId: "agent-1",
        createdAt: "",
        updatedAt: "",
      },
      {
        id: "goal-2",
        companyId: "company-1",
        title: "Close finance books",
        description: null,
        level: "company",
        status: "active",
        parentId: null,
        ownerAgentId: "agent-2",
        createdAt: "",
        updatedAt: "",
      },
    ]);

    const { root } = renderDialog(container);
    await flush();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Ship engineering roadmap");
      expect(container.textContent).not.toContain("Close finance books");
      expect(container.textContent).toContain("Eng Agent");
      expect(container.textContent).not.toContain("Finance Agent");
    });

    act(() => root.unmount());
  });
});
