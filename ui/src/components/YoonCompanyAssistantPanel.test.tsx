// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { YoonCompanyAssistantPanel } from "./YoonCompanyAssistantPanel";

const mockOpenNewIssue = vi.hoisted(() => vi.fn());
const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={to} {...props}>{children}</a>
  ),
  useLocation: () => ({
    pathname: "/YOO/agents/hermes-research-worker",
    search: "?tab=runs",
    hash: "#latest",
  }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: {
      id: "company-1",
      name: "YoonCompany",
      issuePrefix: "YOO",
    },
  }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => ({ openNewIssue: mockOpenNewIssue }),
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Agent",
    urlKey: "agent",
    role: "engineer",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("YoonCompanyAssistantPanel", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;
  let queryClient: QueryClient;

  beforeEach(() => {
    document.title = "직원 상세 • YoonCompany • Paperclip";
    document.body.innerHTML = "<main><h1>직원 상세</h1></main>";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockOpenNewIssue.mockClear();
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({
        id: "codex-1",
        name: "Codex Lead Engineer",
        adapterType: "codex_local",
      }),
      makeAgent({
        id: "hermes-1",
        name: "Hermes Research Worker",
        title: "Research, memory, and report worker - repo write prohibited",
        adapterType: "hermes_local",
        adapterConfig: {
          toolsets: "terminal,memory,session_search,skills,web",
          extraArgs: ["--yolo", "--max-turns", "8"],
          persistSession: false,
        },
        permissions: { canCreateAgents: true },
      }),
    ]);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    document.body.innerHTML = "";
  });

  it("creates a backlog Hermes issue draft with current screen context and user input", async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <YoonCompanyAssistantPanel />
        </QueryClientProvider>,
      );
    });
    await flush();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="YoonCompany 질문 패널"]')?.click();
    });
    await flush();

    expect(container.textContent).toContain("현재 화면 컨텍스트 자동 첨부");
    expect(container.textContent).toContain("이슈 초안에 포함");
    expect(container.textContent).toContain("회사: YoonCompany (YOO)");
    expect(container.textContent).toContain("경로: /YOO/agents/hermes-research-worker?tab=runs#latest");

    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();
    await act(async () => {
      setTextareaValue(textarea!, "현재 Hermes 권한과 조사 역할을 비교해줘");
    });
    await flush();

    const createButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("오케스트레이션 이슈 초안 만들기"));
    expect(createButton).toBeDefined();
    expect((createButton as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      (createButton as HTMLButtonElement).click();
    });
    await flush();

    expect(mockOpenNewIssue).toHaveBeenCalledWith(expect.objectContaining({
      status: "backlog",
      assigneeAgentId: "hermes-1",
      title: "Hermes 오케스트레이션: 현재 Hermes 권한과 조사 역할을 비교해줘",
    }));
    const defaults = mockOpenNewIssue.mock.calls[0]?.[0] as { description?: string };
    expect(defaults.description).toContain("직접 실행 아님");
    expect(defaults.description).toContain("오케스트레이션 접수/조사/보고 전용");
    expect(defaults.description).toContain("명령: C:\\yooncompany\\bin\\hermes.exe");
    expect(defaults.description).toContain("보드: yooncompany");
    expect(defaults.description).toContain("PATH의 hermes.exe를 쓰지 말고 명시 경로로 실행");
    expect(defaults.description).toContain("회사: YoonCompany (YOO)");
    expect(defaults.description).toContain("현재 직원: hermes-research-worker");
    expect(defaults.description).toContain("화면 제목: 직원 상세");
    expect(defaults.description).toContain("현재 Hermes 권한과 조사 역할을 비교해줘");
  });

  it("creates a backlog Codex issue draft with the 6002 execution sequence", async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <YoonCompanyAssistantPanel />
        </QueryClientProvider>,
      );
    });
    await flush();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="YoonCompany 질문 패널"]')?.click();
    });
    await flush();

    const codexTarget = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Codex 개발 위임"));
    await act(async () => {
      codexTarget?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();
    await act(async () => {
      setTextareaValue(textarea!, "이 화면의 다음 개발 작업을 작은 단위로 진행해줘");
    });
    await flush();

    const createButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("개발 이슈 초안 만들기"));
    expect(createButton).toBeDefined();
    await act(async () => {
      (createButton as HTMLButtonElement).click();
    });
    await flush();

    expect(mockOpenNewIssue).toHaveBeenCalledWith(expect.objectContaining({
      status: "backlog",
      assigneeAgentId: "codex-1",
      title: "Codex 질문: 이 화면의 다음 개발 작업을 작은 단위로 진행해줘",
    }));
    const defaults = mockOpenNewIssue.mock.calls[0]?.[0] as { description?: string };
    expect(defaults.description).toContain("6002 실행 순서: observe -> plan -> implement -> verify -> risk-report.");
    expect(defaults.description).toContain("Observe: 실제 문서, git status, 코드, 로그, 화면 상태를 먼저 확인하라.");
    expect(defaults.description).toContain("Verify: typecheck/test/browser/log/API 중 실제 근거를 남겨라.");
    expect(defaults.description).toContain("Risk-report: 변경 파일, 실행 명령, 결과, 남은 위험, 다음 행동을 보고하라.");
  });

  it("shows the Hermes-first read-only status mismatch", async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <YoonCompanyAssistantPanel />
        </QueryClientProvider>,
      );
    });
    await flush();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="YoonCompany 질문 패널"]')?.click();
    });
    await flush();

    expect(container.textContent).toContain("Hermes 중심 상태");
    expect(container.textContent).toContain("Hermes Research Worker · Research, memory, and report worker - repo write prohibited");
    expect(container.textContent).toContain("C:\\yooncompany\\bin\\hermes.exe 필요");
    expect(container.textContent).toContain("terminal, memory, session_search, skills, web");
    expect(container.textContent).toContain("file, browser, mcp, delegation, kanban");
    expect(container.textContent).toContain("비지속 세션");
    expect(container.textContent).toContain("--yolo 중복 위험, agent 생성권한 있음");
    expect(container.textContent).toContain("8 · extraArgs 이전 필요");
    expect(container.textContent).toContain("adapter 0.3.0은 --yolo를 내부에서 추가");
    expect(container.textContent).toContain("제한된 조사 직원에 가깝습니다");
  });

  it("opens a phase 1 Hermes approval issue draft without assigning execution", async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <YoonCompanyAssistantPanel />
        </QueryClientProvider>,
      );
    });
    await flush();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="YoonCompany 질문 패널"]')?.click();
    });
    await flush();

    const approvalButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Hermes 1단계 승인"));
    expect(approvalButton).toBeDefined();

    await act(async () => {
      (approvalButton as HTMLButtonElement).click();
    });
    await flush();

    expect(mockOpenNewIssue).toHaveBeenCalledWith(expect.objectContaining({
      status: "backlog",
      priority: "high",
      title: "Hermes-first 1단계 지속 설정 승인",
    }));
    const defaults = mockOpenNewIssue.mock.calls[0]?.[0] as { assigneeAgentId?: string; description?: string };
    expect(defaults.assigneeAgentId).toBeUndefined();
    expect(defaults.description).toContain("직접 실행 아님");
    expect(defaults.description).toContain("명령: C:\\yooncompany\\bin\\hermes.exe");
    expect(defaults.description).toContain("yoonorchestrator");
    expect(defaults.description).toContain("yoonresearch");
    expect(defaults.description).toContain("yoondocs");
    expect(defaults.description).toContain("승인 전 금지");
    expect(defaults.description).toContain("Hermes repo 쓰기");
    expect(defaults.description).toContain("직접 DB 쓰기");
    expect(defaults.description).toContain("approval_id: none");
    expect(defaults.description).toContain("dangerous_actions_executed: none");
  });
});
