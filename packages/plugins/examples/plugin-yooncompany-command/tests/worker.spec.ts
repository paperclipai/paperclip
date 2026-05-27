import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

function agent(overrides: Record<string, unknown>) {
  const now = new Date();
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Agent",
    urlKey: "agent",
    role: "worker",
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
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("YoonCompany command worker", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(null, JSON.stringify({ id: "t_bridge_001" }), "");
    });
  });

  it("creates Codex quick-action issues as backlog drafts with the 6002 sequence", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({
      agents: [
        agent({
          id: "codex-1",
          name: "Codex Lead Engineer",
          title: "Main development worker",
          adapterType: "codex_local",
        }),
      ] as never,
    });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.performAction<{ id: string; assigneeAgentId: string | null }>("create-guided-issue", {
      companyId: "company-1",
      kind: "ask_codex",
    });

    expect(result.assigneeAgentId).toBe("codex-1");
    const issue = await harness.ctx.issues.get(result.id, "company-1");
    expect(issue).toMatchObject({
      title: "Codex에게 질문",
      status: "backlog",
      assigneeAgentId: "codex-1",
      priority: "high",
    });
    expect(issue?.description).toContain("6002 실행 순서: observe -> plan -> implement -> verify -> risk-report.");
    expect(issue?.description).toContain("Observe: 문서, git status, 실제 코드, 로그, 화면 상태를 먼저 확인한다.");
    expect(issue?.description).toContain("Verify: typecheck/test/browser/log/API 중 실제 근거를 남긴다.");
    expect(issue?.description).toContain("Risk-report: 변경 파일, 실행 명령, 결과, 남은 위험, 다음 행동을 보고한다.");
  });

  it("keeps Hermes quick-action issues in backlog and targets the orchestrator when present", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({
      agents: [
        agent({
          id: "hermes-1",
          name: "Hermes Research Worker",
          title: "Research worker",
          adapterType: "hermes_local",
        }),
        agent({
          id: "hermes-orchestrator-1",
          name: "Hermes Orchestrator",
          title: "Operations orchestrator",
          adapterType: "hermes_local",
        }),
      ] as never,
    });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.performAction<{ id: string; assigneeAgentId: string | null }>("create-guided-issue", {
      companyId: "company-1",
      kind: "ask_hermes",
    });

    expect(result.assigneeAgentId).toBe("hermes-orchestrator-1");
    const issue = await harness.ctx.issues.get(result.id, "company-1");
    expect(issue).toMatchObject({
      title: "Hermes 조사 요청",
      status: "backlog",
      assigneeAgentId: "hermes-orchestrator-1",
      priority: "medium",
    });
    expect(issue?.description).toContain("모드: 조사/보고 전용.");
    expect(issue?.description).toContain("Hermes 명령: C:\\yooncompany\\bin\\hermes.exe");
    expect(issue?.description).toContain("Hermes 보드: yooncompany");
    expect(issue?.description).toContain("PATH의 hermes.exe를 쓰지 말고 명시 경로로 실행");
    expect(issue?.description).toContain("Paperclip ↔ Hermes 연결 필드");
    expect(issue?.description).toContain("paperclip_issue_id: ");
    expect(issue?.description).toContain("paperclip_issue_identifier: ");
    expect(issue?.description).toContain("hermes_task_id: t_bridge_001");
    expect(issue?.description).toContain("hermes_profile: yoonorchestrator");
    expect(issue?.description).toContain("dangerous_actions_executed: none");
    expect(issue?.description).toContain("repo 파일 수정, 배포, 병합, push, 삭제, DB 쓰기");
    expect(execFileMock).toHaveBeenCalledWith(
      "C:\\yooncompany\\bin\\hermes.exe",
      expect.arrayContaining([
        "kanban",
        "--board",
        "yooncompany",
        "create",
        "--triage",
        "--idempotency-key",
        `paperclip:${result.id}:ask_hermes`,
        "--json",
      ]),
      expect.objectContaining({ cwd: "C:\\yooncompany", windowsHide: true }),
      expect.any(Function),
    );
  });
});
