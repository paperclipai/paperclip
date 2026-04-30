// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Project } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickCapturePage } from "./QuickCapturePage";

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockGetSession = vi.hoisted(() => vi.fn());
const mockListProjects = vi.hoisted(() => vi.fn());
const mockCreateInboundDraft = vi.hoisted(() => vi.fn());

let companyState: {
  selectedCompanyId: string | null;
  selectedCompany: { id: string; name: string; issuePrefix: string } | null;
} = {
  selectedCompanyId: "company-1",
  selectedCompany: { id: "company-1", name: "iSens 운영", issuePrefix: "IS" },
};

vi.mock("../../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

vi.mock("../../api/auth", () => ({
  authApi: {
    getSession: () => mockGetSession(),
  },
}));

vi.mock("../../api/projects", () => ({
  projectsApi: {
    list: (companyId: string) => mockListProjects(companyId),
  },
}));

vi.mock("../../api/rt2-tasks", () => ({
  rt2TasksApi: {
    createInboundDraft: (companyId: string, data: unknown) => mockCreateInboundDraft(companyId, data),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    value,
  });
}

function projectFixture(): Project[] {
  return [
    {
      id: "project-1",
      companyId: "company-1",
      urlKey: "project-1",
      goalId: null,
      goalIds: [],
      goals: [],
      name: "모바일 운영",
      description: null,
      status: "in_progress",
      leadAgentId: null,
      targetDate: null,
      color: null,
      env: null,
      pauseReason: null,
      pausedAt: null,
      executionWorkspacePolicy: null,
      codebase: {
        workspaceId: null,
        repoUrl: null,
        repoRef: null,
        defaultRef: null,
        repoName: null,
        localFolder: null,
        managedFolder: "",
        effectiveLocalFolder: "",
        origin: "local_folder",
      },
      workspaces: [],
      primaryWorkspace: null,
      archivedAt: null,
      createdAt: new Date("2026-04-30T00:00:00.000Z"),
      updatedAt: new Date("2026-04-30T00:00:00.000Z"),
    },
  ];
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function renderPage() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <QuickCapturePage />
      </QueryClientProvider>,
    );
  });
  await flushReact();
  await flushReact();
  await flushReact();

  return { container, root };
}

function getTextarea(container: HTMLElement) {
  const textarea = container.querySelector('textarea[aria-label="빠른 업무 기록 내용"]');
  expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
  return textarea as HTMLTextAreaElement;
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  act(() => {
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function clickButton(container: HTMLElement, label: string) {
  const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes(label),
  );
  expect(button).toBeInstanceOf(HTMLButtonElement);
  act(() => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("QuickCapturePage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setOnline(true);
    companyState = {
      selectedCompanyId: "company-1",
      selectedCompany: { id: "company-1", name: "iSens 운영", issuePrefix: "IS" },
    };
    mockGetSession.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: { id: "user-1", email: "user@example.com", name: "User", image: null },
    });
    mockListProjects.mockResolvedValue(projectFixture());
    mockCreateInboundDraft.mockResolvedValue({
      draft: {
        rawInput: "task: 모바일 기록",
        taskTitle: "모바일 기록",
        todoTitle: "",
        dailyLog: "",
        deliverableTitle: "검수 메모",
        basePrice: 90000,
        taskMode: "solo",
        capacity: 1,
        warnings: [],
      },
      inbound: {
        id: "draft-1",
        source: "mobile",
        channel: "quick-capture:project-1",
        externalUserId: null,
        status: "review_required",
        duplicateOfDraftId: null,
        permissionStatus: "allowed",
        sourceEvidence: {
          sourceInstallationId: null,
          installationState: "not_installed",
          signingStatus: "unsigned",
          eventId: "qc-1",
          eventTimestamp: "2026-04-30T00:00:00.000Z",
          reasonCode: null,
        },
        semanticContext: [],
        duplicateWarning: null,
        reviewRequired: true,
      },
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("shows Korean connection state and saves locally when company/auth context is missing", async () => {
    companyState = { selectedCompanyId: null, selectedCompany: null };
    mockGetSession.mockResolvedValue(null);

    const { container, root } = await renderPage();

    expect(container.textContent).toContain("회사 연결 필요");
    expect(container.textContent).toContain("로그인 필요");
    expect(container.textContent).toContain("기기 저장 모드");

    const textarea = getTextarea(container);
    setTextareaValue(textarea, "고객 제안서 후속 조치");
    await flushReact();
    clickButton(container, "기기에 저장");
    await flushReact();
    await flushReact();

    expect(mockCreateInboundDraft).not.toHaveBeenCalled();
    expect(container.textContent).toContain("로그인 필요: 기기 큐에 저장되어 있습니다.");
    expect(container.textContent).toContain("고객 제안서 후속 조치");

    await act(async () => root.unmount());
  });

  it("keeps a failed send in the visible queue and retries into the draft review flow", async () => {
    mockCreateInboundDraft.mockRejectedValueOnce(new Error("서버 연결 실패"));
    const { container, root } = await renderPage();

    const textarea = getTextarea(container);
    setTextareaValue(textarea, "task: 모바일 기록; deliverable: 검수 메모; price: 90000");
    await flushReact();
    clickButton(container, "검수함에 보내기");
    await flushReact();
    await flushReact();

    expect(mockCreateInboundDraft).toHaveBeenCalledWith("company-1", expect.objectContaining({
      source: "mobile",
      channel: "quick-capture:project-1",
      externalUserId: "user-1",
      eventId: expect.any(String),
      text: "task: 모바일 기록; deliverable: 검수 메모; price: 90000",
    }));
    expect(container.textContent).toContain("전송 실패");
    expect(container.textContent).toContain("서버 연결 실패");

    clickButton(container, "다시 전송");
    await flushReact();
    await flushReact();

    expect(mockCreateInboundDraft).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("검수함에 보냈습니다.");
    expect(container.textContent).toContain("초안 draft-1");

    await act(async () => root.unmount());
  });

  it("retries queued captures when the device comes back online", async () => {
    setOnline(false);
    const { container, root } = await renderPage();

    const textarea = getTextarea(container);
    setTextareaValue(textarea, "task: 오프라인 기록; deliverable: 현장 메모; price: 50000");
    await flushReact();
    clickButton(container, "기기에 저장");
    await flushReact();
    await flushReact();

    expect(mockCreateInboundDraft).not.toHaveBeenCalled();
    expect(container.textContent).toContain("네트워크 연결 필요: 기기 큐에 저장되어 있습니다.");

    setOnline(true);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await flushReact();
    await flushReact();

    expect(mockCreateInboundDraft).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("검수함에 보냈습니다.");

    await act(async () => root.unmount());
  });
});
