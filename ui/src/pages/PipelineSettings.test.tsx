// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import type { CompanyUserDirectoryResponse } from "../api/access";
import type { PipelineDetail, PipelineDocumentPayload } from "../api/pipelines";
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
        kind: "open",
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

function makeGuidanceDocument(): PipelineDocumentPayload {
  return {
    link: { key: "guidance", documentId: "doc-1" },
    document: { id: "doc-1", title: "Pipeline guidance", latestBody: "Be clear." },
    revision: { body: "Be clear.", title: "Pipeline guidance" },
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

describe("PipelineSettings", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.spyOn(pipelinesApi, "get").mockResolvedValue(makePipeline());
    vi.spyOn(pipelinesApi, "updateStage").mockResolvedValue(makePipeline().stages[0]!);
    vi.spyOn(pipelinesApi, "setTransitions").mockResolvedValue({ transitions: [] });
    vi.spyOn(pipelinesApi, "createStage").mockResolvedValue({
      id: "stage-3",
      pipelineId: "pipeline-1",
      key: "new_stage",
      name: "New stage",
      kind: "working",
      position: 101,
      config: { variables: [] },
    });
    // Key-aware: guidance has a document; per-stage instructions docs 404 by
    // default so the editor falls back to legacy `config.whatHappensHere`.
    vi.spyOn(pipelinesApi, "getDocument").mockImplementation(async (_pipelineId, key) => {
      if (key === "guidance") return makeGuidanceDocument();
      throw new ApiError("Pipeline document not found", 404, null);
    });
    vi.spyOn(pipelinesApi, "upsertDocument").mockResolvedValue({
      document: makeGuidanceDocument().document,
      revision: { body: "Updated.", title: "Pipeline guidance" },
    });
    vi.spyOn(pipelinesApi, "listDocumentRevisions").mockResolvedValue([]);
    vi.spyOn(pipelinesApi, "restoreDocumentRevision").mockResolvedValue({
      document: makeGuidanceDocument().document,
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

  it("renders only Stages and Guidance top-level tabs", async () => {
    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    const tabLabels = Array.from(container.querySelectorAll("[data-tab-value]")).map((tab) => tab.textContent);
    expect(tabLabels).toEqual(["Stages", "Guidance"]);
    expect(tabLabels).not.toContain("Advanced");
    expect(container.textContent).not.toContain("Automation");

    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("renders the Instructions section and drops the old plain-text fields", async () => {
    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    flushSync(() => {
      findButton(container, "Variables")!.click();
    });

    const headings = Array.from(container.querySelectorAll("h2")).map((heading) => heading.textContent ?? "");
    expect(headings).toContain("Variables");
    expect(headings).toContain("Instructions");
    expect(headings).not.toContain("What happens here");
    expect(headings).not.toContain("Routine variables");
    // The instructions body is the mocked MarkdownEditor, not a plain Textarea.
    expect(container.querySelector('[aria-label="Stage instructions"]')).not.toBeNull();

    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("hides the approval picker until approval is required", async () => {
    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    expect(container.querySelector('[aria-label="Approval picker"]')).toBeNull();
    const switches = Array.from(container.querySelectorAll('[role="switch"]')) as HTMLButtonElement[];
    expect(switches.length).toBeGreaterThanOrEqual(1);

    flushSync(() => {
      switches[0]!.click();
    });

    const picker = container.querySelector<HTMLSelectElement>('[aria-label="Approval picker"]');
    expect(picker).not.toBeNull();
    const options = Array.from(picker!.querySelectorAll("option")).map((option) => option.textContent);
    expect(options).toContain("Any human");
    expect(options).toContain("Ada Human");
    expect(options).toContain("QA Agent");

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

  it("seeds the instructions body from legacy whatHappensHere when no document exists", async () => {
    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    flushSync(() => {
      findButton(container, "Variables")!.click();
    });

    const editor = container.querySelector<HTMLTextAreaElement>('[aria-label="Stage instructions"]')!;
    expect(editor.value).toBe("Collect requests.");

    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("syncs variables from escaped {{snake_case}} tokens and saves body + variables in one action", async () => {
    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    flushSync(() => {
      findButton(container, "Variables")!.click();
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

    // One save action writes the per-stage document...
    expect(pipelinesApi.upsertDocument).toHaveBeenCalledWith(
      "pipeline-1",
      "stage-instructions:stage-1",
      expect.objectContaining({ body: "Draft {{customer\\_name}} for the {{event\\_date}} channel", baseRevisionId: null }),
    );
    // ...and persists the synced routine variables in the stage config.
    const updateStageCalls = (pipelinesApi.updateStage as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const lastConfig = (updateStageCalls.at(-1)?.[2] as { config: { variables: Array<{ name: string }> } }).config;
    expect(lastConfig.variables.map((variable) => variable.name)).toEqual(["customer_name", "event_date"]);

    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("recovers from a stale-revision conflict on the instructions upsert", async () => {
    (pipelinesApi.upsertDocument as unknown as { mockRejectedValueOnce: (error: unknown) => void }).mockRejectedValueOnce(
      new ApiError("Pipeline document was updated by someone else", 409, { code: "stale_base_revision" }),
    );
    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    flushSync(() => {
      findButton(container, "Variables")!.click();
    });

    const editor = container.querySelector<HTMLTextAreaElement>('[aria-label="Stage instructions"]')!;
    flushSync(() => {
      setNativeValue(editor, "Updated instructions body");
    });
    await flushQueries();

    flushSync(() => {
      findButton(container, "Save stage")!.click();
    });
    await flushQueries();

    expect(container.textContent).toContain("Someone else updated these instructions");
    expect(findButton(container, "Reload latest")).toBeTruthy();
    // No silent last-write-wins: the edited body is preserved for the user.
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Stage instructions"]')!.value).toBe(
      "Updated instructions body",
    );

    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
  });
});
