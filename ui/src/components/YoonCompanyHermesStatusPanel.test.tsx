// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Agent } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { YoonCompanyHermesStatusPanel } from "./YoonCompanyHermesStatusPanel";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={to} {...props}>{children}</a>
  ),
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

describe("YoonCompanyHermesStatusPanel", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("shows Hermes-focused dashboard state and the blocked orchestration capabilities", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <YoonCompanyHermesStatusPanel
          agents={[
            makeAgent({
              id: "codex-1",
              name: "Codex Lead Engineer",
              adapterType: "codex_local",
            }),
            makeAgent({
              id: "hermes-1",
              name: "Hermes Research Worker",
              adapterType: "hermes_local",
              adapterConfig: {
                toolsets: "terminal,memory,session_search,skills,web",
                extraArgs: ["--yolo", "--max-turns", "8"],
                persistSession: false,
              },
              permissions: { canCreateAgents: true },
            }),
            makeAgent({
              id: "hermes-orchestrator-1",
              name: "Hermes Orchestrator",
              title: "Hermes-first operations orchestrator - approval gated, no repo writes",
              adapterType: "hermes_local",
              adapterConfig: {
                command: "C:\\yooncompany\\bin\\hermes.exe",
                hermesCommand: "C:\\yooncompany\\bin\\hermes.exe",
                toolsets: "terminal,memory,session_search,skills,web,browser,kanban",
                extraArgs: ["--profile", "yoonorchestrator", "--max-turns", "12"],
                persistSession: true,
              },
              permissions: { canCreateAgents: false },
            }),
          ]}
        />,
      );
    });

    expect(container.textContent).toContain("Hermes 중심 운영 상태");
    expect(container.textContent).toContain("Hermes Orchestrator · hermes_local");
    expect(container.textContent).toContain("C:\\yooncompany\\bin\\hermes.exe");
    expect(container.textContent).toContain("Codex Lead Engineer · codex_local");
    expect(container.textContent).toContain("터미널, 메모리, 세션 검색, 스킬, 웹 조사, 브라우저, Kanban");
    expect(container.textContent).toContain("막힘: 파일 읽기, MCP, 하위 직원 위임");
    expect(container.textContent).toContain("hermes-paperclip-adapter 0.3.0");
    expect(container.textContent).toContain("프로필");
    expect(container.textContent).toContain("yoonorchestrator");
    expect(container.textContent).toContain("지속 세션");
    expect(container.textContent).toContain("--yolo 명시 없음, agent 생성권한 없음, task 배정권한 없음");
    expect(container.textContent).toContain("12 · 실행 인자 기준");
    expect(container.textContent).toContain("승인 패키지 초안");
    expect(container.textContent).toContain("Hermes 중심 1단계 지속 설정 승인");
    expect(container.textContent).toContain("yoonorchestrator");
    expect(container.textContent).toContain("승인 전 금지");
    expect(container.textContent).toContain("자율 heartbeat");
    expect(container.textContent).toContain("Hermes repo 쓰기");
    expect(container.textContent).toContain("Hermes 프로필 구성 미리보기");
    expect(container.textContent).toContain("실제 프로필명 기준 · 직접 변경 없음");
    expect(container.textContent).toContain("yoonorchestrator");
    expect(container.textContent).toContain("yoonbusiness");
    expect(container.textContent).toContain("yoontincolive");
    expect(container.textContent).toContain("yooncodexbridge");
    expect(container.textContent).toContain("Hermes Kanban 읽기 전용 미리보기");
    expect(container.textContent).toContain("실제 보드 기준 · 직접 변경 없음");
    expect(container.textContent).toContain("Codex 이관");
    expect(container.textContent).toContain("evidence 없으면 완료 아님");
    expect(container.textContent).toContain("Paperclip ↔ Hermes 교차링크 템플릿");
    expect(container.textContent).toContain("DB 스키마 변경 없음");
    expect(container.textContent).toContain("Hermes 작업");
    expect(container.textContent).toContain("t_44b37f5f");
    expect(container.querySelector('a[href="/agents"]')?.textContent).toContain("직원 보기");
    expect(container.querySelector('a[href="/approvals"]')?.textContent).toContain("승인 보기");

    await act(async () => {
      root.unmount();
    });
  });
});
