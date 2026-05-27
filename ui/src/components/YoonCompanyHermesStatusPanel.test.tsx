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

  it("shows Hermes-first dashboard state and the blocked orchestration capabilities", async () => {
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
          ]}
        />,
      );
    });

    expect(container.textContent).toContain("Hermes-first 운영 상태");
    expect(container.textContent).toContain("Hermes Research Worker · hermes_local");
    expect(container.textContent).toContain("Codex Lead Engineer · codex_local");
    expect(container.textContent).toContain("terminal, memory, session_search, skills, web");
    expect(container.textContent).toContain("막힘: file, browser, mcp, delegation, kanban");
    expect(container.textContent).toContain("hermes-paperclip-adapter 0.3.0");
    expect(container.textContent).toContain("비지속 세션");
    expect(container.textContent).toContain("--yolo 중복 위험, agent 생성권한 있음");
    expect(container.textContent).toContain("8 · extraArgs 이전 필요");
    expect(container.textContent).toContain("adapter 0.3.0은 --yolo를 내부에서 추가");
    expect(container.textContent).toContain("승인 패키지 초안");
    expect(container.textContent).toContain("Approve Hermes-first phase 1 persistent configuration");
    expect(container.textContent).toContain("yoon-orchestrator");
    expect(container.textContent).toContain("승인 전 금지");
    expect(container.textContent).toContain("autonomous heartbeat");
    expect(container.textContent).toContain("Hermes repo write");
    expect(container.querySelector('a[href="/agents"]')?.textContent).toContain("직원 보기");
    expect(container.querySelector('a[href="/approvals"]')?.textContent).toContain("승인 보기");

    await act(async () => {
      root.unmount();
    });
  });
});
