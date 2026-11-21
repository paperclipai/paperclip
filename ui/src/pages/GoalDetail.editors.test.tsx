// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Goal } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../lib/queryKeys";
import { GoalDetail } from "./GoalDetail";

type EditorPropsForTest = {
  value: string;
  onSave: (value: string) => void | Promise<unknown>;
  draftKey?: string;
  readCurrentValue?: () => Promise<string>;
};

const mockEditors = vi.hoisted(() => ({ current: [] as EditorPropsForTest[] }));
const mockRoute = vi.hoisted(() => ({ goalId: "goal-a" }));
const mockGoalsApi = vi.hoisted(() => ({ get: vi.fn(), list: vi.fn(), update: vi.fn() }));
const mockProjectsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockAssetsApi = vi.hoisted(() => ({ uploadImage: vi.fn() }));
const mockCompany = vi.hoisted(() => ({ selectedCompanyId: "company-a", setSelectedCompanyId: vi.fn() }));
const mockPanel = vi.hoisted(() => ({
  openPanel: vi.fn(),
  closePanel: vi.fn(),
  panelVisible: false,
  setPanelVisible: vi.fn(),
}));
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockOpenNewGoal = vi.hoisted(() => vi.fn());

vi.mock("../api/goals", () => ({ goalsApi: mockGoalsApi }));
vi.mock("../api/projects", () => ({ projectsApi: mockProjectsApi }));
vi.mock("../api/assets", () => ({ assetsApi: mockAssetsApi }));
vi.mock("@/lib/router", () => ({ useParams: () => ({ goalId: mockRoute.goalId }) }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => mockCompany }));
vi.mock("../context/PanelContext", () => ({ usePanel: () => mockPanel }));
vi.mock("../context/DialogContext", () => ({ useDialogActions: () => ({ openNewGoal: mockOpenNewGoal }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }) }));
vi.mock("../components/GoalProperties", () => ({ GoalProperties: () => null }));
vi.mock("../components/GoalTree", () => ({ GoalTree: () => null }));
vi.mock("../components/StatusBadge", () => ({ StatusBadge: () => null }));
vi.mock("../components/EntityRow", () => ({ EntityRow: () => null }));
vi.mock("../components/InlineEditor", () => ({
  InlineEditor: (props: EditorPropsForTest) => {
    mockEditors.current.push(props);
    return <div data-testid="inline-editor">{props.value}</div>;
  },
}));
vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  TabsContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const serverGoals = new Map<string, Goal>();

function makeGoal(id: string, companyId: string): Goal {
  return {
    id,
    companyId,
    title: "Title " + id,
    description: "Description " + id,
    parentId: null,
    level: "company",
    status: "active",
  } as Goal;
}

let root: Root | null = null;
let container: HTMLDivElement;
let client: QueryClient | null = null;

function editorFor(value: string): EditorPropsForTest {
  const found = [...mockEditors.current].reverse().find((entry) => entry.value === value);
  if (!found) throw new Error("InlineEditor with value " + value + " was not rendered");
  return found;
}

async function settle() {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function pageTree(queryClient: QueryClient) {
  return (
    <QueryClientProvider client={queryClient}>
      <GoalDetail />
    </QueryClientProvider>
  );
}

async function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  client = queryClient;
  root = createRoot(container);
  await act(async () => root!.render(pageTree(queryClient)));
  await settle();
  return {
    client: queryClient,
    rerender: async () => {
      await act(async () => root!.render(pageTree(queryClient)));
      await settle();
    },
  };
}

beforeEach(() => {
  mockRoute.goalId = "goal-a";
  mockCompany.selectedCompanyId = "company-a";
  mockEditors.current = [];
  serverGoals.clear();
  serverGoals.set("goal-a", makeGoal("goal-a", "company-a"));
  serverGoals.set("goal-b", makeGoal("goal-b", "company-b"));
  mockGoalsApi.get.mockImplementation(async (id: string) => {
    const result = serverGoals.get(id);
    if (!result) throw new Error("Unknown goal: " + id);
    return result;
  });
  mockGoalsApi.list.mockResolvedValue([]);
  mockGoalsApi.update.mockImplementation(async (id: string, data: Record<string, unknown>) => ({
    ...serverGoals.get(id),
    ...data,
  }));
  mockProjectsApi.list.mockResolvedValue([]);
  mockAssetsApi.uploadImage.mockResolvedValue({ contentPath: "/assets/test.png" });
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = null;
  }
  client?.clear();
  client = null;
  container?.remove();
  vi.clearAllMocks();
});

describe("GoalDetail inline editors", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  it.each([
    { field: "title", original: "Title goal-a", edited: "Updated title" },
    { field: "description", original: "Description goal-a", edited: "Updated description" },
  ])("returns the failed $field PATCH promise to InlineEditor", async ({ field, original, edited }) => {
    await renderPage();
    const editor = editorFor(original);
    mockGoalsApi.update.mockRejectedValueOnce(new Error(field + " PATCH failed"));

    await expect(editor.onSave(edited)).rejects.toThrow(field + " PATCH failed");
    expect(mockGoalsApi.update).toHaveBeenCalledWith("goal-a", { [field]: edited });
  });

  it("isolates each goal draft and binds a delayed save to its original goal", async () => {
    const page = await renderPage();
    const titleA = editorFor("Title goal-a");
    const descriptionA = editorFor("Description goal-a");

    expect(titleA.draftKey).toBe("goal:goal-a:title");
    expect(descriptionA.draftKey).toBe("goal:goal-a:description");
    expect(titleA.readCurrentValue).toBeTypeOf("function");
    expect(descriptionA.readCurrentValue).toBeTypeOf("function");

    mockGoalsApi.get.mockResolvedValueOnce({ ...makeGoal("goal-a", "company-a"), title: "Fresh title" });
    mockGoalsApi.get.mockResolvedValueOnce({ ...makeGoal("goal-a", "company-a"), description: "Fresh description" });
    await expect(titleA.readCurrentValue?.()).resolves.toBe("Fresh title");
    expect(mockGoalsApi.get).toHaveBeenLastCalledWith("goal-a", {
      fresh: true,
      cache: "no-store",
    });

    await expect(descriptionA.readCurrentValue?.()).resolves.toBe("Fresh description");
    expect(mockGoalsApi.get).toHaveBeenLastCalledWith("goal-a", {
      fresh: true,
      cache: "no-store",
    });

    const invalidate = vi.spyOn(page.client, "invalidateQueries");
    mockRoute.goalId = "goal-b";
    await page.rerender();

    await titleA.onSave("Late edit for goal A");

    expect(mockGoalsApi.update).toHaveBeenCalledWith("goal-a", { title: "Late edit for goal A" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.goals.detail("goal-a") });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.goals.list("company-a") });
    expect(mockEditors.current.some((entry) => entry.draftKey === "goal:goal-b:title")).toBe(true);
  });
});
