import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "@/lib/router";
import type { Agent } from "@paperclipai/shared";
import {
  AlertTriangle,
  Bot,
  ClipboardList,
  DollarSign,
  GitBranch,
  HelpCircle,
  MessageSquareText,
  PanelRightOpen,
  Radio,
  SearchCheck,
  Send,
  ShieldCheck,
  Terminal,
  Workflow,
  X,
} from "lucide-react";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import {
  findYoonCompanyAgent,
  getYoonCompanyHermesStatus,
  HERMES_CROSSLINK_TEMPLATE_LINES,
  HERMES_PHASE1_APPROVAL_PACKAGE,
  YOONCOMPANY_HERMES_BOARD,
  YOONCOMPANY_HERMES_COMMAND,
  YOONCOMPANY_HERMES_COMMAND_NOTE,
} from "../lib/yooncompany-hermes-status";

function pageLabel(pathname: string): string {
  if (pathname.includes("/dashboard")) return "대시보드";
  if (pathname.includes("/issues")) return "작업";
  if (pathname.includes("/agents")) return "직원";
  if (pathname.includes("/skills")) return "스킬";
  if (pathname.includes("/org")) return "조직";
  if (pathname.includes("/costs")) return "비용";
  if (pathname.includes("/activity")) return "활동";
  if (pathname.includes("/company/settings")) return "회사 설정";
  if (pathname.includes("/projects")) return "프로젝트";
  return "현재 화면";
}

function routeResourceContext(pathname: string): string[] {
  const segments = pathname.split("/").filter(Boolean);
  const [, section, resourceId] = segments;
  if (!section || !resourceId) return [];
  if (section === "issues") return [`현재 이슈: ${resourceId}`];
  if (section === "agents") return [`현재 직원: ${resourceId}`];
  if (section === "projects") return [`현재 프로젝트: ${resourceId}`];
  if (section === "goals") return [`현재 목표: ${resourceId}`];
  if (section === "approvals") return [`현재 승인: ${resourceId}`];
  return [];
}

function readVisibleScreenContext() {
  if (typeof document === "undefined") return [];
  const mainHeading = document.querySelector("main h1")?.textContent?.trim();
  const activeTab = document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim();
  const selectedText = window.getSelection()?.toString().trim();
  return [
    mainHeading ? `화면 제목: ${mainHeading}` : null,
    activeTab ? `선택 탭: ${activeTab}` : null,
    selectedText ? `선택 텍스트: ${selectedText.slice(0, 500)}` : null,
  ].filter(Boolean) as string[];
}

function pageContextLines(
  pathname: string,
  search: string,
  hash: string,
  company: { id: string; name: string; issuePrefix?: string | null } | null,
) {
  const route = `${pathname}${search}${hash}`;
  return [
    company ? `회사: ${company.name} (${company.issuePrefix ?? "prefix 없음"})` : null,
    company ? `회사 ID: ${company.id}` : null,
    `현재 화면: ${pageLabel(pathname)}`,
    `경로: ${route}`,
    ...routeResourceContext(pathname),
    ...readVisibleScreenContext(),
    typeof document === "undefined" ? null : `브라우저 제목: ${document.title}`,
  ].filter(Boolean) as string[];
}

function pageContext(
  pathname: string,
  search: string,
  hash: string,
  company: { id: string; name: string; issuePrefix?: string | null } | null,
) {
  return pageContextLines(pathname, search, hash, company).join("\n");
}

function requestBlock(userRequest: string) {
  const trimmed = userRequest.trim();
  if (!trimmed) return [];
  return ["", "사용자 입력:", trimmed];
}

function titleFromInput(prefix: string, fallback: string, userRequest: string) {
  const firstLine = userRequest.trim().split(/\r?\n/).find(Boolean);
  if (!firstLine) return fallback;
  return `${prefix}: ${firstLine.slice(0, 48)}`;
}

const CODEX_6002_SEQUENCE = [
  "6002 실행 순서: observe -> plan -> implement -> verify -> risk-report.",
  "- Observe: 실제 문서, git status, 코드, 로그, 화면 상태를 먼저 확인하라.",
  "- Plan: 작은 단위 작업과 검증 방법을 먼저 정리하라.",
  "- Implement: 승인된 범위 안에서만 구현하고 기존 변경을 되돌리지 마라.",
  "- Verify: typecheck/test/browser/log/API 중 실제 근거를 남겨라.",
  "- Risk-report: 변경 파일, 실행 명령, 결과, 남은 위험, 다음 행동을 보고하라.",
];

const HERMES_COMMAND_LINES = [
  "Hermes 실행 기준:",
  `- 명령: ${YOONCOMPANY_HERMES_COMMAND}`,
  `- 보드: ${YOONCOMPANY_HERMES_BOARD}`,
  `- 주의: ${YOONCOMPANY_HERMES_COMMAND_NOTE}.`,
];

function codexDescription(kind: "ask" | "guide" | "analyze", context: string, userRequest = "") {
  const intent = kind === "guide"
    ? "현재 화면 사용법과 다음 클릭 위치를 설명하고, 필요하면 작업으로 쪼개라."
    : kind === "analyze"
      ? "현재 화면의 상태, 위험, 다음 개선 후보를 6002 기준으로 분석하라."
      : "질문에 답하고 필요한 경우 작은 작업 단위와 검증 방법을 제안하라.";

  return [
    "YoonCompany 전역 질문 패널 v2에서 생성됨.",
    "생성 방식: Paperclip 이슈 초안/보류 생성. 직접 실행 아님.",
    "",
    "대상: Codex Lead Engineer.",
    "모드: 6002.",
    "",
    context,
    "",
    "요청:",
    `- ${intent}`,
    ...requestBlock(userRequest),
    "",
    ...CODEX_6002_SEQUENCE,
    "",
    "- 확인한 사실, 추정, 남은 검증을 분리하라.",
    "- 코드 변경이 필요하면 작은 단위로 계획하고 검증하라.",
    "",
    "안전 규칙:",
    "- 승인 없이 배포, 병합, 삭제, 외부 공개, 자격증명 변경, Paperclip DB 직접 쓰기 금지.",
  ].join("\n");
}

function hermesDescription(context: string, userRequest = "") {
  return [
    "YoonCompany 전역 질문 패널 v2에서 생성됨.",
    "생성 방식: Paperclip 이슈 초안/보류 생성. 직접 실행 아님.",
    "",
    "대상: Hermes 오케스트레이터 / 조사 직원.",
    "모드: 오케스트레이션 접수/조사/보고 전용.",
    "",
    ...HERMES_COMMAND_LINES,
    "",
    ...HERMES_CROSSLINK_TEMPLATE_LINES,
    "",
    context,
    "",
    "오케스트레이션 요청:",
    "- 일을 분해하고, 필요한 조사/문서/개발 위임과 승인 필요 항목을 분리하라.",
    "- 공개 자료, 로그, 메모리를 확인할 때는 사실/근거/제안을 분리 보고하라.",
    ...requestBlock(userRequest),
    "- repo 파일 수정, 배포, 병합, push, 삭제, DB 쓰기 금지.",
  ].join("\n");
}

function hermesApprovalDescription(context: string) {
  return [
    "YoonCompany Hermes-first 1단계 승인 요청 초안.",
    "생성 방식: Paperclip 이슈 초안/보류 생성. 직접 실행 아님.",
    "",
    context,
    "",
    ...HERMES_COMMAND_LINES,
    "",
    ...HERMES_CROSSLINK_TEMPLATE_LINES,
    "",
    "승인 제목:",
    HERMES_PHASE1_APPROVAL_PACKAGE.title,
    "",
    "요청 작업:",
    `- ${HERMES_PHASE1_APPROVAL_PACKAGE.action}`,
    "",
    "대상 profile:",
    ...HERMES_PHASE1_APPROVAL_PACKAGE.targets.map((target) => `- ${target}`),
    "",
    "승인 시 허용:",
    ...HERMES_PHASE1_APPROVAL_PACKAGE.allowed.map((item) => `- ${item}`),
    "",
    "승인 전 금지:",
    ...HERMES_PHASE1_APPROVAL_PACKAGE.blocked.map((item) => `- ${item}`),
    "",
    "검증 조건:",
    `- ${YOONCOMPANY_HERMES_COMMAND} profile list/show 결과를 남긴다.`,
    `- ${YOONCOMPANY_HERMES_COMMAND} kanban --board ${YOONCOMPANY_HERMES_BOARD} list/show 결과를 남긴다.`,
    "- Paperclip agent 표시/설정 diff를 남긴다.",
    "- heartbeat, repo 쓰기, 직접 DB 쓰기, 배포/발송/외부 공개가 실행되지 않았음을 보고한다.",
    "",
    "approval_id: none",
    "dangerous_actions_executed: none",
  ].join("\n");
}

function ActionButton({
  icon: Icon,
  title,
  body,
  disabled,
  onClick,
}: {
  icon: typeof MessageSquareText;
  title: string;
  body: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="grid grid-cols-[auto_1fr] gap-3 border border-border bg-background p-3 text-left text-sm transition-colors hover:bg-accent/50 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Icon className="mt-0.5 h-4 w-4 text-muted-foreground" />
      <span className="min-w-0">
        <span className="block font-medium">{title}</span>
        <span className="mt-1 block text-xs leading-5 text-muted-foreground">{body}</span>
      </span>
    </button>
  );
}

function StatusLine({ icon: Icon, label, value }: { icon: typeof GitBranch; label: string; value: string }) {
  return (
    <div className="grid grid-cols-[auto_1fr] gap-2 text-xs leading-5">
      <Icon className="mt-0.5 h-3.5 w-3.5 text-muted-foreground" />
      <div className="min-w-0">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground"> · {value}</span>
      </div>
    </div>
  );
}

function HermesStatusCard({ agent }: { agent: Agent | null }) {
  const status = getYoonCompanyHermesStatus(agent);
  const toolsets = status.toolsets.length > 0 ? status.toolsets.join(", ") : "Paperclip 설정값 없음";
  const missing = status.missingToolsets.length > 0 ? status.missingToolsets.join(", ") : "누락 없음 또는 전체 기본값";
  const session = status.persistSession === null ? "설정값 없음" : status.persistSession ? "지속 세션" : "비지속 세션";
  const safety = [
    status.duplicateYoloRisk ? "--yolo 중복 위험" : status.yolo ? "--yolo 활성" : "--yolo 미표시",
    status.canCreateAgents ? "agent 생성권한 있음" : "agent 생성권한 없음",
    status.canAssignTasks ? "task 배정권한 있음" : "task 배정권한 없음",
  ].join(", ");
  const maxTurns = status.maxTurns
    ? `${status.maxTurns.value} · ${status.maxTurns.source === "extraArgs" ? "extraArgs 이전 필요" : "구조화 설정"}`
    : "설정값 없음";
  const role = status.title || "역할 설명 없음";
  const command = status.command || `${status.requiredCommand} 필요`;

  return (
    <div className="mt-4 border border-border bg-muted/20 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
        <Workflow className="h-3.5 w-3.5 text-muted-foreground" />
        Hermes 중심 상태
      </div>
      <div className="grid gap-2">
        <StatusLine icon={Bot} label="현재 역할" value={agent ? `${agent.name} · ${role}` : "Hermes 직원 미확인"} />
        <StatusLine icon={Terminal} label="실행 명령" value={command} />
        <StatusLine icon={ClipboardList} label="Paperclip toolsets" value={toolsets} />
        <StatusLine icon={AlertTriangle} label="막힌 핵심 기능" value={missing} />
        <StatusLine icon={Radio} label="세션" value={session} />
        <StatusLine icon={GitBranch} label="안전 신호" value={safety} />
        <StatusLine icon={ClipboardList} label="실행 제한" value={maxTurns} />
      </div>
      {status.missingToolsets.length > 0 ? (
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          현재 설정은 아직 제한된 Hermes 오케스트레이션 상태입니다. 기능 개방은 승인 후 단계적으로 진행해야 합니다.
          {status.duplicateYoloRisk ? " adapter 0.3.0은 --yolo를 내부에서 추가하므로 현재 extraArgs의 --yolo는 승인 후 제거하거나 정책화해야 합니다." : ""}
          {status.commandMatchesLocal ? "" : ` Hermes 실행은 ${status.requiredCommand} 명시 경로를 기준으로 해야 합니다.`}
        </p>
      ) : null}
    </div>
  );
}

export function YoonCompanyAssistantPanel() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { openNewIssue } = useDialogActions();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<"codex" | "hermes">("hermes");
  const [requestText, setRequestText] = useState("");

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? "__none__"),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 30_000,
  });

  const codexAgent = useMemo(() => findYoonCompanyAgent(agents, "codex"), [agents]);
  const hermesAgent = useMemo(() => findYoonCompanyAgent(agents, "hermes"), [agents]);
  const contextLines = pageContextLines(location.pathname, location.search, location.hash, selectedCompany);
  const context = contextLines.join("\n");
  const disabled = !selectedCompanyId;

  function openCodex(kind: "ask" | "guide" | "analyze", userRequest = "") {
    openNewIssue({
      title: titleFromInput(
        "Codex 질문",
        kind === "guide" ? "현재 화면 사용법 질문" : kind === "analyze" ? "현재 화면 6002 분석" : "Codex에게 질문",
        userRequest,
      ),
      description: codexDescription(kind, context, userRequest),
      priority: "high",
      status: "backlog",
      assigneeAgentId: codexAgent?.id,
    });
    setOpen(false);
  }

  function openHermes(userRequest = "") {
    openNewIssue({
      title: titleFromInput("Hermes 오케스트레이션", "Hermes 오케스트레이션 요청", userRequest),
      description: hermesDescription(context, userRequest),
      priority: "medium",
      status: "backlog",
      assigneeAgentId: hermesAgent?.id,
    });
    setOpen(false);
  }

  function openHermesApprovalDraft() {
    openNewIssue({
      title: HERMES_PHASE1_APPROVAL_PACKAGE.title,
      description: hermesApprovalDescription(context),
      priority: "high",
      status: "backlog",
    });
    setOpen(false);
  }

  function openCustomRequest() {
    if (target === "hermes") {
      openHermes(requestText);
    } else {
      openCodex("ask", requestText);
    }
  }

  return (
    <>
      <button
        type="button"
        className={cn(
          "fixed bottom-4 right-4 z-[80] inline-flex h-11 w-11 items-center justify-center border border-border bg-background text-foreground shadow-lg transition-colors hover:bg-accent",
          open && "bg-accent",
        )}
        aria-label="YoonCompany 질문 패널"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <X className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
      </button>

      {open ? (
        <aside className="fixed bottom-20 right-4 z-[80] max-h-[min(720px,calc(100dvh-7rem))] w-[min(390px,calc(100vw-2rem))] overflow-y-auto border border-border bg-background p-4 shadow-xl">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold">YoonCompany 질문</div>
              <div className="mt-1 text-xs text-muted-foreground">{pageLabel(location.pathname)}에서 바로 작업을 만듭니다.</div>
            </div>
            <button
              type="button"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center border border-border text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="질문 패널 닫기"
              onClick={() => setOpen(false)}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="grid gap-2">
            <div className="grid gap-2 border border-border bg-muted/20 p-3">
              <div className="grid grid-cols-2 gap-1">
                <button
                  type="button"
                  className={cn(
                    "border border-border px-2.5 py-2 text-xs font-medium transition-colors hover:bg-accent",
                    target === "codex" && "bg-accent text-foreground",
                  )}
                  onClick={() => setTarget("codex")}
                >
                  Codex 개발 위임
                </button>
                <button
                  type="button"
                  className={cn(
                    "border border-border px-2.5 py-2 text-xs font-medium transition-colors hover:bg-accent",
                    target === "hermes" && "bg-accent text-foreground",
                  )}
                  onClick={() => setTarget("hermes")}
                >
                  Hermes 오케스트레이션
                </button>
              </div>
              <textarea
                value={requestText}
                onChange={(event) => setRequestText(event.target.value)}
                rows={4}
                placeholder="현재 화면 맥락과 함께 전달할 내용을 입력"
                className="min-h-24 resize-y border border-border bg-background px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-foreground"
              />
              <div className="border border-border bg-background px-3 py-2">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                    <ClipboardList className="h-3.5 w-3.5" />
                    현재 화면 컨텍스트 자동 첨부
                  </div>
                  <div className="text-xs text-muted-foreground">이슈 초안에 포함</div>
                </div>
                <div className="mt-2 space-y-1">
                  {contextLines.slice(0, 5).map((line) => (
                    <div key={line} className="truncate text-xs leading-5 text-muted-foreground">
                      {line}
                    </div>
                  ))}
                </div>
              </div>
              <button
                type="button"
                disabled={disabled || !requestText.trim()}
                onClick={openCustomRequest}
                className="inline-flex items-center justify-center gap-2 border border-border bg-foreground px-3 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Send className="h-3.5 w-3.5" />
                {target === "hermes" ? "오케스트레이션 이슈 초안 만들기" : "개발 이슈 초안 만들기"}
              </button>
            </div>
            <ActionButton
              icon={MessageSquareText}
              title="Codex 개발 위임"
              body="구현, 설정, 오류 수정 범위를 Codex 작업으로 정리합니다."
              disabled={disabled}
              onClick={() => openCodex("ask")}
            />
            <ActionButton
              icon={HelpCircle}
              title="화면 사용법"
              body="현재 화면에서 무엇을 눌러야 하는지 Codex 작업으로 묻습니다."
              disabled={disabled}
              onClick={() => openCodex("guide")}
            />
            <ActionButton
              icon={SearchCheck}
              title="현재 화면 분석"
              body="상태, 위험, 다음 개선을 6002 검증 기준으로 분석합니다."
              disabled={disabled}
              onClick={() => openCodex("analyze")}
            />
            <ActionButton
              icon={ClipboardList}
              title="Hermes 오케스트레이션"
              body="조사, 문서, 개발 위임, 승인 필요 항목을 보류 이슈로 정리합니다."
              disabled={disabled}
              onClick={() => openHermes()}
            />
            <ActionButton
              icon={ShieldCheck}
              title="Hermes 1단계 승인"
              body="profile/toolset/Kanban 활성화 전 승인 요청 초안을 만듭니다."
              disabled={disabled}
              onClick={openHermesApprovalDraft}
            />
          </div>

          <div className="mt-4 grid gap-2 border-t border-border pt-4">
            <StatusLine icon={Bot} label="오케스트레이터" value={hermesAgent ? `${hermesAgent.name} · Hermes 중심 전환 대상` : "Hermes 직원 미확인"} />
            <StatusLine icon={Bot} label="개발 워커" value={codexAgent ? `${codexAgent.name} · 6002 구현 담당` : "Codex 직원 미확인"} />
            <StatusLine icon={Radio} label="외부 지시" value="Telegram은 미연결, Hermes gateway 설정 후 연결 가능" />
            <StatusLine icon={DollarSign} label="비용" value="구독형 포함 실행과 API 과금은 비용 화면에서 구분" />
            <StatusLine icon={GitBranch} label="프로젝트" value="로컬 변경 후 GitHub 브랜치/PR 단위로 정리" />
          </div>

          <HermesStatusCard agent={hermesAgent} />

          <div className="mt-4 flex flex-wrap gap-2 text-xs">
            <Link to="/dashboard/live" className="border border-border px-2.5 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground">
              진행 확인
            </Link>
            <Link to="/costs" className="border border-border px-2.5 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground">
              비용 보기
            </Link>
            <Link to="/skills" className="border border-border px-2.5 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground">
              스킬 보기
            </Link>
          </div>
        </aside>
      ) : null}
    </>
  );
}
