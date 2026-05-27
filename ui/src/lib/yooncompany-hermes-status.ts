import type { Agent } from "@paperclipai/shared";

export const HERMES_ORCHESTRATION_TOOLSETS = ["file", "browser", "mcp", "delegation", "kanban"];
export const HERMES_PAPERCLIP_ADAPTER_VERSION = "0.3.0";
export const HERMES_ADAPTER_MANAGED_YOLO = true;
export const HERMES_PHASE1_APPROVAL_PACKAGE = {
  title: "Hermes-first 1단계 지속 설정 승인",
  action: "Hermes 오케스트레이터 profile 제안 및 Paperclip 읽기 전용 표시만 허용",
  targets: ["yoon-orchestrator", "yoon-research", "yoon-docs"],
  allowed: ["profile 템플릿", "표시/초안 agent만", "heartbeat 비활성", "repo 쓰기 금지"],
  blocked: ["자율 heartbeat", "Hermes repo 쓰기", "직접 DB 쓰기", "배포/발송/외부 공개"],
};

export const HERMES_PROFILE_ROSTER = [
  {
    name: "yoon-orchestrator",
    role: "작업 라우팅, 하위 작업 분해, Hermes Kanban 소유",
    toolsets: ["kanban", "memory", "skills", "session_search", "web", "browser"],
    phase: "1단계",
  },
  {
    name: "yoon-research",
    role: "공개 자료 조사, 시장 조사, 출처 요약",
    toolsets: ["web", "browser", "memory", "skills", "session_search"],
    phase: "1단계",
  },
  {
    name: "yoon-docs",
    role: "내부 문서, 인수인계, 요약, 절차 초안",
    toolsets: ["file", "memory", "skills", "session_search"],
    phase: "1단계",
  },
  {
    name: "yoon-business",
    role: "비즈니스 사업부 기획 및 KPI 작업",
    toolsets: ["web", "browser", "memory", "skills", "session_search"],
    phase: "2단계",
  },
  {
    name: "yoon-startup",
    role: "모두의 창업 사업부 기획",
    toolsets: ["web", "browser", "memory", "skills", "session_search"],
    phase: "2단계",
  },
  {
    name: "yoon-academy",
    role: "아카데미/팅커 운영",
    toolsets: ["web", "browser", "memory", "skills", "session_search"],
    phase: "2단계",
  },
  {
    name: "yoon-media",
    role: "유튜브/콘텐츠 제작 파이프라인 기획",
    toolsets: ["kanban", "web", "browser", "memory", "skills", "session_search"],
    phase: "2단계",
  },
  {
    name: "yoon-tincolive",
    role: "TincoLive 제품/개발 기획",
    toolsets: ["kanban", "web", "browser", "memory", "skills", "session_search"],
    phase: "2단계",
  },
  {
    name: "yoon-codex-bridge",
    role: "Codex 구현용 Paperclip 작업 생성 및 감사",
    toolsets: ["kanban", "web", "memory", "skills", "session_search"],
    phase: "2단계",
  },
];

export const HERMES_KANBAN_PREVIEW_COLUMNS = [
  {
    key: "intake",
    label: "접수",
    purpose: "Paperclip 작업/승인 요청을 Hermes 작업 후보로 정리",
    owner: "yoon-orchestrator",
    gate: "L3/L4는 Paperclip 승인 필요",
  },
  {
    key: "research_docs",
    label: "조사/문서",
    purpose: "조사, 문서화, 로그 요약, 운영 메모를 profile별로 처리",
    owner: "yoon-research · yoon-docs",
    gate: "repo/DB 변경 없음",
  },
  {
    key: "codex_handoff",
    label: "Codex 이관",
    purpose: "구현이 필요한 항목을 Paperclip 작업으로 넘겨 Codex가 처리",
    owner: "yoon-codex-bridge · Codex Lead Engineer",
    gate: "커밋/PR 증거 필요",
  },
  {
    key: "evidence_done",
    label: "증거/완료",
    purpose: "검증 명령, 브라우저 확인, 남은 위험을 Paperclip에 남김",
    owner: "yoon-orchestrator",
    gate: "evidence 없으면 완료 아님",
  },
];

export const HERMES_PAPERCLIP_CROSSLINK_FIELDS = [
  { key: "paperclip_issue_id", label: "Paperclip 작업", example: "YOO-101" },
  { key: "paperclip_approval_id", label: "Paperclip 승인", example: "approval_id: none" },
  { key: "hermes_board", label: "Hermes 보드", example: "yooncompany" },
  { key: "hermes_task_id", label: "Hermes 작업", example: "hk_abc123" },
  { key: "hermes_profile", label: "Hermes profile", example: "yoon-research" },
  { key: "codex_run_or_pr", label: "Codex 증거", example: "PR #2 / 명령 로그" },
];

export function findYoonCompanyAgent(agents: Agent[] | undefined, keyword: "codex" | "hermes") {
  return agents?.find((agent) => {
    const haystack = `${agent.name} ${agent.title ?? ""} ${agent.adapterType}`.toLowerCase();
    return haystack.includes(keyword);
  }) ?? null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function parseToolsets(config: Record<string, unknown>): string[] {
  const fromString = readString(config.toolsets)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return fromString.length > 0 ? fromString : readStringArray(config.enabledToolsets);
}

function parseMaxTurns(config: Record<string, unknown>, extraArgs: string[]) {
  const configured = readNumber(config.maxTurnsPerRun);
  if (configured !== null) {
    return { value: configured, source: "maxTurnsPerRun" as const };
  }

  for (let index = 0; index < extraArgs.length; index += 1) {
    const arg = extraArgs[index];
    if (arg === "--max-turns") {
      const value = Number(extraArgs[index + 1]);
      return Number.isFinite(value) ? { value, source: "extraArgs" as const } : null;
    }
    if (arg.startsWith("--max-turns=")) {
      const value = Number(arg.slice("--max-turns=".length));
      return Number.isFinite(value) ? { value, source: "extraArgs" as const } : null;
    }
  }

  return null;
}

export function getYoonCompanyHermesStatus(agent: Agent | null) {
  const config = asRecord(agent?.adapterConfig);
  const toolsets = parseToolsets(config);
  const extraArgs = readStringArray(config.extraArgs);
  const maxTurns = parseMaxTurns(config, extraArgs);
  const missingToolsets = toolsets.length > 0
    ? HERMES_ORCHESTRATION_TOOLSETS.filter((toolset) => !toolsets.includes(toolset))
    : [];
  const permissions = asRecord(agent?.permissions);
  const canCreateAgents = permissions.canCreateAgents === true;
  const persistSession = readBoolean(config.persistSession);
  const explicitYolo = extraArgs.includes("--yolo");
  const duplicateYoloRisk = HERMES_ADAPTER_MANAGED_YOLO && explicitYolo;

  return {
    extraArgs,
    toolsets,
    missingToolsets,
    persistSession,
    explicitYolo,
    adapterManagedYolo: HERMES_ADAPTER_MANAGED_YOLO,
    duplicateYoloRisk,
    yolo: explicitYolo || HERMES_ADAPTER_MANAGED_YOLO,
    maxTurns,
    canCreateAgents,
    title: agent?.title ?? "",
    adapterType: agent?.adapterType ?? null,
    orchestrationReady: Boolean(agent) && missingToolsets.length === 0 && persistSession === true,
  };
}
