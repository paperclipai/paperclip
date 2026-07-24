// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AttentionItem,
  DecisionTrainingExample,
  DecisionTrainingPreview,
} from "@paperclipai/shared";

const mockApi = vi.hoisted(() => ({
  preview: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  updateNotes: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("../api/decisionTraining", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api/decisionTraining")>();
  return { ...original, decisionTrainingApi: mockApi };
});

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: React.ComponentProps<"a"> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { DecisionTrainingDrawer } from "./DecisionTrainingDrawer";
import { ToastProvider } from "../context/ToastContext";

function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> | undefined;
  flushSync(() => {
    result = callback();
  });
  return result;
}

async function waitFor(predicate: () => boolean, attempts = 40): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  throw new Error("waitFor predicate did not become true");
}

function setTextareaValue(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Text query across the whole document (Radix portals content into body). */
function bodyText(): string {
  return document.body.textContent ?? "";
}

function findButton(label: string): HTMLButtonElement | null {
  return [...document.body.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim().includes(label),
  ) as HTMLButtonElement | null;
}

/** Buttons or anchors (asChild renders the trigger as its child element). */
function findClickable(label: string): HTMLElement | null {
  return [...document.body.querySelectorAll("button, a")].find(
    (el) => (el.textContent ?? "").trim().includes(label),
  ) as HTMLElement | null;
}

function buildItem(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: "row-1",
    companyId: "c1",
    sourceKind: "issue_thread_interaction",
    subject: {
      kind: "interaction",
      id: "interaction-1",
      companyId: "c1",
      title: "Approve the migration plan?",
      identifier: null,
      status: "pending",
      href: "/tasks/task-1",
      metadata: { issueId: "issue-1", kind: "request_confirmation" },
    },
    whyNow: "",
    decisionVerbs: [],
    inlineResolvable: true,
    entryRule: "",
    exitRule: "",
    dedupKey: "interaction:interaction-1",
    dismissalKey: "attention:interaction:interaction-1",
    severity: "medium",
    rank: 0,
    activityAt: "2026-07-09T12:00:00Z",
    createdAt: "2026-07-09T12:00:00Z",
    updatedAt: "2026-07-09T12:00:00Z",
    relatedIssue: null,
    project: null,
    workspace: null,
    detail: null,
    dismissal: null,
    trainingExampleId: null,
    ...overrides,
  };
}

function buildSnapshot(): DecisionTrainingExample["snapshot"] {
  return {
    version: 1,
    capturedAt: "2026-07-10T00:00:00Z",
    cutoff: { at: "2026-07-10T00:00:00Z", lastCommentId: "comment-abcdef12", commentCount: 3 },
    issue: {},
    comments: [{}, {}, {}],
    runs: [{}, {}],
    decision: { kind: "interaction", payload: {}, actor: null, outcome: "accepted" },
    code: { repoUrl: "r", ref: "main", commitSha: "0123456789abcdef", resolution: "exact" },
  };
}

function buildPreview(): DecisionTrainingPreview {
  return { cutoffAt: "2026-07-10T00:00:00Z", decisionOutcome: "accepted", snapshot: buildSnapshot() };
}

function buildExample(overrides: Partial<DecisionTrainingExample> = {}): DecisionTrainingExample {
  return {
    id: "example-1",
    companyId: "c1",
    sourceKind: "interaction",
    sourceId: "interaction-1",
    issueId: "issue-1",
    cutoffAt: "2026-07-10T00:00:00Z",
    notes: "I accepted because the plan covered rollback.",
    notesHistory: [],
    decisionOutcome: "accepted",
    snapshot: buildSnapshot(),
    createdByUserId: "user-1",
    createdAt: "2026-07-10T00:00:00Z",
    updatedAt: "2026-07-10T00:00:00Z",
    ...overrides,
    retentionPolicy: overrides.retentionPolicy ?? "scrub_deleted_comments_v1",
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function render(node: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });
  root = createRoot(container);
  act(() => {
    root.render(
      <ToastProvider>
        <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
      </ToastProvider>,
    );
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  Object.values(mockApi).forEach((fn) => fn.mockReset());
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("DecisionTrainingDrawer — create state", () => {
  it("previews the frozen snapshot and saves an example", async () => {
    mockApi.preview.mockResolvedValue(buildPreview());
    mockApi.create.mockResolvedValue(buildExample());

    render(
      <DecisionTrainingDrawer open onOpenChange={() => {}} companyId="c1" item={buildItem()} />,
    );

    await waitFor(() => bodyText().includes("before cutoff"));

    // Snapshot preview surfaces cutoff, comment/run counts and the commit.
    expect(bodyText()).toContain("3 · last comment-");
    expect(bodyText()).toContain("2 before cutoff");
    expect(bodyText()).toContain("0123456789");
    expect(bodyText()).toContain("Resolved · accepted");

    const textarea = document.body.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    act(() => setTextareaValue(textarea, "Trusting the rollback plan."));

    await act(() => findButton("Save example")?.click());
    await waitFor(() => mockApi.create.mock.calls.length > 0);

    expect(mockApi.create).toHaveBeenCalledWith("c1", {
      sourceKind: "interaction",
      sourceId: "interaction-1",
      issueId: "issue-1",
      notes: "Trusting the rollback plan.",
    });
  });

  it("refuses to train a decision with no issue anchor", () => {
    const item = buildItem({ subject: { ...buildItem().subject, metadata: {} }, relatedIssue: null });
    render(<DecisionTrainingDrawer open onOpenChange={() => {}} companyId="c1" item={item} />);
    expect(bodyText()).toContain("isn't anchored to an issue");
    expect(mockApi.preview).not.toHaveBeenCalled();
  });
});

describe("DecisionTrainingDrawer — saved state", () => {
  it("shows provenance and a read-only snapshot, and round-trips notes edits", async () => {
    mockApi.get.mockResolvedValue(buildExample());
    mockApi.updateNotes.mockResolvedValue(buildExample({ notes: "Revised reasoning.", updatedAt: "2026-07-11T00:00:00Z" }));

    render(
      <DecisionTrainingDrawer
        open
        onOpenChange={() => {}}
        companyId="c1"
        item={buildItem({ trainingExampleId: "example-1" })}
        currentUserId="user-1"
      />,
    );

    expect(bodyText()).toContain("Training example");
    expect(bodyText()).not.toContain("Train this decision");
    expect(mockApi.preview).not.toHaveBeenCalled();
    await waitFor(() => bodyText().includes("Frozen state"));
    expect(bodyText()).toContain("You"); // provenance author
    expect(bodyText()).toContain("Read-only"); // snapshot is visibly read-only
    expect(bodyText()).toContain("I accepted because the plan covered rollback.");
    expect(findClickable("Open full record")).toBeTruthy();

    await act(() => findButton("Edit")?.click());
    const textarea = document.body.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    act(() => setTextareaValue(textarea, "Revised reasoning."));
    await act(() => findButton("Save notes")?.click());
    await waitFor(() => mockApi.updateNotes.mock.calls.length > 0);

    expect(mockApi.updateNotes).toHaveBeenCalledWith("example-1", "Revised reasoning.");
  });

  it("deletes after confirmation", async () => {
    mockApi.get.mockResolvedValue(buildExample());
    mockApi.delete.mockResolvedValue(undefined);
    const onOpenChange = vi.fn();

    render(
      <DecisionTrainingDrawer
        open
        onOpenChange={onOpenChange}
        companyId="c1"
        item={buildItem({ trainingExampleId: "example-1" })}
        currentUserId="user-1"
      />,
    );

    await waitFor(() => bodyText().includes("Frozen state"));
    await act(() => {
      findButton("Delete")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    // Confirm dialog action.
    await waitFor(() => bodyText().includes("Delete this training example?"));
    const confirm = document.body.querySelector<HTMLButtonElement>(
      '[data-slot="alert-dialog-action"]',
    );
    expect(confirm).toBeTruthy();
    await act(() => {
      confirm?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await waitFor(() => mockApi.delete.mock.calls.length > 0);

    expect(mockApi.delete).toHaveBeenCalledWith("example-1");
  });
});
