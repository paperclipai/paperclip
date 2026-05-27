import type { Agent } from "@paperclipai/shared";

export const YOONCOMPANY_HERMES_COMMAND = "C:\\yooncompany\\bin\\hermes.exe";
export const YOONCOMPANY_HERMES_COMMAND_NOTE = "PATH의 hermes.exe를 쓰지 말고 명시 경로로 실행";
export const YOONCOMPANY_HERMES_BOARD = "yooncompany";
export const HERMES_ORCHESTRATION_TOOLSETS = ["file", "browser", "mcp", "delegation", "kanban"];
export const HERMES_PAPERCLIP_ADAPTER_VERSION = "0.2.0";
export const HERMES_ADAPTER_MANAGED_YOLO = false;
export const HERMES_PHASE1_APPROVAL_PACKAGE = {
  title: "Hermes 중심 1단계 지속 설정 승인",
  action: "Hermes 오케스트레이터 프로필/Kanban 운영 기준과 Paperclip 읽기 전용 표시만 허용",
  targets: ["yoonorchestrator", "yoonresearch", "yoondocs"],
  allowed: ["프로필/Kanban 상태 조회", "표시/초안 agent만", "heartbeat 비활성", "repo 쓰기 금지"],
  blocked: ["자율 heartbeat", "Hermes repo 쓰기", "직접 DB 쓰기", "배포/발송/외부 공개"],
};

const HERMES_TOOLSET_LABELS: Record<string, string> = {
  browser: "브라우저",
  delegation: "하위 직원 위임",
  file: "파일 읽기",
  kanban: "Kanban",
  mcp: "MCP",
  memory: "메모리",
  session_search: "세션 검색",
  skills: "스킬",
  terminal: "터미널",
  web: "웹 조사",
};

export const HERMES_PROFILE_ROSTER = [
  {
    name: "yoonorchestrator",
    role: "작업 라우팅, 하위 작업 분해, Hermes Kanban 소유",
    toolsets: ["kanban", "memory", "skills", "session_search", "web", "browser"],
    phase: "1단계",
  },
  {
    name: "yoonresearch",
    role: "공개 자료 조사, 시장 조사, 출처 요약",
    toolsets: ["web", "browser", "memory", "skills", "session_search"],
    phase: "1단계",
  },
  {
    name: "yoondocs",
    role: "내부 문서, 인수인계, 요약, 절차 초안",
    toolsets: ["file", "memory", "skills", "session_search"],
    phase: "1단계",
  },
  {
    name: "yoonbusiness",
    role: "비즈니스 사업부 기획 및 KPI 작업",
    toolsets: ["web", "browser", "memory", "skills", "session_search"],
    phase: "2단계",
  },
  {
    name: "yoonstartup",
    role: "모두의 창업 사업부 기획",
    toolsets: ["web", "browser", "memory", "skills", "session_search"],
    phase: "2단계",
  },
  {
    name: "yoonacademy",
    role: "아카데미/팅커 운영",
    toolsets: ["web", "browser", "memory", "skills", "session_search"],
    phase: "2단계",
  },
  {
    name: "yoonmedia",
    role: "유튜브/콘텐츠 제작 파이프라인 기획",
    toolsets: ["kanban", "web", "browser", "memory", "skills", "session_search"],
    phase: "2단계",
  },
  {
    name: "yoontincolive",
    role: "TincoLive 제품/개발 기획",
    toolsets: ["kanban", "web", "browser", "memory", "skills", "session_search"],
    phase: "2단계",
  },
  {
    name: "yooncodexbridge",
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
    owner: "yoonorchestrator",
    gate: "L3/L4는 Paperclip 승인 필요",
  },
  {
    key: "research_docs",
    label: "조사/문서",
    purpose: "조사, 문서화, 로그 요약, 운영 메모를 프로필별로 처리",
    owner: "yoonresearch · yoondocs",
    gate: "repo/DB 변경 없음",
  },
  {
    key: "codex_handoff",
    label: "Codex 이관",
    purpose: "구현이 필요한 항목을 Paperclip 작업으로 넘겨 Codex가 처리",
    owner: "yooncodexbridge · Codex Lead Engineer",
    gate: "커밋/PR 증거 필요",
  },
  {
    key: "evidence_done",
    label: "증거/완료",
    purpose: "검증 명령, 브라우저 확인, 남은 위험을 Paperclip에 남김",
    owner: "yoonorchestrator",
    gate: "evidence 없으면 완료 아님",
  },
];

export const HERMES_PAPERCLIP_CROSSLINK_FIELDS = [
  { key: "paperclip_issue_id", label: "Paperclip 작업", example: "YOO-101" },
  { key: "paperclip_approval_id", label: "Paperclip 승인", example: "approval_id: none" },
  { key: "hermes_board", label: "Hermes 보드", example: YOONCOMPANY_HERMES_BOARD },
  { key: "hermes_task_id", label: "Hermes 작업", example: "t_44b37f5f" },
  { key: "hermes_profile", label: "Hermes 프로필", example: "yoonresearch" },
  { key: "codex_run_or_pr", label: "Codex 증거", example: "PR #2 / 명령 로그" },
];

export const HERMES_CROSSLINK_TEMPLATE_LINES = [
  "Paperclip ↔ Hermes 연결 필드:",
  "- paperclip_issue_id: issue 생성 후 자동 입력",
  "- paperclip_issue_identifier: issue 생성 후 자동 입력",
  "- paperclip_approval_id: approval_id: none",
  `- hermes_board: ${YOONCOMPANY_HERMES_BOARD}`,
  "- hermes_task_id: pending",
  "- hermes_profile: yoonorchestrator",
  "- codex_agent_id: 코드 변경 필요 시 연결 대기",
  "- risk_level: L0-L1, approval_id 없으면 조사/초안까지만",
  "- dangerous_actions_executed: none",
];

export function formatHermesToolsetList(toolsets: string[]) {
  return toolsets.map((toolset) => HERMES_TOOLSET_LABELS[toolset] ?? toolset).join(", ");
}

export function localizeYoonCompanyAgentTitle(title: string) {
  const normalized = title.trim().toLowerCase();
  if (!normalized) return "";
  if (normalized.includes("hermes-first operations orchestrator")) {
    return "Hermes 중심 운영 오케스트레이터 - 승인 게이트 적용, repo 쓰기 금지";
  }
  if (normalized.includes("research, memory, and report worker")) {
    return "조사, 메모리, 보고 직원 - repo 쓰기 금지";
  }
  return title
    .replace(/Hermes-first/gi, "Hermes 중심")
    .replace(/operations orchestrator/gi, "운영 오케스트레이터")
    .replace(/approval gated/gi, "승인 게이트 적용")
    .replace(/no repo writes/gi, "repo 쓰기 금지")
    .replace(/repo write prohibited/gi, "repo 쓰기 금지")
    .replace(/Research, memory, and report worker/gi, "조사, 메모리, 보고 직원");
}

function agentSearchText(agent: Agent) {
  return `${agent.name} ${agent.title ?? ""} ${agent.adapterType}`.toLowerCase();
}

function isSelectableAgent(agent: Agent) {
  return agent.status !== "terminated" && agent.status !== "pending_approval";
}

export function findYoonCompanyAgent(agents: Agent[] | undefined, keyword: "codex" | "hermes") {
  const matches = agents?.filter((agent) => {
    if (!isSelectableAgent(agent)) return false;
    return agentSearchText(agent).includes(keyword);
  }) ?? [];

  if (keyword === "hermes") {
    return matches.find((agent) => agentSearchText(agent).includes("orchestrator")) ?? matches[0] ?? null;
  }

  return matches[0] ?? null;
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

function parseProfile(extraArgs: string[]) {
  for (let index = 0; index < extraArgs.length; index += 1) {
    const arg = extraArgs[index];
    if (arg === "--profile" || arg === "-p") {
      return readString(extraArgs[index + 1]);
    }
    if (arg.startsWith("--profile=")) {
      return readString(arg.slice("--profile=".length));
    }
  }

  return "";
}

export function getYoonCompanyHermesStatus(agent: Agent | null) {
  const config = asRecord(agent?.adapterConfig);
  const command = readString(config.hermesCommand) || readString(config.command);
  const toolsets = parseToolsets(config);
  const extraArgs = readStringArray(config.extraArgs);
  const maxTurns = parseMaxTurns(config, extraArgs);
  const profile = parseProfile(extraArgs);
  const missingToolsets = toolsets.length > 0
    ? HERMES_ORCHESTRATION_TOOLSETS.filter((toolset) => !toolsets.includes(toolset))
    : [];
  const permissions = asRecord(agent?.permissions);
  const canCreateAgents = permissions.canCreateAgents === true;
  const canAssignTasks = permissions.canAssignTasks === true;
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
    yolo: explicitYolo,
    profile,
    maxTurns,
    canCreateAgents,
    canAssignTasks,
    title: agent?.title ?? "",
    adapterType: agent?.adapterType ?? null,
    command,
    commandMatchesLocal: command === YOONCOMPANY_HERMES_COMMAND,
    requiredCommand: YOONCOMPANY_HERMES_COMMAND,
    orchestrationReady: Boolean(agent)
      && command === YOONCOMPANY_HERMES_COMMAND
      && missingToolsets.length === 0
      && persistSession === true,
  };
}
