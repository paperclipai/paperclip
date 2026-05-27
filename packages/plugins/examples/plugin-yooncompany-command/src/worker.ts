import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import { ACTION_KEYS, type GuidedIssueKind } from "./constants.js";

type CreateGuidedIssueParams = {
  companyId?: unknown;
  kind?: unknown;
};

type AgentCandidate = Awaited<ReturnType<PluginContext["agents"]["list"]>>[number];

const HEALTH_MESSAGE = "YoonCompany command plugin ready";

const CODEX_6002_SEQUENCE = [
  "6002 실행 순서: observe -> plan -> implement -> verify -> risk-report.",
  "- Observe: 문서, git status, 실제 코드, 로그, 화면 상태를 먼저 확인한다.",
  "- Plan: 한 번에 할 작은 단위와 검증 명령을 정한다.",
  "- Implement: 승인된 범위만 구현하고 기존 변경을 되돌리지 않는다.",
  "- Verify: typecheck/test/browser/log/API 중 실제 근거를 남긴다.",
  "- Risk-report: 변경 파일, 실행 명령, 결과, 남은 위험, 다음 행동을 보고한다.",
];

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseGuidedIssueKind(value: unknown): GuidedIssueKind {
  if (value === "ask_codex" || value === "ask_hermes" || value === "new_task") {
    return value;
  }
  throw new Error("Unsupported quick action kind");
}

function matchesCodex(agent: AgentCandidate): boolean {
  const haystack = `${agent.name} ${agent.title ?? ""} ${agent.adapterType ?? ""}`.toLowerCase();
  return haystack.includes("codex");
}

function matchesHermes(agent: AgentCandidate): boolean {
  const haystack = `${agent.name} ${agent.title ?? ""} ${agent.adapterType ?? ""}`.toLowerCase();
  return haystack.includes("hermes");
}

async function findTargetAgent(ctx: PluginContext, companyId: string, kind: GuidedIssueKind) {
  const agents = await ctx.agents.list({ companyId, limit: 100, offset: 0 });
  const matcher = kind === "ask_hermes" ? matchesHermes : matchesCodex;
  return agents.find(matcher) ?? null;
}

function getIssueTemplate(kind: GuidedIssueKind): {
  title: string;
  description: string;
  priority: "high" | "medium";
} {
  if (kind === "ask_codex") {
    return {
      title: "Codex에게 질문",
      priority: "high",
      description: [
        "YoonCompany 빠른 실행에서 생성됨.",
        "",
        "대상: Codex Lead Engineer.",
        "모드: 6002.",
        ...CODEX_6002_SEQUENCE,
        "",
        "질문/작업:",
        "- 화면 사용법, 기능 위치, 개발 질문, 오류 증상을 여기에 적으세요.",
        "- 관련 화면, 파일, 기대 결과, 검증 방법을 알면 같이 적으세요.",
        "- 모르면 '현재 화면에서 무엇을 눌러야 하는지 설명하고 필요한 작업을 만들어라'라고 적어도 됩니다.",
        "",
        "안전 규칙:",
        "- 승인 없이 배포, 병합, 삭제, 이메일 발송, 외부 공개, 자격증명 변경, Paperclip DB 직접 쓰기, 영구 규칙 변경 금지.",
      ].join("\n"),
    };
  }

  if (kind === "ask_hermes") {
    return {
      title: "Hermes 조사 요청",
      priority: "medium",
      description: [
        "YoonCompany 빠른 실행에서 생성됨.",
        "",
        "대상: Hermes Research Worker.",
        "모드: 조사/보고 전용.",
        "",
        "조사 요청:",
        "- 조사 주제, 비교 대상, 필요한 근거를 여기에 적으세요.",
        "- 결과는 사실, 근거, 제안으로 분리해서 보고하세요.",
        "",
        "강제 규칙:",
        "- Hermes는 repo 파일 수정, 배포, 병합, push, 삭제, DB 쓰기, 이메일 발송, 외부 공개, 자격증명 변경, 영구 규칙 변경 금지.",
      ].join("\n"),
    };
  }

  return {
    title: "새 YoonCompany 작업",
    priority: "medium",
    description: [
      "YoonCompany 빠른 실행에서 생성됨.",
      "",
      "대상: Codex Lead Engineer.",
      "모드: 6002.",
      ...CODEX_6002_SEQUENCE,
      "",
      "채울 내용:",
      "- 목표",
      "- 범위",
      "- 완료 기준",
      "- 검증 방법",
      "",
      "실행 규칙:",
      "- 한 번에 크게 바꾸지 말고 작은 단위로 개발하고 각 단위마다 검증하세요.",
      "- 확인한 사실, 추정, 남은 검증을 분리해서 보고하세요.",
      "",
      "안전 규칙:",
      "- 위험 작업은 실행 전에 승인으로 넘기세요.",
    ].join("\n"),
  };
}

async function createGuidedIssue(ctx: PluginContext, params: CreateGuidedIssueParams) {
  const companyId = readString(params.companyId);
  if (!companyId) throw new Error("companyId is required");

  const kind = parseGuidedIssueKind(params.kind);
  const targetAgent = await findTargetAgent(ctx, companyId, kind);
  const template = getIssueTemplate(kind);

  const issue = await ctx.issues.create({
    companyId,
    title: template.title,
    description: template.description,
    priority: template.priority,
    status: "backlog",
    assigneeAgentId: targetAgent?.id,
  });

  await ctx.issues.createComment(
    issue.id,
    [
      "YoonCompany 운영 플러그인이 생성함.",
      "",
      "approval_id: none",
      "",
      "이 빠른 실행은 Paperclip 보류 작업만 만들었습니다. 직접 실행, 위험 작업, 외부 작업은 수행하지 않았습니다.",
      "담당자는 미리 지정되지만 상태는 대기(backlog)로 유지됩니다. 실행하려면 보드에서 상태를 변경하세요.",
    ].join("\n"),
    companyId,
  );

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    assigneeAgentId: issue.assigneeAgentId,
    route: `/issues/${issue.identifier ?? issue.id}`,
  };
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.actions.register(ACTION_KEYS.createGuidedIssue, async (params) => {
      return createGuidedIssue(ctx, params);
    });
    ctx.logger.info("yooncompany-command plugin setup complete");
  },

  async onHealth() {
    return { status: "ok", message: HEALTH_MESSAGE };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
