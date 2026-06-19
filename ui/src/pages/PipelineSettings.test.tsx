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
vi.mock("../components/MarkdownEditor", async () => {
  const React = await import("react");
  return {
    MarkdownEditor: React.forwardRef(({
    value,
    onChange,
    placeholder,
  }: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
  }, ref) => {
    const textareaRef = React.useRef<HTMLTextAreaElement>(null);
    React.useImperativeHandle(ref, () => ({
      focus: () => textareaRef.current?.focus(),
      insertMarkdown: (markdown: string) => {
        const textarea = textareaRef.current;
        const start = textarea?.selectionStart ?? value.length;
        const end = textarea?.selectionEnd ?? start;
        onChange(`${value.slice(0, start)}${markdown}${value.slice(end)}`);
      },
    }), [onChange, value]);
    return (
      <textarea
        ref={textareaRef}
        aria-label="Stage instructions"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }),
  };
});

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

function makeBreakdownPipeline(): PipelineDetail {
  const pipeline = makePipeline();
  pipeline.stages = pipeline.stages.map((stage) =>
    stage.id === "stage-1"
      ? {
          ...stage,
          config: {
            ...stage.config,
            variables: [
              {
                key: "release",
                label: "Release",
                type: "text",
                options: [],
                required: true,
                showInAddForm: true,
              },
              {
                key: "owner",
                label: "Owner",
                type: "text",
                options: [],
                required: false,
                showInAddForm: true,
              },
              {
                key: "title",
                label: "Title",
                type: "text",
                options: [],
                required: false,
                showInAddForm: true,
              },
            ],
            breakdown: {
              targetPipelineId: "pipeline-2",
              targetStageKey: "incoming",
              pieceNoun: "task",
              carryOverPolicy: { version: 1, mode: "all_except", includeFields: [], excludeFields: [] },
              inheritFields: ["release", "owner"],
              advanceTo: "review",
              waitForPieces: false,
              whenFinishedMoveTo: null,
            },
          },
        }
      : stage,
  );
  return pipeline;
}

function makeChildPipeline(): PipelineDetail {
  return {
    ...makePipeline(),
    id: "pipeline-2",
    key: "piece_pipeline",
    name: "Piece pipeline",
    stages: [
      {
        id: "piece-stage-1",
        pipelineId: "pipeline-2",
        key: "incoming",
        name: "Incoming",
        kind: "working",
        position: 100,
        config: {
          variables: [],
          automation: {
            assigneeAgentId: "agent-1",
            instructionsBody: "Use incoming details.",
          },
        },
      },
      {
        id: "piece-stage-2",
        pipelineId: "pipeline-2",
        key: "review",
        name: "Review",
        kind: "review",
        position: 200,
        config: { variables: [] },
      },
    ],
    transitions: [],
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
    vi.spyOn(pipelinesApi, "listCompanyCaseEvents").mockResolvedValue({
      items: [],
      pagination: { limit: 75, offset: 0, nextOffset: null, hasMore: false },
    });
    vi.spyOn(pipelinesApi, "list").mockResolvedValue([
      makePipeline(),
      {
        ...makePipeline(),
        id: "pipeline-2",
        key: "piece_pipeline",
        name: "Piece pipeline",
        stages: [
          {
            id: "piece-stage-1",
            pipelineId: "pipeline-2",
            key: "incoming",
            name: "Incoming",
            kind: "working",
            position: 100,
            config: {
              variables: [
                {
                  key: "release",
                  label: "Release",
                  type: "text",
                  options: [],
                  required: true,
                },
              ],
            },
          },
        ],
      },
    ]);
    vi.spyOn(pipelinesApi, "getIntakeForm").mockResolvedValue({
      pipelineId: "pipeline-2",
      stageId: "piece-stage-1",
      stageName: "Incoming",
      fields: [{ key: "release", label: "Release", type: "text", required: true }],
    });
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

  it("renders the combined Automation section without the old Overview tab", async () => {
    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    const headings = Array.from(container.querySelectorAll("h2")).map((heading) => heading.textContent ?? "");
    expect(headings).toContain("Automation");
    expect(headings).not.toContain("Overview");
    expect(findButton(container, "Overview")).toBeUndefined();
    expect(container.textContent).toContain("Name");
    expect(container.textContent).toContain("Step type");
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

  it("orders stage settings before activity and removes the Runs section", async () => {
    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    const stageSectionButtons = Array.from(
      container.querySelectorAll<HTMLElement>('nav[aria-label="Stage sections"] button'),
    ).map((button) => button.textContent?.trim() ?? "");

    expect(stageSectionButtons).toEqual(["Automation", "Advanced", "Secrets", "Activity", "History"]);
    expect(stageSectionButtons).not.toContain("Runs");

    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("shows run-backed stage events in Activity", async () => {
    vi.mocked(pipelinesApi.listCompanyCaseEvents).mockResolvedValue({
      items: [
        {
          id: "event-1",
          companyId: "company-1",
          caseId: "case-1",
          type: "case.automation_executed",
          actorType: "agent",
          actorAgentId: "agent-1",
          actorUserId: null,
          runId: "run-1",
          fromStageId: null,
          toStageId: "stage-1",
          payload: {},
          case: { id: "case-1", caseKey: "CASE-1", title: "Launch checklist" },
          pipeline: { id: "pipeline-1", key: "content_pipeline", name: "Content pipeline" },
          fromStage: null,
          toStage: { id: "stage-1", key: "intake", name: "Intake", kind: "working" },
          actorAgent: { id: "agent-1", name: "QA Agent" },
          automation: {
            routine: { id: "routine-1", title: "Intake automation" },
            issue: { id: "issue-1", identifier: "PAP-1", title: "Run intake", status: "done" },
            routineRunId: "routine-run-1",
            stage: { id: "stage-1", key: "intake", name: "Intake", kind: "working" },
          },
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
        },
      ],
      pagination: { limit: 75, offset: 0, nextOffset: null, hasMore: false },
    });
    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    flushSync(() => {
      findButton(container, "Activity")!.click();
    });
    await flushQueries();

    expect(pipelinesApi.listCompanyCaseEvents).toHaveBeenCalledWith("company-1", { limit: 75 });
    expect(container.textContent).toContain("Launch checklist");
    expect(container.textContent).toContain("Automation completed");
    expect(container.textContent).toContain("Intake automation");
    expect(container.textContent).toContain("PAP-1");

    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("shows intake fields only in the lower editor", async () => {
    const intakePipeline = makePipeline();
    const intakeStage = intakePipeline.stages[0]!;
    const intakeStageConfig =
      intakeStage.config && typeof intakeStage.config === "object" && !Array.isArray(intakeStage.config)
        ? intakeStage.config
        : {};
    const existingVariables = Array.isArray(intakeStageConfig.variables) ? intakeStageConfig.variables : [];
    intakeStage.config = {
      ...intakeStageConfig,
      variables: [
        ...existingVariables,
        {
          key: "internal_note",
          label: "Internal note",
          type: "text",
          options: [],
          required: false,
          showInAddForm: false,
        },
        {
          name: "release_tag",
          label: "Release tag",
          type: "text",
          options: [],
          required: true,
          defaultValue: "v2.1.0",
        },
        {
          name: "feature_angle",
          label: "Feature angle",
          type: "select",
          options: ["Reliability", "Workflow clarity"],
          required: false,
          defaultValue: "Workflow clarity",
        },
      ],
    };
    vi.mocked(pipelinesApi.get).mockResolvedValue(intakePipeline);

    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    expect(container.textContent).toContain("Intake fields");
    expect(container.textContent).not.toContain("These fields power Add item forms and other pipelines' Carry over pickers.");
    expect(container.textContent).toContain("{{customer}}");
    expect(container.textContent).toContain("{{release_tag}}");
    expect(container.textContent).toContain("{{feature_angle}}");
    expect(
      Array.from(container.querySelectorAll<HTMLInputElement>("input")).some((input) =>
        input.value === "Customer"
      ),
    ).toBe(true);
    expect(
      Array.from(container.querySelectorAll<HTMLInputElement>("input")).some((input) =>
        input.value === "Release tag"
      ),
    ).toBe(true);
    expect(
      Array.from(container.querySelectorAll<HTMLInputElement>("input")).some((input) =>
        input.value === "Feature angle"
      ),
    ).toBe(true);
    expect(
      Array.from(container.querySelectorAll<HTMLInputElement>("input")).some((input) =>
        input.value === "Reliability, Workflow clarity"
      ),
    ).toBe(true);

    const reviewStageButton = container.querySelector<HTMLButtonElement>('button[aria-label="Review"]')!;
    flushSync(() => {
      reviewStageButton.click();
    });
    await flushQueries();

    expect(container.textContent).not.toContain("These fields power Add item forms and other pipelines' Carry over pickers.");
    expect(container.textContent).not.toContain("Customer");
    expect(container.textContent).toContain("No intake fields yet.");

    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("keeps the active detail tab when switching stages", async () => {
    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    flushSync(() => {
      findButton(container, "Automation")!.click();
    });

    expect(Array.from(container.querySelectorAll("h2")).map((heading) => heading.textContent ?? "")).toContain("Automation");
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Stage instructions"]')?.value).toBe("Collect requests.");

    const reviewStageButton = container.querySelector<HTMLButtonElement>('button[aria-label="Review"]')!;
    expect(reviewStageButton).toBeTruthy();
    flushSync(() => {
      reviewStageButton.click();
    });
    await flushQueries();

    expect(Array.from(container.querySelectorAll("h2")).map((heading) => heading.textContent ?? "")).toContain("Automation");
    expect(container.textContent).toContain("Nothing runs here automatically");

    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("renders break-into-pieces settings in Automation instead of Advanced", async () => {
    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    flushSync(() => {
      findButton(container, "Automation")!.click();
    });

    expect(container.textContent).toContain("Break into smaller pieces");

    flushSync(() => {
      findButton(container, "Advanced")!.click();
    });

    expect(container.textContent).not.toContain("Break into smaller pieces");
    expect(container.textContent).toContain("Children");

    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("keeps allowed-next-step controls out of the primary Automation flow", async () => {
    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    expect(Array.from(container.querySelectorAll("h2")).map((heading) => heading.textContent ?? "")).toContain("Automation");
    expect(container.textContent).not.toContain("Allowed next steps");

    flushSync(() => {
      findButton(container, "Advanced")!.click();
    });

    expect(container.textContent).toContain("Strictly enforce transitions");
    expect(container.textContent).toContain(
      "Saved allowed-next-step choices are kept, but they are not enforced.",
    );
    expect(container.textContent).not.toContain("Allowed next steps");

    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("persists strict transition enforcement and reveals saved transition edges", async () => {
    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    flushSync(() => {
      findButton(container, "Advanced")!.click();
    });

    const strictToggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Strictly enforce transitions"]',
    )!;
    expect(strictToggle).toBeTruthy();
    expect(strictToggle.getAttribute("aria-checked")).toBe("false");

    flushSync(() => {
      strictToggle.click();
    });
    await flushQueries();

    expect(pipelinesApi.update).toHaveBeenCalledWith("pipeline-1", { enforceTransitions: true });
    expect(strictToggle.getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).toContain("Allowed next steps");

    const reviewTransition = Array.from(container.querySelectorAll("label")).find((label) =>
      label.textContent?.includes("Review"),
    );
    expect(reviewTransition).toBeTruthy();
    expect(reviewTransition!.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);

    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("turns strict mode off without clearing saved transition edges on stage save", async () => {
    const strictPipeline = makePipeline();
    strictPipeline.enforceTransitions = true;
    vi.mocked(pipelinesApi.get).mockResolvedValue(strictPipeline);

    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    flushSync(() => {
      findButton(container, "Advanced")!.click();
    });

    expect(container.textContent).toContain("Allowed next steps");
    const strictToggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Strictly enforce transitions"]',
    )!;
    flushSync(() => {
      strictToggle.click();
    });
    await flushQueries();

    expect(pipelinesApi.update).toHaveBeenCalledWith("pipeline-1", { enforceTransitions: false });
    expect(container.textContent).not.toContain("Allowed next steps");

    flushSync(() => {
      findButton(container, "Automation")!.click();
    });
    const editor = container.querySelector<HTMLTextAreaElement>('[aria-label="Stage instructions"]')!;
    flushSync(() => {
      setNativeValue(editor, "Collect updated requests.");
    });
    await flushQueries();

    const saveButton = findButton(container, "Save stage")!;
    flushSync(() => {
      saveButton.click();
    });
    await flushQueries();

    expect(pipelinesApi.updateStage).toHaveBeenCalled();
    expect(pipelinesApi.setTransitions).not.toHaveBeenCalled();

    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("hides generated breakdown mechanics and explains the empty Advanced tab", async () => {
    const pipeline = makePipeline();
    pipeline.stages = pipeline.stages.map((stage) =>
      stage.id === "stage-1"
        ? {
            ...stage,
            config: {
              ...stage.config,
              breakdown: {
                targetPipelineId: "pipeline-2",
                targetStageKey: "incoming",
                pieceNoun: "task",
                inheritFields: [],
                advanceTo: "review",
                waitForPieces: false,
                whenFinishedMoveTo: null,
              },
            },
          }
        : stage,
    );
    vi.mocked(pipelinesApi.get).mockResolvedValue(pipeline);

    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    flushSync(() => {
      findButton(container, "Automation")!.click();
    });

    expect(container.textContent).toContain("What should the agent decide?");
    expect(container.textContent).not.toContain("Paperclip handles this");

    flushSync(() => {
      findButton(container, "Advanced")!.click();
    });

    expect(container.textContent).toContain(
      "Advanced child settings are hidden while Break into smaller pieces is enabled",
    );
    expect(container.textContent).not.toContain("Block children");

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

  it("shows automation issue events in the selected stage Activity section", async () => {
    (pipelinesApi.listCompanyCaseEvents as unknown as { mockResolvedValueOnce: (value: unknown) => void }).mockResolvedValueOnce({
      items: [
        {
          id: "event-automation",
          companyId: "company-1",
          caseId: "case-1",
          type: "automation_executed",
          actorType: "system",
          actorUserId: null,
          actorAgentId: null,
          runId: null,
          fromStageId: null,
          toStageId: null,
          payload: { routineId: "routine-1", issueId: "issue-1", routineRunId: "run-1" },
          case: { id: "case-1", caseKey: "case-1", title: "Launch release", terminalKind: null },
          pipeline: { id: "pipeline-1", key: "content_pipeline", name: "Content pipeline" },
          fromStage: null,
          toStage: null,
          actorAgent: null,
          automation: {
            routine: { id: "routine-1", title: "Intake automation" },
            issue: { id: "issue-1", identifier: "PAP-222", title: "Run automation", status: "in_progress" },
            routineRunId: "run-1",
            stage: { id: "stage-1", key: "intake", name: "Intake", kind: "working" },
          },
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
        },
      ],
      pagination: { limit: 75, offset: 0, nextOffset: null, hasMore: false },
    });
    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    flushSync(() => {
      findButton(container, "Activity")!.click();
    });
    await flushQueries();

    expect(container.textContent).toContain("Launch release");
    expect(container.textContent).toContain("Automation completed");
    expect(container.textContent).toContain("Intake automation");
    expect(container.textContent).toContain("PAP-222");

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

  it("groups carry-over fields by source and ancestor while keeping destination as validation context", async () => {
    const breakdownPipeline = makeBreakdownPipeline();
    vi.mocked(pipelinesApi.get).mockResolvedValue(breakdownPipeline);
    vi.mocked(pipelinesApi.list).mockResolvedValue([
      makePipeline(),
      {
        ...makePipeline(),
        id: "pipeline-parent",
        key: "release_pipeline",
        name: "Release",
        stages: [
          {
            id: "parent-stage-1",
            pipelineId: "pipeline-parent",
            key: "planning",
            name: "Planning",
            kind: "working",
            position: 100,
            config: {
              variables: [
                { key: "campaign", label: "Campaign", type: "text", options: [], required: false },
                { key: "title", label: "Title", type: "text", options: [], required: false },
              ],
              breakdown: {
                targetPipelineId: "pipeline-1",
                targetStageKey: "intake",
                pieceNoun: "feature",
              },
            },
          },
        ],
      },
      {
        ...makePipeline(),
        id: "pipeline-grandparent",
        key: "campaign_pipeline",
        name: "Campaign",
        stages: [
          {
            id: "grandparent-stage-1",
            pipelineId: "pipeline-grandparent",
            key: "planning",
            name: "Planning",
            kind: "working",
            position: 100,
            config: {
              variables: [{ key: "quarter", label: "Quarter", type: "text", options: [], required: false }],
              breakdown: {
                targetPipelineId: "pipeline-parent",
                targetStageKey: "planning",
                pieceNoun: "release",
              },
            },
          },
        ],
      },
      {
        ...makePipeline(),
        id: "pipeline-2",
        key: "piece_pipeline",
        name: "Piece pipeline",
        stages: [
          {
            id: "piece-stage-1",
            pipelineId: "pipeline-2",
            key: "incoming",
            name: "Incoming",
            kind: "working",
            position: 100,
            config: {
              variables: [{ key: "release", label: "Release", type: "text", options: [], required: true }],
            },
          },
        ],
      },
    ]);

    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    flushSync(() => {
      findButton(container, "Automation")!.click();
    });
    await flushQueries();

    const carryOverRow = Array.from(container.querySelectorAll("div")).find(
      (node) =>
        node.textContent?.includes("Values are copied from this item and its ancestors") &&
        node.textContent.includes("Destination validation:"),
    ) as HTMLElement | undefined;
    expect(carryOverRow).toBeTruthy();
    expect(carryOverRow!.textContent).toContain("Piece pipeline");
    expect(carryOverRow!.textContent).toContain("Incoming");
    expect(carryOverRow!.textContent).toContain("This item");
    expect(carryOverRow!.textContent).toContain("Parent: Release");
    expect(carryOverRow!.textContent).toContain("Grandparent: Campaign");
    expect(carryOverRow!.textContent).toContain("Campaign");
    expect(carryOverRow!.textContent).toContain("Quarter");

    const editLink = Array.from(container.querySelectorAll("a")).find((anchor) =>
      anchor.textContent?.includes("Review destination fields"),
    ) as HTMLAnchorElement | undefined;
    expect(editLink?.getAttribute("href")).toBe("/pipelines/pipeline-2/settings?stage=piece-stage-1");
    const carryOverLabels = Array.from(carryOverRow!.querySelectorAll("label")).map((label) => label.textContent ?? "");
    expect(carryOverLabels.some((label) => label.includes("Release"))).toBe(true);
    expect(carryOverLabels.some((label) => label.includes("Owner"))).toBe(true);
    expect(carryOverLabels.some((label) => label.includes("Title"))).toBe(false);
    expect(carryOverLabels.some((label) => label.includes("Name"))).toBe(false);
    const releaseCheckbox = carryOverLabels
      .map((label, index) => ({ label, node: carryOverRow!.querySelectorAll("label")[index] }))
      .find((entry) => entry.label.includes("Release"))
      ?.node.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(releaseCheckbox?.checked).toBe(true);

    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("saves carry-over exclusions with an all-except policy", async () => {
    vi.mocked(pipelinesApi.get).mockResolvedValue(makeBreakdownPipeline());

    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    flushSync(() => {
      findButton(container, "Automation")!.click();
    });
    await flushQueries();

    const ownerLabel = Array.from(container.querySelectorAll("label")).find((label) =>
      label.textContent?.includes("Owner"),
    );
    const ownerCheckbox = ownerLabel?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(ownerCheckbox?.checked).toBe(true);
    flushSync(() => {
      ownerCheckbox!.click();
    });
    await flushQueries();

    flushSync(() => {
      findButton(container, "Save stage")!.click();
    });
    await flushQueries();

    const updateStageCalls = (pipelinesApi.updateStage as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const lastConfig = (updateStageCalls.at(-1)?.[2] as { config: { breakdown: Record<string, unknown> } }).config;
    expect(lastConfig.breakdown.carryOverPolicy).toEqual({
      version: 1,
      mode: "all_except",
      includeFields: [],
      excludeFields: ["owner"],
    });
    expect(lastConfig.breakdown.inheritFields).toEqual(["release"]);

    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("explains inline when the carry-over source pipeline is archived", async () => {
    vi.mocked(pipelinesApi.get).mockResolvedValue(makeBreakdownPipeline());
    vi.mocked(pipelinesApi.list).mockResolvedValue([
      makePipeline(),
      {
        ...makePipeline(),
        id: "pipeline-2",
        key: "piece_pipeline",
        name: "Piece pipeline",
        archivedAt: "2026-06-10T00:00:00.000Z",
        stages: [
          {
            id: "piece-stage-1",
            pipelineId: "pipeline-2",
            key: "incoming",
            name: "Incoming",
            kind: "working",
            position: 100,
            config: {
              variables: [{ key: "release", label: "Release", type: "text", options: [], required: true }],
            },
          },
        ],
      },
    ]);

    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    flushSync(() => {
      findButton(container, "Automation")!.click();
    });
    await flushQueries();

    expect(container.textContent).toContain(
      "This destination pipeline is archived, so its validation fields can't be edited until it's restored.",
    );

    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("inserts carried field tokens and suppresses duplicate placeholder prompts", async () => {
    const childPipeline = makeChildPipeline();
    vi.mocked(pipelinesApi.get).mockResolvedValue(childPipeline);
    vi.mocked(pipelinesApi.list).mockResolvedValue([makeBreakdownPipeline(), childPipeline]);

    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    flushSync(() => {
      findButton(container, "Automation")!.click();
    });
    await flushQueries();

    expect(container.textContent).toContain("Already available on child items");
    expect(findButton(container, "{{release}}")).toBeTruthy();
    expect(findButton(container, "{{owner}}")).toBeTruthy();
    expect(findButton(container, "{{title}}")).toBeUndefined();

    const editor = container.querySelector<HTMLTextAreaElement>('[aria-label="Stage instructions"]')!;
    flushSync(() => {
      editor.focus();
      editor.setSelectionRange(0, 0);
      findButton(container, "{{release}}")!.click();
    });
    await flushQueries();

    expect(editor.value).toBe("{{release}}Use incoming details.");
    expect(container.textContent).not.toContain("Prompted when this placeholder appears in the instructions.");

    flushSync(() => {
      findButton(container, "Save stage")!.click();
    });
    await flushQueries();

    const updateStageCalls = (pipelinesApi.updateStage as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const lastConfig = (updateStageCalls.at(-1)?.[2] as {
      config: {
        automation: { instructionsBody: string };
        variables: Array<{ name: string }>;
      };
    }).config;
    expect(lastConfig.automation.instructionsBody).toBe("{{release}}Use incoming details.");
    expect(lastConfig.variables.map((variable) => variable.name)).not.toContain("release");

    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("does not mark legacy carried intake fields dirty on load", async () => {
    const childPipeline = makeChildPipeline();
    childPipeline.stages[0]!.config = {
      ...childPipeline.stages[0]!.config,
      variables: [
        {
          key: "release",
          label: "Release",
          type: "text",
          options: [],
          required: false,
          showInAddForm: true,
        },
      ],
      automation: {
        assigneeAgentId: "agent-1",
        instructionsBody: "{{release}}Use incoming details.",
      },
    };
    vi.mocked(pipelinesApi.get).mockResolvedValue(childPipeline);
    vi.mocked(pipelinesApi.list).mockResolvedValue([makeBreakdownPipeline(), childPipeline]);

    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    flushSync(() => {
      findButton(container, "Automation")!.click();
    });
    await flushQueries();

    expect(container.textContent).toContain("Already available on child items");
    expect(container.textContent).not.toContain("Prompted when this placeholder appears in the instructions.");
    expect(findButton(container, "Save stage")).toBeUndefined();

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
    expect(lastConfig.variables.map((variable) => variable.name)).toEqual(["customer_name", "event_date", "customer"]);

    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("reconciles placeholder renames without saving intermediate field cards", async () => {
    const renamePipeline = makePipeline();
    renamePipeline.stages = renamePipeline.stages.map((stage) =>
      stage.id === "stage-1"
        ? {
            ...stage,
            config: {
              ...stage.config,
              variables: [
                {
                  name: "old_topic",
                  label: "Topic",
                  type: "select",
                  defaultValue: "urgent",
                  required: false,
                  options: ["urgent", "later"],
                },
                {
                  name: "customer",
                  label: "Customer",
                  type: "text",
                  defaultValue: null,
                  required: true,
                  options: [],
                },
              ],
              automation: {
                assigneeAgentId: "agent-1",
                instructionsBody: "Review {{old_topic}}.",
              },
              whatHappensHere: "Review {{old_topic}}.",
            },
          }
        : stage,
    );
    (pipelinesApi.get as unknown as { mockResolvedValueOnce: (value: unknown) => void }).mockResolvedValueOnce(
      renamePipeline,
    );

    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    flushSync(() => {
      findButton(container, "Automation")!.click();
    });

    const editor = container.querySelector<HTMLTextAreaElement>('[aria-label="Stage instructions"]')!;
    for (const body of ["Review {{n}}.", "Review {{ne}}.", "Review {{new_topic}}."]) {
      flushSync(() => {
        setNativeValue(editor, body);
      });
      await flushQueries();
    }

    expect(container.textContent).toContain("{{new_topic}}");
    expect(container.textContent).toContain("{{customer}}");
    expect(container.textContent).not.toContain("{{old_topic}}");
    expect(container.textContent).not.toContain("{{ne}}");

    flushSync(() => {
      findButton(container, "Save stage")!.click();
    });
    await flushQueries();

    const updateStageCalls = (pipelinesApi.updateStage as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const lastConfig = (updateStageCalls.at(-1)?.[2] as {
      config: {
        variables: Array<{ name: string; label: string | null; source?: string }>;
      };
    }).config;
    expect(lastConfig.variables.map((variable) => variable.name)).toEqual(["new_topic", "customer"]);
    expect(lastConfig.variables[0]).toMatchObject({
      name: "new_topic",
      label: "Topic",
      type: "select",
      defaultValue: "urgent",
      required: false,
      options: ["urgent", "later"],
    });
    expect(lastConfig.variables[1]).toMatchObject({ name: "customer", label: "Customer", source: "manual" });

    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("edits manual intake fields without an automation agent or instruction placeholder", async () => {
    const manualPipeline = makePipeline();
    manualPipeline.stages = manualPipeline.stages.map((stage) =>
      stage.id === "stage-1"
        ? {
            ...stage,
            config: {
              ...stage.config,
              variables: [
                {
                  name: "customer",
                  label: "Customer",
                  type: "text",
                  defaultValue: null,
                  required: true,
                  options: [],
                },
              ],
              automation: {
                assigneeAgentId: null,
                instructionsBody: "Collect requests.",
              },
              whatHappensHere: "Collect requests.",
            },
          }
        : stage,
    );
    (pipelinesApi.get as unknown as { mockResolvedValueOnce: (value: unknown) => void }).mockResolvedValueOnce(
      manualPipeline,
    );

    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    flushSync(() => {
      findButton(container, "Automation")!.click();
    });

    expect(container.textContent).toContain("Nothing runs here automatically");
    expect(container.textContent).toContain("Intake fields");
    expect(container.textContent).toContain("{{customer}}");

    const labelInput = Array.from(container.querySelectorAll<HTMLInputElement>("input")).find((input) =>
      input.value === "Customer"
    );
    expect(labelInput).toBeTruthy();
    flushSync(() => {
      setNativeValue(labelInput!, "Client");
    });
    await flushQueries();

    const saveButton = findButton(container, "Save stage")!;
    expect(saveButton).toBeTruthy();
    flushSync(() => {
      saveButton.click();
    });
    await flushQueries();

    const updateStageCalls = (pipelinesApi.updateStage as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const lastConfig = (updateStageCalls.at(-1)?.[2] as {
      config: {
        automation: { assigneeAgentId: string | null; instructionsBody: string };
        variables: Array<{ name: string; label: string | null }>;
      };
    }).config;
    expect(lastConfig.automation).toEqual({
      assigneeAgentId: null,
      instructionsBody: "Collect requests.",
    });
    expect(lastConfig.variables).toEqual([
      expect.objectContaining({ name: "customer", label: "Client" }),
    ]);

    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
  });

});
