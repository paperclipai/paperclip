// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  Routine,
  RoutineRevision,
  RoutineRevisionSnapshotV1,
} from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoutineHistoryTab } from "./RoutineHistoryTab";

const mockRoutinesApi = vi.hoisted(() => ({
  listRevisions: vi.fn(),
  restoreRevision: vi.fn(),
}));

vi.mock("../api/routines", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../api/routines");
  return {
    ...actual,
    routinesApi: {
      ...((actual as { routinesApi?: Record<string, unknown> }).routinesApi ?? {}),
      ...mockRoutinesApi,
    },
  };
});

vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, type = "button", disabled, ...props }: ComponentProps<"button">) => (
    <button type={type} onClick={onClick} disabled={disabled} {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: ComponentProps<"input">) => <input {...props} />,
}));

vi.mock("@/components/ui/label", () => ({
  Label: ({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
}));

vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: (props: ComponentProps<"div">) => <div data-testid="skeleton" {...props} />,
}));

const toastSpy = vi.fn();
vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: toastSpy }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function snapshotV1(overrides?: Partial<RoutineRevisionSnapshotV1["routine"]>): RoutineRevisionSnapshotV1 {
  return {
    version: 1,
    routine: {
      id: "routine-1",
      companyId: "company-1",
      projectId: null,
      goalId: null,
      parentIssueId: null,
      title: "Daily standup digest",
      description: "Summarize standup notes",
      assigneeAgentId: null,
      priority: "medium",
      status: "active",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
      variables: [],
      ...overrides,
    },
    triggers: [],
  };
}

function createRevision(overrides: Partial<RoutineRevision> = {}): RoutineRevision {
  return {
    id: overrides.id ?? "revision-1",
    companyId: "company-1",
    routineId: "routine-1",
    revisionNumber: overrides.revisionNumber ?? 1,
    title: "Daily standup digest",
    description: "Summarize standup notes",
    snapshot: overrides.snapshot ?? snapshotV1(),
    changeSummary: null,
    restoredFromRevisionId: null,
    createdByAgentId: null,
    createdByUserId: "user-1",
    createdByRunId: null,
    createdAt: new Date("2026-05-01T12:00:00.000Z"),
    ...overrides,
  };
}

function createRoutine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: "routine-1",
    companyId: "company-1",
    projectId: null,
    goalId: null,
    parentIssueId: null,
    title: "Daily standup digest",
    description: "Summarize standup notes",
    assigneeAgentId: null,
    priority: "medium",
    status: "active",
    concurrencyPolicy: "coalesce_if_active",
    catchUpPolicy: "skip_missed",
    variables: [],
    latestRevisionId: "revision-2",
    latestRevisionNumber: 2,
    createdByAgentId: null,
    createdByUserId: "user-1",
    updatedByAgentId: null,
    updatedByUserId: "user-1",
    lastTriggeredAt: null,
    lastEnqueuedAt: null,
    createdAt: new Date("2026-05-01T11:00:00.000Z"),
    updatedAt: new Date("2026-05-04T12:00:00.000Z"),
    ...overrides,
  };
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

describe("RoutineHistoryTab", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.clearAllMocks();
    toastSpy.mockReset();
  });

  afterEach(() => {
    container.remove();
  });

  async function render(props: Partial<Parameters<typeof RoutineHistoryTab>[0]> = {}) {
    const root = createRoot(container);
    const queryClient = makeQueryClient();
    const routine = props.routine ?? createRoutine();
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RoutineHistoryTab
            routine={routine}
            isEditDirty={false}
            dirtyFields={[]}
            onDiscardEdits={() => {}}
            onSaveEdits={() => {}}
            agents={new Map()}
            projects={new Map()}
            onRestoreSecretMaterials={() => {}}
            {...props}
          />
        </QueryClientProvider>,
      );
    });
    await flush();
    return root;
  }

  it("shows the empty state when only the bootstrap revision exists", async () => {
    mockRoutinesApi.listRevisions.mockResolvedValue([
      createRevision({ id: "revision-1", revisionNumber: 1 }),
    ]);
    await render({
      routine: createRoutine({ latestRevisionId: "revision-1", latestRevisionNumber: 1 }),
    });
    expect(container.textContent).toContain("No edits yet");
    expect(container.textContent).toContain("Revision 1 is the only history");
  });

  it("renders the revision list with current and historical pills", async () => {
    const current = createRevision({
      id: "revision-2",
      revisionNumber: 2,
      changeSummary: "Updated routine",
    });
    const old = createRevision({
      id: "revision-1",
      revisionNumber: 1,
      changeSummary: "Created routine",
    });
    mockRoutinesApi.listRevisions.mockResolvedValue([current, old]);
    await render();
    expect(container.textContent).toContain("rev 2");
    expect(container.textContent).toContain("rev 1");
    expect(container.textContent).toContain("Current");
  });

  it("shows the historical-preview banner with append-only copy when previewing an old revision", async () => {
    const current = createRevision({
      id: "revision-2",
      revisionNumber: 2,
      changeSummary: "Updated routine",
    });
    const old = createRevision({
      id: "revision-1",
      revisionNumber: 1,
      snapshot: snapshotV1({ status: "paused" }),
      changeSummary: "Created routine",
    });
    mockRoutinesApi.listRevisions.mockResolvedValue([current, old]);
    await render();
    const oldRow = container.querySelector(
      "[data-testid='revision-row-1']",
    ) as HTMLButtonElement | null;
    expect(oldRow).not.toBeNull();
    await act(async () => {
      oldRow?.click();
    });
    await flush();
    expect(container.textContent).toContain("Viewing revision 1 (read-only)");
    expect(container.textContent).toContain(
      "Restoring this revision creates a new revision 3 with the same content. History stays append-only.",
    );
    expect(container.textContent).toContain("Status");
    expect(container.textContent).toContain("paused");
    expect(container.textContent).toContain("Restore as new revision");
  });

  it("blocks historical preview and surfaces the conflict banner when local edits are dirty", async () => {
    const current = createRevision({ id: "revision-2", revisionNumber: 2 });
    const old = createRevision({ id: "revision-1", revisionNumber: 1 });
    mockRoutinesApi.listRevisions.mockResolvedValue([current, old]);
    await render({
      isEditDirty: true,
      dirtyFields: [{ key: "description", label: "the description" }],
    });
    expect(container.textContent).toContain("Unsaved routine edits");
    const oldRow = container.querySelector(
      "[data-testid='revision-row-1']",
    ) as HTMLButtonElement | null;
    expect(oldRow?.disabled).toBe(true);
  });

  it("calls restoreRevision and surfaces a success toast after confirming restore", async () => {
    const current = createRevision({ id: "revision-2", revisionNumber: 2 });
    const old = createRevision({ id: "revision-1", revisionNumber: 1 });
    mockRoutinesApi.listRevisions.mockResolvedValue([current, old]);
    mockRoutinesApi.restoreRevision.mockResolvedValue({
      routine: createRoutine({ latestRevisionId: "revision-3", latestRevisionNumber: 3 }),
      revision: createRevision({
        id: "revision-3",
        revisionNumber: 3,
        restoredFromRevisionId: "revision-1",
      }),
      restoredFromRevisionId: "revision-1",
      restoredFromRevisionNumber: 1,
      secretMaterials: [],
    });
    await render();
    const oldRow = container.querySelector(
      "[data-testid='revision-row-1']",
    ) as HTMLButtonElement | null;
    await act(async () => {
      oldRow?.click();
    });
    await flush();
    const restoreButtons = Array.from(container.querySelectorAll("button")).filter(
      (button) => button.textContent === "Restore as new revision",
    );
    expect(restoreButtons.length).toBeGreaterThan(0);
    await act(async () => {
      restoreButtons[0].click();
    });
    await flush();
    expect(container.querySelector("[data-testid='dialog']")).not.toBeNull();
    const confirmButtons = Array.from(container.querySelectorAll("button")).filter((b) =>
      (b.textContent ?? "").includes("Restore as revision 3"),
    );
    expect(confirmButtons.length).toBeGreaterThan(0);
    await act(async () => {
      confirmButtons[0].click();
    });
    await flush();
    expect(mockRoutinesApi.restoreRevision).toHaveBeenCalledWith(
      "routine-1",
      "revision-1",
      { changeSummary: null },
    );
    expect(toastSpy).toHaveBeenCalled();
    const successCall = toastSpy.mock.calls.find(
      (call) => call[0]?.title === "Restored revision 1 as revision 3",
    );
    expect(successCall).toBeTruthy();
  });

  it("invokes onRestored with the restore response so the editor can rehydrate (PAP-3588)", async () => {
    const current = createRevision({ id: "revision-2", revisionNumber: 2 });
    const old = createRevision({
      id: "revision-1",
      revisionNumber: 1,
      snapshot: snapshotV1({ description: "Original description" }),
    });
    mockRoutinesApi.listRevisions.mockResolvedValue([current, old]);
    const restoredRoutine = createRoutine({
      description: "Original description",
      latestRevisionId: "revision-3",
      latestRevisionNumber: 3,
    });
    mockRoutinesApi.restoreRevision.mockResolvedValue({
      routine: restoredRoutine,
      revision: createRevision({
        id: "revision-3",
        revisionNumber: 3,
        restoredFromRevisionId: "revision-1",
      }),
      restoredFromRevisionId: "revision-1",
      restoredFromRevisionNumber: 1,
      secretMaterials: [],
    });
    const onRestored = vi.fn();
    await render({ onRestored });
    const oldRow = container.querySelector(
      "[data-testid='revision-row-1']",
    ) as HTMLButtonElement | null;
    await act(async () => {
      oldRow?.click();
    });
    await flush();
    const restoreButtons = Array.from(container.querySelectorAll("button")).filter(
      (button) => button.textContent === "Restore as new revision",
    );
    await act(async () => {
      restoreButtons[0].click();
    });
    await flush();
    const confirmButtons = Array.from(container.querySelectorAll("button")).filter((b) =>
      (b.textContent ?? "").includes("Restore as revision 3"),
    );
    await act(async () => {
      confirmButtons[0].click();
    });
    await flush();
    expect(onRestored).toHaveBeenCalledTimes(1);
    const [response] = onRestored.mock.calls[0];
    expect(response.routine).toEqual(restoredRoutine);
    expect(response.revision.id).toBe("revision-3");
  });
});
