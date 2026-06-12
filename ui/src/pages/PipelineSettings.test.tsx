// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import type { CompanyUserDirectoryResponse } from "../api/access";
import type { PipelineDetail } from "../api/pipelines";
import { agentsApi } from "../api/agents";
import { accessApi } from "../api/access";
import { pipelinesApi } from "../api/pipelines";
import { ApiError } from "../api/client";
import { PipelineSettings } from "./PipelineSettings";

// MarkdownEditor pulls in heavy Lexical/sandpack deps that crash jsdom at import.
// Mock it with a controllable textarea so tests can drive the instructions body
// (and the real RoutineVariablesEditor still syncs against it).
vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
  }) => (
    <textarea
      aria-label="Stage instructions"
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
  useParams: () => ({ pipelineId: "pipeline-1" }),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makePipeline(): PipelineDetail {
  return {
    id: "pipeline-1",
    companyId: "company-1",
    key: "content_pipeline",
    name: "Content pipeline",
    description: "Publish useful work",
    projectId: null,
    enforceTransitions: false,
    archivedAt: null,
    stageCount: 2,
    openCaseCount: 0,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    stages: [
      {
        id: "stage-1",
        pipelineId: "pipeline-1",
        key: "intake",
        name: "Intake",
        kind: "working",
        position: 100,
        config: {
          variables: [
            {
              key: "customer",
              label: "Customer",
              type: "text",
              options: [],
              required: true,
              showInAddForm: true,
            },
          ],
          disabled: false,
          requireApproval: false,
          approver: { kind: "any_human" },
          automation: {
            assigneeAgentId: "agent-1",
            instructionsBody: "Collect requests.",
          },
          whatHappensHere: "Collect requests.",
        },
      },
      {
        id: "stage-2",
        pipelineId: "pipeline-1",
        key: "review",
        name: "Review",
        kind: "review",
        position: 200,
        config: {
          variables: [],
          approveToStageKey: "intake",
          rejectToStageKey: "intake",
        },
      },
    ],
    transitions: [{ fromStageId: "stage-1", toStageId: "stage-2" }],
    documentKeys: [{ key: "guidance", documentId: "doc-1" }],
  };
}

function renderSettings() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <PipelineSettings />
      </QueryClientProvider>,
    );
  });

  return { container, root, queryClient };
}

async function flushQueries() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function setNativeValue(element: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const valueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  valueSetter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function findButton(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes(text)) as
    | HTMLButtonElement
    | undefined;
}

async function chooseStepType(container: HTMLElement, label: string) {
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Step type"]')!;
  flushSync(() => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false }));
  });
  await flushQueries();

  const item = Array.from(document.body.querySelectorAll('[role="menuitemradio"]')).find((menuItem) =>
    menuItem.textContent?.includes(label),
  ) as HTMLElement | undefined;
  expect(item).toBeTruthy();
  flushSync(() => {
    item!.click();
  });
  await flushQueries();
}

describe("PipelineSettings", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.spyOn(pipelinesApi, "get").mockResolvedValue(makePipeline());
    vi.spyOn(pipelinesApi, "updateStage").mockResolvedValue(makePipeline().stages[0]!);
    vi.spyOn(pipelinesApi, "setTransitions").mockResolvedValue({ transitions: [] });
    vi.spyOn(pipelinesApi, "deleteStage").mockResolvedValue({ deleted: true });
    vi.spyOn(pipelinesApi, "createStage").mockResolvedValue({
      id: "stage-3",
      pipelineId: "pipeline-1",
      key: "new_stage",
      name: "New stage",
      kind: "working",
      position: 101,
      config: { variables: [] },
    });
    // Per-stage instructions docs 404 by default so the editor falls back to
    // legacy `config.whatHappensHere`.
    vi.spyOn(pipelinesApi, "getDocument").mockImplementation(async () => {
      throw new ApiError("Pipeline document not found", 404, null);
    });
    vi.spyOn(pipelinesApi, "upsertDocument").mockResolvedValue({
      document: { id: "doc-stage", title: "Stage instructions", latestBody: "Updated." },
      revision: { body: "Updated.", title: "Stage instructions" },
    });
    vi.spyOn(pipelinesApi, "listDocumentRevisions").mockResolvedValue([]);
    vi.spyOn(pipelinesApi, "restoreDocumentRevision").mockResolvedValue({
      document: { id: "doc-stage", title: "Stage instructions", latestBody: "Restored body." },
      revision: {
        id: "rev-restored",
        companyId: "company-1",
        documentId: "doc-stage",
        pipelineId: "pipeline-1",
        key: "stage-instructions:stage-1",
        revisionNumber: 3,
        title: null,
        format: "markdown",
        body: "Restored body.",
        changeSummary: "Restored from revision 1",
        createdByAgentId: null,
        createdByUserId: null,
        createdAt: "2026-06-01T00:00:00.000Z",
      },
      restoredFromRevisionId: "rev-1",
      restoredFromRevisionNumber: 1,
    });
    vi.spyOn(pipelinesApi, "update").mockResolvedValue(makePipeline());
    vi.spyOn(pipelinesApi, "getHealth").mockResolvedValue({ pipelineId: "pipeline-1", warnings: [], ok: true });
    vi.spyOn(agentsApi, "list").mockResolvedValue([
      { id: "agent-1", name: "QA Agent", role: "QA", status: "active" } as unknown as Agent,
    ]);
    vi.spyOn(accessApi, "listUserDirectory").mockResolvedValue({
      users: [
        {
          principalId: "user-1",
          status: "active",
          user: { id: "user-1", name: "Ada Human", email: "ada@example.com", image: null },
        },
      ],
    } as unknown as CompanyUserDirectoryResponse);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("does not render top-level guidance settings", async () => {
    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    const tabLabels = Array.from(container.querySelectorAll("[data-tab-value]")).map((tab) => tab.textContent);
    expect(tabLabels).toEqual([]);
    expect(container.textContent).not.toContain("Guidance");
    expect(container.textContent).not.toContain("Pipeline guidance");
    expect(pipelinesApi.getDocument).not.toHaveBeenCalledWith("pipeline-1", "guidance");

    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("renders the Automation section and drops the old plain-text fields", async () => {
    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    flushSync(() => {
      findButton(container, "Automation")!.click();
    });

    const headings = Array.from(container.querySelectorAll("h2")).map((heading) => heading.textContent ?? "");
    expect(headings).toContain("Automation");
    expect(headings).not.toContain("What happens here");
    expect(headings).not.toContain("Routine variables");
    expect(container.textContent).toContain("When an item enters this step");
    expect(container.textContent).toContain("runs these instructions, then moves the item to the next step.");
    // The instructions body is the mocked MarkdownEditor, not a plain Textarea.
    expect(container.querySelector('[aria-label="Stage instructions"]')).not.toBeNull();

    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("shows the approver picker only for review stages", async () => {
    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    const stepTypeTrigger = container.querySelector<HTMLButtonElement>('button[aria-label="Step type"]')!;
    expect(stepTypeTrigger).toBeTruthy();
    expect(stepTypeTrigger.textContent).toContain("Working");
    expect(stepTypeTrigger.querySelector("svg")).not.toBeNull();
    expect(container.textContent).toContain("Items wait here while work happens.");
    expect(container.querySelector('input[name="stage-kind"]')).toBeNull();
    expect(container.querySelector('[aria-label="Approval picker"]')).toBeNull();
    expect(container.textContent).not.toContain("Require approval");
    expect(container.textContent).not.toContain("Any human");

    await chooseStepType(container, "Review");

    expect(container.querySelector('[aria-label="Approval picker"]')).toBeNull();
    expect(container.textContent).toContain("Approver");
    expect(container.textContent).toContain("Any human");
    expect(container.textContent).toContain("Someone has to approve before items leave.");

    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("gates archiving behind the pipeline name", async () => {
    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    const actionsButton = container.querySelector<HTMLButtonElement>('button[title="Pipeline actions"]')!;
    flushSync(() => {
      actionsButton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false }));
    });
    await flushQueries();

    const menuArchiveButton = Array.from(document.body.querySelectorAll("div[role='menuitem']")).find((button) =>
      button.textContent?.includes("Archive pipeline"),
    ) as HTMLElement | undefined;
    expect(menuArchiveButton).toBeTruthy();
    flushSync(() => {
      menuArchiveButton!.click();
    });
    await flushQueries();

    const archiveButton = Array.from(document.body.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Archive pipeline"),
    ) as HTMLButtonElement | undefined;
    expect(archiveButton?.disabled).toBe(true);

    const input = document.body.querySelector<HTMLInputElement>('[aria-label="Archive confirmation"]')!;
    flushSync(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      valueSetter?.call(input, "Content pipeline");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(archiveButton?.disabled).toBe(false);

    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("deletes the selected stage and moves existing items to another stage", async () => {
    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    const deleteButton = container.querySelector<HTMLButtonElement>('button[aria-label="Delete Intake"]')!;
    expect(deleteButton).toBeTruthy();
    flushSync(() => {
      deleteButton.click();
    });
    await flushQueries();

    const moveTarget = document.body.querySelector<HTMLSelectElement>('[aria-label="Move existing items to"]')!;
    expect(moveTarget.value).toBe("stage-2");
    const confirmButton = Array.from(document.body.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Delete stage"),
    ) as HTMLButtonElement | undefined;
    expect(confirmButton).toBeTruthy();

    flushSync(() => {
      confirmButton!.click();
    });
    await flushQueries();

    expect(pipelinesApi.deleteStage).toHaveBeenCalledWith("pipeline-1", "stage-1", {
      moveCasesToStageId: "stage-2",
    });

    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("seeds the instructions body from legacy whatHappensHere when no document exists", async () => {
    const legacyPipeline = makePipeline();
    legacyPipeline.stages[0]!.config = {
      ...legacyPipeline.stages[0]!.config,
      automation: { assigneeAgentId: "agent-1", instructionsBody: null },
      whatHappensHere: "Legacy body.",
    };
    (pipelinesApi.get as unknown as { mockResolvedValueOnce: (value: unknown) => void }).mockResolvedValueOnce(legacyPipeline);
    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    flushSync(() => {
      findButton(container, "Automation")!.click();
    });

    const editor = container.querySelector<HTMLTextAreaElement>('[aria-label="Stage instructions"]')!;
    expect(editor.value).toBe("Legacy body.");

    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("surfaces stage health warnings on the stage card and selected settings panel", async () => {
    (pipelinesApi.getHealth as unknown as { mockResolvedValueOnce: (value: unknown) => void }).mockResolvedValueOnce({
      pipelineId: "pipeline-1",
      ok: false,
      warnings: [
        {
          code: "stage_no_automation",
          stageId: "stage-1",
          stageKey: "intake",
          stageName: "Intake",
          message:
            "Nothing runs here automatically — items will sit until a person moves them. Add an agent to run this step, or make it a review step if a person should decide.",
        },
      ],
    });
    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    expect(container.querySelector('button[aria-label="Intake, 1 warning"]')).not.toBeNull();
    expect(container.textContent).toContain("This step won't run yet");
    expect(container.textContent).toContain("Nothing runs here automatically");

    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("does not render insert-stage controls after terminal stages", async () => {
    const terminalPipeline = makePipeline();
    terminalPipeline.stages = [
      ...terminalPipeline.stages,
      {
        id: "stage-3",
        pipelineId: "pipeline-1",
        key: "covered",
        name: "Covered",
        kind: "done",
        position: 300,
        config: { variables: [] },
      },
      {
        id: "stage-4",
        pipelineId: "pipeline-1",
        key: "cancelled",
        name: "Cancelled",
        kind: "cancelled",
        position: 400,
        config: { variables: [] },
      },
    ];
    (pipelinesApi.get as unknown as { mockResolvedValueOnce: (value: unknown) => void }).mockResolvedValueOnce(terminalPipeline);

    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    expect(container.querySelector('button[aria-label="Insert stage after Intake"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Insert stage after Covered"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Insert stage after Cancelled"]')).toBeNull();

    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("syncs variables from escaped {{snake_case}} tokens and saves body + variables in one action", async () => {
    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    flushSync(() => {
      findButton(container, "Automation")!.click();
    });

    const editor = container.querySelector<HTMLTextAreaElement>('[aria-label="Stage instructions"]')!;
    flushSync(() => {
      setNativeValue(editor, "Draft {{customer\\_name}} for the {{event\\_date}} channel");
    });
    await flushQueries();
    // The real RoutineVariablesEditor detected and surfaced both variables.
    expect(container.textContent).toContain("{{customer_name}}");
    expect(container.textContent).toContain("{{event_date}}");

    const saveButton = findButton(container, "Save stage")!;
    expect(saveButton).toBeTruthy();
    flushSync(() => {
      saveButton.click();
    });
    await flushQueries();

    expect(pipelinesApi.upsertDocument).not.toHaveBeenCalledWith(
      "pipeline-1",
      "stage-instructions:stage-1",
      expect.anything(),
    );
    // One save action asks the server to sync the backing routine and persists
    // the synced routine variables in the stage config.
    const updateStageCalls = (pipelinesApi.updateStage as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const lastConfig = (updateStageCalls.at(-1)?.[2] as {
      config: {
        automation: { assigneeAgentId: string | null; instructionsBody: string };
        variables: Array<{ name: string }>;
      };
    }).config;
    expect(lastConfig.automation).toEqual({
      assigneeAgentId: "agent-1",
      instructionsBody: "Draft {{customer\\_name}} for the {{event\\_date}} channel",
    });
    expect(lastConfig.variables.map((variable) => variable.name)).toEqual(["customer_name", "event_date"]);

    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
  });

});
