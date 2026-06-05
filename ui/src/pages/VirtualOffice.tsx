import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  BookOpen,
  Bot,
  Boxes,
  BriefcaseBusiness,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleDot,
  ClipboardList,
  Copy,
  Eye,
  ListChecks,
  MessageSquare,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  TriangleAlert,
  UserRoundCog,
} from "lucide-react";
import type { Agent, AgentRole, CompanySkillListItem, Issue, Project } from "@paperclipai/shared";
import { adaptersApi } from "../api/adapters";
import { agentsApi } from "../api/agents";
import { activityApi } from "../api/activity";
import { companySkillsApi } from "../api/companySkills";
import { heartbeatsApi } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { routinesApi } from "../api/routines";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusBadge } from "../components/StatusBadge";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useToastActions } from "../context/ToastContext";
import { getAdapterLabel } from "../adapters/adapter-display-registry";
import { isSystemRecoveryIssue } from "../lib/project-workflow-map";
import { queryKeys } from "../lib/queryKeys";
import { agentRouteRef, cn, projectRouteRef } from "../lib/utils";

type OfficeRoom = {
  id: string;
  label: string;
  hint: string;
  className: string;
  match: (agent: Agent) => boolean;
};

const OFFICE_ROOMS: OfficeRoom[] = [
  {
    id: "leadership",
    label: "主管室",
    hint: "策略、拆解、審核",
    className: "left-[5%] top-[8%] h-[34%] w-[30%]",
    match: (agent) => agent.role === "ceo" || /lead|manager|主管|pm|project/i.test(`${agent.title ?? ""} ${agent.capabilities ?? ""}`),
  },
  {
    id: "engineering",
    label: "研發區",
    hint: "程式、工具、本地模型",
    className: "left-[37%] top-[8%] h-[34%] w-[36%]",
    match: (agent) => /code|codex|engineer|developer|程式|開發|backend|frontend|hermes/i.test(`${agent.adapterType} ${agent.title ?? ""} ${agent.capabilities ?? ""}`),
  },
  {
    id: "product",
    label: "產品區",
    hint: "需求、設計、測試",
    className: "left-[5%] top-[48%] h-[40%] w-[42%]",
    match: (agent) => /product|design|test|qa|ux|需求|設計|測試/i.test(`${agent.title ?? ""} ${agent.capabilities ?? ""}`),
  },
  {
    id: "meeting",
    label: "會議室",
    hint: "討論、覆盤、介入",
    className: "left-[50%] top-[48%] h-[40%] w-[23%]",
    match: () => false,
  },
];

const OFFICE_REFERENCE_IMAGE = "/virtual-office/office-reference.png";

function roomForAgent(agent: Agent): string {
  return OFFICE_ROOMS.find((room) => room.id !== "meeting" && room.match(agent))?.id ?? "product";
}

function activeIssues(issues: Issue[]): Issue[] {
  return issues.filter((issue) => !isSystemRecoveryIssue(issue) && !["done", "cancelled"].includes(issue.status));
}

function projectIssues(project: Project, issues: Issue[]): Issue[] {
  return issues.filter((issue) => issue.projectId === project.id && !isSystemRecoveryIssue(issue));
}

function issueProgress(issues: Issue[]): number {
  if (issues.length === 0) return 0;
  const complete = issues.filter((issue) => issue.status === "done").length;
  return Math.round((complete / issues.length) * 100);
}

function isMeetingLike(issue: Issue): boolean {
  const text = `${issue.title} ${issue.description ?? ""}`;
  return /meeting|discussion|review|sync|standup|會議|討論|覆盤|同步/i.test(text);
}

function needsUserIntervention(issue: Issue): boolean {
  const text = `${issue.title} ${issue.description ?? ""}`;
  return /使用者介入規則|需要使用者介入|需要我介入|需要我決定|需要你拍板|待使用者決定|請使用者決定/i.test(text);
}

function isSandboxName(value: string | null | undefined): boolean {
  return /test|sandbox|測試|沙盒/i.test(value ?? "");
}

function pickWorkflowIssues(issues: Issue[]): Issue[] {
  const priority = ["blocked", "in_progress", "in_review", "todo", "backlog"];
  return [...issues]
    .sort((a, b) => {
      const statusDelta = priority.indexOf(a.status) - priority.indexOf(b.status);
      if (statusDelta !== 0) return statusDelta;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    })
    .slice(0, 4);
}

function AgentAvatar({ agent, index }: { agent: Agent; index: number }) {
  const initials = agent.name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <Link
      to={`/agents/${agentRouteRef(agent)}`}
      className="group flex min-w-0 items-center gap-2 rounded-md border border-border/70 bg-background/95 px-2 py-1.5 text-xs shadow-sm transition hover:border-primary/50 hover:bg-accent"
      style={{ transform: `translateY(${index % 2 === 0 ? 0 : 8}px)` }}
      title={`${agent.name} · ${getAdapterLabel(agent.adapterType)}`}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-[11px] font-semibold">
        {initials || <Bot className="h-4 w-4" />}
      </span>
      <span className="min-w-0">
        <span className="block truncate font-medium text-foreground">{agent.name}</span>
        <span className="block truncate text-muted-foreground">{agent.title ?? getAdapterLabel(agent.adapterType)}</span>
      </span>
    </Link>
  );
}

function Desk({ className }: { className: string }) {
  return (
    <div className={cn("absolute rounded-sm border border-border/60 bg-background/70 shadow-sm", className)}>
      <span className="absolute left-2 top-1 h-1.5 w-5 rounded-full bg-primary/25" />
      <span className="absolute bottom-1 right-2 h-2 w-2 rounded-sm bg-muted-foreground/20" />
    </div>
  );
}

function Chair({ className }: { className: string }) {
  return <div className={cn("absolute h-5 w-5 rounded-sm border border-border/60 bg-muted shadow-sm", className)} />;
}

function Plant({ className }: { className: string }) {
  return (
    <div className={cn("absolute h-8 w-8 rounded-full border border-emerald-500/30 bg-emerald-500/10", className)}>
      <span className="absolute left-1/2 top-1/2 h-5 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-emerald-600/50" />
      <span className="absolute left-2 top-2 h-3 w-3 rounded-full bg-emerald-500/60" />
      <span className="absolute right-2 top-2 h-3 w-3 rounded-full bg-emerald-400/60" />
    </div>
  );
}

function RoomFurniture({ roomId }: { roomId: string }) {
  if (roomId === "meeting") {
    return (
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-[28%] top-[34%] h-24 w-24 rounded-full border border-border/70 bg-background/75 shadow-sm">
          <span className="absolute left-1/2 top-1/2 h-14 w-14 -translate-x-1/2 -translate-y-1/2 rounded-full border border-border/60 bg-muted/60" />
        </div>
        {[
          "left-[45%] top-[17%]",
          "left-[45%] bottom-[17%]",
          "left-[13%] top-[44%]",
          "right-[18%] top-[44%]",
        ].map((className) => (
          <Chair key={className} className={className} />
        ))}
        <Plant className="right-3 top-3" />
      </div>
    );
  }

  if (roomId === "leadership") {
    return (
      <div className="pointer-events-none absolute inset-0">
        <Desk className="left-[14%] top-[42%] h-16 w-28" />
        <Chair className="left-[38%] top-[30%]" />
        <div className="absolute right-4 top-4 h-12 w-20 rounded-sm border border-border/60 bg-muted/60" />
        <Plant className="right-5 bottom-5" />
      </div>
    );
  }

  if (roomId === "engineering") {
    return (
      <div className="pointer-events-none absolute inset-0">
        <Desk className="left-[9%] top-[30%] h-12 w-24" />
        <Desk className="left-[43%] top-[30%] h-12 w-24" />
        <Desk className="left-[9%] bottom-[14%] h-12 w-24" />
        <Desk className="left-[43%] bottom-[14%] h-12 w-24" />
        <Chair className="left-[20%] top-[55%]" />
        <Chair className="left-[54%] top-[55%]" />
        <div className="absolute right-4 top-4 h-10 w-14 rounded-sm border border-border/60 bg-muted/60" />
      </div>
    );
  }

  return (
    <div className="pointer-events-none absolute inset-0">
      <Desk className="left-[10%] top-[34%] h-14 w-28" />
      <Desk className="left-[48%] top-[34%] h-14 w-28" />
      <Desk className="left-[28%] bottom-[13%] h-14 w-32" />
      <Chair className="left-[22%] top-[58%]" />
      <Chair className="left-[60%] top-[58%]" />
      <Plant className="right-4 top-4" />
    </div>
  );
}

function OfficeRoomPanel({ room, agents }: { room: OfficeRoom; agents: Agent[] }) {
  return (
    <section
      className={cn(
        "absolute overflow-hidden rounded-md border border-border bg-card/95 p-3 shadow-sm",
        room.className,
      )}
    >
      <div className="absolute inset-0 bg-[linear-gradient(135deg,hsl(var(--muted))_0,hsl(var(--muted))_48%,transparent_49%)] opacity-20" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,hsl(var(--primary)/0.12),transparent_42%)]" />
      <RoomFurniture roomId={room.id} />
      <div className="relative z-10 mb-3 flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">{room.label}</h2>
          <p className="text-[11px] text-muted-foreground">{room.hint}</p>
        </div>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{agents.length}</span>
      </div>
      <div className="relative z-10 grid grid-cols-1 gap-2 lg:grid-cols-2">
        {agents.slice(0, 6).map((agent, index) => (
          <AgentAvatar key={agent.id} agent={agent} index={index} />
        ))}
      </div>
    </section>
  );
}

function ProjectFlow({ project, issues, agentsById }: { project: Project; issues: Issue[]; agentsById: Map<string, Agent> }) {
  const selectedIssues = pickWorkflowIssues(issues);
  const progress = issueProgress(issues);
  const lead = project.leadAgentId ? agentsById.get(project.leadAgentId) : null;

  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <Link to={`/projects/${projectRouteRef(project)}`} className="font-medium hover:underline">
            {project.name}
          </Link>
          <p className="truncate text-xs text-muted-foreground">
            主管：{lead?.name ?? "未指定"} · 任務 {issues.length}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{progress}%</span>
          <div className="h-2 w-28 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary" style={{ width: `${progress}%` }} />
          </div>
        </div>
      </div>

      <div className="grid gap-2 md:grid-cols-4">
        {(selectedIssues.length > 0 ? selectedIssues : [null, null, null, null]).map((issue, index) => (
          <div key={issue?.id ?? index} className="relative rounded-md border border-border/70 bg-background p-3">
            {index > 0 && <span className="absolute -left-2 top-1/2 hidden h-px w-2 bg-border md:block" />}
            {issue ? (
              <>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-[11px] text-muted-foreground">{issue.identifier ?? `#${issue.issueNumber ?? index + 1}`}</span>
                  <StatusBadge status={issue.status} />
                </div>
                <Link to={`/issues/${issue.id}`} className="line-clamp-2 text-sm font-medium hover:underline">
                  {issue.title}
                </Link>
                <p className="mt-2 truncate text-xs text-muted-foreground">
                  {issue.assigneeAgentId ? agentsById.get(issue.assigneeAgentId)?.name ?? "已指派" : "未指派"}
                </p>
              </>
            ) : (
              <div className="flex h-20 items-center justify-center text-xs text-muted-foreground">等待任務</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

type StarterPhase = {
  title: string;
  description: string;
  matcher: RegExp;
};

type StarterAction = {
  label: string;
  description: string;
  icon: typeof Plus;
  testId: string;
} & (
  | { href: string; onClick?: never }
  | { onClick: () => void; href?: never }
);

type StarterStep = {
  id: string;
  label: string;
  description: string;
  done: boolean;
  statusLabel: string;
  checkItems: string[];
  actionLabel: string;
  onClick: () => void;
};

type StarterSkillTemplate = {
  id: string;
  name: string;
  description: string;
  markdown: string;
};

type AgencyRoleTemplate = {
  id: string;
  name: string;
  division: string;
  useWhen: string;
  suggestedName: string;
  suggestedTitle: string;
  suggestedRole: AgentRole;
  capabilities: string;
  starterSkills: string[];
  firstTasks: string[];
  profile?: "pm" | "engineering" | "quality";
};

type MeetingTemplate = {
  id: string;
  label: string;
  hint: string;
  body: string;
};

type EmployeeRolePreset = {
  id: string;
  label: string;
  title: string;
  capabilities: string;
};

type AcceptanceStatus = "已驗證" | "部分完成" | "待開發" | "需人工驗收";

type AcceptanceSection = {
  title: string;
  items: {
    label: string;
    status: AcceptanceStatus;
    note: string;
  }[];
};

const STARTER_PHASES: StarterPhase[] = [
  {
    title: "需求整理",
    description: "把目標、限制、成功標準和需要我補充的問題整理清楚。",
    matcher: /product|pm|manager|lead|需求|產品|企劃|分析/i,
  },
  {
    title: "方案設計",
    description: "提出可執行的設計、資料流、畫面或技術方案，並標出風險。",
    matcher: /design|ux|ui|architect|設計|原型|產品/i,
  },
  {
    title: "實作處理",
    description: "依方案完成主要工作，留下變更紀錄與必要說明。",
    matcher: /code|codex|engineer|developer|backend|frontend|hermes|開發|工程/i,
  },
  {
    title: "測試檢查",
    description: "檢查成果是否符合需求，列出問題、待修正項目與驗收建議。",
    matcher: /test|qa|quality|review|測試|品保|檢查/i,
  },
  {
    title: "覆盤紀錄",
    description: "整理討論過程、決策理由、完成項目和下一步，方便之後回看。",
    matcher: /pm|manager|lead|product|review|主管|專案|覆盤/i,
  },
];

const STARTER_SKILL_TEMPLATES: StarterSkillTemplate[] = [
  {
    id: "meeting-notes",
    name: "會議紀錄與覆盤",
    description: "整理討論過程、決策理由、待確認問題與下一步。",
    markdown: [
      "# 會議紀錄與覆盤",
      "",
      "使用這個技能時，請固定整理：",
      "",
      "- 會議目標",
      "- 參與者觀點",
      "- 已做出的決策",
      "- 還沒決定的問題",
      "- 下一步與負責人",
      "",
      "輸出要方便使用者回看，不要只給結論，也要保留重要推理脈絡。",
    ].join("\n"),
  },
  {
    id: "requirements-analysis",
    name: "需求分析",
    description: "把模糊想法拆成目標、限制、驗收標準與任務清單。",
    markdown: [
      "# 需求分析",
      "",
      "使用這個技能時，先幫使用者整理：",
      "",
      "- 想達成的目標",
      "- 目前已知限制",
      "- 需要追問的問題",
      "- 可交付成果",
      "- 驗收標準",
      "- 建議的任務拆解",
      "",
      "如果資訊不足，先列出缺口，再提出最小可行的下一步。",
    ].join("\n"),
  },
  {
    id: "quality-check",
    name: "測試檢查",
    description: "檢查成果是否符合需求，列出風險、問題與驗收建議。",
    markdown: [
      "# 測試檢查",
      "",
      "使用這個技能時，請依序檢查：",
      "",
      "- 成果是否符合原始需求",
      "- 主要流程是否可用",
      "- 有沒有明顯錯誤或缺口",
      "- 風險與邊界情況",
      "- 建議修正項目",
      "- 是否可以驗收",
      "",
      "輸出要具體，避免只說看起來正常。",
    ].join("\n"),
  },
];

const EMPLOYEE_ROLE_PRESETS: EmployeeRolePreset[] = [
  {
    id: "pm-lead",
    label: "PM / 主管",
    title: "專案管理主管",
    capabilities: "需求分析、任務拆解、會議主持、進度追蹤、決策整理與覆盤紀錄",
  },
  {
    id: "engineer",
    label: "工程",
    title: "本地模型工程師",
    capabilities: "程式實作、工具串接、本地模型流程、錯誤排查、技術方案整理",
  },
  {
    id: "qa",
    label: "測試 / 覆盤",
    title: "測試與品質檢查",
    capabilities: "驗收檢查、風險列舉、測試案例、問題回報、修正建議與交付確認",
  },
  {
    id: "design",
    label: "產品設計",
    title: "辦公室體驗設計",
    capabilities: "需求轉譯、UI/UX 設計、原型規劃、使用流程整理、新手體驗優化",
  },
];

const AGENCY_ROLE_TEMPLATES: AgencyRoleTemplate[] = [
  {
    id: "project-manager",
    name: "Project Manager",
    division: "Product / Ops",
    useWhen: "拆專案、排優先順序、主持決策與覆盤。",
    suggestedName: "Eve",
    suggestedTitle: "專案管理主管",
    suggestedRole: "pm",
    capabilities: "拆解目標、安排負責人、主持會議、留下決策與覆盤紀錄。",
    starterSkills: ["需求分析", "會議紀錄與覆盤"],
    firstTasks: ["建立五階段工作流", "開討論任務", "整理使用者需要介入的決策"],
    profile: "pm",
  },
  {
    id: "frontend-developer",
    name: "Frontend Developer",
    division: "Engineering",
    useWhen: "做 UI、React/Vue 元件、畫面驗收與前端效能。",
    suggestedName: "Faye",
    suggestedTitle: "前端介面工程師",
    suggestedRole: "engineer",
    capabilities: "實作畫面、調整互動狀態、檢查響應式版面與瀏覽器顯示。",
    starterSkills: ["測試檢查"],
    firstTasks: ["實作 Office UI", "修正行動版排版", "確認按鈕與對話框流程"],
    profile: "engineering",
  },
  {
    id: "backend-architect",
    name: "Backend Architect",
    division: "Engineering",
    useWhen: "設計 API、資料流、服務拆分與後端風險。",
    suggestedName: "Ben",
    suggestedTitle: "後端架構設計師",
    suggestedRole: "engineer",
    capabilities: "設計資料模型、API 流程、權限邊界與服務穩定性風險。",
    starterSkills: ["需求分析", "測試檢查"],
    firstTasks: ["規劃 skills 匯入資料流", "檢查 issue blockers 寫入流程", "整理本地模型設定需求"],
    profile: "engineering",
  },
  {
    id: "ai-engineer",
    name: "AI Engineer",
    division: "Engineering",
    useWhen: "接本地模型、設計 agent 工作流與模型評估。",
    suggestedName: "Alex",
    suggestedTitle: "本地模型工程師",
    suggestedRole: "engineer",
    capabilities: "設定 Hermes 或其它本地模型、設計 agent 指令與評估輸出品質。",
    starterSkills: ["需求分析", "測試檢查"],
    firstTasks: ["整理 Hermes 啟動需求", "設計模型能力檢查清單", "測試 agent 是否能接手任務"],
    profile: "engineering",
  },
  {
    id: "code-reviewer",
    name: "Code Reviewer",
    division: "Quality",
    useWhen: "檢查 bug、風險、可維護性與缺少的測試。",
    suggestedName: "Quinn",
    suggestedTitle: "程式審查員",
    suggestedRole: "qa",
    capabilities: "找出行為風險、缺少驗收、可維護性問題與需要補測的地方。",
    starterSkills: ["測試檢查"],
    firstTasks: ["檢查 UI 變更風險", "列出缺少的端到端驗收", "確認文件與畫面是否一致"],
    profile: "quality",
  },
  {
    id: "technical-writer",
    name: "Technical Writer",
    division: "Docs",
    useWhen: "把操作流程寫成新手看得懂的教學文件。",
    suggestedName: "Tina",
    suggestedTitle: "新手文件撰寫員",
    suggestedRole: "general",
    capabilities: "整理教學、入門流程、檢查清單與開源使用說明。",
    starterSkills: ["會議紀錄與覆盤", "需求分析"],
    firstTasks: ["更新入門教學", "補充角色模板說明", "把開發進度轉成可驗收文件"],
    profile: "pm",
  },
  {
    id: "research-analyst",
    name: "Research Analyst",
    division: "Research",
    useWhen: "需要比較工具、整理資料來源、做採用前評估。",
    suggestedName: "Rina",
    suggestedTitle: "研究分析員",
    suggestedRole: "general",
    capabilities: "蒐集資料、比較方案、整理可信來源、提出採用建議與待確認問題。",
    starterSkills: ["需求分析", "會議紀錄與覆盤"],
    firstTasks: ["比較本地模型選項", "整理外部工具採用風險", "把研究結論轉成決策摘要"],
    profile: "pm",
  },
  {
    id: "data-steward",
    name: "Data Steward",
    division: "Data",
    useWhen: "需要整理專案資料、命名規則、測試資料與清理邊界。",
    suggestedName: "Dana",
    suggestedTitle: "資料管理員",
    suggestedRole: "qa",
    capabilities: "整理測試資料、定義命名規則、檢查資料一致性、避免誤改正式紀錄。",
    starterSkills: ["測試檢查", "需求分析"],
    firstTasks: ["建立測試資料命名規則", "檢查驗收資料是否可回溯", "整理清理前確認清單"],
    profile: "quality",
  },
  {
    id: "operations-coordinator",
    name: "Operations Coordinator",
    division: "Ops",
    useWhen: "需要排程、追蹤例行工作、提醒哪些任務卡住。",
    suggestedName: "Owen",
    suggestedTitle: "營運協調員",
    suggestedRole: "pm",
    capabilities: "安排排程、追蹤阻塞、整理例行檢查、提醒使用者需要介入的地方。",
    starterSkills: ["會議紀錄與覆盤", "測試檢查"],
    firstTasks: ["整理每日檢查節奏", "追蹤卡住的 issue", "安排驗收批次與覆盤提醒"],
    profile: "pm",
  },
  {
    id: "security-reviewer",
    name: "Security Reviewer",
    division: "Risk",
    useWhen: "需要檢查本地資料、權限、外部工具與自動化邊界。",
    suggestedName: "Sage",
    suggestedTitle: "安全與風險審查員",
    suggestedRole: "qa",
    capabilities: "檢查資料外傳風險、權限邊界、危險操作、驗收前後的安全紀錄。",
    starterSkills: ["測試檢查", "會議紀錄與覆盤"],
    firstTasks: ["審查會改資料的按鈕", "整理外部 repo 採用注意事項", "確認驗收紀錄沒有暴露敏感資料"],
    profile: "quality",
  },
];

const MEETING_TEMPLATES: MeetingTemplate[] = [
  {
    id: "decision",
    label: "決策會議",
    hint: "適合需要拍板、分工或請使用者介入的討論。",
    body: [
      "## 會議紀錄模板",
      "",
      "請依照以下格式回覆：",
      "",
      "1. 會議目標",
      "2. 目前背景與限制",
      "3. 各參與者觀點",
      "4. 已決定事項",
      "5. 尚未決定或需要使用者介入的問題",
      "6. 下一步、負責人與建議時間",
    ].join("\n"),
  },
  {
    id: "review",
    label: "覆盤會議",
    hint: "適合檢查成果、整理學到什麼、留下可回看紀錄。",
    body: [
      "## 覆盤紀錄模板",
      "",
      "請依照以下格式回覆：",
      "",
      "1. 原本目標",
      "2. 實際完成內容",
      "3. 成功的地方",
      "4. 卡住或失敗的地方",
      "5. 下次要調整的流程",
      "6. 使用者需要知道的風險或決策",
    ].join("\n"),
  },
  {
    id: "handoff",
    label: "交接會議",
    hint: "適合上下游任務交接，讓下一位員工知道要接什麼。",
    body: [
      "## 交接紀錄模板",
      "",
      "請依照以下格式回覆：",
      "",
      "1. 已完成輸入",
      "2. 交給下一階段的產出",
      "3. 已知限制與假設",
      "4. 下一位負責人應先看的重點",
      "5. 若下一步失敗，應回頭確認的問題",
    ].join("\n"),
  },
];

const ACCEPTANCE_SECTIONS: AcceptanceSection[] = [
  {
    title: "新手開始使用",
    items: [
      { label: "Office 入口與主頁", status: "已驗證", note: "側欄入口、主頁與新手操作檯已可用。" },
      { label: "新手進度與已讀狀態", status: "已驗證", note: "可展開驗收細節，也能記住已讀步驟。" },
      { label: "2.5D 辦公室視覺", status: "已驗證", note: "房間、桌椅、會議桌、走廊與員工分區已在瀏覽器確認。" },
      { label: "檢查清單可複製 Markdown", status: "已驗證", note: "可一鍵複製目前驗收摘要、下一步與完整清單，方便貼到文件或 issue。" },
      { label: "下一步驗收指引", status: "已驗證", note: "下一步優先檢查會顯示每項建議驗收方式與安全提醒。" },
      { label: "今日驗收紀錄摘要", status: "已驗證", note: "檢查清單會整理本日已驗證項目、驗證方式與尚未觸碰的資料變更動作。" },
      { label: "端到端驗收沙盒計畫", status: "已驗證", note: "使用教學會說明真正落地測試前要先準備測試員工、測試專案與備份紀錄。" },
      { label: "驗收紀錄模板", status: "已驗證", note: "檢查清單提供可複製的驗收紀錄格式，方便填寫預期、實際與是否通過。" },
      { label: "端到端驗收批次計畫", status: "已驗證", note: "檢查清單把會改資料的驗收拆成批次，避免一次測太多動作。" },
      { label: "批次通過標準", status: "已驗證", note: "每個端到端驗收批次都有明確通過標準，方便判斷是否完成。" },
      { label: "驗收失敗處理指引", status: "已驗證", note: "每個端到端驗收批次都有未通過時的暫停與紀錄方式。" },
      { label: "測試資料清理前檢查", status: "已驗證", note: "檢查清單提醒清理測試資料前先確認名稱、連結、正式任務與紀錄位置。" },
      { label: "正式驗收前快照", status: "已驗證", note: "檢查清單提醒真正改資料前先記錄員工、技能、專案、會議與預覽服務狀態。" },
      { label: "資料變更按鈕索引", status: "已驗證", note: "檢查清單列出哪些按鈕會寫入本地資料，以及可先看的安全預覽方式。" },
      { label: "資料變更風險分流", status: "已驗證", note: "檢查清單把資料變更動作分成低風險、需快照與需人工確認三種驗收路線。" },
      { label: "資料變更操作確認表", status: "已驗證", note: "檢查清單會列出會改資料的按鈕在操作前、操作中與操作後要確認的事項。" },
      { label: "驗收批次執行紀錄", status: "已驗證", note: "每個端到端驗收批次都有結果、證據與暫停條件欄位，方便逐批覆盤。" },
      { label: "端到端驗收準備度", status: "已驗證", note: "檢查清單用五個門檻整理是否已準備好進入會改資料的驗收。" },
      { label: "端到端驗收決策規則", status: "已驗證", note: "檢查清單會提示何時可繼續、何時暫停、何時需要回復或人工介入。" },
      { label: "主畫面驗收摘要", status: "已驗證", note: "新手操作檯會直接顯示建議驗收批次、準備門檻與決策規則入口。" },
      { label: "正式驗收快照模板", status: "已驗證", note: "檢查清單提供可單獨複製的快照模板，方便在改資料前記錄狀態。" },
      { label: "資料變更安全地圖", status: "已驗證", note: "使用教學會區分可安全預覽與會修改本地資料的最後動作。" },
      { label: "端到端驗收控制台", status: "已驗證", note: "主畫面會顯示沙盒資料、starter skills、會議與工作流的下一批驗收建議。" },
      { label: "工作流乾淨狀態門檻", status: "已驗證", note: "端到端驗收控制台會列出 running/error 員工，提醒先處理自動喚醒風險再建立新工作流。" },
      { label: "沙盒資料草稿入口", status: "已驗證", note: "主畫面可預填測試員工、測試工作流與測試會議草稿，按最後建立前都不會改資料。" },
      { label: "沙盒資料不誤判正式資料", status: "已驗證", note: "沙盒訊號只認 Test、Sandbox、測試或沙盒，不再把 Virtual Office MVP 當測試專案。" },
      { label: "沙盒員工與專案實測", status: "已驗證", note: "已建立 Sandbox PM 與 Virtual Office Sandbox，主畫面可正確辨識為測試資料。" },
      { label: "沙盒編輯不等於喚醒", status: "已驗證", note: "Sandbox/Test 中改描述、改派員工或安排工作流只算編輯；仍需一次性授權才可喚醒 agent。" },
      { label: "沙盒安心狀態面板", status: "已驗證", note: "主畫面會直接顯示目前 active run 數、編輯不喚醒、喚醒需逐字授權與 transient error 停手線。" },
      { label: "沙盒成功範例", status: "已驗證", note: "主畫面可複製 AI-98533 的成功路徑：建立沙盒任務、改派 Eve、逐字一次性授權、留言產出、人工確認方向 OK。" },
      { label: "非英文描述更新保護", status: "已驗證", note: "Issue 更新測試已覆蓋 UTF-8 中文描述，避免中文內容變成問號或因改派 backlog 沙盒任務而喚醒 agent。" },
    ],
  },
  {
    title: "員工與 Skills",
    items: [
      { label: "建立員工", status: "已驗證", note: "沿用 Paperclip 原本建立員工流程。" },
      { label: "技能安裝精靈", status: "已驗證", note: "UI、資料同步、只讀復查與 Hermes Sandbox runtime capability key 真測都已驗證；正式員工仍需另行安全驗收。" },
      { label: "技能同步端到端任務卡", status: "已驗證", note: "檢查清單可複製技能同步 E2E 任務卡，驗證員工選擇、技能勾選、同步保存與重整後保留。" },
      { label: "技能同步只讀復查", status: "已驗證", note: "檢查清單可只讀讀取 Sandbox Skills Sync Test 的 desired skills，確認保存狀態但不觸發同步或喚醒模型。" },
      { label: "技能精靈完成判斷卡", status: "已驗證", note: "檢查清單可複製技能精靈完成判斷，區分 UI/資料同步、Sandbox runtime proof 與正式員工尚需另行驗收。" },
      { label: "Starter skills 準備狀態", status: "已驗證", note: "精靈會顯示已準備數、缺少項目與下一步提示。" },
      { label: "沙盒員工技能配置持久化", status: "已驗證", note: "Sandbox Skills Sync Test 已同步 3 個 starter skills；desired skills 重新讀取後仍保留。" },
      { label: "外部角色模板排程", status: "已驗證", note: "已把 agency-agents 納入角色模板來源，先做 UI 排程不直接匯入。" },
      { label: "角色模板可查看細節", status: "已驗證", note: "可先看建議職稱、能力、starter skills 與適合任務。" },
      { label: "角色模板可預填建立頁", status: "已驗證", note: "可從角色詳情帶入姓名、職稱、角色與 prompt 草稿。" },
      { label: "建立頁保留角色草稿上下文", status: "已驗證", note: "建立頁會提示來源角色與建議 starter skills。" },
      { label: "個人公司角色模板擴充", status: "已驗證", note: "角色模板已補到 10 種，涵蓋管理、工程、品質、文件、研究、資料、營運與風險。" },
      { label: "員工管理入口", status: "已驗證", note: "Office 右側員工清單可直接開啟管理視窗。" },
      { label: "員工職責範本", status: "已驗證", note: "管理視窗提供 PM、工程、測試、設計四種職責範本，套用後仍需手動保存。" },
      { label: "停用前影響提示", status: "已驗證", note: "管理視窗會顯示該員工進行中任務與主管專案，避免新手誤停用。" },
      { label: "未保存變更提示", status: "已驗證", note: "員工管理視窗會提示未保存變更，無變更時不可按保存。" },
      { label: "停用前交接建議", status: "已驗證", note: "管理視窗會依角色與工作量推薦交接對象，但不會自動重派任務。" },
      { label: "交接會議草稿", status: "已驗證", note: "管理視窗能產生停用前交接議程，方便先開會覆盤再處理停用。" },
      { label: "有影響時需確認交接", status: "已驗證", note: "員工仍有任務或主管專案時，需先勾選交接確認才可停用。" },
      { label: "未保存時不可停用", status: "已驗證", note: "管理視窗有未保存變更時會提示先保存或取消，停用按鈕保持不可按。" },
      { label: "管理視窗操作列可點擊", status: "已驗證", note: "員工管理視窗改為內容捲動、底部操作列固定，保存按鈕可在預覽瀏覽器直接點擊。" },
      { label: "沙盒員工職稱保存", status: "已驗證", note: "Sandbox PM 已用 UI 改為 Virtual Office Sandbox UI Lead PM，重新整理後仍保留；本次沒有停用員工。" },
      { label: "沙盒員工安全停用", status: "已驗證", note: "Sandbox Termination Test 已用 UI 勾選確認後停用，主畫面不再顯示，但歷史 agent 記錄仍可查到。" },
      { label: "交接停用測試資料", status: "已驗證", note: "Sandbox UI Final Handoff Test 帶 1 個主管專案；已用 UI 勾選停用與交接確認後停用，歷史紀錄仍可查。" },
      { label: "員工改名與停用", status: "已驗證", note: "改職稱、無影響沙盒停用、交接門檻與完整交接停用 UI 最終點擊都已驗證。" },
      { label: "Starter skills", status: "已驗證", note: "三個 starter skills 已實際建立並同步給沙盒員工；目前保持 3 筆，沒有重複建立。" },
      { label: "Starter skill slug 穩定建立", status: "已驗證", note: "建立 starter skill 時會帶穩定英文 slug，避免中文名稱都落到 skill 而互相覆蓋。" },
    ],
  },
  {
    title: "專案與工作流",
    items: [
      { label: "建立五階段工作流", status: "已驗證", note: "Virtual Office Sandbox Workflow Clean E2E 已用 UI 建立五階段任務，API 確認上下游 blockers 正確。" },
      { label: "建立前工作流預覽", status: "已驗證", note: "建立前可查看五階段、主管、負責人與上下游依賴提示。" },
      { label: "工作流表單操作列可點擊", status: "已驗證", note: "工作流彈窗改為內容可捲動、底部操作列固定，預覽瀏覽器可直接點擊建立按鈕。" },
      { label: "工作流自動喚醒風險提示", status: "已驗證", note: "建立工作流前若有 running/error 員工，會要求確認 recovery 任務風險，避免沙盒驗收被自動喚醒干擾。" },
      { label: "工作流乾淨驗收處理入口", status: "已驗證", note: "可從端到端驗收控制台處理 running/error 員工與 queued/running 舊工作；確認後才會暫停或取消。" },
      { label: "舊工作取消入口", status: "已驗證", note: "若只剩舊工作卡住，主畫面仍會提供處理入口，勾選確認後可取消舊 run。" },
      { label: "平行模式預覽", status: "已驗證", note: "可切換平行單位協作，預覽共同輸入、平行單位、統整輸出與彙整規則。" },
      { label: "平行工作流端到端", status: "已驗證", note: "Virtual Office Sandbox Parallel Workflow E2E 已用 UI 建立，API 確認平行 blockers 正確保存。" },
      { label: "專案主管與階段負責人", status: "已驗證", note: "表單可指定主管與每階段負責人。" },
      { label: "沙盒上下游鏈可保存", status: "已驗證", note: "沙盒工作流五個人工任務已保存成需求、設計、實作、測試、覆盤的上下游鏈。" },
      { label: "工作流地圖", status: "已驗證", note: "專案頁可看上下游、平行區與卡點提示。" },
      { label: "工作流地圖隱藏復原任務", status: "已驗證", note: "專案頁工作流地圖會隱藏系統 recovery 任務與 recovery 上游，並保留提示避免誤判。" },
      { label: "工作流地圖分類測試", status: "已驗證", note: "已新增測試保護標題優先分類與 recovery 任務辨識，避免測試任務被放錯階段。" },
      { label: "Office 與專案頁共用復原判斷", status: "已驗證", note: "Office 主頁與專案工作流地圖共用同一份 recovery 任務判斷，避免兩邊顯示不一致。" },
      { label: "Office 工作流圖例", status: "已驗證", note: "Office 主頁會說明上下游方向、平行處理與等待上游的判讀方式。" },
      { label: "Routine 排程安全面板", status: "已驗證", note: "Office 只讀顯示 routines、schedule triggers、active routine issues 與 Sandbox 排程狀態，並連到既有 Routines 頁，不直接啟用 cron。" },
      { label: "Routine 草稿預填", status: "已驗證", note: "Office 可預填 Sandbox routine 草稿，Routines 建立視窗會顯示安全提醒；仍需使用者手動建立，不會新增 trigger。" },
      { label: "Routine trigger 安全門", status: "已驗證", note: "Virtual Office routine 詳情頁新增 trigger 前必須勾選 Sandbox/Test 安全確認，避免新手誤開排程。" },
      { label: "Routine 手動執行安全門", status: "已驗證", note: "Virtual Office routine 按 Run now 前必須勾選 Sandbox/Test 安全確認，避免不小心立即執行。" },
      { label: "Routine 啟用前檢查表", status: "已驗證", note: "Office 可複製 routine/schedule 啟用前 Markdown 檢查表，涵蓋草稿、trigger、Run now 與完成後覆盤。" },
      { label: "Routine 新手安全文件", status: "已驗證", note: "教學文件地圖會列出 routine/schedule 安全說明，讓開源新手知道 Office 不會自動建立、啟用、執行或指派 Hermes。" },
      { label: "Routine 安全三步驟", status: "已驗證", note: "Routine 安全面板直接顯示先草稿、再安全門、最後覆盤，讓新手在按排程功能前先看到操作順序。" },
    ],
  },
  {
    title: "會議與覆盤",
    items: [
      { label: "建立討論會議", status: "已驗證", note: "表單可指定議程、主持人、參與者與模板。" },
      { label: "可覆盤討論紀錄", status: "已驗證", note: "已建立沙盒覆盤會議，issue 描述含討論過程、決策理由、待確認問題與下一步模板。" },
      { label: "使用者介入討論", status: "已驗證", note: "已在沙盒會議 issue 留下使用者介入驗收註記，供後續覆盤與拍板。" },
      { label: "需介入會議提示", status: "已驗證", note: "沙盒會議含使用者介入規則，任務狀態為 blocked，會被視為等待使用者處理。" },
      { label: "會議介入判讀提示", status: "已驗證", note: "Meetings & Review 會說明需介入、一般紀錄與尚無會議時該怎麼判斷。" },
    ],
  },
  {
    title: "開源與本地模型",
    items: [
      { label: "英文文件真人回饋 gate", status: "部分完成", note: "English-reader feedback gate：英文文件、UI 對照與安全提醒已完成自動檢查；仍等英文讀者回饋語氣與自然度。" },
      { label: "本地模型準備檢查", status: "已驗證", note: "新手教學說明模型服務、adapter、測試任務與自動喚醒安全邊界。" },
      { label: "Hermes adapter 預檢", status: "已驗證", note: "Office 會顯示 hermes_local 是否已在後端註冊、是否支援 skills，以及是否還缺本機 CLI。" },
      { label: "Hermes CLI 動態環境檢查", status: "已驗證", note: "Office 會呼叫 hermes_local Test environment，並可用重新檢查刷新 CLI、Python、模型與 API key 狀態。" },
      { label: "Hermes Ollama 本地模式預檢", status: "已驗證", note: "Test environment 會辨識 WSL2 Hermes + Windows Ollama bridge，Custom endpoint 不再因沒有雲端 API key 被誤判成阻塞。" },
      { label: "Hermes 接入模式選擇", status: "已驗證", note: "Office 可顯示本機 Hermes、遠端 Hermes API 與尚未決定三條路，並可複製接入判斷卡。" },
      { label: "Hermes 安裝前檢查提示", status: "已驗證", note: "Office 會列出預覽健康、Python/pip、Hermes CLI、模型憑證與沙盒邊界。" },
      { label: "Hermes 本機環境盤點", status: "已驗證", note: "已只讀確認 Python 3.14.3、python3 與 pip 可用；目前尚未安裝 hermes CLI。" },
      { label: "Hermes Windows 安裝路線", status: "已驗證", note: "PyPI 直接安裝不可用；已改以官方 WSL2 安裝與 Windows 橋接作為下一步。" },
      { label: "Hermes WSL2 設定路線", status: "已驗證", note: "Office 會顯示 bridge、模型/API key 與沙盒喚醒三段式狀態，並提醒不要記錄 API key。" },
      { label: "Hermes Sandbox 員工草稿", status: "已驗證", note: "建立員工頁會顯示 Hermes Sandbox 專屬確認，草稿預填 WSL bridge command 與沙盒安全 prompt。" },
      { label: "Hermes Sandbox 測試員工", status: "已驗證", note: "已建立 Hermes Sandbox Engineer，adapter、模型、heartbeat 與 starter skills 可作為第一次沙盒喚醒前的承接點。" },
      { label: "Hermes Sandbox 草稿確認包", status: "已驗證", note: "Office 可複製即將帶入新員工頁的 Hermes Sandbox 草稿內容，使用同一份資料來源。" },
      { label: "Hermes 建立後檢查", status: "已驗證", note: "Office 會檢查 Hermes Sandbox 員工、starter skills 同步、正式主管權限與 Test environment，並提供安全的 skills 預選入口。" },
      { label: "Hermes 建立後回報", status: "已驗證", note: "Office 可複製建立後檢查回報，整理 Sandbox 員工、skills 同步、正式主管與環境測試狀態。" },
      { label: "Hermes 沙盒喚醒模板", status: "已驗證", note: "Office 會提供第一次沙盒喚醒任務模板，只複製內容，不自動建立或喚醒 agent。" },
      { label: "Hermes 沙盒喚醒門檻", status: "已驗證", note: "Office 會檢查環境狀態、Hermes Sandbox 員工、Sandbox/Test 專案與結束判斷，避免模型未設定時進入正式喚醒。" },
      { label: "Hermes Sandbox issue 草稿", status: "已驗證", note: "環境、Hermes Sandbox 員工與測試專案都通過後，Office 可預填 Sandbox issue；仍需使用者手動按建立，不會自動喚醒。" },
      { label: "Hermes Sandbox issue 已建立", status: "已驗證", note: "已建立 AI-97978 作為第一次 Hermes Sandbox/Test 喚醒前置 issue；狀態仍是 backlog，沒有 Run now 或自動喚醒。" },
      { label: "Hermes Sandbox issue 預填交接", status: "已驗證", note: "Office 可複製預填草稿交接卡，提醒只能打開與檢查草稿，不代按建立、不 Run now、不喚醒。" },
      { label: "Hermes Sandbox issue 建立前確認", status: "已驗證", note: "Office 可複製預填草稿送出前確認表，逐項確認標題、內容、專案與負責人都只限 Sandbox/Test，不自動建立。" },
      { label: "Hermes Sandbox issue 手動建立交接", status: "已驗證", note: "Office 可複製 READY TO CREATE MANUALLY 後的交接卡，確認只有使用者可手動建立，Codex 不代按。" },
      { label: "Hermes Sandbox issue 建立後觀察", status: "已驗證", note: "Office 可複製手動建立 Sandbox issue 後的觀察表，確認 issue、live runs、recovery 與員工狀態乾淨，不自動喚醒。" },
      { label: "Hermes Sandbox issue CLEAN 交接", status: "已驗證", note: "Office 可複製建立後 CLEAN 交接卡，確認 CLEAN 只代表可準備喚醒授權，不代表已授權喚醒。" },
      { label: "Hermes 第 4 階入口交接", status: "已驗證", note: "Office 可複製只讀 PASS 後進入第 4 階前的交接卡，確認 PASS 只開啟喚醒前檢查，不開啟喚醒。" },
      { label: "Hermes 第 4 階 WAIT 補齊包", status: "已驗證", note: "Office 可複製第 4 階入口 WAIT 時的補齊清單，只補 Sandbox/Test 員工、專案或使用者確認，不建立或喚醒。" },
      { label: "Hermes 第 4 階喚醒前檢查表", status: "已驗證", note: "Office 可複製第 4 階沙盒喚醒前檢查表，要求環境、Sandbox 員工、Sandbox/Test 專案與使用者確認都通過後才可預填 issue。" },
      { label: "Hermes 喚醒前預填判讀", status: "已驗證", note: "Office 可複製第 4 階檢查後的預填判讀規則，只決定是否可預填 Sandbox issue 草稿，不建立、不 Run now、不喚醒。" },
      { label: "Hermes 第 4 階 READY 交接", status: "已驗證", note: "Office 可複製 READY TO PREFILL 後的交接卡，只允許開預填 Sandbox/Test issue 草稿，最後仍由使用者手動建立。" },
      { label: "Hermes Sandbox 喚醒授權文字", status: "已驗證", note: "Office 可複製第 4 階一次性 Sandbox/Test 喚醒授權文字，限定單一 Sandbox issue 與單一 Hermes Sandbox/Test 員工，不 Run now、不排程、不接正式專案。" },
      { label: "AI-97978 喚醒授權規格", status: "已驗證", note: "下一步只接受明確點名 AI-97978 的一次性 Sandbox/Test 喚醒授權；請繼續、下一步或可以都不算授權。" },
      { label: "AI-97978 一次性喚醒覆盤", status: "已驗證", note: "修正 hermes-wsl.exe bridge 後，授權 retry run ed6de5fa 成功；Hermes 已在 AI-97978 留言列出 skills 並確認只處理 Sandbox/Test 類任務。" },
      { label: "Hermes 喚醒授權貼出前確認", status: "已驗證", note: "Office 可複製授權句檢查卡，確認使用者貼出的句子必須明確限定一次性 Sandbox/Test 喚醒。" },
      { label: "Hermes 喚醒授權 ACCEPT 交接", status: "已驗證", note: "Office 可複製授權句 ACCEPT 後的最後交接卡，確認只進單次 Sandbox/Test 喚醒，不擴張授權。" },
      { label: "Hermes 一次性喚醒前最後確認", status: "已驗證", note: "Office 可複製實際喚醒前最後確認卡，核對單一 issue、單一員工與無 running/live run/recovery 風險。" },
      { label: "Hermes 一次性喚醒執行交接", status: "已驗證", note: "Office 可複製單次喚醒執行交接卡，確認執行範圍只限一次 Sandbox/Test 喚醒並要求完成後停下覆盤。" },
      { label: "Hermes 一次性喚醒完成停手", status: "已驗證", note: "Office 可複製喚醒完成後停手交接卡，要求回到喚醒後檢查與覆盤，完成前不進下一個任務。" },
      { label: "Hermes 喚醒後檢查面板", status: "已驗證", note: "Office 會只讀顯示 Hermes 員工狀態、Hermes live runs、recovery issues 與覆盤 issue，供第一次沙盒喚醒後判讀。" },
      { label: "Hermes 喚醒後覆盤回報", status: "已驗證", note: "Office 可複製沙盒喚醒後覆盤回報，整理回覆是否可讀、員工是否卡住、live runs/recovery 是否乾淨與是否可進下一步。" },
      { label: "Hermes 喚醒後覆盤判讀", status: "已驗證", note: "Office 可複製喚醒後覆盤判讀卡，把結果限定為 CLEAN、WAIT 或 PAUSE；CLEAN 也先停下記錄。" },
      { label: "Hermes 覆盤 CLEAN 記錄交接", status: "已驗證", note: "Office 可複製 CLEAN 後記錄交接卡，把乾淨結果寫進進度與驗收清單，不當成下一次授權。" },
      { label: "Hermes 覆盤 WAIT/PAUSE 處理", status: "已驗證", note: "Office 可複製覆盤 WAIT/PAUSE 處理卡，限制 WAIT 只等待或只讀重查、PAUSE 只停下排查。" },
      { label: "Hermes 下一任務重啟入口", status: "已驗證", note: "Office 可複製下一個 Hermes 任務重啟入口卡，要求重新走 Sandbox/Test 範圍、檢查與授權流程。" },
      { label: "Hermes 沙盒循環總結", status: "已驗證", note: "Office 可複製一次 Sandbox/Test Hermes 任務循環總結，彙整狀態、結果與下一個安全動作。" },
      { label: "Hermes 喚醒操作紀錄", status: "已驗證", note: "Office 可複製一次性沙盒喚醒 Markdown 紀錄表，包含設定前、建立前、喚醒前與完成後檢查。" },
      { label: "Hermes 授權總控狀態", status: "已驗證", note: "Office 可彙整 Hermes 第 0 到第 4 階與喚醒後覆盤狀態，提示目前停在哪一階與下一個最小安全動作。" },
      { label: "Hermes 開始設定判斷", status: "已驗證", note: "Office 會把預覽驗證、adapter、環境、沙盒員工、沙盒專案與 starter skills 合成開始/暫緩判斷，並可複製前置檢查。" },
      { label: "Hermes 安裝前最後檢查包", status: "已驗證", note: "Office 會把安裝前一刻分成可自己先做、需要 Codex 陪同與現在先不要碰三區，並可複製停止條件。" },
      { label: "Hermes 安裝前總檢回報", status: "已驗證", note: "Office 可複製安裝前總檢回報，把預覽、bridge、模型憑證、沙盒邊界與授權狀態整理成 READY/WAIT/PAUSE。" },
      { label: "Hermes 安裝前 WAIT 補齊包", status: "已驗證", note: "Office 可複製總檢 WAIT 時的補齊清單，列出缺項、下一個安全動作與仍禁止跨過的安裝/喚醒線。" },
      { label: "Hermes 安裝授權文字", status: "已驗證", note: "Office 可複製真正開始安裝前貼給 Codex 的授權文字，明列可做、不可做與停下詢問條件。" },
      { label: "Hermes 安裝授權貼出前確認", status: "已驗證", note: "Office 可複製安裝授權句檢查卡，避免把繼續、下一步或好的誤判成可安裝授權。" },
      { label: "Hermes 安裝授權 WAIT/PAUSE 處理", status: "已驗證", note: "Office 可複製安裝授權句 WAIT/PAUSE 處理卡，未 ACCEPT 時只補明確授權或停下，不安裝、不重試。" },
      { label: "Hermes 安裝授權 ACCEPT 交接", status: "已驗證", note: "Office 可複製安裝授權 ACCEPT 後的交接卡，限定只進逐條命令陪同，不擴張到憑證或喚醒。" },
      { label: "Hermes 安裝逐條命令通用流程", status: "已驗證", note: "Office 已把 HERMES-INSTALL-001 到 005 的重複卡收攏成通用的預覽、同意、結果、判讀、總結流程，不再新增無限編號卡。" },
      { label: "Hermes 授權前二次確認", status: "已驗證", note: "Office 可複製 GO/PAUSE 二次確認卡，避免把安裝授權誤當成可直接執行或喚醒。" },
      { label: "Hermes 安裝前最終閘門", status: "已驗證", note: "Office 可複製安裝前最終閘門卡，要求預覽健康、交接完整、逐條命令鏈完整且無憑證/喚醒風險才可請使用者決定是否授權。" },
      { label: "Hermes 最終閘門判斷回覆", status: "已驗證", note: "Office 可複製最終閘門 GO/PAUSE 回覆卡，把原因、缺項、下一個最小動作與仍禁止事項固定留痕。" },
      { label: "Hermes 最終閘門 GO 後交接", status: "已驗證", note: "Office 可複製最終閘門 GO 後交接卡，只允許請使用者閱讀並決定是否貼出安裝授權文字，不執行命令。" },
      { label: "Hermes 最終閘門 PAUSE 修補交接", status: "已驗證", note: "Office 可複製最終閘門 PAUSE 後修補交接卡，只允許補最小缺項並回到閘門重判，不重試、不安裝。" },
      { label: "Hermes 安裝陪同紀錄", status: "已驗證", note: "Office 可複製安裝陪同紀錄表，追蹤命令預覽、使用者同意、結果摘要與停止條件。" },
      { label: "Hermes 安裝前狀態快照", status: "已驗證", note: "Office 可複製安裝前交接快照，列出已準備項目、下一步順序與仍然禁止的動作。" },
      { label: "Hermes 安裝前流程導引", status: "已驗證", note: "Office 以 1 到 5 顯示安裝前順序：驗證、快照、檢查包、授權、陪同紀錄。" },
      { label: "Hermes 新手安裝前閱讀順序", status: "已驗證", note: "Office 可複製新手閱讀順序卡，把總檢、快照、檢查包、命令預覽與授權階梯排成安全路線。" },
      { label: "Hermes 安裝前風險判斷", status: "已驗證", note: "Office 會彙整預覽驗證、bridge、模型憑證、沙盒邊界與授權狀態，並可複製 GO/PAUSE 判斷。" },
      { label: "Hermes 下一個安全動作", status: "已驗證", note: "Office 會依 bridge、模型憑證、沙盒資料與授權狀態，提示下一個最小安全步驟。" },
      { label: "Hermes 命令預覽請求", status: "已驗證", note: "Office 可複製安裝前命令預覽請求，要求 Codex 先列命令、目的、風險與停止條件，不得直接執行。" },
      { label: "Hermes 命令預覽表單", status: "已驗證", note: "Office 可複製第 1 階命令預覽表單，要求 Codex 用表格列出命令類型、寫檔/下載/改設定風險與逐條同意欄位。" },
      { label: "Hermes 逐條同意紀錄", status: "已驗證", note: "Office 可複製第 2 階逐條同意紀錄，要求每條命令先有編號、風險、使用者同意與執行後結果，不能用一次同意涵蓋全部。" },
      { label: "Hermes 單一命令結果回報", status: "已驗證", note: "Office 可複製單一命令執行後回報卡，要求先判斷 PASS/WAIT/PAUSE，再決定是否能請使用者同意下一條。" },
      { label: "Hermes 命令結果判讀", status: "已驗證", note: "Office 可複製單一命令結果判讀卡，把 PASS/WAIT/PAUSE 對應到下一個安全動作，避免連續執行。" },
      { label: "Hermes 命令 PASS 後交接", status: "已驗證", note: "Office 可複製命令 PASS 後交接卡，提醒 PASS 只代表本條乾淨，下一條仍需命令預覽與逐條同意。" },
      { label: "Hermes 命令 WAIT/PAUSE 處理", status: "已驗證", note: "Office 可複製命令 WAIT/PAUSE 處理卡，把 WAIT 限定為補資訊或只讀檢查，把 PAUSE 限定為停下排查。" },
      { label: "Hermes 安裝陪同循環總結", status: "已驗證", note: "Office 可複製安裝陪同循環總結，彙整本輪命令、最後判讀、敏感資訊檢查與下一張安全卡。" },
      { label: "Hermes 安裝陪同收工交接", status: "已驗證", note: "Office 可複製安裝陪同收工交接，記錄關機前狀態、明天開工入口與仍未授權事項。" },
      { label: "Hermes 安裝陪同開工接續判斷", status: "已驗證", note: "Office 可複製開工接續判斷卡，要求重開機後先確認預覽與收工交接，再決定回命令預覽、逐條同意或暫停。" },
      { label: "Hermes 開工後下一條命令預覽", status: "已驗證", note: "Office 可複製開工後下一條命令預覽卡，只在 PASS HANDOFF 後列一條候選命令、目的、風險與停手線，不執行。" },
      { label: "Hermes 開工後單一命令同意", status: "已驗證", note: "Office 可複製開工後單一命令同意卡，限定只同意 HERMES-NEXT-001 且命令需完全符合預覽，執行後立即回報結果。" },
      { label: "Hermes 開工後單一命令結果", status: "已驗證", note: "Office 可複製 HERMES-NEXT-001 執行後結果回報卡，要求確認命令一致、敏感資訊、PASS/WAIT/PAUSE 與停止線。" },
      { label: "Hermes 開工後單一命令判讀", status: "已驗證", note: "Office 可複製 HERMES-NEXT-001 結果判讀卡，將 PASS/WAIT/PAUSE 收斂到回預覽、只讀補查或停下排查。" },
      { label: "Hermes 開工後單一命令循環總結", status: "已驗證", note: "Office 可複製 HERMES-NEXT-001 循環總結，記錄預覽、同意、結果、判讀與下一張安全卡，不授權下一條命令。" },
      { label: "Hermes 安裝前最後交接包", status: "已驗證", note: "Office 可複製安裝前最後交接包，統整快照、檢查包、命令預覽、授權、陪同紀錄與停手線。" },
      { label: "Hermes 授權階梯", status: "已驗證", note: "Office 把 Hermes 前置、命令預覽、安裝、設定與沙盒測試分成 0 到 4 階，讓使用者可逐階授權而不誤開喚醒線。" },
      { label: "Hermes 安裝狀態再盤點", status: "已驗證", note: "SOP 記錄 2026-05-10 只讀盤點：Hermes CLI 與 bridge 已可用，gateway running；目前卡在 provider/model/API key 設定，不重裝、不喚醒。" },
      { label: "Hermes provider/model 設定前判斷", status: "已驗證", note: "SOP 與 Office 說明設定前先選一個 provider/model，只回報非敏感選項，不貼 API key、不登入、不喚醒。" },
      { label: "Hermes provider/model 選擇表", status: "已驗證", note: "Office 可複製非敏感 provider/model 選擇表，只填候選 provider、model、帳號/額度與是否需要命令預覽，不收 API key。" },
      { label: "Hermes provider/model 選擇回覆檢查", status: "已驗證", note: "Office 可複製 Codex 檢查規則，收到選擇表後只判斷缺項、下一步與 GO/WAIT/PAUSE，不登入、不填 key、不執行命令。" },
      { label: "Hermes provider/model 設定命令預覽", status: "已驗證", note: "Office 可複製 provider/model 設定前命令預覽請求，要求 Codex 只列候選步驟、風險與停手線，不直接執行。" },
      { label: "Hermes provider/model 自行設定陪跑卡", status: "已驗證", note: "Office 可複製使用者自行設定 provider/model/API key 時的陪跑清單，Codex 只接非敏感回報，不登入、不填 key。" },
      { label: "Hermes provider/model 設定後交接", status: "已驗證", note: "Office 可複製自行設定後的交接卡，讓使用者只回報 provider/model/key 是否已就緒與不含憑證錯誤，不貼密鑰。" },
      { label: "Hermes 設定完成回報", status: "已驗證", note: "Office 可複製非敏感回報模板，讓使用者填模型/provider 狀態，但不貼 API key、token 或密碼。" },
      { label: "Hermes 設定回報判讀規則", status: "已驗證", note: "Office 可複製設定完成回報的 Codex 判讀規則，只決定可否跑只讀檢查或 Test environment，不建立任務、不喚醒。" },
      { label: "Hermes 只讀檢查前確認", status: "已驗證", note: "Office 可複製只讀檢查前確認卡，確認回報無敏感資訊、只看 preview/bridge/status/Test environment，不改設定或喚醒。" },
      { label: "Hermes 只讀檢查請求", status: "已驗證", note: "Office 可複製 GO read-only check 後的只讀檢查請求，只允許健康檢查與 Test environment，不寫檔、不改設定、不喚醒。" },
      { label: "Hermes 只讀檢查結果交接", status: "已驗證", note: "Office 可複製只讀檢查跑完後的結果交接表，只貼 preview/bridge/status/Test environment 摘要，不貼 raw log 或密鑰。" },
      { label: "Hermes 只讀檢查結果判讀", status: "已驗證", note: "Office 可複製只讀檢查後的結果判讀規則，只輸出 PASS/WARN/FAIL/PAUSE 與下一個安全動作，不直接進喚醒。" },
      { label: "Hermes 只讀 PASS 後交接", status: "已驗證", note: "Office 可複製只讀檢查 PASS 後的交接卡，明確限制下一步只能準備第 4 階喚醒前檢查，不代表可喚醒。" },
      { label: "Hermes 第 3 階設定檢查表", status: "已驗證", note: "Office 可複製第 3 階設定檢查表，區分可回報狀態、不可貼憑證與只讀 Test environment 條件。" },
      { label: "Hermes 安裝與環境測試 SOP", status: "已驗證", note: "已新增 Hermes SOP，從 Python/CLI/API key 到 Test environment 與沙盒喚醒都有步驟。" },
      { label: "Hermes 本地模型喚醒", status: "已驗證", note: "AI-97978 一次性 Sandbox/Test 喚醒已成功，Hermes Sandbox Engineer 留下可覆盤留言；完成後員工已暫停，heartbeat 仍關閉。" },
      { label: "Hermes 第二沙盒任務準備", status: "已驗證", note: "Office 可複製第二個 Sandbox/Test 任務準備卡；只整理候選 issue、目的與停手線，不授權喚醒、不 Run now、不排程。" },
      { label: "Hermes 第二沙盒 issue 草稿", status: "已驗證", note: "Office 可複製或預填第二個 Sandbox/Test issue 草稿；只建立待辦草稿，不沿用第一次授權、不喚醒 Hermes。" },
      { label: "Hermes 第二沙盒 issue 覆盤", status: "已驗證", note: "Office 可複製第二沙盒 issue 建立後覆盤表，確認仍是待辦草稿、沒有 run、沒有排程、沒有喚醒 Hermes。" },
      { label: "Hermes 第二沙盒授權模板", status: "已驗證", note: "Office 可複製第二個 Sandbox/Test issue 的一次性授權模板；模板本身不是授權，需使用者填入 issue 與員工後另行貼出。" },
      { label: "Hermes 第二沙盒授權判讀", status: "已驗證", note: "Office 可複製第二次授權句貼出後的 ACCEPT/WAIT/PAUSE 判讀卡；未 ACCEPT 前不喚醒 Hermes。" },
      { label: "Hermes 第二沙盒喚醒前最後確認", status: "已驗證", note: "Office 可複製第二次 ACCEPT 後的最後確認卡；再次核對單一 issue、單一員工、無 run/recovery/排程後才可等待執行授權。" },
      { label: "AI-98227 第二沙盒喚醒覆盤", status: "已驗證", note: "AI-98227 已在明確一次性授權下完成 Sandbox/Test 喚醒；run 515b2fe4 成功，Hermes 已留言，完成後員工暫停、issue done、active run 為空。" },
      { label: "Hermes runtime skill key 回報證據", status: "已驗證", note: "AI-98530 真測通過：Hermes 回覆含 Paperclip runtime capability keys 段落，7 個 exact keys 都逐項標示 used 或 visible but not used。" },
      { label: "Hermes runtime skill key 回覆提示", status: "已驗證", note: "hermes_local 會把 Final Required Output Contract 放在 workflow 後面，要求 Hermes 列出 exact runtime capability keys；AI-98530 已證明模型會照格式回覆。" },
      { label: "AI-98228 skill key 驗證 issue 準備", status: "已驗證", note: "已建立 AI-98228 作為下一次 exact runtime skill key Sandbox/Test 驗證 issue；目前 backlog、Hermes 暫停、無 active run，等待明確一次性授權。" },
      { label: "AI-98228 skill key 驗證喚醒覆盤", status: "已驗證", note: "AI-98228 一次性喚醒、停手與失敗覆盤已完成；exact key 缺口後續由 AI-98530 final output contract proof 補齊。" },
      { label: "Hermes runtime skill prompt 只讀 preflight", status: "已驗證", note: "office:hermes-preflight 已確認下一次 Hermes 輸入會把 runtime skill prompt 注入 custom promptTemplate，且 7 個 desired skills 都以 exact key 出現；仍需另行授權才可喚醒。" },
      { label: "AI-98229 preflight proof issue 準備", status: "已驗證", note: "已建立 AI-98229 作為下一次完全測試用 Sandbox/Test 驗證 issue；目前 backlog、無留言、無 active run，Hermes 仍暫停，等待明確一次性授權。" },
      { label: "AI-98229 preflight proof 喚醒覆盤", status: "已驗證", note: "AI-98229 單次喚醒、停手與 prompt 組裝路徑覆盤已完成；後續修正已由 AI-98530 真測驗證。" },
      { label: "AI-98230 fixed prompt proof issue 準備", status: "已驗證", note: "已建立 AI-98230 作為修正後真實 execute 路徑的 Sandbox/Test 驗證 issue；目前 backlog、無留言、無 active run，Hermes 仍暫停。" },
      { label: "AI-98230 fixed prompt proof 喚醒覆盤", status: "已驗證", note: "AI-98230 單次喚醒、停手與 task context 修正覆盤已完成；exact key proof 已由 AI-98530 補上。" },
      { label: "AI-98231 taskBody prompt proof issue 準備", status: "已驗證", note: "已建立 AI-98231 作為 taskBody prompt routing 的 Sandbox/Test 驗證 issue；目前 backlog、無留言、無 active run，Hermes 仍暫停。" },
      { label: "AI-98530 final output contract proof", status: "已驗證", note: "一次性 Sandbox/Test 真測完成；run 76a100e8 成功，Hermes 回覆 7 個 Paperclip runtime capability keys，完成後 paused/manual、active run 為空。" },
      { label: "非商轉定位", status: "已驗證", note: "文件已說明是個人與新手友善工具。" },
      { label: "教學文件地圖", status: "已驗證", note: "新手教學會列出入門、開源導覽、驗收清單與開機 SOP 的用途。" },
      { label: "Codex 求助文字", status: "已驗證", note: "使用教學可複製安全求助文字，提醒只做健康檢查與安全說明，不刪資料庫、不改資料、不喚醒 Hermes。" },
      { label: "每日開工檢查 UI", status: "已驗證", note: "使用教學會提醒每天先跑 office:check，Backend OK / Frontend OK 後才碰資料變更。" },
      { label: "預覽求助文字", status: "已驗證", note: "新手操作檯可複製預覽卡住時的安全求助文字，要求先看狀態報告與 office:check，不刪資料庫或手動刪 lock file。" },
      { label: "狀態報告欄位翻譯", status: "已驗證", note: "新手操作檯會把 .virtual-office-preview-status.json 的 backendOk、frontendOk、lock file、portOwnership 與 nextAction 翻成安全下一步。" },
      { label: "狀態報告覆盤模板", status: "已驗證", note: "新手操作檯可複製狀態報告覆盤模板，方便重開機後把 backendOk、frontendOk、lock file、port 與 nextAction 貼給 Codex。" },
      { label: "預覽故障決策表", status: "已驗證", note: "新手操作檯會把 backendOk false、frontendOk false、lock file 與舊程序佔用轉成先做與先不要做的判斷表。" },
      { label: "可複製預覽故障決策表", status: "已驗證", note: "新手操作檯可複製預覽故障決策表，方便卡住時把安全下一步貼給 Codex。" },
      { label: "開機安全包", status: "已驗證", note: "新手操作檯可一鍵複製每日開工檢查、預覽求助文字、狀態報告模板與故障決策表。" },
      { label: "一鍵新手啟動包", status: "已驗證", note: "新增 scripts/open-virtual-office.cmd，非工程使用者可用雙擊入口安全啟動預覽；預設 heartbeat scheduler false，不喚醒 Hermes。" },
      { label: "新手啟動文件精簡版", status: "已驗證", note: "新增中英文 quick start，把每日開工、失敗求助、Backend/Frontend/heartbeat 確認與先不要做的動作壓成短版。" },
      { label: "長時間穩定性檢查工具", status: "已驗證", note: "新增 pnpm run office:stability，可定時檢查 backend/frontend 並輸出 .virtual-office-stability-report.json；2026-05-12 已完成 60 分鐘長測，0 failed samples；2026-05-15 已完成 3/3 重開機驗收。" },
      { label: "真實頁面渲染 smoke check", status: "已驗證", note: "新增 pnpm run office:render-smoke，會用乾淨的 headless Edge/Chrome 實際載入 /AI/office，確認 React root 與 Office 文字真的渲染。" },
      { label: "完整驗證 UI 入口", status: "已驗證", note: "新手操作檯會顯示 pnpm run office:verify，讓使用者知道可一次跑 UI 型別、驗收同步、文件、預覽健康與真實渲染 smoke check。" },
      { label: "接近完成總結", status: "已驗證", note: "檢查清單可顯示並複製目前完成度、剩餘 gate 與下一個安全動作。" },
      { label: "理想版交付判斷卡", status: "已驗證", note: "檢查清單可把目前狀態分成可交付、仍需證據與不可越線三類，供開源前最後 check 使用。" },
      { label: "完成前剩餘路線", status: "已驗證", note: "檢查清單會明列技能 runtime、文件人工閱讀、Hermes 沙盒喚醒與開源前穩定性 gate 的最新狀態。" },
      { label: "98% 剩餘缺口交接", status: "已驗證", note: "檢查清單會列出所有部分完成、待開發與需人工驗收項目，並提供可複製的下一步交接。" },
      { label: "完成前 Gate 交接包", status: "已驗證", note: "檢查清單可複製最後 gate 交接包，列出完成條件、阻塞原因與不可越線動作。" },
      { label: "剩餘 Gate 決策板", status: "已驗證", note: "檢查清單會把剩餘 gate 轉成今天可做、暫緩、授權後才做的判斷，避免新手誤跨 Hermes 正式喚醒線。" },
      { label: "Runtime skill loading 驗收模板", status: "已驗證", note: "檢查清單可複製 runtime skill loading 驗收格式；AI-98530 已用 Hermes Sandbox/Test 真測補上 exact keys 證據。" },
      { label: "Hermes runtime skill loading 準備度", status: "已驗證", note: "Hermes 區塊只讀顯示 adapter skills、starter skills 同步、Sandbox/Test 與下一步驗收狀態，條件未齊前不喚醒模型。" },
      { label: "技能同步驗收交接", status: "已驗證", note: "Hermes 區塊可複製技能同步驗收交接模板，區分 desired skills 已保存與 runtime 是否真的載入。" },
      { label: "Runtime skill loading 模擬自檢", status: "已驗證", note: "Hermes 區塊可在不建立 issue、不喚醒模型的前提下，整理 starter skills runtime payload 與缺口。" },
      { label: "Hermes runtime skills 注入路徑", status: "已驗證", note: "後端 hermes_local execute 會把 desired Paperclip runtime skills 注入 task body 或自訂 promptTemplate，並有 adapter 測試覆蓋。" },
      { label: "Runtime skill loading 缺口修補順序", status: "已驗證", note: "Hermes 區塊會依 dry-run 缺口提示先建 Sandbox 草稿、同步 starter skills，再重跑 dry-run。" },
      { label: "文件人工閱讀回饋模板", status: "已驗證", note: "檢查清單可複製文件閱讀回饋格式，讓新手回報卡住位置、太工程化語句與安全提醒是否清楚。" },
      { label: "文件人工閱讀準備度", status: "已驗證", note: "檢查清單會列出第一次啟動、開源試用與 Hermes 前的閱讀文件、檢查問題與固定回報入口。" },
      { label: "新手文件自評表", status: "已驗證", note: "檢查清單可複製非工程新手文件自評表，回報能否照做、哪裡卡住與安全停手線是否清楚。" },
      { label: "中文文件完成判斷卡", status: "已驗證", note: "檢查清單可複製中文文件完成判斷，區分文件工具已準備與仍需非工程新手實際試讀。" },
      { label: "真人試讀任務卡", status: "已驗證", note: "檢查清單可複製給試讀者的任務卡，限定閱讀範圍、時間、安全邊界與回報格式。" },
      { label: "開源試讀邀請包", status: "已驗證", note: "檢查清單可複製給朋友或 GitHub 讀者的試讀邀請，說明目標、範圍、安全界線與回覆方式。" },
      { label: "開源試用回報包", status: "已驗證", note: "檢查清單可複製給開源試用者的回報格式，收集系統、預覽狀態、卡住點與安全界線，不要求貼密鑰、完整 log 或私密路徑。" },
      { label: "開源 issue 回報模板", status: "已驗證", note: "檢查清單可複製 GitHub issue 友善回報格式，讓試用者分流 bug、文件、安裝卡點與安全疑慮，並提醒不要貼密鑰或完整 log。" },
      { label: "GitHub issue template", status: "已驗證", note: "已新增 .github/ISSUE_TEMPLATE/virtual-office.yml，讓開源試用者直接在 GitHub 用安全欄位回報 Virtual Office 問題。" },
      { label: "GitHub issue 分流設定", status: "已驗證", note: "新增 .github/ISSUE_TEMPLATE/config.yml，關閉空白 issue，並連到入門文件、發布檢查表、貢獻指南與 private security advisory。" },
      { label: "Virtual Office 貢獻指南", status: "已驗證", note: "CONTRIBUTING.md 補上 Virtual Office 回報路徑、好回報內容、敏感資訊停手線與 SECURITY.md 分流。" },
      { label: "Virtual Office PR 檢查", status: "已驗證", note: "PR template 補上 Virtual Office verification block，提醒跑 office:verify、人工檢查頁面/文件、同步驗收清單與保留 Hermes 停手線。" },
      { label: "第一次貢獻 SOP", status: "已驗證", note: "新增中英文 first contribution SOP，讓第一次貢獻者只做小範圍文件、UI 文字、檢查清單或開源導覽修正，並保留 Hermes/Run now/排程停手線。" },
      { label: "Virtual Office PR 審查 SOP", status: "已驗證", note: "新增中英文 PR review SOP，維護者合併前檢查範圍、office:verify、文件/UI/檢查清單同步與 Hermes 停手線。" },
      { label: "README Virtual Office 入口", status: "已驗證", note: "README 新增 Virtual Office 段落，連到中英文入門、開源導覽、驗收清單、office:verify 與安全 issue form。" },
      { label: "開源目前狀態揭露", status: "已驗證", note: "README 與中英文開源導覽都明確說明 AI-98530 已補 runtime/Hermes Sandbox 證據，中文文件試讀、60 分鐘長測與 3/3 重開機驗收已通過；剩餘 gate 是英文文件試讀與正式 Hermes 喚醒授權。" },
      { label: "開源發布檢查表文件", status: "已驗證", note: "新增中英文 release checklist，發布前逐項核對 README、issue form、PR template、CONTRIBUTING、SECURITY、驗收文件、本機檔案與停手線。" },
      { label: "開源試用發布 Go/Pause SOP", status: "已驗證", note: "新增中英文 release decision SOP，對外分享前用 Go / Pause / Internal Only 判斷是否只適合試用、需暫停或留在內部整理。" },
      { label: "英文開機預覽復原 SOP", status: "已驗證", note: "新增 docs/virtual-office-startup-sop.en.md，英文入門、開源導覽、README 與 release checklist 都連到安全復原流程。" },
      { label: "發布前試讀證據檢查", status: "已驗證", note: "中英文 release checklist 都要求確認複製證據紀錄與真人試讀證據，避免把模板當成文件已完成。" },
      { label: "開源發布備註草稿", status: "已驗證", note: "新增中英文 release notes draft，對外說明可試用項目、仍保留的三個 gate 與安全停手線。" },
      { label: "開源前人工驗收總表", status: "已驗證", note: "檢查清單可複製單一總表，合併中文試讀、英文試讀、多次重開機與長時間穩定性，不再新增無限流程卡。" },
      { label: "開源回報分流 SOP", status: "已驗證", note: "新增中英文 feedback triage SOP，收到回報後先分流預覽、文件、UI、Hermes 前置、Routine 安全或 private security path。" },
      { label: "維護者日常檢查 SOP", status: "已驗證", note: "新增中英文 maintainer daily SOP，維護者每天先跑 office:verify、分流回報、記錄進度，並保留 Hermes/Run now/排程停手線。" },
      { label: "回報轉工作項目 SOP", status: "已驗證", note: "新增中英文 feedback-to-work-items SOP，把已分流回報轉成文件、UI、驗收清單、進度紀錄或安全處理工作項目。" },
      { label: "試讀回饋彙整表", status: "已驗證", note: "檢查清單可複製回饋彙整表，把真人試讀意見分成必修、建議修、可延後與安全風險。" },
      { label: "試讀回饋回填卡", status: "已驗證", note: "檢查清單可複製回填卡，把試讀意見轉成文件修改、UI 文字、安全提醒與驗收狀態更新。" },
      { label: "試讀證據紀錄表", status: "已驗證", note: "檢查清單可複製逐位讀者的證據紀錄，追蹤第一步、安全邊界、卡住位置與是否足以推進文件 gate。" },
      { label: "新手名詞翻譯", status: "已驗證", note: "使用教學會把 agent、issue、project、skill 翻成辦公室語言，降低第一次使用的理解門檻。" },
      { label: "第一次使用路線", status: "已驗證", note: "使用教學把初次使用分成只看介面、沙盒測試與正式使用三條路線。" },
      { label: "繼續前狀態判斷", status: "已驗證", note: "使用教學用綠燈、黃燈、紅燈說明何時可繼續、何時需記錄、何時該停下。" },
      { label: "開源安裝前確認", status: "已驗證", note: "使用教學與開源導覽會列出必要條件、可先跳過項目與卡住時的處理入口。" },
      { label: "中英文開源導覽草稿", status: "已驗證", note: "已新增適合 README 使用的中英文開源導覽，整理定位、功能、安全邊界與驗收方式。" },
      { label: "開源發布前安全包", status: "已驗證", note: "檢查清單可複製開源發布前安全包，確認本機設定/log 不提交、文件入口齊全、驗證指令與 Hermes 停手線都清楚。" },
      { label: "英文文件 UI 標籤對照", status: "已驗證", note: "英文入門與開源導覽列出常見中文 UI 標籤與英文意思，方便英文讀者對照畫面。" },
      { label: "英文文件試讀包", status: "已驗證", note: "檢查清單可複製英文讀者試讀包，請讀者檢查英文語氣、中文 UI 對照與安全提醒。" },
      { label: "英文文件完成判斷卡", status: "已驗證", note: "檢查清單可複製英文文件完成判斷，區分自動可讀性檢查已通過與仍需英文讀者人工確認。" },
      { label: "開機預覽復原 SOP", status: "已驗證", note: "已新增中文 SOP 與 Windows 輔助腳本，支援只檢查、啟動與重啟模式。" },
      { label: "後端卡住診斷提示", status: "已驗證", note: "啟動 helper 會列出殘留程序、embedded Postgres lock file 與安全復原建議，不會刪除資料庫檔案。" },
      { label: "預覽狀態報告", status: "已驗證", note: "office helper 每次檢查都會寫入本機狀態報告，方便重開機或求助時回看後端、前端、port 與 lock file 狀態。" },
      { label: "錯誤分頁安全處理", status: "已驗證", note: "若瀏覽器分頁落到 data 錯誤頁，先刷新或新開 Office 分頁；恢復前只做只讀檢查。" },
      { label: "預覽服務狀態教學", status: "已驗證", note: "新手操作檯會把前端、後端 health 與 embedded Postgres lock file 三種訊號翻成可判斷的下一步。" },
      { label: "後端失敗友善頁", status: "已驗證", note: "App health 失敗時會顯示復原指令與安全提醒，而不是只顯示錯誤文字。" },
      { label: "後端復原頁安全操作", status: "已驗證", note: "後端失敗頁可重新檢查 health、複製狀態紀錄與求助文字，並集中列出前端、health、SOP 與 lock file 位置。" },
      { label: "復原頁可強制重載", status: "已驗證", note: "後端復原頁新增重新載入頁面，避免前端 health 狀態偶發卡在檢查中。" },
      { label: "英文文件閱讀檢查點", status: "已驗證", note: "英文入門文件已補上人工閱讀重點，提醒開源前檢查語氣、資料變更與本地模型安全邊界。" },
    ],
  },
];

function acceptanceStatusClassName(status: AcceptanceStatus) {
  if (status === "已驗證") return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700";
  if (status === "部分完成") return "border-amber-500/40 bg-amber-500/10 text-amber-700";
  if (status === "需人工驗收") return "border-sky-500/40 bg-sky-500/10 text-sky-700";
  return "border-muted-foreground/30 bg-muted text-muted-foreground";
}

function acceptanceProgressWidth(status: AcceptanceStatus) {
  if (status === "已驗證") return "100%";
  if (status === "部分完成") return "58%";
  if (status === "需人工驗收") return "72%";
  return "18%";
}

function acceptanceNextCheck(label: string) {
  switch (label) {
    case "技能安裝精靈":
      return "打開安裝技能，確認可選員工、勾選技能與查看同步前摘要；目前先不要按同步技能。";
    case "員工改名與停用":
      return "打開員工管理，確認改名、職責範本、交接提醒與二次確認；真正保存或停用前先備份。";
    case "Starter skills":
      return "在安裝技能精靈查看三個 starter skills 的預覽與已存在偵測；建立前先確認不會重複。";
    case "建立五階段工作流":
      return "打開工作流表單，確認五階段、主管、負責人與依賴預覽；目前先不要按建立工作流。";
    case "可覆盤討論紀錄":
      return "打開會議表單，確認模板要求留下背景、觀點、決策與下一步；建立前先確認測試專案。";
    case "使用者介入討論":
      return "確認會議表單可設定介入規則，並在實際測試會議後檢查留言流程是否清楚。";
    case "需介入會議提示":
      return "需要先有一筆測試會議資料，再確認 Office 右側會議清單是否醒目標出需介入。";
    case "英文文件真人回饋 gate":
      return "請英文讀者照英文入門、開源導覽與安全提醒走一遍，回填語氣、UI 對照與卡住位置；沒有真人回饋前維持部分完成。";
    case "Hermes 本地模型喚醒":
      return "已完成 AI-97978 一次性 Sandbox/Test 喚醒；下一步只剩評估是否要再新增正式前的沙盒任務，不可連續喚醒。";
    default:
      return "先檢查 UI 是否清楚，再決定是否需要建立測試資料做端到端驗收。";
  }
}

const ACCEPTANCE_RECORD_TEMPLATE = [
  "## 單項驗收紀錄",
  "",
  "- 日期：",
  "- 驗收項目：",
  "- 測試資料：",
  "- 操作步驟：",
  "- 預期結果：",
  "- 實際結果：",
  "- 結論：通過 / 需修正 / 暫緩",
  "- 補充截圖或連結：",
];

const ACCEPTANCE_REMAINING_ROADMAP = [
  {
    title: "技能真正載入",
    status: "已驗證",
    next: "AI-98530 已完成 Sandbox/Test runtime capability key 真測；正式員工或正式專案若要啟用，仍需另行授權與安全驗收。",
    checks: [
      "Sandbox 員工已同步 starter skills，重新整理後仍保留。",
      "adapter 明確回報支援 runtime skill loading，且 preflight 看得到 7 個 desired skill keys。",
      "Sandbox/Test 任務回覆列出 7 個 exact Paperclip runtime capability keys，並標記 used 或 visible but not used。",
    ],
  },
  {
    title: "英文文件真人回饋 gate",
    status: "部分完成",
    next: "中文 UI 對照與安全提醒已由使用者確認；英文文件仍需要英文讀者或熟練英文使用者回饋後，才能從部分完成推進到已驗證。",
    checks: [
      "英文讀者看得懂 Virtual Office 的用途與第一步。",
      "英文讀者看得懂中文 UI 名詞對照，或知道去哪裡查。",
      "英文讀者知道 Hermes/local model、Run now、schedule trigger 都需要明確授權。",
      "讀者卡住的位置已回填到驗收清單、文件或進度紀錄。",
    ],
  },
  {
    title: "Hermes 沙盒喚醒",
    status: "已驗證",
    next: "AI-97978、AI-98227 與 AI-98530 已證明 Sandbox/Test 喚醒、留言、覆盤與停手流程可運作；仍不可延伸成正式專案或連續喚醒。",
    checks: [
      "Backend OK / Frontend OK，且 office:verify 通過。",
      "Hermes Sandbox 員工、Sandbox/Test 專案與 API key 安全邊界都已確認。",
      "每次喚醒都只使用新的 Sandbox/Test issue 與新的逐字一次性授權，不接正式專案或自動排程。",
    ],
  },
];

const ACCEPTANCE_GATE_DECISIONS = [
  {
    title: "今天可安全做",
    tone: "綠燈",
    summary: "只讀檢查、文件試讀、缺口交接與 office:verify。",
    actions: [
      "跑 `pnpm run office:verify`，確認 Backend OK / Frontend OK。",
      "複製文件回饋、自評表或試讀任務卡，交給真人讀者。",
      "複製技能同步復查或 AI-98530 覆盤，確認 Sandbox/Test runtime key proof 已留證。",
    ],
  },
  {
    title: "先暫緩",
    tone: "黃燈",
    summary: "需要真人或長時間證據，但還不需要正式指派 Hermes。",
    actions: [
      "正式員工的 runtime skill loading 仍要另開 Sandbox/Test 或正式前驗收，不沿用 AI-98530 當正式授權。",
      "文件 gate 要等非工程新手或英文讀者回饋後再更新狀態。",
      "資料變更 E2E 只在 preview health 穩定且測試資料清楚時做。",
    ],
  },
  {
    title: "授權後才做",
    tone: "紅燈",
    summary: "Hermes 安裝、設定、喚醒、Run now 與 schedule trigger。",
    actions: [
      "沒有使用者明確 GO，不再新增 Hermes 喚醒、不下載、不改 PATH。",
      "不貼 API key、token、密碼或完整 `.env`。",
      "任何下一次喚醒都只准用新的 Sandbox/Test issue 與新的逐字一次性授權，不接正式專案或自動排程。",
    ],
  },
];

const ACCEPTANCE_DELIVERY_DECISIONS = [
  {
    title: "可交付",
    status: "可以開源試用",
    detail: "2.5D Office UI、員工/skills/專案/工作流/會議/排程安全、預覽復原與檢查表同步已有可操作入口。",
    checks: [
      "office:verify 通過，Backend OK / Frontend OK。",
      "新手可從教學、檢查清單、開源導覽與 SOP 找到下一步。",
      "所有會改資料的功能都有沙盒、確認或停手提醒。",
    ],
  },
  {
    title: "仍需證據",
    status: "先保留 gate",
    detail: "AI-98530 已補 runtime/Hermes Sandbox 證據，中文文件試讀、60 分鐘長測與 3/3 重開機驗收也已通過；英文真人試讀與正式 Hermes 喚醒仍需要實際證據後才能標成完成。",
    checks: [
      "Hermes/local model 真接 Sandbox/Test 任務時能看出 skills 被載入。",
      "非工程新手照文件操作後回填卡住點。",
      "英文讀者確認英文導覽、UI 標籤與安全線可理解。",
    ],
  },
  {
    title: "不可越線",
    status: "需要明確授權",
    detail: "Hermes 安裝、憑證、Run now、schedule trigger、heartbeat scheduler 與正式專案喚醒都不能靠交付判斷自動放行。",
    checks: [
      "不安裝 Hermes、不填 API key、token、密碼或完整 .env。",
      "不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
      "不把 Sandbox/Test 通過直接當成正式專案可用。",
    ],
  },
];

const OPEN_SOURCE_RELEASE_SAFETY_ITEMS = [
  {
    title: "不要提交本機狀態",
    detail: ".paperclip-dev-config.json、.paperclip-dev*.log、paperclip-dev*.log、.virtual-office-preview-status.json 與任何 .env 都應留在本機。",
  },
  {
    title: "文件入口齊全",
    detail: "中英文入門、開源導覽、驗收清單、開機 SOP、Hermes SOP 與 Routine safety notes 都要能被找到。",
  },
  {
    title: "驗證方式一致",
    detail: "發布前先跑 pnpm run office:verify；它會檢查 UI 型別、驗收同步、文件連結與預覽健康。",
  },
  {
    title: "Hermes 停手線",
    detail: "開源試用不代表安裝 Hermes、填憑證、Run now、啟用 schedule trigger 或喚醒模型。",
  },
];

function buildRemainingRoadmapMarkdown() {
  return [
    "## 完成前剩餘路線",
    "",
    ...ACCEPTANCE_REMAINING_ROADMAP.flatMap((item) => [
      `- ${item.title}（${item.status}）：${item.next}`,
      ...item.checks.map((check) => `  - [ ] ${check}`),
    ]),
    "",
  ];
}

function buildGateDecisionBoardMarkdown() {
  return [
    "## Virtual Office 剩餘 Gate 決策板",
    "",
    `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
    "- 用途：把最後 gate 轉成今天可做、暫緩、授權後才做的判斷。",
    "",
    ...ACCEPTANCE_GATE_DECISIONS.flatMap((decision) => [
      `### ${decision.tone} ${decision.title}`,
      decision.summary,
      ...decision.actions.map((action) => `- ${action}`),
      "",
    ]),
    "### 對應剩餘 gate",
    ...ACCEPTANCE_REMAINING_ROADMAP.map((item) => `- ${item.title}（${item.status}）：${item.next}`),
    "",
    "### 明確停手線",
    "- 不把 AI-98530 的 Sandbox/Test 證據延伸成正式員工或正式專案授權。",
    "- 不把文件模板當成真人已看懂。",
    "- 不把 Hermes 前置檢查當成安裝或喚醒授權。",
    "",
  ];
}

function buildFinalGateHandoffMarkdown() {
  return [
    "## Virtual Office 完成前 Gate 交接包",
    "",
    `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
    "- 目的：把不能硬完成的最後 gate 交接清楚，避免誤按安裝、喚醒或正式資料操作。",
    "",
    "### 目前剩餘 gate",
    ...ACCEPTANCE_REMAINING_ROADMAP.flatMap((item) => [
      `- ${item.title}（${item.status}）`,
      `  - 下一步：${item.next}`,
      "  - 完成條件：",
      ...item.checks.map((check) => `    - [ ] ${check}`),
    ]),
    "",
    "### 目前先不要越線",
    "- 不把 `技能安裝精靈` 或 AI-98530 的 Sandbox/Test 證據延伸成正式員工授權。",
    "- 不把文件準備工具視為真人已讀過且能看懂。",
    "- 不安裝、不設定、不喚醒 Hermes，除非使用者明確授權。",
    "- 不貼 API key、token、密碼或完整 `.env`。",
    "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
    "",
    "### 下一位接手者先做",
    "- 跑 `pnpm run office:verify`，確認 Backend OK / Frontend OK。",
    "- 若要處理 skills，只先看 `複製技能交接` 與 `複製技能載入驗收`。",
    "- 若要處理文件，只先看 `複製閱讀準備`、`複製文件回饋`、`複製新手自評`。",
    "- 若要處理 Hermes，只先看 `複製設定回報`、`複製下一步` 與 Hermes SOP。",
    "",
  ];
}

const DOCUMENT_REVIEW_FEEDBACK_TEMPLATE = [
  "## Virtual Office 文件人工閱讀回饋",
  "",
  "- 閱讀者：",
  "- 閱讀日期：",
  "- 文件版本或分支：",
  "- 閱讀文件：",
  "  - [ ] docs/virtual-office-getting-started.zh-TW.md",
  "  - [ ] docs/virtual-office-getting-started.en.md",
  "  - [ ] docs/virtual-office-open-source-readme.zh-TW.md",
  "  - [ ] docs/virtual-office-open-source-readme.en.md",
  "- 目標：第一次啟動 / 開源試用 / Hermes 前準備 / Routine 安全 / 其它：",
  "- 成功完成的步驟：",
  "- 卡住的位置：",
  "- 看不懂或太工程化的句子：",
  "- 安全提醒是否清楚：是 / 否，原因：",
  "- 是否知道不要刪資料庫、不要改正式資料、不要喚醒 Hermes：是 / 否",
  "- 建議改寫：",
  "- 結論：可給新手使用 / 需修正後再給新手 / 需要 Codex 協助整理",
];

const DOCUMENT_REVIEW_READINESS_ITEMS = [
  {
    title: "第一次啟動必讀",
    status: "已準備",
    docs: ["docs/virtual-office-getting-started.zh-TW.md", "docs/virtual-office-startup-sop.zh-TW.md"],
    checks: ["能照文件跑健康檢查。", "知道 Backend OK / Frontend OK 後才繼續。", "卡住時知道先貼安全求助文字。"],
  },
  {
    title: "開源試用建議讀",
    status: "已準備",
    docs: ["docs/virtual-office-open-source-readme.zh-TW.md", "docs/virtual-office-acceptance-checklist.zh-TW.md"],
    checks: ["知道目前完成度與剩餘 gate。", "知道哪些操作只可預覽，哪些會改資料。", "可以用固定格式回報文件卡點。"],
  },
  {
    title: "Hermes 前再讀",
    status: "先暫緩",
    docs: ["docs/virtual-office-hermes-sop.zh-TW.md", "docs/virtual-office-routine-safety.zh-TW.md"],
    checks: ["知道不要把 API key 寫進文件或 issue。", "知道條件未齊前不要喚醒 Hermes。", "知道 Run now 與 schedule trigger 先不要碰正式資料。"],
  },
];

function buildDocumentReviewReadinessMarkdown() {
  return [
    "## Virtual Office 文件人工閱讀準備",
    "",
    ...DOCUMENT_REVIEW_READINESS_ITEMS.flatMap((item) => [
      `- ${item.title}（${item.status}）`,
      "  - 閱讀文件：",
      ...item.docs.map((doc) => `    - [ ] ${doc}`),
      "  - 檢查問題：",
      ...item.checks.map((check) => `    - [ ] ${check}`),
    ]),
    "",
    "### 回報時請補充",
    "- 卡住的位置：",
    "- 看不懂或太工程化的句子：",
    "- 安全提醒是否清楚：是 / 否，原因：",
    "- 是否知道不要刪資料庫、不要改正式資料、不要喚醒 Hermes：是 / 否",
    "",
  ];
}

const BEGINNER_DOCUMENT_SELF_CHECK_TEMPLATE = [
  "## Virtual Office 新手文件自評表",
  "",
  "- 試讀者：",
  "- 試讀日期：",
  "- 我會寫程式嗎：會 / 不太會 / 完全不會",
  "- 我使用的系統：Windows / macOS / Linux / 不確定",
  "- 試讀文件：",
  "  - [ ] docs/virtual-office-getting-started.zh-TW.md",
  "  - [ ] docs/virtual-office-getting-started.en.md",
  "  - [ ] docs/virtual-office-open-source-readme.zh-TW.md",
  "  - [ ] docs/virtual-office-open-source-readme.en.md",
  "",
  "### 我能不能照做",
  "- 我知道第一步要先做健康檢查：是 / 否 / 不確定",
  "- 我知道 Backend OK / Frontend OK 代表可以繼續看畫面：是 / 否 / 不確定",
  "- 我知道如果卡住要貼安全求助文字，而不是亂刪資料庫：是 / 否 / 不確定",
  "- 我知道 Hermes/API key/Run now/schedule trigger 先不要碰：是 / 否 / 不確定",
  "",
  "### 卡住位置",
  "- 我在哪一段停下來：",
  "- 我看不懂的原句：",
  "- 我希望它改成怎麼說：",
  "- 我需要圖片、流程圖、按鈕位置、或範例嗎：",
  "",
  "### 安全感",
  "- 我能分辨只讀檢查和會修改資料的操作：是 / 否 / 不確定",
  "- 我知道不要貼 API key、token、密碼或完整 .env：是 / 否 / 不確定",
  "- 我知道不要喚醒 Hermes 或其它本地模型：是 / 否 / 不確定",
  "",
  "### 結論",
  "- 這份文件可以給像我一樣的新手使用：可以 / 需要小修 / 需要大修",
  "- 我最希望補上的一件事：",
];

const CHINESE_DOCUMENT_COMPLETION_DECISION_TEMPLATE = [
  "## Virtual Office 中文文件完成判斷卡",
  "",
  "- 判斷日期：",
  "- 判斷者：",
  "- 新手試讀回饋來源：",
  "",
  "### 工具與文件已準備",
  "- [ ] 中文入門文件已說明第一步與預覽健康檢查。",
  "- [ ] 開源導覽已說明個人/新手定位與安全邊界。",
  "- [ ] 文件人工閱讀準備度已列出閱讀範圍。",
  "- [ ] 新手文件自評表可複製。",
  "- [ ] 真人試讀任務卡可複製。",
  "- [ ] 試讀回饋彙整表與回填卡可複製。",
  "- [ ] `pnpm run office:verify` 通過，文件連結與檢查表同步。",
  "",
  "### 仍需非工程新手確認",
  "- [ ] 試讀者知道第一步要先做健康檢查。",
  "- [ ] 試讀者知道 Backend OK / Frontend OK 後才繼續。",
  "- [ ] 試讀者能分辨只讀檢查與會修改資料的操作。",
  "- [ ] 試讀者知道不要刪資料庫、不要貼 API key、不要 Run now、不要喚醒 Hermes。",
  "- [ ] 試讀者能指出卡住位置或確認沒有卡住。",
  "- [ ] 試讀者覺得文字不只是工程師看得懂。",
  "",
  "### 不可標成完成的情況",
  "- [ ] 還沒有非工程新手實際試讀。",
  "- [ ] 試讀者不知道第一步要做什麼。",
  "- [ ] 試讀者誤以為要刪資料庫、貼密鑰、Run now、啟用排程或喚醒 Hermes。",
  "- [ ] 試讀者看不懂主要 UI 名詞或安全停手線。",
  "",
  "### 建議驗收狀態",
  "- 文件能讓非工程新手看懂：維持部分完成 / 可改成已驗證 / 需補更多試讀",
  "- 依據：",
  "- 下一步修改：",
];

const HUMAN_DOCUMENT_REVIEW_TASK_CARD_TEMPLATE = [
  "## Virtual Office 真人試讀任務卡",
  "",
  "- 試讀者：",
  "- 試讀日期：",
  "- 預計時間：30 到 45 分鐘",
  "- 使用系統：Windows / macOS / Linux / 不確定",
  "",
  "### 請讀這幾份",
  "- [ ] docs/virtual-office-getting-started.zh-TW.md",
  "- [ ] docs/virtual-office-open-source-readme.zh-TW.md",
  "- [ ] docs/virtual-office-startup-sop.zh-TW.md",
  "- [ ] 若會英文，再看 docs/virtual-office-getting-started.en.md 或 docs/virtual-office-open-source-readme.en.md",
  "",
  "### 你可以做",
  "- 只看文件與畫面文字。",
  "- 嘗試找出第一步應該按哪裡。",
  "- 記下看不懂的句子、按鈕名稱或流程。",
  "- 回報哪裡需要截圖、範例或更白話說法。",
  "",
  "### 請不要做",
  "- 不要刪資料庫或手動刪 lock file。",
  "- 不要貼 API key、token、密碼或完整 .env。",
  "- 不要建立正式任務、不要 Run now、不要啟用 schedule trigger。",
  "- 不要安裝、設定或喚醒 Hermes 或其它本地模型。",
  "",
  "### 回報格式",
  "- 我能不能照文件找到 Virtual Office：可以 / 卡住 / 不確定",
  "- 我知道卡住時要複製安全求助文字：知道 / 不知道 / 不確定",
  "- 我知道哪些操作會改資料：知道 / 不知道 / 不確定",
  "- 我看不懂的原句：",
  "- 我希望改成：",
  "- 我覺得最需要補圖或範例的位置：",
  "- 結論：可以給新手 / 小修後可用 / 需要重寫",
];

const OPEN_SOURCE_REVIEW_INVITE_TEMPLATE = [
  "## Virtual Office 開源試讀邀請包",
  "",
  "嗨，我正在整理一個新手友善的 Virtual Office 開源工具，想請你幫忙試讀文件與畫面文字。你不需要會寫程式，也不用真的建立任務；我主要想知道：像你一樣的讀者能不能看懂第一步、知道哪裡安全、卡住時知道怎麼求助。",
  "",
  "### 請你幫我看",
  "- 是否知道這個工具是做什麼的。",
  "- 是否知道第一次開啟時要先看健康檢查與預覽狀態。",
  "- 是否能分辨只讀檢查、會改資料的操作、以及 Hermes/local model 相關高風險操作。",
  "- 是否知道卡住時可以複製安全求助文字，而不是刪資料庫或貼密鑰。",
  "",
  "### 建議閱讀範圍",
  "- docs/virtual-office-getting-started.zh-TW.md",
  "- docs/virtual-office-open-source-readme.zh-TW.md",
  "- docs/virtual-office-startup-sop.zh-TW.md",
  "- 若你會英文，也可看 docs/virtual-office-getting-started.en.md 或 docs/virtual-office-open-source-readme.en.md",
  "",
  "### 請不要做",
  "- 不要刪資料庫、lock file 或任何你不確定的檔案。",
  "- 不要貼 API key、token、密碼或完整 .env。",
  "- 不要建立正式任務、不要 Run now、不要啟用 schedule trigger。",
  "- 不要安裝、設定或喚醒 Hermes 或其它本地模型。",
  "",
  "### 回覆格式",
  "- 我看得懂這個工具的目的：可以 / 還可以 / 看不懂",
  "- 我知道第一步要做什麼：知道 / 不確定 / 不知道",
  "- 我知道哪些地方不能亂按：知道 / 不確定 / 不知道",
  "- 我卡住的位置：",
  "- 我看不懂的原句：",
  "- 我希望它改成：",
  "- 我最想看到的截圖、範例或流程圖：",
  "- 結論：可以開源給新手試用 / 小修後可以 / 需要重寫",
];

const OPEN_SOURCE_TRIAL_REPORT_TEMPLATE = [
  "## Virtual Office 開源試用回報包",
  "",
  "- 試用者：",
  "- 日期：",
  "- 作業系統：Windows / macOS / Linux / 不確定",
  "- 你是第一次使用 Paperclip / 本地模型 / agent 嗎：是 / 否 / 不確定",
  "",
  "### 你做了哪些安全步驟",
  "- [ ] 看過 docs/virtual-office-getting-started.zh-TW.md 或英文版。",
  "- [ ] 知道要先跑或請人協助跑 pnpm run office:verify。",
  "- [ ] 知道 Backend OK / Frontend OK 後才繼續。",
  "- [ ] 知道不要貼 API key、token、密碼或完整 .env。",
  "",
  "### 你看到的狀態",
  "- Office 頁面是否能打開：可以 / 不可以 / 不確定",
  "- 預覽狀態：Backend OK / Frontend OK / blocked / 不確定",
  "- 你在哪一步卡住：",
  "- 看到的錯誤摘要：請只貼短摘要，不貼完整 log 或私密路徑",
  "",
  "### 哪裡不懂",
  "- 看不懂的按鈕或詞：",
  "- 看不懂的文件句子：",
  "- 需要截圖、範例或更白話說法的位置：",
  "",
  "### 請不要貼",
  "- API key、token、密碼、完整 .env。",
  "- 完整 log、含帳號的路徑、私有 repo URL、內網 URL。",
  "- 正式客戶、公司、個人資料或任務內容。",
  "",
  "### 結論",
  "- 我能不能照文件完成第一次安全檢查：可以 / 卡住 / 需要協助",
  "- 我是否知道哪些操作不能自己按：知道 / 不知道 / 不確定",
  "- 我建議優先改善：文件 / UI 文字 / 啟動流程 / 錯誤提示 / 其它",
];

const OPEN_SOURCE_ISSUE_REPORT_TEMPLATE = [
  "## Virtual Office 開源 issue 回報模板",
  "",
  "### 回報類型",
  "- [ ] 預覽啟動卡住",
  "- [ ] Office 畫面或按鈕看不懂",
  "- [ ] 文件需要改寫",
  "- [ ] Hermes / local model 前置說明不清楚",
  "- [ ] Routine / Run now / schedule trigger 安全疑慮",
  "- [ ] 其它：",
  "",
  "### 使用環境",
  "- 作業系統：Windows / macOS / Linux / 不確定",
  "- 是否第一次使用 Paperclip / agent / 本地模型：是 / 否 / 不確定",
  "- Office 頁面是否能打開：可以 / 不可以 / 不確定",
  "- 預覽狀態：Backend OK / Frontend OK / blocked / 不確定",
  "",
  "### 我做了什麼",
  "- 我讀過的文件：",
  "  - [ ] getting started",
  "  - [ ] open-source README",
  "  - [ ] startup SOP",
  "  - [ ] Hermes SOP",
  "- 我按過或嘗試過的按鈕：",
  "- 我卡住的步驟：",
  "",
  "### 期望與實際",
  "- 我以為會發生：",
  "- 實際發生：",
  "- 短錯誤摘要：請只貼 3 到 5 行摘要，不貼完整 log",
  "",
  "### 安全確認",
  "- [ ] 我沒有貼 API key、token、密碼或完整 .env。",
  "- [ ] 我沒有貼完整 log、含帳號的路徑、私有 repo URL 或內網 URL。",
  "- [ ] 我沒有貼正式客戶、公司、個人資料或任務內容。",
  "- [ ] 這份 issue 不是 Hermes 安裝、Run now、schedule trigger 或喚醒授權。",
  "",
  "### 建議",
  "- 我希望補上的文件、截圖或提示：",
  "- 我覺得最容易誤按或誤解的地方：",
];

const DOCUMENT_REVIEW_SYNTHESIS_TEMPLATE = [
  "## Virtual Office 試讀回饋彙整表",
  "",
  "- 彙整日期：",
  "- 彙整者：",
  "- 回饋來源：朋友 / GitHub issue / Discord / 其它",
  "- 試讀人數：",
  "- 試讀文件：",
  "",
  "### 一句話結論",
  "- 可以給新手使用 / 小修後可用 / 需要大修 / 暫緩公開",
  "- 主要原因：",
  "",
  "### 必修",
  "- [ ] 卡住位置：",
  "  - 讀者原話：",
  "  - 建議修改：",
  "  - 影響：新手無法開始 / 可能誤改資料 / 可能洩漏密鑰 / 其它",
  "",
  "### 建議修",
  "- [ ] 卡住位置：",
  "  - 讀者原話：",
  "  - 建議修改：",
  "  - 影響：理解變慢 / 需要截圖 / 需要範例 / 其它",
  "",
  "### 可延後",
  "- [ ] 想補但不阻塞開源的項目：",
  "  - 原因：",
  "",
  "### 安全風險",
  "- [ ] 有人誤以為可以刪資料庫、lock file 或不確定的檔案：是 / 否 / 不確定",
  "- [ ] 有人誤以為可以貼 API key、token、密碼或完整 .env：是 / 否 / 不確定",
  "- [ ] 有人誤以為可以 Run now、啟用 schedule trigger 或喚醒 Hermes：是 / 否 / 不確定",
  "- [ ] 有人分不清只讀檢查與會改資料的操作：是 / 否 / 不確定",
  "",
  "### 下一步",
  "- [ ] 修中文入門文件",
  "- [ ] 修英文入門文件",
  "- [ ] 修開源導覽",
  "- [ ] 補截圖或流程圖",
  "- [ ] 回到 Virtual Office 檢查清單更新狀態",
];

const DOCUMENT_REVIEW_BACKFILL_TEMPLATE = [
  "## Virtual Office 試讀回饋回填卡",
  "",
  "- 回填日期：",
  "- 回填者：",
  "- 回饋來源：朋友 / GitHub issue / Discord / 英文讀者 / 其它",
  "- 對應試讀包：文件回饋 / 新手自評 / 真人試讀任務 / 開源試讀邀請 / 英文文件試讀包",
  "",
  "### 先不要誤判",
  "- [ ] 這只是回填讀者意見，不代表文件 gate 已完成。",
  "- [ ] 只有讀者實際照文件走過並能說清楚第一步、安全界線與卡住位置，才可把文件 gate 往完成推進。",
  "- [ ] 若讀者誤解 API key、資料庫、Run now、schedule trigger 或 Hermes 喚醒，先標成安全風險。",
  "",
  "### 需要改的文件",
  "- [ ] docs/virtual-office-getting-started.zh-TW.md：",
  "- [ ] docs/virtual-office-getting-started.en.md：",
  "- [ ] docs/virtual-office-open-source-readme.zh-TW.md：",
  "- [ ] docs/virtual-office-open-source-readme.en.md：",
  "- [ ] docs/virtual-office-routine-safety.zh-TW.md / .en.md：",
  "- [ ] docs/virtual-office-hermes-sop.zh-TW.md：",
  "",
  "### 需要改的 UI 文字",
  "- [ ] 按鈕或面板名稱：",
  "- [ ] 說明文字：",
  "- [ ] 安全提醒：",
  "- [ ] 需要補截圖、流程圖或例子：",
  "",
  "### 安全風險回填",
  "- [ ] 有人想刪資料庫或 lock file：是 / 否 / 不確定",
  "- [ ] 有人想貼 API key、token、密碼或完整 .env：是 / 否 / 不確定",
  "- [ ] 有人想 Run now、啟用 schedule trigger 或喚醒 Hermes：是 / 否 / 不確定",
  "- [ ] 有人分不清只讀檢查與資料變更：是 / 否 / 不確定",
  "",
  "### 驗收狀態建議",
  "- 文件能讓非工程新手看懂：維持部分完成 / 可改成已驗證 / 需補更多試讀",
  "- 有英文版文件：維持部分完成 / 可改成已驗證 / 需補英文讀者回饋",
  "- 依據：",
  "",
  "### 下一步",
  "- [ ] 建立文件修改待辦",
  "- [ ] 修改文件或 UI 文字",
  "- [ ] 再請一位讀者試讀",
  "- [ ] 更新驗收清單與進度紀錄",
];

const DOCUMENT_REVIEW_EVIDENCE_LOG_TEMPLATE = [
  "## Virtual Office 試讀證據紀錄表",
  "",
  "- 紀錄日期：",
  "- 紀錄者：",
  "- 試讀者代稱：",
  "- 試讀者背景：非工程 / 工程 / 本地模型新手 / Paperclip 新手 / 英文讀者 / 其它",
  "- 試讀語言：中文 / 英文 / 中英對照",
  "- 試讀方式：只看文件 / 看文件與畫面 / 實際開啟預覽 / 其它",
  "",
  "### 試讀範圍",
  "- [ ] docs/virtual-office-getting-started.zh-TW.md",
  "- [ ] docs/virtual-office-getting-started.en.md",
  "- [ ] docs/virtual-office-open-source-readme.zh-TW.md",
  "- [ ] docs/virtual-office-open-source-readme.en.md",
  "- [ ] docs/virtual-office-startup-sop.zh-TW.md",
  "- [ ] docs/virtual-office-startup-sop.en.md",
  "- [ ] docs/virtual-office-routine-safety.zh-TW.md / .en.md",
  "",
  "### 必須能說清楚的事",
  "- [ ] 讀者知道第一步是先確認預覽健康，而不是直接建立任務。",
  "- [ ] 讀者知道 Backend OK / Frontend OK 才繼續。",
  "- [ ] 讀者能分辨只讀檢查與會修改資料的操作。",
  "- [ ] 讀者知道不要刪資料庫、不要手動刪 lock file。",
  "- [ ] 讀者知道不要貼 API key、token、密碼或完整 .env。",
  "- [ ] 讀者知道不要 Run now、不要啟用 schedule trigger、不要喚醒 Hermes。",
  "",
  "### 讀者原話",
  "- 我看得懂的地方：",
  "- 我卡住的位置：",
  "- 我看不懂的原句：",
  "- 我希望改成：",
  "- 我覺得需要截圖、範例或流程圖的位置：",
  "",
  "### 安全風險",
  "- [ ] 讀者想刪資料庫或 lock file。",
  "- [ ] 讀者想貼密鑰、完整 .env、完整 log 或私密路徑。",
  "- [ ] 讀者想建立正式任務、Run now、啟用排程或喚醒 Hermes。",
  "- [ ] 讀者分不清 Sandbox/Test 與正式資料。",
  "- 風險說明：",
  "",
  "### Gate 判斷",
  "- 文件能讓非工程新手看懂：仍部分完成 / 可推進已驗證 / 需要再試讀",
  "- 有英文版文件：仍部分完成 / 可推進已驗證 / 需要英文讀者再試讀",
  "- 判斷依據：",
  "- 下一步修改：",
];

const OPEN_SOURCE_FINAL_MANUAL_EVIDENCE_TEMPLATE = [
  "## Virtual Office 開源前人工驗收總表",
  "",
  "- 彙整日期：",
  "- 彙整者：",
  "- 目標版本 / branch：",
  "- `pnpm run office:verify` 結果：PASS / FAIL",
  "- 是否仍保持 heartbeat scheduler false：是 / 否",
  "",
  "### 這張表的目的",
  "- 只用一張表收攏最後人工 gate，不為每次重開機、每位讀者或每次長測新增流程卡。",
  "- 這不是 Hermes 安裝授權，不是 Run now 授權，不是 schedule trigger 授權，也不是正式專案喚醒授權。",
  "- 若任何一項 FAIL，先記錄原因與修正，不把開源前人工 gate 標成完成。",
  "",
  "### A. 中文非工程新手試讀",
  "| 項目 | 結果 | 證據 / 讀者原話 | 下一步 |",
  "| --- | --- | --- | --- |",
  "| 知道第一步要先做預覽健康檢查 | PASS / FAIL |  |  |",
  "| 知道 Backend OK / Frontend OK / render smoke 的差異 | PASS / FAIL |  |  |",
  "| 能分辨只讀檢查與會修改資料的操作 | PASS / FAIL |  |  |",
  "| 知道不要刪資料庫、不要貼密鑰、不要 Run now、不要喚醒 Hermes | PASS / FAIL |  |  |",
  "| 能指出卡住位置或確認沒有卡住 | PASS / FAIL |  |  |",
  "",
  "### B. 英文文件試讀",
  "| 項目 | 結果 | 證據 / 讀者原話 | 下一步 |",
  "| --- | --- | --- | --- |",
  "| 英文讀者看得懂 Virtual Office 的用途 | PASS / FAIL |  |  |",
  "| 英文讀者知道 startup / preview recovery 的安全流程 | PASS / FAIL |  |  |",
  "| 英文讀者看得懂中文 UI 名詞對照或知道去哪裡查 | PASS / FAIL |  |  |",
  "| 英文讀者知道 Hermes/local model 需要明確授權 | PASS / FAIL |  |  |",
  "",
  "### C. 多次重開機",
  "| 次數 | `office:restart` | `office:verify` | render smoke | 結論 | 備註 |",
  "| --- | --- | --- | --- | --- | --- |",
  "| 1 / 3 | PASS / FAIL | PASS / FAIL | PASS / FAIL | PASS / FAIL |  |",
  "| 2 / 3 | PASS / FAIL | PASS / FAIL | PASS / FAIL | PASS / FAIL |  |",
  "| 3 / 3 | PASS / FAIL | PASS / FAIL | PASS / FAIL | PASS / FAIL |  |",
  "",
  "### D. 長時間穩定性",
  "| 項目 | 結果 | 證據 | 備註 |",
  "| --- | --- | --- | --- |",
  "| `pnpm run office:stability` 60 到 120 分鐘 | PASS / FAIL | `.virtual-office-stability-report.json` 摘要： |  |",
  "| 長測期間 Backend / Frontend / render smoke 沒有掉線 | PASS / FAIL |  |  |",
  "| 長測期間沒有 active Hermes run、沒有 recovery chain、沒有正式資料喚醒 | PASS / FAIL |  |  |",
  "",
  "### 最終判斷",
  "- 中文文件 gate：維持部分完成 / 可推進已驗證 / 需要再試讀",
  "- 英文文件 gate：維持部分完成 / 可推進已驗證 / 需要再試讀",
  "- 開源前多次重開機：已驗證 / 3 次皆通過",
  "- 開源前長時間穩定性：已驗證 / 需補更長測試",
  "- 是否可開源試用：可以 / 小修後可以 / 暫緩",
  "- 判斷依據：",
  "- 下一步：",
];

const ENGLISH_DOCUMENT_REVIEW_PACKET_TEMPLATE = [
  "## Virtual Office English Documentation Review Packet",
  "",
  "- Reviewer:",
  "- Review date:",
  "- Native / comfortable language:",
  "- Operating system:",
  "",
  "### Please Read",
  "- [ ] docs/virtual-office-getting-started.en.md",
  "- [ ] docs/virtual-office-open-source-readme.en.md",
  "- [ ] docs/virtual-office-routine-safety.en.md",
  "- [ ] If needed, compare against the Chinese UI labels in the Office checklist.",
  "",
  "### Please Check",
  "- [ ] I understand what Virtual Office is for.",
  "- [ ] I know the first safe step is to run the preview health check.",
  "- [ ] I can match the Chinese UI labels to the English explanation.",
  "- [ ] I understand the difference between read-only checks and data-changing actions.",
  "- [ ] I understand that Hermes/local model setup should not start without explicit authorization.",
  "",
  "### Safety Clarity",
  "- Do the docs clearly say not to delete the database or lock files: yes / no / unsure",
  "- Do the docs clearly say not to paste API keys, tokens, passwords, or a full .env: yes / no / unsure",
  "- Do the docs clearly say not to press Run now, enable schedule triggers, or wake Hermes: yes / no / unsure",
  "",
  "### Feedback",
  "- Sentence or section that feels too technical:",
  "- Missing screenshot, example, or flow:",
  "- Chinese UI label that still needs a clearer English explanation:",
  "- One thing that would make the docs easier for beginners:",
  "- Conclusion: ready for English readers / small edits first / major rewrite needed",
];

const ENGLISH_DOCUMENT_COMPLETION_DECISION_TEMPLATE = [
  "## Virtual Office English Documentation Completion Decision",
  "",
  "- Review date:",
  "- Reviewer / maintainer:",
  "- English reader feedback source:",
  "",
  "### Already Covered By Automation",
  "- [ ] `pnpm run office:verify` passes.",
  "- [ ] English Virtual Office docs have no known mojibake findings.",
  "- [ ] English docs include common Chinese UI label translations.",
  "- [ ] English docs mention preview health checks and safe recovery.",
  "- [ ] English docs mention not to paste API keys, tokens, passwords, or a full `.env`.",
  "- [ ] English docs mention not to press Run now, enable schedule triggers, or wake Hermes without explicit authorization.",
  "",
  "### Still Needs A Human English Reader",
  "- [ ] The reader understands what Virtual Office is for.",
  "- [ ] The reader knows the first safe step.",
  "- [ ] The reader can match Chinese UI labels to English explanations.",
  "- [ ] The reader understands read-only checks versus data-changing actions.",
  "- [ ] The reader understands Hermes/local model setup is gated.",
  "- [ ] The reader reports no sentence that feels too technical for a beginner.",
  "",
  "### Do Not Mark Complete If",
  "- [ ] There is no human English-reader feedback yet.",
  "- [ ] The reader is confused by Chinese UI labels.",
  "- [ ] The reader thinks they should paste secrets into chat, docs, issues, or Office.",
  "- [ ] The reader thinks Run now, schedule triggers, or Hermes wake-up are part of first-time setup.",
  "",
  "### Suggested Checklist Status",
  "- 有英文版文件：維持部分完成 / 可改成已驗證 / 需補英文讀者回饋",
  "- Reason:",
  "- Follow-up edits:",
];

const RUNTIME_SKILL_LOADING_CHECK_TEMPLATE = [
  "## Virtual Office Runtime Skill Loading 驗收",
  "",
  "- 驗收日期：",
  "- 測試 adapter：Hermes / Ollama / vLLM / LM Studio / 其它：",
  "- 測試員工：",
  "- 測試專案或 issue：",
  "- 已同步 skills：",
  "  - [ ] 會議紀錄與覆盤",
  "  - [ ] 需求分析",
  "  - [ ] 測試檢查",
  "- 重新整理後 desired skills 是否仍保留：是 / 否",
  "- adapter 是否明確支援 runtime skill loading：是 / 否 / 不確定",
  "- Sandbox/Test 任務提示：",
  "- agent 回覆中能看出的 skill 使用證據：",
  "- Paperclip runtime capability keys 是否逐字列出：是 / 否",
  "- 若沿用 AI-98530 證據：run `76a100e8-9e24-4acc-add4-515cde557494`，issue `AI-98530`，Hermes 已 paused/manual。",
  "- 是否只使用 Sandbox/Test issue，未接正式專案：是 / 否",
  "- 是否未喚醒正式員工或自動排程：是 / 否",
  "- 結論：通過 / 需修正 / 需另開正式前驗收",
];

const SKILL_SYNC_E2E_TASK_CARD_TEMPLATE = [
  "## Virtual Office 技能同步端到端任務卡",
  "",
  "- 驗收者：",
  "- 驗收日期：",
  "- 測試員工：Sandbox Skills Sync Test / 其它 Sandbox/Test 員工：",
  "- 測試 skills：會議紀錄與覆盤、需求分析、測試檢查",
  "",
  "### 前置確認",
  "- [ ] `pnpm run office:verify` 通過，Backend OK / Frontend OK。",
  "- [ ] 使用名稱含 Sandbox/Test/測試/沙盒的員工。",
  "- [ ] 不使用正式員工或正式專案。",
  "- [ ] 不安裝、不設定、不喚醒 Hermes 或其它本地模型。",
  "",
  "### 驗收步驟",
  "- [ ] 打開 Virtual Office。",
  "- [ ] 按 `安裝技能`。",
  "- [ ] 選擇 Sandbox/Test 員工。",
  "- [ ] 勾選三個 starter skills。",
  "- [ ] 確認同步前摘要列出將新增或保留的 skills。",
  "- [ ] 手動按 `同步技能`。",
  "- [ ] 重新整理頁面後再次打開技能精靈。",
  "- [ ] 確認 desired skills 仍保留，沒有重複 starter skills。",
  "",
  "### 回報",
  "- 同步前摘要是否清楚：是 / 否 / 不確定",
  "- 重新整理後是否仍保留：是 / 否 / 不確定",
  "- 是否只使用 Sandbox/Test 員工：是 / 否",
  "- 是否未建立 issue、Run now、排程或喚醒 Hermes：是 / 否",
  "- 卡住位置或錯誤訊息：",
  "- 結論：通過 UI/資料同步 / 需修正 / 等 runtime skill loading 驗收",
];

const SKILL_WIZARD_COMPLETION_DECISION_TEMPLATE = [
  "## Virtual Office 技能精靈完成判斷卡",
  "",
  "- 判斷日期：",
  "- 判斷者：",
  "- 測試員工：Sandbox Skills Sync Test / 其它 Sandbox/Test 員工：",
  "",
  "### 可以視為已通過",
  "- [ ] 技能安裝精靈可以打開。",
  "- [ ] 可以選擇 Sandbox/Test 員工。",
  "- [ ] 可以勾選 starter skills。",
  "- [ ] 同步前摘要能看懂將新增或保留的 skills。",
  "- [ ] 手動同步後重新整理，desired skills 仍保留。",
  "- [ ] 只讀復查確認 starter skills 保存狀態。",
  "",
  "### 仍然不能視為已完成",
  "- [ ] 尚未證明正式員工或正式專案會安全使用相同 runtime skills。",
  "- [ ] process adapter 回報 runtime skill sync unsupported 時，不可把 UI 同步當成 runtime 已通過。",
  "- [ ] AI-98530 是 Sandbox/Test 證據，不可延伸成正式專案授權。",
  "",
  "### 安全邊界",
  "- 不建立正式 issue。",
  "- 不 Run now。",
  "- 不啟用 schedule trigger。",
  "- 不喚醒 Hermes/local model；若要再測，需新 issue 與新逐字授權。",
  "- 不把 skills 同步到正式員工做第一次驗收。",
  "",
  "### 建議狀態",
  "- 技能安裝精靈：已驗證 / 需補正式員工驗收 / 需修正",
  "- 判斷依據：",
  "- 下一步：若要把 runtime skills 用到正式員工，需另開 Sandbox/Test 或正式前驗收，不沿用 AI-98530 授權。",
];

const ACCEPTANCE_SESSION_LOG = [
  {
    title: "型別檢查",
    result: "通過",
    detail: "多次執行 @paperclipai/ui typecheck，確認 Virtual Office UI 變更可編譯。",
  },
  {
    title: "瀏覽器畫面確認",
    result: "通過",
    detail: "已在 http://localhost:5173/AI/office 確認主畫面、檢查清單、快照模板與風險分流顯示正常。",
  },
  {
    title: "安全邊界",
    result: "維持",
    detail: "本日只打開視窗與重新整理畫面，沒有按建立、同步、保存、停用或清理資料的按鈕。",
  },
  {
    title: "後端復原診斷",
    result: "通過",
    detail: "已用 office helper 的只檢查模式確認會顯示 postmaster.pid、殘留程序狀態與安全復原建議。",
  },
  {
    title: "文件同步",
    result: "完成",
    detail: "同步更新驗收清單與進度紀錄，讓 UI 狀態、文件數字與下次繼續方向一致。",
  },
];

const ACCEPTANCE_TEST_BATCHES = [
  {
    title: "批次 0：沙盒與備份",
    focus: "確認只使用測試員工、測試專案與複製好的 Markdown 紀錄。",
    caution: "先不按任何會改資料的按鈕，只確認測試範圍。",
    pass: "能說出本次測試使用哪位測試員工、哪個測試專案，以及紀錄要貼回哪裡。",
    fail: "先停止後續批次，補齊測試資料名稱與紀錄位置後再開始。",
  },
  {
    title: "批次 1：技能與 starter skills",
    focus: "驗收 starter skill 建立、已存在偵測、技能勾選與同步後員工能力是否更新。",
    caution: "一次只建立缺少的 starter skill，避免重複建立 demo 資料。",
    pass: "同步後測試員工能力中能看到指定 skills，重新整理後仍保留，且沒有重複 starter skill。",
    fail: "不要連續重按建立或同步；先記錄 skill 名稱、員工、錯誤訊息與重新整理後狀態。",
  },
  {
    title: "批次 2：員工改名與停用",
    focus: "驗收改名保存、未保存提醒、交接建議、二次確認與停用後歷史紀錄保留。",
    caution: "只用測試員工操作，停用前確認沒有正式任務或主管專案。",
    pass: "保存後名稱與職責正確更新；停用前會出現交接確認；停用後正式紀錄沒有被刪除。",
    fail: "不要停用正式員工；先截下管理視窗、影響提示與員工列表狀態。",
  },
  {
    title: "批次 3：專案工作流",
    focus: "驗收五階段工作流建立後，專案、任務、主管、負責人與上下游說明是否正確。",
    caution: "只建立一個測試專案，並先記錄預期產出的五個任務。",
    pass: "測試專案產生五個階段任務，主管與負責人正確，工作流地圖能看出上下游或平行關係。",
    fail: "不要再建立第二個同名專案；先記錄已產生的專案與任務數量，再決定是否清理測試資料。",
  },
  {
    title: "批次 4：會議與覆盤",
    focus: "驗收會議任務建立後是否留下模板、參與者、介入規則與可覆盤討論欄位。",
    caution: "先用測試會議，不要把正式專案討論混進驗收資料。",
    pass: "會議 issue 內有議程、參與者、介入規則、決策理由、待確認問題與下一步欄位。",
    fail: "不要要求 agent 繼續討論；先保存 issue 內容、參與者與介入規則設定。",
  },
];

const ACCEPTANCE_CLEANUP_CHECKS = [
  "確認資料名稱有測試標記，例如 Test、Sandbox 或 Virtual Office Sandbox。",
  "記下測試員工、測試專案、測試 issue 或 starter skill 的連結與名稱。",
  "確認沒有正式任務、正式專案主管或仍需保留的討論紀錄綁在測試資料上。",
  "先把驗收紀錄補完，再決定是否清理或保留當作範例資料。",
  "若不確定是否能刪除，先停下來詢問，不要直接清理。",
];

const ACCEPTANCE_SNAPSHOT_CHECKS = [
  "目前員工清單與每位測試員工的名稱、職稱、能力摘要。",
  "技能庫中已存在的 starter skills 與準備數。",
  "測試專案名稱、目前任務數與工作流預覽中的五個階段。",
  "測試會議或覆盤 issue 的數量與是否需要使用者介入。",
  "預覽服務網址、後端健康狀態，以及是否仍顯示 restart required。",
];

const ACCEPTANCE_SNAPSHOT_TEMPLATE = [
  "## 正式驗收前快照",
  "",
  "- 日期：",
  "- 操作者：",
  "- 預覽網址：http://localhost:5173/AI/office",
  "- 測試範圍：",
  "- 測試員工：",
  "- 測試專案：",
  "- 目前 starter skills：",
  "- 目前開啟任務 / 會議：",
  "- 預計按下的資料變更按鈕：",
  "- 預期結果：",
  "- 若失敗先暫停的位置：",
];

const E2E_SANDBOX_SIGNALS = [
  {
    label: "測試員工",
    pass: "至少 1 位名稱或職稱含 Test、Sandbox、測試或沙盒。",
    pause: "沒有測試員工時，先建立草稿或指定既有測試員工，不要用正式員工停用驗收。",
  },
  {
    label: "測試專案",
    pass: "至少 1 個測試專案可承接工作流與會議驗收。",
    pause: "沒有測試專案時，先建立或規劃測試專案名稱，避免把會議掛到正式專案。",
  },
  {
    label: "starter skills",
    pass: "三個 starter skills 都存在，或清楚知道缺哪幾個。",
    pause: "缺少項目時一次只建立一個，建立前先確認沒有同名項目。",
  },
  {
    label: "覆盤會議",
    pass: "可以辨識會議或討論 issue，並知道是否需要使用者介入。",
    pause: "還沒有會議資料時，先只開測試會議，暫時不要讓 agent 自動長討論。",
  },
];

const E2E_SANDBOX_DRAFTS = [
  {
    label: "測試員工草稿",
    value: "Sandbox PM",
    detail: "用 PM 角色建立第一位驗收員工，之後再安裝 starter skills。",
  },
  {
    label: "測試工作流草稿",
    value: "Virtual Office Sandbox",
    detail: "預填五階段工作流，用來測專案主管、負責人與上下游關係。",
  },
  {
    label: "測試會議草稿",
    value: "Virtual Office Sandbox Review",
    detail: "預填覆盤會議，確認討論紀錄、使用者介入與下一步欄位。",
  },
];

const ACCEPTANCE_DATA_CHANGE_ACTIONS = [
  {
    button: "建立 starter skill",
    changes: "在技能庫建立新的公司技能。",
    preview: "先按預覽，確認名稱、描述與用途；確認沒有同名 skill 後再建立。",
  },
  {
    button: "同步技能",
    changes: "把目前勾選的 skills 寫入指定員工設定。",
    preview: "先確認員工、勾選清單與目前選取數量，不確定時先取消。",
  },
  {
    button: "保存員工變更",
    changes: "更新員工名稱、職稱或能力描述。",
    preview: "先看未保存提示與職責範本套用結果；沒有變更時按鈕應不可用。",
  },
  {
    button: "停用員工",
    changes: "把員工移出目前辦公室顯示，歷史紀錄仍保留。",
    preview: "先看影響提示、交接建議與二次確認；只用測試員工驗收。",
  },
  {
    button: "建立工作流",
    changes: "建立 Paperclip project 與五個階段任務。",
    preview: "先看工作流預覽、主管、負責人、上下游或平行關係。",
  },
  {
    button: "建立會議任務",
    changes: "建立用來討論或覆盤的 Paperclip issue。",
    preview: "先確認議程、主持人、參與者、模板與使用者介入規則。",
  },
];

const ACCEPTANCE_DATA_CHANGE_RISK_LANES = [
  {
    label: "低風險預覽",
    badge: "可先看",
    actions: ["開啟表單", "查看 starter skill 預覽", "查看工作流預覽", "複製檢查清單"],
    rule: "只讀畫面或複製到本機剪貼簿，不會改 Paperclip 資料。",
  },
  {
    label: "需要快照後再測",
    badge: "先記錄",
    actions: ["建立 starter skill", "同步技能", "保存員工變更", "建立工作流", "建立會議任務"],
    rule: "先複製快照模板，限定測試員工與測試專案，再一次只測一個動作。",
  },
  {
    label: "需要人工確認",
    badge: "先停下",
    actions: ["停用員工", "清理測試資料", "牽連正式專案的變更"],
    rule: "若會影響任務歸屬、歷史紀錄或正式專案，先停下來確認交接與清理範圍。",
  },
];

const ACCEPTANCE_DATA_CHANGE_CONFIRMATION_CARDS = [
  {
    action: "建立 starter skill",
    before: "確認 skill 名稱、用途與內容只放在測試員工身上。",
    during: "只按一次建立，若畫面沒有反應先截圖，不連續重按。",
    after: "確認 skill 出現在列表、被勾選，且沒有重複建立同名項目。",
  },
  {
    action: "同步技能",
    before: "確認目前選到的是測試員工，並記下原本已安裝的技能。",
    during: "按下同步後等待完成訊息，不切換到其他員工。",
    after: "重新打開員工技能區，確認新增技能與原本技能都還在。",
  },
  {
    action: "保存員工變更",
    before: "記下原姓名、職稱、能力與目前負責任務。",
    during: "保存前確認沒有停用勾選，保存後等待提示或畫面更新。",
    after: "重新整理頁面，確認新名稱與能力仍存在，歷史任務沒有消失。",
  },
  {
    action: "停用員工",
    before: "確認交接人、主管替代方案、進行中任務與會議草稿都已記錄。",
    during: "只在測試員工上操作，看到二次確認或交接確認時逐項核對。",
    after: "確認員工不再出現在可分派名單，但討論紀錄與既有任務仍可追溯。",
  },
  {
    action: "建立工作流",
    before: "確認專案名稱是測試專案，並記下要產生的階段與負責人。",
    during: "建立後不要立刻重複按，先看專案與 issue 是否出現。",
    after: "確認五階段任務、上下游或平行關係、主管與負責人都符合預期。",
  },
  {
    action: "建立會議任務",
    before: "確認參與者、專案、討論目標與介入規則都只用測試資料。",
    during: "建立後先停在 issue 或會議紀錄頁，觀察是否有議程與模板。",
    after: "確認討論紀錄包含背景、觀點、決策、待確認問題與下一步。",
  },
];

const ACCEPTANCE_EXECUTION_RECORDS = [
  {
    batch: "批次 0：沙盒與備份",
    result: "測試範圍已確認",
    evidence: "記下測試員工、測試專案、快照模板與紀錄貼回位置。",
    pause: "若測試資料或備份位置不明，先不要進入會改資料的批次。",
  },
  {
    batch: "批次 1：技能與 starter skills",
    result: "技能建立與同步結果",
    evidence: "截圖 starter skill 預覽、建立後清單、同步後員工技能。",
    pause: "若 skill 重複建立或同步到錯員工，先記錄並停止下一步。",
  },
  {
    batch: "批次 2：員工資料與停用",
    result: "員工變更與交接狀態",
    evidence: "記錄改名前後、能力清單、交接建議、停用後可追溯紀錄。",
    pause: "若正式任務、主管專案或討論紀錄被牽動，立即停止。",
  },
  {
    batch: "批次 3：專案工作流",
    result: "任務與上下游關係",
    evidence: "截圖五階段任務、負責人、專案主管、平行或等待上游標記。",
    pause: "若任務建立在錯專案或重複建立，先記錄再清理測試資料。",
  },
  {
    batch: "批次 4：會議與覆盤",
    result: "討論紀錄可覆盤",
    evidence: "確認 issue 內有議程、參與者、決策理由、待確認問題與下一步。",
    pause: "若 agent 開始在錯串討論或內容缺少決策背景，先停止會議。",
  },
];

const ACCEPTANCE_READINESS_GATES = [
  {
    label: "快照已記錄",
    status: "已準備",
    note: "先記錄員工、技能、專案、會議與預覽服務狀態。",
  },
  {
    label: "測試資料已限定",
    status: "已準備",
    note: "只用 Test、Sandbox 或 Virtual Office Sandbox 相關資料。",
  },
  {
    label: "批次順序已確認",
    status: "已準備",
    note: "從沙盒與備份開始，再依序測技能、員工、工作流、會議。",
  },
  {
    label: "資料變更按鈕已辨識",
    status: "已準備",
    note: "知道哪些按鈕會建立、同步、保存、停用或建立 issue。",
  },
  {
    label: "失敗與清理規則已確認",
    status: "已準備",
    note: "未通過時先停下記錄，清理前確認沒有正式資料被牽連。",
  },
];

const ACCEPTANCE_DECISION_RULES = [
  {
    label: "可以繼續下一批",
    when: "本批資料只影響測試員工或測試專案，畫面結果、重新整理後資料、文件紀錄三者一致。",
    next: "把驗收紀錄標成通過，再進入下一個批次。",
  },
  {
    label: "先暫停並記錄",
    when: "畫面看起來成功，但重新整理後資料不一致，或結果與預期只有一部分符合。",
    next: "不要重複按同一個資料變更按鈕，先記下步驟、實際畫面與相關 issue。",
  },
  {
    label: "需要回復或清理",
    when: "測試資料建立錯專案、重複建立、或牽連到正式任務與正式員工。",
    next: "先確認影響範圍，再決定保留、改名標記為測試資料，或另外安排清理。",
  },
  {
    label: "需要人工介入",
    when: "會議、工作流或 agent 討論內容包含不確定決策，或需要你確認專案方向。",
    next: "把該批標成需人工驗收，等你介入確認後再繼續。",
  },
];

const PREVIEW_SERVICE_CHECKS = [
  {
    label: "前端畫面",
    value: "localhost:5173",
    status: "看得到 Office",
    note: "代表 UI 預覽服務正常，仍可看教學、檢查清單與畫面設計。",
  },
  {
    label: "後端健康",
    value: "127.0.0.1:3100/api/health",
    status: "要回 status: ok",
    note: "若無法連線，先不要驗收會改資料的功能，改跑 office helper。",
  },
  {
    label: "資料庫鎖",
    value: "postmaster.pid",
    status: "只看提示不手動刪",
    note: "看到 lock file 時先照 SOP 重啟或重開 Windows，避免誤傷本機資料。",
  },
];

const PREVIEW_STATUS_REPORT_FIELDS = [
  {
    field: "backendOk",
    meaning: "後端資料服務是否健康。",
    safeNextStep: "false 時先不要測建立、同步、保存、停用或 Run now。",
  },
  {
    field: "frontendOk",
    meaning: "Office 頁面是否能打開。",
    safeNextStep: "false 時優先重啟前端預覽，不代表資料庫壞掉。",
  },
  {
    field: "embeddedPostgresLockFile.exists",
    meaning: "本機資料庫是否仍有 lock file。",
    safeNextStep: "只當成提示，不手動刪；先照 SOP 重啟或重開 Windows。",
  },
  {
    field: "portOwnership",
    meaning: "哪些程序正在佔用 3100、5173 或資料庫 port。",
    safeNextStep: "若 port 被舊程序佔用，先用 office:restart，不直接砍未知程序。",
  },
  {
    field: "nextAction",
    meaning: "helper 建議的下一步。",
    safeNextStep: "照建議處理；不確定時複製預覽求助文字貼回 Codex。",
  },
];

const PREVIEW_STATUS_DECISION_RULES = [
  {
    condition: "backendOk = false",
    doFirst: "先跑 office:restart，回來再看 health 是否回到 status: ok。",
    avoid: "不要建立、同步、保存、停用、Run now 或喚醒 Hermes。",
  },
  {
    condition: "backendOk = true / frontendOk = false",
    doFirst: "後端已健康，只重啟前端預覽；若 helper 顯示 Frontend blocked，跑 office:restart 後再看 localhost:5173/AI/office。",
    avoid: "不要刪資料庫、不要手動刪 postmaster.pid，也不要因為前端 blocked 就喚醒 Hermes。",
  },
  {
    condition: "lock file exists",
    doFirst: "先照 startup SOP 重啟；仍卡住時重開 Windows。",
    avoid: "不要手動刪 postmaster.pid，也不要刪資料庫資料夾。",
  },
  {
    condition: "portOwnership 有舊程序",
    doFirst: "先用 office:restart 讓 helper 清理 Paperclip 相關程序。",
    avoid: "不要手動結束未知程序，避免誤傷其他本機服務。",
  },
];

const PREVIEW_STATUS_DECISION_PROMPT = [
  "Virtual Office 預覽故障決策表",
  "",
  ...PREVIEW_STATUS_DECISION_RULES.flatMap((rule, index) => [
    `${index + 1}. ${rule.condition}`,
    `   先做：${rule.doFirst}`,
    `   先不要做：${rule.avoid}`,
  ]),
  "",
  "若不確定屬於哪一種狀況，先跑 pnpm run office:check，並複製預覽求助文字給 Codex。",
].join("\n");

const HERMES_WSL_BRIDGE_COMMAND = "scripts/hermes-wsl.cmd";
const HERMES_SANDBOX_AGENT_DRAFT = {
  template: "Hermes Local Model Engineer",
  name: "Hermes Sandbox Engineer",
  title: "本地模型工程師",
  role: "engineer" satisfies AgentRole,
  adapterType: "hermes_local",
  command: HERMES_WSL_BRIDGE_COMMAND,
  promptLines: [
    "你是 Virtual Office 的 Hermes 本地模型工程師。",
    "你只能先處理名稱含 Sandbox、Test、沙盒或測試的任務與專案。",
    "第一次任務只回覆你能看到的上下文、可用 skills、環境狀態與下一步安全檢查。",
    "不要修改檔案、不要建立正式任務、不要停用或改名員工、不要讀取或回覆 API key、token、密碼或私密設定。",
    "任何會修改正式資料、啟動長時間任務、安裝外部工具或需要模型憑證的動作，都要先等使用者確認。",
  ],
};

const HERMES_INSTALL_PREFLIGHT_CHECKS = [
  {
    label: "預覽健康",
    detail: "先確認 Backend OK / Frontend OK，頁面沒有 Restart Required。",
  },
  {
    label: "Windows 路線",
    detail: "Hermes 官方目前不支援 Native Windows；Windows 建議先走 WSL2。",
  },
  {
    label: "Hermes CLI",
    detail: "WSL2 內安裝後要能跑 hermes --help；再補 Paperclip 從 Windows 呼叫的橋接。",
  },
  {
    label: "模型憑證",
    detail: "先只設定一個 provider 與 model，API key 不寫進文件、截圖或 issue。",
  },
  {
    label: "沙盒邊界",
    detail: "第一次只用 Sandbox/Test 員工與任務，不指派正式專案或開自動 heartbeat。",
  },
];

const HERMES_PRE_INSTALL_PACKAGE = [
  {
    title: "我可以自己先做",
    status: "可準備",
    items: [
      "跑 pnpm run office:verify，確認 Backend OK / Frontend OK。",
      "確認已能打開 Office 的 Hermes / local model gate。",
      "準備 WSL2/Ubuntu 視窗，但先不要貼 API key。",
    ],
  },
  {
    title: "需要 Codex 陪同",
    status: "先交接",
    items: [
      "確認目前 Hermes WSL2 設定指引與開始設定判斷。",
      "確認要用哪個 provider / model，但不要把憑證貼進聊天或 issue。",
      "如果命令輸出看不懂，先貼不含憑證的錯誤訊息。",
    ],
  },
  {
    title: "現在先不要碰",
    status: "先暫緩",
    items: [
      "不要執行安裝或模型設定命令，除非使用者明確要求開始。",
      "不要填 API key、token、密碼到 Paperclip 文件、prompt、skills 或 issue。",
      "不要建立喚醒 issue、Run now、啟用 schedule trigger 或喚醒 Hermes。",
    ],
  },
];

const HERMES_INSTALL_AUTHORIZATION_PROMPT = [
  "## Hermes 安裝授權文字",
  "",
  "我確認要開始 Hermes 安裝或設定，請 Codex 陪同進行。",
  "",
  "### 可以做",
  "- 先跑 pnpm run office:verify，確認 Backend OK / Frontend OK。",
  "- 只在 WSL2/Ubuntu 或 Hermes 官方建議路線內檢查安裝狀態。",
  "- 顯示即將執行的命令，等我同意後再執行。",
  "- 如果命令失敗，整理不含憑證的錯誤訊息與下一步。",
  "",
  "### 不可以做",
  "- 不要自動填 API key、token、密碼。",
  "- 不要把憑證寫進 Paperclip 文件、prompt、skills、issue 或聊天紀錄。",
  "- 不要建立喚醒 issue、不要 Run now、不要啟用 schedule trigger。",
  "- 不要喚醒 Hermes 或其它本地模型。",
  "",
  "### 需要停下問我",
  "- 任何步驟要求輸入或顯示 API key、token、密碼。",
  "- 任何命令會修改正式資料、建立任務、啟用排程或喚醒模型。",
  "- 安裝路線和目前文件不一致。",
  "- 你不確定命令是否安全。",
].join("\n");

const HERMES_AUTHORIZATION_SECOND_CHECK_TEMPLATE = [
  "## Hermes 授權前二次確認",
  "",
  "請先不要執行安裝、下載、寫檔、改 PATH、設定或喚醒模型。請先用以下項目做 GO / PAUSE 判斷，等我確認 GO 後才可以進入安裝授權文字。",
  "",
  "### GO 條件",
  "- [ ] 已跑 pnpm run office:verify，Backend OK / Frontend OK。",
  "- [ ] 已複製並閱讀 Hermes 安裝前最後檢查包。",
  "- [ ] 已複製命令預覽請求，且每條命令都先列出目的、會修改什麼與風險。",
  "- [ ] 安裝路線只限 WSL2/Ubuntu 或 Hermes 官方建議路線。",
  "- [ ] 不需要把 API key、token、密碼或完整 .env 貼進對話、文件、issue 或 Office。",
  "- [ ] 第一次只做安裝或 Test environment，不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
  "",
  "### PAUSE 條件",
  "- [ ] 預覽或後端健康檢查不穩。",
  "- [ ] 命令用途不清楚，或會修改正式資料。",
  "- [ ] 命令要求輸入、顯示或保存 API key、token、密碼。",
  "- [ ] 可能建立正式任務、啟用排程、Run now 或喚醒 Hermes。",
  "- [ ] 安裝路線和 SOP 不一致，或需要下載未知來源內容。",
  "",
  "### 請回覆",
  "- 判斷：GO / PAUSE",
  "- 原因：",
  "- 下一步只允許做什麼：",
  "- 仍然禁止做什麼：",
].join("\n");

const HERMES_INSTALL_FINAL_GATE_TEMPLATE = [
  "## Hermes 安裝前最終閘門",
  "",
  "用途：在使用者貼出 Hermes 安裝授權文字前，做最後 GO / PAUSE 判斷。這不是安裝授權，也不是執行命令授權。",
  "",
  "### GO 必須全部成立",
  "- [ ] `office:verify` 已通過，Backend OK / Frontend OK。",
  "- [ ] 已讀 `Hermes 安裝前最後交接包` 或最新收工交接。",
  "- [ ] 已完成 `Hermes 授權前二次確認`，判斷為 GO。",
  "- [ ] 下一步只會先列命令預覽，不會直接執行。",
  "- [ ] 若已有 HERMES-NEXT-001 循環，預覽、單一命令同意、結果回報、判讀與循環總結都已完成。",
  "- [ ] 不需要使用者貼 API key、token、密碼或完整 .env。",
  "- [ ] 不會建立喚醒 issue、不會 Run now、不會啟用 schedule trigger、不會喚醒 Hermes。",
  "",
  "### 任何一項成立就 PAUSE",
  "- 預覽、後端或文件不同步。",
  "- 沒有最新交接或不知道上一輪停在哪裡。",
  "- 命令尚未預覽，或想一次同意多條命令。",
  "- 命令會下載、安裝、寫檔、改 PATH、改設定，但尚未逐條說明。",
  "- 需要貼憑證、登入、建立 key、保存 .env 或處理正式資料。",
  "- 任何動作可能建立 issue、Run now、啟用排程、live run 或喚醒模型。",
  "",
  "### 請回覆",
  "- 最終判斷：GO / PAUSE",
  "- 原因：",
  "- 若 GO：只允許請使用者決定是否貼出 `Hermes 安裝授權文字`。",
  "- 若 PAUSE：下一個最小修補動作：",
  "",
  "### 固定禁止",
  "- 本閘門不是安裝授權。",
  "- 不執行安裝、下載、寫檔、改 PATH 或設定命令。",
  "- 不自動填 API key、token、密碼或完整 .env。",
  "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
  "- 不喚醒 Hermes 或其它本地模型。",
].join("\n");

const HERMES_INSTALL_FINAL_GATE_DECISION_TEMPLATE = [
  "## Hermes 最終閘門判斷回覆",
  "",
  "用途：讀完 `Hermes 安裝前最終閘門` 後，固定記錄 GO / PAUSE 判斷。這不是安裝授權，也不是執行命令授權。",
  "",
  "### 判斷",
  "- 最終判斷：GO / PAUSE",
  "- 判斷時間：",
  "- 判斷依據：",
  "- 仍缺項目：無 / 有，列出：",
  "",
  "### 若是 GO",
  "- 只允許請使用者閱讀並決定是否貼出 `Hermes 安裝授權文字`。",
  "- GO 不代表可以直接安裝、下載、寫檔、改 PATH、改設定或執行命令。",
  "- GO 不代表可以填 API key、token、密碼或完整 .env。",
  "- GO 不代表可以建立喚醒 issue、Run now、啟用 schedule trigger 或喚醒 Hermes。",
  "",
  "### 若是 PAUSE",
  "- 下一個最小修補動作：",
  "- 修補後要回到哪張卡：複製最終閘門 / 複製二次確認 / 複製開工接續 / 複製下一命令預覽 / 其它",
  "- 不要跳到安裝授權文字。",
  "",
  "### 固定禁止",
  "- 不把 GO 當成安裝授權。",
  "- 不把 PAUSE 當成重試授權。",
  "- 不連續執行命令。",
  "- 不自動填 API key、token、密碼或完整 .env。",
  "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
  "- 不喚醒 Hermes 或其它本地模型。",
].join("\n");

const HERMES_INSTALL_FINAL_GATE_GO_HANDOFF_TEMPLATE = [
  "## Hermes 最終閘門 GO 後交接",
  "",
  "用途：當 `Hermes 最終閘門判斷回覆` 是 GO 時，交接到使用者閱讀安裝授權文字。這不是安裝授權，也不是命令執行授權。",
  "",
  "### GO 只代表",
  "- 最終閘門檢查目前沒有阻擋項。",
  "- 可以請使用者閱讀 `Hermes 安裝授權文字`。",
  "- 可以請使用者自己決定是否貼出安裝授權文字。",
  "- 在使用者貼出明確授權前，仍只停在準備狀態。",
  "",
  "### 下一步只允許",
  "- 顯示或複製 `Hermes 安裝授權文字`。",
  "- 提醒使用者：若不想開始安裝，就不要貼出授權文字。",
  "- 若使用者貼出授權文字，再回到 `Hermes 安裝授權貼出前確認` 判斷 ACCEPT / WAIT / PAUSE。",
  "",
  "### 仍然禁止",
  "- 不把 GO 當成安裝授權。",
  "- 不執行安裝、下載、寫檔、改 PATH、改設定或任何命令。",
  "- 不自動填 API key、token、密碼或完整 .env。",
  "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
  "- 不喚醒 Hermes 或其它本地模型。",
  "- 不把使用者的 `好的`、`繼續`、`下一步` 當成安裝授權。",
].join("\n");

const HERMES_INSTALL_FINAL_GATE_PAUSE_HANDOFF_TEMPLATE = [
  "## Hermes 最終閘門 PAUSE 修補交接",
  "",
  "用途：當 `Hermes 最終閘門判斷回覆` 是 PAUSE 時，固定修補方向。這不是重試授權、不是安裝授權，也不是命令執行授權。",
  "",
  "### PAUSE 原因",
  "- 觸發項目：預覽不穩 / 無最新交接 / 命令未預覽 / 想一次同意多條 / 需要憑證 / Run now / 排程 / 喚醒 / 其它：",
  "- 風險摘要：",
  "- 是否含敏感資訊：否 / 是，已停止且不重貼",
  "",
  "### 下一個最小修補動作",
  "- 只允許選一個：",
  "- [ ] 重新跑 `office:verify` 或只讀健康檢查。",
  "- [ ] 補最新收工交接或最後交接。",
  "- [ ] 回到 `Hermes 安裝陪同開工接續判斷`。",
  "- [ ] 回到 `Hermes 開工後下一條命令預覽`，只列一條候選命令。",
  "- [ ] 回到 `Hermes 授權前二次確認`。",
  "- [ ] 回到 `Hermes 安裝前最終閘門` 重新判斷。",
  "",
  "### 修補後",
  "- 修補完成後，重新複製最終閘門。",
  "- 重新輸出 `GO / PAUSE` 判斷。",
  "- 未重新 GO 前，不顯示安裝授權文字、不請使用者貼授權。",
  "",
  "### 固定禁止",
  "- PAUSE 不是重試授權。",
  "- 不跳過最終閘門。",
  "- 不執行安裝、下載、寫檔、改 PATH、改設定或任何命令。",
  "- 不自動填 API key、token、密碼或完整 .env。",
  "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
  "- 不喚醒 Hermes 或其它本地模型。",
].join("\n");

const HERMES_INSTALL_AUTHORIZATION_INTAKE_TEMPLATE = [
  "## Hermes 安裝授權貼出前確認",
  "",
  "請先判斷使用者剛貼出的文字是否真的授權跨過 Hermes 安裝線。未 ACCEPT 前，不安裝、不下載、不寫檔、不改 PATH、不設定、不喚醒。",
  "",
  "### 不算授權",
  "- 好的",
  "- 繼續",
  "- 下一步",
  "- 可以",
  "- 請繼續",
  "- 照你建議",
  "- 做吧",
  "- 任何沒有明確寫出 Hermes 安裝或設定範圍的句子",
  "",
  "### 可 ACCEPT 的最低文字",
  "- 我確認要開始 Hermes 安裝或設定，請 Codex 陪同進行。",
  "- 我同意第 2 階：逐條確認後陪同安裝 Hermes。",
  "- 我同意第 3 階：只做 Hermes 設定完成後的非敏感檢查。",
  "",
  "### ACCEPT 後仍然禁止",
  "- 不自動填 API key、token、密碼或完整 .env。",
  "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
  "- 不喚醒 Hermes 或其它本地模型。",
  "- 不用一次同意涵蓋後續全部命令；每條會修改系統的命令仍需逐條同意。",
  "",
  "### 請回覆",
  "- 判斷：ACCEPT / WAIT / PAUSE",
  "- 原因：",
  "- 下一步只允許做什麼：",
  "- 仍然禁止做什麼：",
].join("\n");

const HERMES_INSTALL_AUTHORIZATION_WAIT_PAUSE_TEMPLATE = [
  "## Hermes 安裝授權 WAIT/PAUSE 處理",
  "",
  "用途：當 `Hermes 安裝授權貼出前確認` 判斷為 WAIT 或 PAUSE 時，固定下一步。這不是安裝授權、不是重試授權，也不是命令執行授權。",
  "",
  "### WAIT 代表",
  "- 使用者文字可能想繼續，但沒有明確授權 Hermes 安裝或設定範圍。",
  "- 只允許請使用者補一句明確授權文字，或回到 `Hermes 安裝授權文字` 閱讀。",
  "- 例：`好的`、`繼續`、`下一步`、`照你建議` 都維持 WAIT。",
  "",
  "### PAUSE 代表",
  "- 使用者文字要求貼憑證、登入、建立 key、保存 .env、Run now、排程、建立喚醒 issue 或喚醒 Hermes。",
  "- 使用者文字要求跳過命令預覽、一次同意多條命令，或處理正式資料。",
  "- 立刻停下，記錄風險與需要改回哪張安全卡。",
  "",
  "### 下一步只允許",
  "- WAIT：請使用者選擇是否貼出 `Hermes 安裝授權文字` 的明確句子。",
  "- WAIT：或回到 `Hermes 最終閘門 GO 後交接`，重新提醒使用者可不貼授權。",
  "- PAUSE：回到 `Hermes 最終閘門 PAUSE 修補交接`。",
  "- PAUSE：或回到 `Hermes 安裝前最終閘門` 重新判斷。",
  "",
  "### 固定禁止",
  "- 不把 WAIT 或 PAUSE 當成 ACCEPT。",
  "- 不把 `好的`、`繼續`、`下一步` 當成安裝授權。",
  "- 不執行安裝、下載、寫檔、改 PATH、改設定或任何命令。",
  "- 不自動填 API key、token、密碼或完整 .env。",
  "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
  "- 不喚醒 Hermes 或其它本地模型。",
].join("\n");

const HERMES_ACCEPT_FIRST_COMMAND_PREVIEW_TEMPLATE = [
  "## Hermes ACCEPT 後第一命令預覽",
  "",
  "用途：安裝授權句檢查為 ACCEPT 後，只列第一條候選命令 HERMES-INSTALL-001。這不是命令執行授權，也不是連續安裝授權。",
  "",
  "### 使用前確認",
  "- [ ] `Hermes 安裝授權貼出前確認` 判斷為 ACCEPT。",
  "- [ ] `Hermes 安裝授權 ACCEPT 交接` 已完成。",
  "- [ ] Backend OK / Frontend OK。",
  "- [ ] 下一步仍只允許列命令，不執行。",
  "- [ ] 不需要 API key、token、密碼或完整 .env。",
  "",
  "### 請 Codex 只列一條候選命令",
  "| 欄位 | 內容 |",
  "| --- | --- |",
  "| 命令編號 | HERMES-INSTALL-001 |",
  "| 執行位置 | Windows PowerShell / WSL2 Ubuntu / 專案資料夾 / 其它 |",
  "| 候選命令 | 只列命令，不執行 |",
  "| 目的 | |",
  "| 會讀取什麼 | |",
  "| 會修改什麼 | 無 / 檔案 / PATH / 套件 / 設定 / 其它 |",
  "| 是否下載或安裝 | 否 / 是，需逐條同意 |",
  "| 是否涉及 API key/token/password/.env | 否 / 是，需 PAUSE |",
  "| 成功判斷 | |",
  "| 失敗停手線 | |",
  "| 需要使用者逐條同意 | 是 |",
  "",
  "### 固定限制",
  "- 只列 HERMES-INSTALL-001，不執行。",
  "- 不連續列多條命令要求一次同意。",
  "- 不自動填 API key、token、密碼或完整 .env。",
  "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
  "- 不喚醒 Hermes 或其它本地模型。",
].join("\n");

const HERMES_INSTALL_FIRST_COMMAND_CONSENT_TEMPLATE = [
  "## Hermes HERMES-INSTALL-001 單一命令同意",
  "",
  "用途：在 `Hermes ACCEPT 後第一命令預覽` 已完成後，只同意或拒絕 HERMES-INSTALL-001 這一條命令。這不是連續安裝授權、不是下一條命令授權，也不是憑證或喚醒授權。",
  "",
  "### 使用前確認",
  "- [ ] `Hermes 安裝授權貼出前確認` 判斷為 ACCEPT。",
  "- [ ] `Hermes ACCEPT 後第一命令預覽` 已列出 HERMES-INSTALL-001。",
  "- [ ] 實際命令必須和預覽完全一致。",
  "- [ ] 命令不包含 API key、token、密碼或完整 .env。",
  "- [ ] 命令不會建立喚醒 issue、不會 Run now、不會啟用 schedule trigger、不會喚醒 Hermes。",
  "",
  "### 使用者決定",
  "- HERMES-INSTALL-001：同意 / 不同意 / 先暫停",
  "- 若同意，只允許執行預覽中的這一條命令。",
  "- 若不同意，回到 `Hermes ACCEPT 後第一命令預覽` 重新列候選命令。",
  "- 若先暫停，回到 `Hermes 安裝授權 WAIT/PAUSE 處理` 或 `Hermes 最終閘門 PAUSE 修補交接`。",
  "",
  "### 執行後必須立刻停下",
  "- 執行後只回報結果摘要、錯誤摘要、是否下載或安裝、是否修改 PATH/套件/設定、是否出現敏感資訊。",
  "- 回報後進入 `Hermes 單一命令結果回報` 或下一張指定的結果卡。",
  "- 未完成結果回報前，不列下一條、不執行下一條。",
  "",
  "### 固定禁止",
  "- 不把 HERMES-INSTALL-001 的同意延伸成 HERMES-INSTALL-002 或 HERMES-NEXT-001。",
  "- 不把安裝授權延伸成憑證填寫、issue 建立、Run now、schedule trigger 或喚醒授權。",
  "- 不連續執行多條命令。",
  "- 不自動填 API key、token、密碼或完整 .env。",
  "- 不喚醒 Hermes 或其它本地模型。",
].join("\n");

const HERMES_INSTALL_FIRST_COMMAND_RESULT_TEMPLATE = [
  "## Hermes HERMES-INSTALL-001 單一命令結果回報",
  "",
  "用途：HERMES-INSTALL-001 執行後立刻停下，回報結果與敏感資訊檢查。未完成這張回報前，不列下一條、不執行下一條。",
  "",
  "### 本次命令",
  "- 命令編號：HERMES-INSTALL-001",
  "- 實際命令是否和預覽完全一致：是 / 否，若否請 PAUSE",
  "- 執行位置：Windows PowerShell / WSL2 Ubuntu / 專案資料夾 / 其它",
  "- 使用者是否已逐條同意：是 / 否",
  "",
  "### 結果",
  "- 狀態：PASS / WAIT / PAUSE",
  "- 輸出摘要：",
  "- 是否有錯誤：否 / 是，摘要：",
  "- 是否下載或安裝任何套件：否 / 是，摘要：",
  "- 是否修改 PATH、設定、系統或檔案：否 / 是，摘要：",
  "",
  "### 敏感資訊與越線檢查",
  "- 是否出現 API key、token、密碼或完整 .env：否 / 是，請 PAUSE",
  "- 是否碰到正式資料、正式 issue、Run now 或 schedule trigger：否 / 是，請 PAUSE",
  "- 是否有模型喚醒、agent 執行或 live run：否 / 是，請 PAUSE",
  "- 是否要求輸入憑證或登入第三方服務：否 / 是，請 WAIT 或 PAUSE",
  "",
  "### 下一步判斷",
  "- PASS：只允許進入 HERMES-INSTALL-001 結果判讀或下一張指定安全卡。",
  "- WAIT：先補資訊或只讀檢查，不執行下一條命令。",
  "- PAUSE：立刻停下，整理風險與復原建議。",
  "",
  "### 固定禁止",
  "- 不把 HERMES-INSTALL-001 的結果回報延伸成 HERMES-INSTALL-002 或 HERMES-NEXT-001 授權。",
  "- 不連續執行下一條命令。",
  "- 不自動填 API key、token、密碼或完整 .env。",
  "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
  "- 不喚醒 Hermes 或其它本地模型。",
].join("\n");

const HERMES_INSTALL_FIRST_COMMAND_DECISION_TEMPLATE = [
  "## Hermes HERMES-INSTALL-001 結果判讀",
  "",
  "用途：讀完 `Hermes HERMES-INSTALL-001 單一命令結果回報` 後，判斷下一個安全出口。這不是下一條命令授權，也不是憑證或喚醒授權。",
  "",
  "### 使用前確認",
  "- [ ] 已完成 `Hermes HERMES-INSTALL-001 單一命令結果回報`。",
  "- [ ] 命令編號是 HERMES-INSTALL-001。",
  "- [ ] 已確認實際命令是否和預覽完全一致。",
  "- [ ] 已檢查 API key、token、密碼、完整 .env、Run now、schedule trigger、live run 與模型喚醒。",
  "",
  "### 判讀規則",
  "- PASS：第一條命令結果乾淨；只允許進入下一張指定安全卡，或請使用者決定是否回到下一條命令預覽。",
  "- WAIT：資訊不足或需要只讀補查；不列下一條、不執行下一條。",
  "- PAUSE：命令不一致、出現錯誤、敏感資訊、正式資料或越線行為；立刻停下排查。",
  "",
  "### PASS 也仍然禁止",
  "- 不把 HERMES-INSTALL-001 的 PASS 當成 HERMES-INSTALL-002 或 HERMES-NEXT-001 授權。",
  "- 不連續執行下一條命令。",
  "- 不自動填 API key、token、密碼或完整 .env。",
  "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
  "- 不喚醒 Hermes 或其它本地模型。",
  "",
  "### 請回覆",
  "- 判讀：PASS / WAIT / PAUSE",
  "- 原因：",
  "- 下一個只允許做的動作：",
  "- 需要使用者決定的問題：",
  "- 仍然禁止做的事：",
].join("\n");

const HERMES_INSTALL_FIRST_COMMAND_CYCLE_SUMMARY_TEMPLATE = [
  "## Hermes HERMES-INSTALL-001 循環總結",
  "",
  "用途：整理 HERMES-INSTALL-001 這一輪做到哪裡，方便重開機、換對話、收工、覆盤或決定下一張安全卡。這不是下一條命令授權。",
  "",
  "### 本輪命令",
  "- 命令編號：HERMES-INSTALL-001",
  "- 第一命令預覽是否完成：是 / 否",
  "- 單一命令同意：同意 / 不同意 / 先暫停",
  "- 實際命令是否與預覽完全一致：是 / 否 / 未執行",
  "- 結果回報狀態：PASS / WAIT / PAUSE / 未完成",
  "- 最後判讀：PASS / WAIT / PAUSE / 未完成",
  "",
  "### 安全檢查",
  "- 是否下載或安裝任何套件：否 / 是，摘要：",
  "- 是否修改系統、PATH、設定或檔案：否 / 是，摘要：",
  "- 是否出現 API key、token、密碼或完整 .env：否 / 是，已停止",
  "- 是否碰到正式資料、正式 issue、Run now 或 schedule trigger：否 / 是，已停止",
  "- 是否有模型喚醒、agent 執行或 live run：否 / 是，已停止",
  "",
  "### 下一張安全卡",
  "- PASS：只可進入下一張指定安全卡，或請使用者決定是否回到下一條命令預覽。",
  "- WAIT：只補資訊或只讀檢查，不列下一條、不執行下一條。",
  "- PAUSE：停下整理風險、錯誤摘要與復原建議。",
  "- 收工或換對話：使用 `Hermes 安裝陪同收工交接`。",
  "",
  "### 固定禁止",
  "- 本總結不是 HERMES-INSTALL-002 或 HERMES-NEXT-001 授權。",
  "- 不連續執行下一條命令。",
  "- 不把 HERMES-INSTALL-001 的同意或 PASS 延伸成下一條同意。",
  "- 不自動填 API key、token、密碼或完整 .env。",
  "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
  "- 不喚醒 Hermes 或其它本地模型。",
].join("\n");

const HERMES_INSTALL_NEXT_COMMAND_PREVIEW_TEMPLATE = [
  "## Hermes HERMES-INSTALL-002 候選命令預覽",
  "",
  "用途：在 HERMES-INSTALL-001 循環總結判讀為 PASS 後，只列下一條候選命令 HERMES-INSTALL-002。這不是命令執行授權，也不是連續安裝授權。",
  "",
  "### 使用前確認",
  "- [ ] `Hermes HERMES-INSTALL-001 循環總結` 已完成。",
  "- [ ] HERMES-INSTALL-001 最後判讀是 PASS。",
  "- [ ] 使用者明確要求列出下一條候選命令。",
  "- [ ] 下一步仍只允許列命令，不執行。",
  "- [ ] 不需要 API key、token、密碼或完整 .env。",
  "",
  "### 請 Codex 只列一條候選命令",
  "| 欄位 | 內容 |",
  "| --- | --- |",
  "| 命令編號 | HERMES-INSTALL-002 |",
  "| 執行位置 | Windows PowerShell / WSL2 Ubuntu / 專案資料夾 / 其它 |",
  "| 候選命令 | 只列命令，不執行 |",
  "| 目的 | |",
  "| 會讀取什麼 | |",
  "| 會修改什麼 | 無 / 檔案 / PATH / 套件 / 設定 / 其它 |",
  "| 是否下載或安裝 | 否 / 是，需逐條同意 |",
  "| 是否涉及 API key/token/password/.env | 否 / 是，需 PAUSE |",
  "| 成功判斷 | |",
  "| 失敗停手線 | |",
  "| 需要使用者逐條同意 | 是 |",
  "",
  "### 固定限制",
  "- 只列 HERMES-INSTALL-002，不執行。",
  "- 不把 HERMES-INSTALL-001 的 PASS 或循環總結當成執行授權。",
  "- 不連續列多條命令要求一次同意。",
  "- 不自動填 API key、token、密碼或完整 .env。",
  "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
  "- 不喚醒 Hermes 或其它本地模型。",
].join("\n");

const HERMES_INSTALL_SECOND_COMMAND_CONSENT_TEMPLATE = [
  "## Hermes HERMES-INSTALL-002 單一命令同意",
  "",
  "用途：在 `Hermes HERMES-INSTALL-002 候選命令預覽` 已完成後，只同意或拒絕 HERMES-INSTALL-002 這一條命令。這不是連續安裝授權、不是下一條命令授權，也不是憑證或喚醒授權。",
  "",
  "### 使用前確認",
  "- [ ] `Hermes HERMES-INSTALL-001 循環總結` 最後判讀為 PASS。",
  "- [ ] `Hermes HERMES-INSTALL-002 候選命令預覽` 已列出 HERMES-INSTALL-002。",
  "- [ ] 實際命令必須和預覽完全一致。",
  "- [ ] 命令不包含 API key、token、密碼或完整 .env。",
  "- [ ] 命令不會建立喚醒 issue、不會 Run now、不會啟用 schedule trigger、不會喚醒 Hermes。",
  "",
  "### 使用者決定",
  "- HERMES-INSTALL-002：同意 / 不同意 / 先暫停",
  "- 若同意，只允許執行預覽中的這一條命令。",
  "- 若不同意，回到 `Hermes HERMES-INSTALL-002 候選命令預覽` 重新列候選命令。",
  "- 若先暫停，回到 `Hermes HERMES-INSTALL-001 循環總結` 或 `Hermes 安裝陪同收工交接`。",
  "",
  "### 執行後必須立刻停下",
  "- 執行後只回報結果摘要、錯誤摘要、是否下載或安裝、是否修改 PATH/套件/設定、是否出現敏感資訊。",
  "- 回報後進入 `Hermes 單一命令結果回報` 或下一張指定的結果卡。",
  "- 未完成結果回報前，不列下一條、不執行下一條。",
  "",
  "### 固定禁止",
  "- 不把 HERMES-INSTALL-002 的同意延伸成 HERMES-INSTALL-003 或 HERMES-NEXT-001。",
  "- 不把安裝授權延伸成憑證填寫、issue 建立、Run now、schedule trigger 或喚醒授權。",
  "- 不連續執行多條命令。",
  "- 不自動填 API key、token、密碼或完整 .env。",
  "- 不喚醒 Hermes 或其它本地模型。",
].join("\n");

const HERMES_INSTALL_SECOND_COMMAND_RESULT_TEMPLATE = [
  "## Hermes HERMES-INSTALL-002 單一命令結果回報",
  "",
  "用途：HERMES-INSTALL-002 執行後立刻停下，回報結果與敏感資訊檢查。未完成這張回報前，不列下一條、不執行下一條。",
  "",
  "### 本次命令",
  "- 命令編號：HERMES-INSTALL-002",
  "- 實際命令是否和預覽完全一致：是 / 否，若否請 PAUSE",
  "- 執行位置：Windows PowerShell / WSL2 Ubuntu / 專案資料夾 / 其它",
  "- 使用者是否已逐條同意：是 / 否",
  "",
  "### 結果",
  "- 狀態：PASS / WAIT / PAUSE",
  "- 輸出摘要：",
  "- 是否有錯誤：否 / 是，摘要：",
  "- 是否下載或安裝任何套件：否 / 是，摘要：",
  "- 是否修改 PATH、設定、系統或檔案：否 / 是，摘要：",
  "",
  "### 敏感資訊與越線檢查",
  "- 是否出現 API key、token、密碼或完整 .env：否 / 是，請 PAUSE",
  "- 是否碰到正式資料、正式 issue、Run now 或 schedule trigger：否 / 是，請 PAUSE",
  "- 是否有模型喚醒、agent 執行或 live run：否 / 是，請 PAUSE",
  "- 是否要求輸入憑證或登入第三方服務：否 / 是，請 WAIT 或 PAUSE",
  "",
  "### 下一步判斷",
  "- PASS：只允許進入 HERMES-INSTALL-002 結果判讀或下一張指定安全卡。",
  "- WAIT：先補資訊或只讀檢查，不執行下一條命令。",
  "- PAUSE：立刻停下，整理風險與復原建議。",
  "",
  "### 固定禁止",
  "- 不把 HERMES-INSTALL-002 的結果回報延伸成 HERMES-INSTALL-003 或 HERMES-NEXT-001 授權。",
  "- 不連續執行下一條命令。",
  "- 不自動填 API key、token、密碼或完整 .env。",
  "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
  "- 不喚醒 Hermes 或其它本地模型。",
].join("\n");

const HERMES_INSTALL_SECOND_COMMAND_DECISION_TEMPLATE = [
  "## Hermes HERMES-INSTALL-002 結果判讀",
  "",
  "用途：讀完 `Hermes HERMES-INSTALL-002 單一命令結果回報` 後，判斷下一個安全出口。這不是下一條命令授權，也不是憑證或喚醒授權。",
  "",
  "### 使用前確認",
  "- [ ] 已完成 `Hermes HERMES-INSTALL-002 單一命令結果回報`。",
  "- [ ] 命令編號是 HERMES-INSTALL-002。",
  "- [ ] 已確認實際命令是否和預覽完全一致。",
  "- [ ] 已檢查 API key、token、密碼、完整 .env、Run now、schedule trigger、live run 與模型喚醒。",
  "",
  "### 判讀規則",
  "- PASS：第二條命令結果乾淨；只允許進入下一張指定安全卡，或請使用者決定是否回到下一條命令預覽。",
  "- WAIT：資訊不足或需要只讀補查；不列下一條、不執行下一條。",
  "- PAUSE：命令不一致、出現錯誤、敏感資訊、正式資料或越線行為；立刻停下排查。",
  "",
  "### PASS 也仍然禁止",
  "- 不把 HERMES-INSTALL-002 的 PASS 當成 HERMES-INSTALL-003 或 HERMES-NEXT-001 授權。",
  "- 不連續執行下一條命令。",
  "- 不自動填 API key、token、密碼或完整 .env。",
  "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
  "- 不喚醒 Hermes 或其它本地模型。",
  "",
  "### 請回覆",
  "- 判讀：PASS / WAIT / PAUSE",
  "- 原因：",
  "- 下一個只允許做的動作：",
  "- 需要使用者決定的問題：",
  "- 仍然禁止做的事：",
].join("\n");

const HERMES_INSTALL_SECOND_COMMAND_CYCLE_SUMMARY_TEMPLATE = [
  "## Hermes HERMES-INSTALL-002 循環總結",
  "",
  "用途：整理 HERMES-INSTALL-002 這一輪做到哪裡，方便重開機、換對話、收工、覆盤或決定下一張安全卡。這不是下一條命令授權。",
  "",
  "### 本輪命令",
  "- 命令編號：HERMES-INSTALL-002",
  "- 第二命令預覽是否完成：是 / 否",
  "- 單一命令同意：同意 / 不同意 / 先暫停",
  "- 實際命令是否與預覽完全一致：是 / 否 / 未執行",
  "- 結果回報狀態：PASS / WAIT / PAUSE / 未完成",
  "- 最後判讀：PASS / WAIT / PAUSE / 未完成",
  "",
  "### 安全檢查",
  "- 是否下載或安裝任何套件：否 / 是，摘要：",
  "- 是否修改系統、PATH、設定或檔案：否 / 是，摘要：",
  "- 是否出現 API key、token、密碼或完整 .env：否 / 是，已停止",
  "- 是否碰到正式資料、正式 issue、Run now 或 schedule trigger：否 / 是，已停止",
  "- 是否有模型喚醒、agent 執行或 live run：否 / 是，已停止",
  "",
  "### 下一張安全卡",
  "- PASS：只可進入下一張指定安全卡，或請使用者決定是否回到下一條命令預覽。",
  "- WAIT：只補資訊或只讀檢查，不列下一條、不執行下一條。",
  "- PAUSE：停下整理風險、錯誤摘要與復原建議。",
  "- 收工或換對話：使用 `Hermes 安裝陪同收工交接`。",
  "",
  "### 固定禁止",
  "- 本總結不是 HERMES-INSTALL-003 或 HERMES-NEXT-001 授權。",
  "- 不連續執行下一條命令。",
  "- 不把 HERMES-INSTALL-002 的同意或 PASS 延伸成下一條同意。",
  "- 不自動填 API key、token、密碼或完整 .env。",
  "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
  "- 不喚醒 Hermes 或其它本地模型。",
].join("\n");

const HERMES_INSTALL_THIRD_COMMAND_PREVIEW_TEMPLATE = [
  "## Hermes HERMES-INSTALL-003 候選命令預覽",
  "",
  "用途：在 HERMES-INSTALL-002 循環總結判讀為 PASS 後，只列下一條候選命令 HERMES-INSTALL-003。這不是命令執行授權，也不是連續安裝授權。",
  "",
  "### 使用前確認",
  "- [ ] `Hermes HERMES-INSTALL-002 循環總結` 已完成。",
  "- [ ] HERMES-INSTALL-002 最後判讀是 PASS。",
  "- [ ] 使用者明確要求列出下一條候選命令。",
  "- [ ] 下一步仍只允許列命令，不執行。",
  "- [ ] 不需要 API key、token、密碼或完整 .env。",
  "",
  "### 請 Codex 只列一條候選命令",
  "| 欄位 | 內容 |",
  "| --- | --- |",
  "| 命令編號 | HERMES-INSTALL-003 |",
  "| 執行位置 | Windows PowerShell / WSL2 Ubuntu / 專案資料夾 / 其它 |",
  "| 候選命令 | 只列命令，不執行 |",
  "| 目的 | |",
  "| 會讀取什麼 | |",
  "| 會修改什麼 | 無 / 檔案 / PATH / 套件 / 設定 / 其它 |",
  "| 是否下載或安裝 | 否 / 是，需逐條同意 |",
  "| 是否涉及 API key/token/password/.env | 否 / 是，需 PAUSE |",
  "| 成功判斷 | |",
  "| 失敗停手線 | |",
  "| 需要使用者逐條同意 | 是 |",
  "",
  "### 固定限制",
  "- 只列 HERMES-INSTALL-003，不執行。",
  "- 不把 HERMES-INSTALL-002 的 PASS 或循環總結當成執行授權。",
  "- 不連續列多條命令要求一次同意。",
  "- 不自動填 API key、token、密碼或完整 .env。",
  "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
  "- 不喚醒 Hermes 或其它本地模型。",
].join("\n");

const HERMES_INSTALL_THIRD_COMMAND_CONSENT_TEMPLATE = [
  "## Hermes HERMES-INSTALL-003 單一命令同意",
  "",
  "用途：在 `Hermes HERMES-INSTALL-003 候選命令預覽` 已完成後，只同意或拒絕 HERMES-INSTALL-003 這一條命令。這不是連續安裝授權、不是下一條命令授權，也不是憑證或喚醒授權。",
  "",
  "### 使用前確認",
  "- [ ] `Hermes HERMES-INSTALL-002 循環總結` 最後判讀為 PASS。",
  "- [ ] `Hermes HERMES-INSTALL-003 候選命令預覽` 已列出 HERMES-INSTALL-003。",
  "- [ ] 實際命令必須和預覽完全一致。",
  "- [ ] 命令不包含 API key、token、密碼或完整 .env。",
  "- [ ] 命令不會建立喚醒 issue、不會 Run now、不會啟用 schedule trigger、不會喚醒 Hermes。",
  "",
  "### 使用者決定",
  "- HERMES-INSTALL-003：同意 / 不同意 / 先暫停",
  "- 若同意，只允許執行預覽中的這一條命令。",
  "- 若不同意，回到 `Hermes HERMES-INSTALL-003 候選命令預覽` 重新列候選命令。",
  "- 若先暫停，回到 `Hermes HERMES-INSTALL-002 循環總結` 或 `Hermes 安裝陪同收工交接`。",
  "",
  "### 執行後必須立刻停下",
  "- 執行後只回報結果摘要、錯誤摘要、是否下載或安裝、是否修改 PATH/套件/設定、是否出現敏感資訊。",
  "- 回報後進入 `Hermes 單一命令結果回報` 或下一張指定的結果卡。",
  "- 未完成結果回報前，不列下一條、不執行下一條。",
  "",
  "### 固定禁止",
  "- 不把 HERMES-INSTALL-003 的同意延伸成 HERMES-INSTALL-004 或 HERMES-NEXT-001。",
  "- 不把安裝授權延伸成憑證填寫、issue 建立、Run now、schedule trigger 或喚醒授權。",
  "- 不連續執行多條命令。",
  "- 不自動填 API key、token、密碼或完整 .env。",
  "- 不喚醒 Hermes 或其它本地模型。",
].join("\n");

const HERMES_INSTALL_THIRD_COMMAND_RESULT_TEMPLATE = [
  "## Hermes HERMES-INSTALL-003 單一命令結果回報",
  "",
  "用途：HERMES-INSTALL-003 執行後立刻停下，回報結果與敏感資訊檢查。未完成這張回報前，不列下一條、不執行下一條。",
  "",
  "### 本次命令",
  "- 命令編號：HERMES-INSTALL-003",
  "- 實際命令是否和預覽完全一致：是 / 否，若否請 PAUSE",
  "- 執行位置：Windows PowerShell / WSL2 Ubuntu / 專案資料夾 / 其它",
  "- 使用者是否已逐條同意：是 / 否",
  "",
  "### 結果",
  "- 狀態：PASS / WAIT / PAUSE",
  "- 輸出摘要：",
  "- 是否有錯誤：否 / 是，摘要：",
  "- 是否下載或安裝任何套件：否 / 是，摘要：",
  "- 是否修改 PATH、設定、系統或檔案：否 / 是，摘要：",
  "",
  "### 敏感資訊與越線檢查",
  "- 是否出現 API key、token、密碼或完整 .env：否 / 是，請 PAUSE",
  "- 是否碰到正式資料、正式 issue、Run now 或 schedule trigger：否 / 是，請 PAUSE",
  "- 是否有模型喚醒、agent 執行或 live run：否 / 是，請 PAUSE",
  "- 是否要求輸入憑證或登入第三方服務：否 / 是，請 WAIT 或 PAUSE",
  "",
  "### 下一步判斷",
  "- PASS：只允許進入 HERMES-INSTALL-003 結果判讀或下一張指定安全卡。",
  "- WAIT：先補資訊或只讀檢查，不執行下一條命令。",
  "- PAUSE：立刻停下，整理風險與復原建議。",
  "",
  "### 固定禁止",
  "- 不把 HERMES-INSTALL-003 的結果回報延伸成 HERMES-INSTALL-004 或 HERMES-NEXT-001 授權。",
  "- 不連續執行下一條命令。",
  "- 不自動填 API key、token、密碼或完整 .env。",
  "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
  "- 不喚醒 Hermes 或其它本地模型。",
].join("\n");

const HERMES_INSTALL_THIRD_COMMAND_DECISION_TEMPLATE = [
  "## Hermes HERMES-INSTALL-003 結果判讀",
  "",
  "用途：讀完 `Hermes HERMES-INSTALL-003 單一命令結果回報` 後，判斷下一個安全出口。這不是下一條命令授權，也不是憑證或喚醒授權。",
  "",
  "### 使用前確認",
  "- [ ] 已完成 `Hermes HERMES-INSTALL-003 單一命令結果回報`。",
  "- [ ] 命令編號是 HERMES-INSTALL-003。",
  "- [ ] 已確認實際命令是否和預覽完全一致。",
  "- [ ] 已檢查 API key、token、密碼、完整 .env、Run now、schedule trigger、live run 與模型喚醒。",
  "",
  "### 判讀規則",
  "- PASS：第三條命令結果乾淨；只允許進入下一張指定安全卡，或請使用者決定是否回到下一條命令預覽。",
  "- WAIT：資訊不足或需要只讀補查；不列下一條、不執行下一條。",
  "- PAUSE：命令不一致、出現錯誤、敏感資訊、正式資料或越線行為；立刻停下排查。",
  "",
  "### PASS 也仍然禁止",
  "- 不把 HERMES-INSTALL-003 的 PASS 當成 HERMES-INSTALL-004 或 HERMES-NEXT-001 授權。",
  "- 不連續執行下一條命令。",
  "- 不自動填 API key、token、密碼或完整 .env。",
  "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
  "- 不喚醒 Hermes 或其它本地模型。",
  "",
  "### 請回覆",
  "- 判讀：PASS / WAIT / PAUSE",
  "- 原因：",
  "- 下一個只允許做的動作：",
  "- 需要使用者決定的問題：",
  "- 仍然禁止做的事：",
].join("\n");

const HERMES_INSTALL_THIRD_COMMAND_CYCLE_SUMMARY_TEMPLATE = [
  "## Hermes HERMES-INSTALL-003 循環總結",
  "",
  "用途：整理 HERMES-INSTALL-003 這一輪做到哪裡，方便重開機、換對話、收工、覆盤或決定下一張安全卡。這不是下一條命令授權。",
  "",
  "### 本輪命令",
  "- 命令編號：HERMES-INSTALL-003",
  "- 第三命令預覽是否完成：是 / 否",
  "- 單一命令同意：同意 / 不同意 / 先暫停",
  "- 實際命令是否與預覽完全一致：是 / 否 / 未執行",
  "- 結果回報狀態：PASS / WAIT / PAUSE / 未完成",
  "- 最後判讀：PASS / WAIT / PAUSE / 未完成",
  "",
  "### 安全檢查",
  "- 是否下載或安裝任何套件：否 / 是，摘要：",
  "- 是否修改系統、PATH、設定或檔案：否 / 是，摘要：",
  "- 是否出現 API key、token、密碼或完整 .env：否 / 是，已停止",
  "- 是否碰到正式資料、正式 issue、Run now 或 schedule trigger：否 / 是，已停止",
  "- 是否有模型喚醒、agent 執行或 live run：否 / 是，已停止",
  "",
  "### 下一張安全卡",
  "- PASS：只可進入下一張指定安全卡，或請使用者決定是否回到下一條命令預覽。",
  "- WAIT：只補資訊或只讀檢查，不列下一條、不執行下一條。",
  "- PAUSE：停下整理風險、錯誤摘要與復原建議。",
  "- 收工或換對話：使用 `Hermes 安裝陪同收工交接`。",
  "",
  "### 固定禁止",
  "- 本總結不是 HERMES-INSTALL-004 或 HERMES-NEXT-001 授權。",
  "- 不連續執行下一條命令。",
  "- 不把 HERMES-INSTALL-003 的同意或 PASS 延伸成下一條同意。",
  "- 不自動填 API key、token、密碼或完整 .env。",
  "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
  "- 不喚醒 Hermes 或其它本地模型。",
].join("\n");

const HERMES_INSTALL_FOURTH_COMMAND_PREVIEW_TEMPLATE = [
  "## Hermes HERMES-INSTALL-004 候選命令預覽",
  "",
  "用途：在 HERMES-INSTALL-003 循環總結判讀為 PASS 後，只列下一條候選命令 HERMES-INSTALL-004。這不是命令執行授權，也不是連續安裝授權。",
  "",
  "### 使用前確認",
  "- [ ] `Hermes HERMES-INSTALL-003 循環總結` 已完成。",
  "- [ ] HERMES-INSTALL-003 最後判讀是 PASS。",
  "- [ ] 使用者明確要求列出下一條候選命令。",
  "- [ ] 下一步仍只允許列命令，不執行。",
  "- [ ] 不需要 API key、token、密碼或完整 .env。",
  "",
  "### 請 Codex 只列一條候選命令",
  "| 欄位 | 內容 |",
  "| --- | --- |",
  "| 命令編號 | HERMES-INSTALL-004 |",
  "| 執行位置 | Windows PowerShell / WSL2 Ubuntu / 專案資料夾 / 其它 |",
  "| 候選命令 | 只列命令，不執行 |",
  "| 目的 | |",
  "| 會讀取什麼 | |",
  "| 會修改什麼 | 無 / 檔案 / PATH / 套件 / 設定 / 其它 |",
  "| 是否下載或安裝 | 否 / 是，需逐條同意 |",
  "| 是否涉及 API key/token/password/.env | 否 / 是，需 PAUSE |",
  "| 成功判斷 | |",
  "| 失敗停手線 | |",
  "| 需要使用者逐條同意 | 是 |",
  "",
  "### 固定限制",
  "- 只列 HERMES-INSTALL-004，不執行。",
  "- 不把 HERMES-INSTALL-003 的 PASS 或循環總結當成執行授權。",
  "- 不連續列多條命令要求一次同意。",
  "- 不自動填 API key、token、密碼或完整 .env。",
  "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
  "- 不喚醒 Hermes 或其它本地模型。",
].join("\n");

const HERMES_INSTALL_FOURTH_COMMAND_CONSENT_TEMPLATE = [
  "## Hermes HERMES-INSTALL-004 單一命令同意",
  "",
  "用途：在 `Hermes HERMES-INSTALL-004 候選命令預覽` 已完成後，只同意或拒絕 HERMES-INSTALL-004 這一條命令。這不是連續安裝授權、不是下一條命令授權，也不是憑證或喚醒授權。",
  "",
  "### 使用前確認",
  "- [ ] `Hermes HERMES-INSTALL-003 循環總結` 最後判讀為 PASS。",
  "- [ ] `Hermes HERMES-INSTALL-004 候選命令預覽` 已列出 HERMES-INSTALL-004。",
  "- [ ] 實際命令必須和預覽完全一致。",
  "- [ ] 命令不包含 API key、token、密碼或完整 .env。",
  "- [ ] 命令不會建立喚醒 issue、不會 Run now、不會啟用 schedule trigger、不會喚醒 Hermes。",
  "",
  "### 使用者決定",
  "- HERMES-INSTALL-004：同意 / 不同意 / 先暫停",
  "- 若同意，只允許執行預覽中的這一條命令。",
  "- 若不同意，回到 `Hermes HERMES-INSTALL-004 候選命令預覽` 重新列候選命令。",
  "- 若先暫停，回到 `Hermes HERMES-INSTALL-003 循環總結` 或 `Hermes 安裝陪同收工交接`。",
  "",
  "### 執行後必須立刻停下",
  "- 執行後只回報結果摘要、錯誤摘要、是否下載或安裝、是否修改 PATH/套件/設定、是否出現敏感資訊。",
  "- 回報後進入 `Hermes 單一命令結果回報` 或下一張指定的結果卡。",
  "- 未完成結果回報前，不列下一條、不執行下一條。",
  "",
  "### 固定禁止",
  "- 不把 HERMES-INSTALL-004 的同意延伸成 HERMES-INSTALL-005 或 HERMES-NEXT-001。",
  "- 不把安裝授權延伸成憑證填寫、issue 建立、Run now、schedule trigger 或喚醒授權。",
  "- 不連續執行多條命令。",
  "- 不自動填 API key、token、密碼或完整 .env。",
  "- 不喚醒 Hermes 或其它本地模型。",
].join("\n");

const HERMES_INSTALL_FOURTH_COMMAND_RESULT_TEMPLATE = [
  "## Hermes HERMES-INSTALL-004 單一命令結果回報",
  "",
  "用途：HERMES-INSTALL-004 執行後立刻停下，回報結果與敏感資訊檢查。未完成這張回報前，不列下一條、不執行下一條。",
  "",
  "### 本次命令",
  "- 命令編號：HERMES-INSTALL-004",
  "- 實際命令是否和預覽完全一致：是 / 否，若否請 PAUSE",
  "- 執行位置：Windows PowerShell / WSL2 Ubuntu / 專案資料夾 / 其它",
  "- 使用者是否已逐條同意：是 / 否",
  "",
  "### 結果",
  "- 狀態：PASS / WAIT / PAUSE",
  "- 輸出摘要：",
  "- 是否有錯誤：否 / 是，摘要：",
  "- 是否下載或安裝任何套件：否 / 是，摘要：",
  "- 是否修改 PATH、設定、系統或檔案：否 / 是，摘要：",
  "",
  "### 敏感資訊與越線檢查",
  "- 是否出現 API key、token、密碼或完整 .env：否 / 是，請 PAUSE",
  "- 是否碰到正式資料、正式 issue、Run now 或 schedule trigger：否 / 是，請 PAUSE",
  "- 是否有模型喚醒、agent 執行或 live run：否 / 是，請 PAUSE",
  "- 是否要求輸入憑證或登入第三方服務：否 / 是，請 WAIT 或 PAUSE",
  "",
  "### 下一步判斷",
  "- PASS：只允許進入 HERMES-INSTALL-004 結果判讀或下一張指定安全卡。",
  "- WAIT：先補資訊或只讀檢查，不執行下一條命令。",
  "- PAUSE：立刻停下，整理風險與復原建議。",
  "",
  "### 固定禁止",
  "- 不把 HERMES-INSTALL-004 的結果回報延伸成 HERMES-INSTALL-005 或 HERMES-NEXT-001 授權。",
  "- 不連續執行下一條命令。",
  "- 不自動填 API key、token、密碼或完整 .env。",
  "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
  "- 不喚醒 Hermes 或其它本地模型。",
].join("\n");

const HERMES_INSTALL_FOURTH_COMMAND_DECISION_TEMPLATE = [
  "## Hermes HERMES-INSTALL-004 結果判讀",
  "",
  "用途：讀完 `Hermes HERMES-INSTALL-004 單一命令結果回報` 後，判斷下一個安全出口。這不是下一條命令授權，也不是憑證或喚醒授權。",
  "",
  "### 使用前確認",
  "- [ ] 已完成 `Hermes HERMES-INSTALL-004 單一命令結果回報`。",
  "- [ ] 命令編號是 HERMES-INSTALL-004。",
  "- [ ] 已確認實際命令是否和預覽完全一致。",
  "- [ ] 已檢查 API key、token、密碼、完整 .env、Run now、schedule trigger、live run 與模型喚醒。",
  "",
  "### 判讀規則",
  "- PASS：第四條命令結果乾淨；只允許進入下一張指定安全卡，或請使用者決定是否回到下一條命令預覽。",
  "- WAIT：資訊不足或需要只讀補查；不列下一條、不執行下一條。",
  "- PAUSE：命令不一致、出現錯誤、敏感資訊、正式資料或越線行為；立刻停下排查。",
  "",
  "### PASS 也仍然禁止",
  "- 不把 HERMES-INSTALL-004 的 PASS 當成 HERMES-INSTALL-005 或 HERMES-NEXT-001 授權。",
  "- 不連續執行下一條命令。",
  "- 不自動填 API key、token、密碼或完整 .env。",
  "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
  "- 不喚醒 Hermes 或其它本地模型。",
  "",
  "### 請回覆",
  "- 判讀：PASS / WAIT / PAUSE",
  "- 原因：",
  "- 下一個只允許做的動作：",
  "- 需要使用者決定的問題：",
  "- 仍然禁止做的事：",
].join("\n");

const HERMES_INSTALL_FOURTH_COMMAND_CYCLE_SUMMARY_TEMPLATE = [
  "## Hermes HERMES-INSTALL-004 循環總結",
  "",
  "用途：整理 HERMES-INSTALL-004 這一輪做到哪裡，方便重開機、換對話、收工、覆盤或決定下一張安全卡。這不是下一條命令授權。",
  "",
  "### 本輪命令",
  "- 命令編號：HERMES-INSTALL-004",
  "- 第四命令預覽是否完成：是 / 否",
  "- 單一命令同意：同意 / 不同意 / 先暫停",
  "- 實際命令是否與預覽完全一致：是 / 否 / 未執行",
  "- 結果回報狀態：PASS / WAIT / PAUSE / 未完成",
  "- 最後判讀：PASS / WAIT / PAUSE / 未完成",
  "",
  "### 安全檢查",
  "- 是否下載或安裝任何套件：否 / 是，摘要：",
  "- 是否修改系統、PATH、設定或檔案：否 / 是，摘要：",
  "- 是否出現 API key、token、密碼或完整 .env：否 / 是，已停止",
  "- 是否碰到正式資料、正式 issue、Run now 或 schedule trigger：否 / 是，已停止",
  "- 是否有模型喚醒、agent 執行或 live run：否 / 是，已停止",
  "",
  "### 下一張安全卡",
  "- PASS：只可進入下一張指定安全卡，或請使用者決定是否回到下一條命令預覽。",
  "- WAIT：只補資訊或只讀檢查，不列下一條、不執行下一條。",
  "- PAUSE：停下整理風險、錯誤摘要與復原建議。",
  "- 收工或換對話：使用 `Hermes 安裝陪同收工交接`。",
  "",
  "### 固定禁止",
  "- 本總結不是 HERMES-INSTALL-005 或 HERMES-NEXT-001 授權。",
  "- 不連續執行下一條命令。",
  "- 不把 HERMES-INSTALL-004 的同意或 PASS 延伸成下一條同意。",
  "- 不自動填 API key、token、密碼或完整 .env。",
  "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
  "- 不喚醒 Hermes 或其它本地模型。",
].join("\n");

const HERMES_INSTALL_FIFTH_COMMAND_PREVIEW_TEMPLATE = [
  "## Hermes HERMES-INSTALL-005 候選命令預覽",
  "",
  "用途：在 HERMES-INSTALL-004 循環總結判讀為 PASS 後，只列下一條候選命令 HERMES-INSTALL-005。這不是命令執行授權，也不是連續安裝授權。",
  "",
  "### 使用前確認",
  "- [ ] `Hermes HERMES-INSTALL-004 循環總結` 已完成。",
  "- [ ] HERMES-INSTALL-004 最後判讀是 PASS。",
  "- [ ] 使用者明確要求列出下一條候選命令。",
  "- [ ] 下一步仍只允許列命令，不執行。",
  "- [ ] 不需要 API key、token、密碼或完整 .env。",
  "",
  "### 請 Codex 只列一條候選命令",
  "| 欄位 | 內容 |",
  "| --- | --- |",
  "| 命令編號 | HERMES-INSTALL-005 |",
  "| 執行位置 | Windows PowerShell / WSL2 Ubuntu / 專案資料夾 / 其它 |",
  "| 候選命令 | 只列命令，不執行 |",
  "| 目的 | |",
  "| 會讀取什麼 | |",
  "| 會修改什麼 | 無 / 檔案 / PATH / 套件 / 設定 / 其它 |",
  "| 是否下載或安裝 | 否 / 是，需逐條同意 |",
  "| 是否涉及 API key/token/password/.env | 否 / 是，需 PAUSE |",
  "| 成功判斷 | |",
  "| 失敗停手線 | |",
  "| 需要使用者逐條同意 | 是 |",
  "",
  "### 固定限制",
  "- 只列 HERMES-INSTALL-005，不執行。",
  "- 不把 HERMES-INSTALL-004 的 PASS 或循環總結當成執行授權。",
  "- 不連續列多條命令要求一次同意。",
  "- 不自動填 API key、token、密碼或完整 .env。",
  "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
  "- 不喚醒 Hermes 或其它本地模型。",
].join("\n");

const HERMES_INSTALL_FIFTH_COMMAND_CONSENT_TEMPLATE = [
  "## Hermes HERMES-INSTALL-005 單一命令同意",
  "",
  "用途：在 `Hermes HERMES-INSTALL-005 候選命令預覽` 已完成後，只同意或拒絕 HERMES-INSTALL-005 這一條命令。這不是連續安裝授權、不是下一條命令授權，也不是憑證或喚醒授權。",
  "",
  "### 使用前確認",
  "- [ ] `Hermes HERMES-INSTALL-004 循環總結` 最後判讀為 PASS。",
  "- [ ] `Hermes HERMES-INSTALL-005 候選命令預覽` 已列出 HERMES-INSTALL-005。",
  "- [ ] 實際命令必須和預覽完全一致。",
  "- [ ] 命令不包含 API key、token、密碼或完整 .env。",
  "- [ ] 命令不會建立喚醒 issue、不會 Run now、不會啟用 schedule trigger、不會喚醒 Hermes。",
  "",
  "### 使用者決定",
  "- HERMES-INSTALL-005：同意 / 不同意 / 先暫停",
  "- 若同意，只允許執行預覽中的這一條命令。",
  "- 若不同意，回到 `Hermes HERMES-INSTALL-005 候選命令預覽` 重新列候選命令。",
  "- 若先暫停，回到 `Hermes HERMES-INSTALL-004 循環總結` 或 `Hermes 安裝陪同收工交接`。",
  "",
  "### 執行後必須立刻停下",
  "- 執行後只回報結果摘要、錯誤摘要、是否下載或安裝、是否修改 PATH/套件/設定、是否出現敏感資訊。",
  "- 回報後進入 `Hermes 單一命令結果回報` 或下一張指定的結果卡。",
  "- 未完成結果回報前，不列下一條、不執行下一條。",
  "",
  "### 固定禁止",
  "- 不把 HERMES-INSTALL-005 的同意延伸成 HERMES-INSTALL-006 或 HERMES-NEXT-001。",
  "- 不把安裝授權延伸成憑證填寫、issue 建立、Run now、schedule trigger 或喚醒授權。",
  "- 不連續執行多條命令。",
  "- 不自動填 API key、token、密碼或完整 .env。",
  "- 不喚醒 Hermes 或其它本地模型。",
].join("\n");

const HERMES_INSTALL_FIFTH_COMMAND_RESULT_TEMPLATE = [
  "## Hermes HERMES-INSTALL-005 單一命令結果回報",
  "",
  "用途：HERMES-INSTALL-005 執行後立刻停下，回報結果與敏感資訊檢查。未完成這張回報前，不列下一條、不執行下一條。",
  "",
  "### 本次命令",
  "- 命令編號：HERMES-INSTALL-005",
  "- 實際命令是否和預覽完全一致：是 / 否，若否請 PAUSE",
  "- 執行位置：Windows PowerShell / WSL2 Ubuntu / 專案資料夾 / 其它",
  "- 使用者是否已逐條同意：是 / 否",
  "",
  "### 結果",
  "- 狀態：PASS / WAIT / PAUSE",
  "- 輸出摘要：",
  "- 是否有錯誤：否 / 是，摘要：",
  "- 是否下載或安裝任何套件：否 / 是，摘要：",
  "- 是否修改 PATH、設定、系統或檔案：否 / 是，摘要：",
  "",
  "### 敏感資訊與越線檢查",
  "- 是否出現 API key、token、密碼或完整 .env：否 / 是，請 PAUSE",
  "- 是否碰到正式資料、正式 issue、Run now 或 schedule trigger：否 / 是，請 PAUSE",
  "- 是否有模型喚醒、agent 執行或 live run：否 / 是，請 PAUSE",
  "- 是否要求輸入憑證或登入第三方服務：否 / 是，請 WAIT 或 PAUSE",
  "",
  "### 下一步判斷",
  "- PASS：只允許進入 HERMES-INSTALL-005 結果判讀或下一張指定安全卡。",
  "- WAIT：先補資訊或只讀檢查，不執行下一條命令。",
  "- PAUSE：立刻停下，整理風險與復原建議。",
  "",
  "### 固定禁止",
  "- 不把 HERMES-INSTALL-005 的結果回報延伸成 HERMES-INSTALL-006 或 HERMES-NEXT-001 授權。",
  "- 不連續執行下一條命令。",
  "- 不自動填 API key、token、密碼或完整 .env。",
  "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
  "- 不喚醒 Hermes 或其它本地模型。",
].join("\n");

const HERMES_INSTALL_FIFTH_COMMAND_DECISION_TEMPLATE = [
  "## Hermes HERMES-INSTALL-005 結果判讀",
  "",
  "用途：讀完 `Hermes HERMES-INSTALL-005 單一命令結果回報` 後，判斷下一個安全出口。這不是下一條命令授權，也不是憑證或喚醒授權。",
  "",
  "### 使用前確認",
  "- [ ] 已完成 `Hermes HERMES-INSTALL-005 單一命令結果回報`。",
  "- [ ] 命令編號是 HERMES-INSTALL-005。",
  "- [ ] 已確認實際命令是否和預覽完全一致。",
  "- [ ] 已檢查 API key、token、密碼、完整 .env、Run now、schedule trigger、live run 與模型喚醒。",
  "",
  "### 判讀規則",
  "- PASS：第五條命令結果乾淨；只允許進入下一張指定安全卡，或請使用者決定是否回到下一條命令預覽。",
  "- WAIT：資訊不足或需要只讀補查；不列下一條、不執行下一條。",
  "- PAUSE：命令不一致、出現錯誤、敏感資訊、正式資料或越線行為；立刻停下排查。",
  "",
  "### PASS 也仍然禁止",
  "- 不把 HERMES-INSTALL-005 的 PASS 當成 HERMES-INSTALL-006 或 HERMES-NEXT-001 授權。",
  "- 不連續執行下一條命令。",
  "- 不自動填 API key、token、密碼或完整 .env。",
  "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
  "- 不喚醒 Hermes 或其它本地模型。",
  "",
  "### 請回覆",
  "- 判讀：PASS / WAIT / PAUSE",
  "- 原因：",
  "- 下一個只允許做的動作：",
  "- 需要使用者決定的問題：",
  "- 仍然禁止做的事：",
].join("\n");

const HERMES_INSTALL_COMPANION_LOG_TEMPLATE = [
  "## Hermes 安裝陪同紀錄",
  "",
  "- 日期：",
  "- 執行者：",
  "- 目標：只安裝 / 設定模型 / 測試 bridge / 其它：",
  "- 授權來源：已貼 `Hermes 安裝授權文字` / 其它：",
  "",
  "### 開始前",
  "- [ ] 已跑 office:verify 並通過。",
  "- [ ] 已確認 Backend OK / Frontend OK。",
  "- [ ] 已確認不會建立喚醒 issue、Run now、啟用 schedule trigger 或喚醒 Hermes。",
  "- [ ] 已確認 API key、token、密碼不會貼進文件、prompt、skills、issue 或聊天紀錄。",
  "",
  "### 命令紀錄",
  "- 命令 1：",
  "  - 目的：",
  "  - 預覽命令：",
  "  - 使用者是否同意執行：是 / 否",
  "  - 結果摘要：",
  "  - 是否包含憑證或敏感資訊：否 / 是，已停止處理",
  "- 命令 2：",
  "  - 目的：",
  "  - 預覽命令：",
  "  - 使用者是否同意執行：是 / 否",
  "  - 結果摘要：",
  "  - 是否包含憑證或敏感資訊：否 / 是，已停止處理",
  "",
  "### 停止條件檢查",
  "- [ ] 沒有要求輸入或顯示 API key、token、密碼。",
  "- [ ] 沒有修改正式資料。",
  "- [ ] 沒有建立任務、Run now、啟用排程或喚醒模型。",
  "- [ ] 如果安裝路線和文件不一致，已停下問使用者。",
  "",
  "### 結論",
  "- 狀態：未開始 / 安裝中止 / 安裝完成待重新檢查 / 需補文件",
  "- 下一步：回 Office 按重新檢查 / 補 bridge / 設定模型 / 暫停",
].join("\n");

const HERMES_COMMAND_PREVIEW_REQUEST_TEMPLATE = [
  "## Hermes 命令預覽請求",
  "",
  "請先不要執行任何安裝、設定、寫檔或喚醒模型的命令。請只列出你下一步打算使用的命令預覽，等我逐條確認後再執行。",
  "",
  "### 請先提供",
  "- 目標：檢查 / 安裝 / 設定 / 橋接 / 測試環境 / 其它",
  "- 會在哪裡執行：Windows PowerShell / WSL2 Ubuntu / 其它",
  "- 每一條命令的目的：",
  "- 每一條命令是否會寫入檔案或修改系統：",
  "- 是否會下載或安裝套件：",
  "- 是否需要 API key、token、密碼或 .env：",
  "- 如果失敗，停止條件是什麼：",
  "",
  "### 安全邊界",
  "- 不要直接執行命令。",
  "- 不要要求我貼 API key、token、密碼或完整 .env。",
  "- 不要建立 issue、不要 Run now、不要啟用 schedule trigger。",
  "- 不要喚醒 Hermes 或其它本地模型。",
  "- 若命令會安裝、寫檔、改 PATH、改設定或下載套件，請先停下等我明確同意。",
  "",
  "### 回覆格式",
  "| 順序 | 命令 | 執行位置 | 目的 | 會修改什麼 | 風險 | 需要我同意嗎 |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  "| 1 |  |  |  |  |  |  |",
].join("\n");

const HERMES_COMMAND_PREVIEW_FORM_TEMPLATE = [
  "## Hermes 第 1 階命令預覽表單",
  "",
  "我同意第 1 階：只列 Hermes 命令預覽，不執行。",
  "",
  "請先不要執行任何命令。請只用表格列出你建議的下一步，等我逐條回覆同意後才可進入第 2 階。",
  "",
  "### 目前目標",
  "- 目標：檢查 / 安裝 / 設定 / 橋接 / Test environment / 其它：",
  "- 執行環境：Windows PowerShell / WSL2 Ubuntu / 其它：",
  "- 是否只讀：是 / 否 / 不確定",
  "- 是否會下載或安裝套件：是 / 否 / 不確定",
  "- 是否會寫入檔案、改 PATH、改設定或改資料庫：是 / 否 / 不確定",
  "- 是否需要 API key、token、密碼或完整 .env：是 / 否 / 不確定",
  "",
  "### 請 Codex 回覆這張表",
  "| 編號 | 命令 | 類型 | 執行位置 | 目的 | 會修改什麼 | 是否下載/安裝 | 是否需要憑證 | 風險 | 是否需要我逐條同意 |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  "| 1 |  | 只讀/安裝/設定/測試 |  |  |  | 是/否 | 是/否 |  | 是 |",
  "",
  "### 回覆規則",
  "- 只列命令，不執行。",
  "- 若任何命令不是只讀，請標成需要我逐條同意。",
  "- 若任何命令可能碰到憑證、正式資料、issue、Run now、schedule trigger 或模型喚醒，請標成 PAUSE。",
  "- 若命令用途不明，請不要猜，先問我。",
  "",
  "### 固定停手線",
  "- 不安裝、不下載、不寫檔、不改 PATH、不改設定。",
  "- 不要求貼 API key、token、密碼或完整 .env。",
  "- 不建立 issue、不 Run now、不啟用 schedule trigger。",
  "- 不喚醒 Hermes 或其它本地模型。",
].join("\n");

const HERMES_COMMAND_APPROVAL_LOG_TEMPLATE = [
  "## Hermes 第 2 階逐條同意紀錄",
  "",
  "我只同意執行下方明確標為「同意」的命令。沒有列在表內、沒有編號、或沒有逐條同意的命令都不可執行。",
  "",
  "### 開始前確認",
  "- [ ] 第 1 階命令預覽表單已完成。",
  "- [ ] 每條命令都已列出目的、執行位置、會修改什麼與風險。",
  "- [ ] 我知道這不是憑證授權、不是 Run now 授權、不是模型喚醒授權。",
  "- [ ] 如果命令輸出含 API key、token、密碼或完整 .env，立即停止並不要貼回紀錄。",
  "",
  "### 逐條同意表",
  "| 編號 | 命令摘要 | 執行位置 | 風險等級 | 使用者同意 | 執行結果 | 是否含敏感資訊 | 下一步 |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
  "| 1 |  |  | 低/中/高/PAUSE | 同意/不同意/先暫停 | 未執行/成功/失敗 | 否/是，已停止 |  |",
  "",
  "### 執行規則",
  "- 只能執行表內標為同意的單一命令。",
  "- 每執行一條命令後，先回報結果，再詢問是否繼續下一條。",
  "- 若命令和預覽不同，停下重新做第 1 階命令預覽。",
  "- 若出現憑證、正式資料、issue、Run now、schedule trigger 或模型喚醒，停下並標成 PAUSE。",
  "",
  "### 固定禁止",
  "- 不用一段同意文字授權全部命令。",
  "- 不自動填 API key、token、密碼或完整 .env。",
  "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
  "- 不喚醒 Hermes 或其它本地模型。",
].join("\n");

const HERMES_SINGLE_COMMAND_RESULT_TEMPLATE = [
  "## Hermes 單一命令結果回報",
  "",
  "用途：每執行完一條被使用者逐條同意的命令後，先回報結果與敏感資訊檢查。未完成這張回報前，不執行下一條命令。",
  "",
  "### 本次命令",
  "- 編號：",
  "- 命令摘要：",
  "- 執行位置：Windows / WSL2 / 其他",
  "- 使用者是否已逐條同意：是 / 否",
  "",
  "### 結果",
  "- 狀態：PASS / WAIT / PAUSE",
  "- 輸出摘要：",
  "- 是否有錯誤：否 / 是，摘要：",
  "- 是否修改系統、PATH、設定或檔案：否 / 是，摘要：",
  "",
  "### 敏感資訊檢查",
  "- 是否出現 API key、token、密碼或完整 .env：否 / 是",
  "- 是否碰到正式資料、正式 issue、Run now 或 schedule trigger：否 / 是",
  "- 是否有模型喚醒、agent 執行或 live run：否 / 是",
  "",
  "### 下一步判斷",
  "- PASS：可請使用者決定是否同意下一條命令。",
  "- WAIT：先補資訊或只讀檢查，不執行下一條命令。",
  "- PAUSE：立刻停下，整理風險與復原建議。",
  "",
  "### 固定限制",
  "- 不連續執行下一條命令。",
  "- 不自動填 API key、token、密碼或完整 .env。",
  "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
  "- 不喚醒 Hermes 或其它本地模型。",
].join("\n");

const HERMES_SINGLE_COMMAND_DECISION_TEMPLATE = [
  "## Hermes 命令結果判讀",
  "",
  "用途：讀完 `Hermes 單一命令結果回報` 後，決定下一個安全動作。這不是下一條命令授權。",
  "",
  "### 判讀規則",
  "- PASS：本條命令結果乾淨；只能請使用者決定是否同意下一條命令。",
  "- WAIT：資訊不足或需要只讀補查；不執行下一條命令。",
  "- PAUSE：出現風險、錯誤、敏感資訊或可能碰到正式資料；立刻停下排查。",
  "",
  "### PASS 也仍然禁止",
  "- 不連續執行下一條命令。",
  "- 不把上一條同意延伸成下一條同意。",
  "- 不自動填 API key、token、密碼或完整 .env。",
  "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
  "- 不喚醒 Hermes 或其它本地模型。",
  "",
  "### 請回覆",
  "- 判讀：PASS / WAIT / PAUSE",
  "- 原因：",
  "- 下一個只允許做的動作：",
  "- 需要使用者決定的問題：",
  "- 仍然禁止做的事：",
].join("\n");

const HERMES_SINGLE_COMMAND_PASS_HANDOFF_TEMPLATE = [
  "## Hermes 命令 PASS 後交接",
  "",
  "用途：當 `Hermes 命令結果判讀` 是 PASS 時，交接下一個安全動作。PASS 只代表本條命令乾淨，不是下一條命令授權。",
  "",
  "### PASS 代表",
  "- 本條命令已完成。",
  "- 沒有發現 API key、token、密碼或完整 .env 外洩。",
  "- 沒有碰到正式資料、喚醒 issue、Run now、schedule trigger、live run 或模型喚醒。",
  "- 可以請使用者決定是否要進下一條命令。",
  "",
  "### 下一步只允許",
  "- 若下一條命令尚未列出，回到第 1 階命令預覽表單。",
  "- 若下一條命令已列出，請使用者逐條同意單一命令。",
  "- 執行下一條前，先確認命令編號、目的、風險與是否修改系統。",
  "",
  "### 仍然禁止",
  "- 不連續執行下一條命令。",
  "- 不把本次 PASS 當成後續命令同意。",
  "- 不自動填 API key、token、密碼或完整 .env。",
  "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
  "- 不喚醒 Hermes 或其它本地模型。",
].join("\n");

const HERMES_SINGLE_COMMAND_WAIT_PAUSE_TEMPLATE = [
  "## Hermes 命令 WAIT/PAUSE 處理",
  "",
  "用途：當 `Hermes 命令結果判讀` 是 WAIT 或 PAUSE 時，固定停手與補查方式。這不是重試授權，也不是下一條命令授權。",
  "",
  "### WAIT 只允許",
  "- 等待使用者補充資訊。",
  "- 做只讀檢查，且先說明要看什麼、不修改任何設定。",
  "- 回到第 1 階命令預覽，重新列出下一個候選命令。",
  "- 更新單一命令結果回報，不執行下一條命令。",
  "",
  "### PAUSE 只允許",
  "- 立刻停止命令執行。",
  "- 整理非敏感錯誤摘要與可能原因。",
  "- 標出是否碰到 API key、token、密碼、完整 .env、正式資料、Run now、schedule trigger、live run 或模型喚醒。",
  "- 提出復原建議，但不執行復原命令，除非使用者另行逐條同意。",
  "",
  "### 固定禁止",
  "- 不重試原命令。",
  "- 不執行下一條命令。",
  "- 不自動填 API key、token、密碼或完整 .env。",
  "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
  "- 不喚醒 Hermes 或其它本地模型。",
].join("\n");

const HERMES_INSTALL_COMPANION_CYCLE_SUMMARY_TEMPLATE = [
  "## Hermes 安裝陪同循環總結",
  "",
  "用途：整理本輪 Hermes 安裝/設定陪同做到哪裡，方便換對話、重開機或請使用者判斷下一步。這不是安裝授權、憑證授權或喚醒授權。",
  "",
  "### 本輪範圍",
  "- 授權階級：第 2 階安裝陪同 / 第 3 階設定檢查 / 其它：",
  "- 執行環境：Windows PowerShell / WSL2 Ubuntu / 其它：",
  "- 已執行命令數：",
  "- 最後一條命令編號：",
  "- 最後判讀：PASS / WAIT / PAUSE",
  "",
  "### 安全檢查",
  "- 是否出現 API key、token、密碼或完整 .env：否 / 是",
  "- 是否碰到正式資料、正式 issue、Run now 或 schedule trigger：否 / 是",
  "- 是否有模型喚醒、agent 執行或 live run：否 / 是",
  "- 是否仍停在安裝/設定陪同範圍內：是 / 否",
  "",
  "### 下一張安全卡",
  "- 若最後判讀是 PASS：先用 `複製 PASS 交接`，再請使用者決定是否同意下一條。",
  "- 若最後判讀是 WAIT 或 PAUSE：先用 `複製 WAIT/PAUSE`，不要重試或跑下一條。",
  "- 若要換對話或收工：用 `複製最後交接` 或本總結交接目前狀態。",
  "",
  "### 固定禁止",
  "- 本總結不是下一條命令授權。",
  "- 不連續執行命令。",
  "- 不自動填 API key、token、密碼或完整 .env。",
  "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
  "- 不喚醒 Hermes 或其它本地模型。",
].join("\n");

const HERMES_INSTALL_COMPANION_SHUTDOWN_HANDOFF_TEMPLATE = [
  "## Hermes 安裝陪同收工交接",
  "",
  "用途：關機、重開機、換對話或今天收工前，記錄 Hermes 安裝陪同停在哪裡。這不是明天的安裝授權，也不是下一條命令授權。",
  "",
  "### 收工前狀態",
  "- 日期：",
  "- 預覽狀態：Backend OK / Frontend OK / blocked / 未檢查",
  "- 最後使用的安全卡：命令回報 / 結果判讀 / PASS 交接 / WAIT/PAUSE / 陪同總結 / 最後交接 / 其它",
  "- 最後判讀：PASS / WAIT / PAUSE / 尚未進命令",
  "- 明天第一步：先跑 office:check / office:restart / office:verify / 其它",
  "",
  "### 明天開工入口",
  "- 先確認預覽健康：Backend OK / Frontend OK。",
  "- 先讀本交接，不沿用今天的下一條命令同意。",
  "- 若要繼續命令，回到命令預覽或逐條同意。",
  "- 若要跨到設定或喚醒，重新走對應授權卡。",
  "",
  "### 仍未授權",
  "- 未授權自動填 API key、token、密碼或完整 .env。",
  "- 未授權建立喚醒 issue、Run now 或啟用 schedule trigger。",
  "- 未授權喚醒 Hermes 或其它本地模型。",
  "- 未授權連續執行任何下一條命令。",
  "",
  "### 固定提醒",
  "- 收工交接不是下一次授權。",
  "- 重開機後先走開機/預覽復原 SOP。",
  "- 不刪資料庫、不刪 Postgres 目錄、不刪 lock file，除非使用者明確要求資料庫復原。",
].join("\n");

const HERMES_INSTALL_COMPANION_STARTUP_RESUME_TEMPLATE = [
  "## Hermes 安裝陪同開工接續判斷",
  "",
  "用途：重開機、隔天或換對話後，根據收工交接決定下一個安全入口。這不是安裝授權、不是下一條命令授權，也不是喚醒授權。",
  "",
  "### 開工前確認",
  "- [ ] 已跑 office:check 或 office:verify，Backend OK / Frontend OK。",
  "- [ ] 已讀昨天的 `Hermes 安裝陪同收工交接` 或 `Hermes 安裝陪同循環總結`。",
  "- [ ] 沒有沿用昨天的逐條同意或 ACCEPT。",
  "- [ ] 沒有貼 API key、token、密碼或完整 .env。",
  "",
  "### 接續判斷",
  "- PREVIEW BLOCKED：只走開機/預覽復原 SOP，不碰資料、不跑命令。",
  "- NO HANDOFF：先補收工交接或最後交接，不猜測昨天狀態。",
  "- PASS HANDOFF：回到命令預覽或請使用者逐條同意下一個單一命令。",
  "- WAIT/PAUSE HANDOFF：先用 WAIT/PAUSE 處理，不重試、不跑下一條。",
  "- NEED NEW SCOPE：重新走安裝授權句檢查與二次確認。",
  "",
  "### 固定禁止",
  "- 不沿用昨天的下一條命令同意。",
  "- 不連續執行命令。",
  "- 不自動填 API key、token、密碼或完整 .env。",
  "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
  "- 不喚醒 Hermes 或其它本地模型。",
].join("\n");

const HERMES_STARTUP_NEXT_COMMAND_PREVIEW_TEMPLATE = [
  "## Hermes 開工後下一條命令預覽",
  "",
  "用途：開工接續判斷為 PASS HANDOFF 後，只請 Codex 列出下一條候選命令。這不是執行授權、不是安裝授權，也不是喚醒授權。",
  "",
  "### 使用前確認",
  "- [ ] Backend OK / Frontend OK。",
  "- [ ] 已讀 `Hermes 安裝陪同開工接續判斷`。",
  "- [ ] 接續判斷是 PASS HANDOFF，不是 PREVIEW BLOCKED、NO HANDOFF、WAIT/PAUSE HANDOFF 或 NEED NEW SCOPE。",
  "- [ ] 使用者尚未同意執行任何新命令。",
  "",
  "### 請 Codex 只列一條候選命令",
  "| 欄位 | 內容 |",
  "| --- | --- |",
  "| 命令編號 | HERMES-NEXT-001 |",
  "| 執行位置 | Windows PowerShell / WSL2 Ubuntu / 專案資料夾 / 其它 |",
  "| 候選命令 | 只列命令，不執行 |",
  "| 目的 | |",
  "| 會讀取什麼 | |",
  "| 會修改什麼 | 無 / 檔案 / PATH / 套件 / 設定 / 其它 |",
  "| 是否下載或安裝 | 否 / 是，需 PAUSE |",
  "| 是否涉及 API key/token/password/.env | 否 / 是，需 PAUSE |",
  "| 成功判斷 | |",
  "| 失敗停手線 | |",
  "| 需要使用者逐條同意 | 是 |",
  "",
  "### 固定限制",
  "- 只列一條候選命令，不執行。",
  "- 不連續列多條命令來要求一次同意。",
  "- 不下載、不安裝、不寫檔、不改 PATH、不改設定。",
  "- 不要求貼 API key、token、密碼或完整 .env。",
  "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
  "- 不喚醒 Hermes 或其它本地模型。",
].join("\n");

const HERMES_STARTUP_SINGLE_COMMAND_APPROVAL_TEMPLATE = [
  "## Hermes 開工後單一命令同意",
  "",
  "用途：在 `Hermes 開工後下一條命令預覽` 已完成後，只同意或拒絕 HERMES-NEXT-001 這一條命令。這不是連續命令授權、不是安裝包授權，也不是喚醒授權。",
  "",
  "### 同意前確認",
  "- [ ] Backend OK / Frontend OK。",
  "- [ ] 已讀開工接續判斷，狀態是 PASS HANDOFF。",
  "- [ ] 已讀 `Hermes 開工後下一條命令預覽`。",
  "- [ ] 候選命令編號是 HERMES-NEXT-001。",
  "- [ ] 實際要執行的命令與預覽完全一致。",
  "- [ ] 命令不涉及 API key、token、密碼或完整 .env。",
  "- [ ] 命令不會建立喚醒 issue、Run now、啟用 schedule trigger 或喚醒模型。",
  "",
  "### 我的決定",
  "- HERMES-NEXT-001：同意 / 不同意 / 先暫停",
  "- 若同意，只能執行這一條命令。",
  "- 若命令和預覽不同，視為不同意並回到下一條命令預覽。",
  "",
  "### 執行後必做",
  "- 立即停止，不執行下一條命令。",
  "- 回報命令結果、是否成功、是否有錯誤、是否含敏感資訊。",
  "- 接著使用 `Hermes 單一命令結果回報` 或 `Hermes 命令結果判讀`。",
  "",
  "### 固定禁止",
  "- 不把本同意延伸成後續命令同意。",
  "- 不連續執行命令。",
  "- 不下載、不安裝、不寫檔、不改 PATH、不改設定，除非本條預覽已明列且使用者同意。",
  "- 不要求貼 API key、token、密碼或完整 .env。",
  "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
  "- 不喚醒 Hermes 或其它本地模型。",
].join("\n");

const HERMES_STARTUP_SINGLE_COMMAND_RESULT_TEMPLATE = [
  "## Hermes 開工後單一命令結果回報",
  "",
  "用途：HERMES-NEXT-001 執行後立刻停下，回報結果與敏感資訊檢查。未完成這張回報前，不執行下一條命令。",
  "",
  "### 命令一致性",
  "- 命令編號：HERMES-NEXT-001",
  "- 實際執行命令是否與預覽完全一致：是 / 否",
  "- 執行位置是否與預覽一致：是 / 否",
  "- 若不一致：標成 PAUSE，停止，不補跑、不重試。",
  "",
  "### 結果摘要",
  "- 狀態：PASS / WAIT / PAUSE",
  "- 輸出摘要：",
  "- 是否成功：是 / 否 / 不確定",
  "- 是否有錯誤：否 / 是，摘要：",
  "- 是否修改系統、PATH、設定或檔案：否 / 是，摘要：",
  "- 是否下載或安裝套件：否 / 是，摘要：",
  "",
  "### 敏感資訊檢查",
  "- 是否出現 API key、token、密碼或完整 .env：否 / 是，已停止",
  "- 是否碰到正式資料、正式 issue、Run now 或 schedule trigger：否 / 是，已停止",
  "- 是否有模型喚醒、agent 執行或 live run：否 / 是，已停止",
  "",
  "### 下一步只允許",
  "- PASS：只可請使用者決定是否回到下一條命令預覽。",
  "- WAIT：只補資訊或只讀檢查，不執行下一條命令。",
  "- PAUSE：停下整理風險、錯誤摘要與復原建議。",
  "",
  "### 固定禁止",
  "- 不連續執行下一條命令。",
  "- 不把 HERMES-NEXT-001 的同意延伸成下一條同意。",
  "- 不自動填 API key、token、密碼或完整 .env。",
  "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
  "- 不喚醒 Hermes 或其它本地模型。",
].join("\n");

const HERMES_STARTUP_SINGLE_COMMAND_DECISION_TEMPLATE = [
  "## Hermes 開工後單一命令判讀",
  "",
  "用途：讀完 `Hermes 開工後單一命令結果回報` 後，判讀 HERMES-NEXT-001 的下一個安全出口。這不是下一條命令授權。",
  "",
  "### 必讀前提",
  "- [ ] 已完成 `Hermes 開工後單一命令結果回報`。",
  "- [ ] 命令編號是 HERMES-NEXT-001。",
  "- [ ] 已確認實際命令與預覽是否完全一致。",
  "- [ ] 已檢查 API key、token、密碼、完整 .env、正式資料、Run now、schedule trigger 與模型喚醒。",
  "",
  "### 判讀規則",
  "- PASS：命令一致、結果乾淨、沒有敏感資訊、沒有喚醒或正式資料；只可請使用者決定是否回到下一條命令預覽。",
  "- WAIT：資訊不足或需要只讀補查；只補資訊或只讀檢查，不執行下一條命令。",
  "- PAUSE：命令不一致、錯誤不明、出現敏感資訊、碰到正式資料、Run now、schedule trigger、live run 或模型喚醒；立刻停下排查。",
  "",
  "### 請回覆",
  "- 判讀：PASS / WAIT / PAUSE",
  "- 原因：",
  "- 下一個只允許做的動作：回到下一條命令預覽 / 只讀補查 / 停下排查",
  "- 需要使用者決定的問題：",
  "- 仍然禁止做的事：",
  "",
  "### 固定禁止",
  "- PASS 也不是下一條命令授權。",
  "- 不連續執行下一條命令。",
  "- 不把 HERMES-NEXT-001 的同意延伸成下一條同意。",
  "- 不自動填 API key、token、密碼或完整 .env。",
  "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
  "- 不喚醒 Hermes 或其它本地模型。",
].join("\n");

const HERMES_STARTUP_SINGLE_COMMAND_CYCLE_SUMMARY_TEMPLATE = [
  "## Hermes 開工後單一命令循環總結",
  "",
  "用途：整理 HERMES-NEXT-001 這一輪做到哪裡，方便換對話、收工、覆盤或決定下一張安全卡。這不是下一條命令授權。",
  "",
  "### 本輪命令",
  "- 命令編號：HERMES-NEXT-001",
  "- 預覽是否完成：是 / 否",
  "- 單一命令同意：同意 / 不同意 / 先暫停",
  "- 實際命令是否與預覽一致：是 / 否 / 未執行",
  "- 結果回報狀態：PASS / WAIT / PAUSE / 未完成",
  "- 最後判讀：PASS / WAIT / PAUSE / 未完成",
  "",
  "### 安全檢查",
  "- 是否出現 API key、token、密碼或完整 .env：否 / 是，已停止",
  "- 是否碰到正式資料、正式 issue、Run now 或 schedule trigger：否 / 是，已停止",
  "- 是否有模型喚醒、agent 執行或 live run：否 / 是，已停止",
  "- 是否修改系統、PATH、設定或檔案：否 / 是，摘要：",
  "",
  "### 下一張安全卡",
  "- PASS：只可回到 `Hermes 開工後下一條命令預覽`，不可直接執行下一條。",
  "- WAIT：使用 `Hermes 命令 WAIT/PAUSE 處理`，只補資訊或只讀檢查。",
  "- PAUSE：停下整理風險、錯誤摘要與復原建議。",
  "- 收工或換對話：使用 `Hermes 安裝陪同收工交接`。",
  "",
  "### 固定禁止",
  "- 本總結不是下一條命令授權。",
  "- 不連續執行下一條命令。",
  "- 不把 HERMES-NEXT-001 的同意延伸成下一條同意。",
  "- 不自動填 API key、token、密碼或完整 .env。",
  "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
  "- 不喚醒 Hermes 或其它本地模型。",
].join("\n");

const HERMES_CONFIGURATION_CHECK_TEMPLATE = [
  "## Hermes 第 3 階設定檢查表",
  "",
  "我同意第 3 階：只做 Hermes 設定完成後的非敏感檢查。",
  "",
  "### 開始前確認",
  "- [ ] 第 2 階逐條同意紀錄已完成，或這次只需要只讀設定檢查。",
  "- [ ] API key、token、密碼或完整 .env 已留在 Hermes 自己的設定位置，沒有貼進對話、文件、issue 或 Office。",
  "- [ ] 這不是 Run now 授權、不是 schedule trigger 授權、不是模型喚醒授權。",
  "",
  "### 可以回報",
  "- WSL2/Ubuntu 是否可開啟：是 / 否 / 不確定",
  "- hermes --version 或 scripts/hermes-wsl.cmd --version 是否可回版本：是 / 否 / 不確定",
  "- Provider 名稱：ollama / openai / openrouter / 其他 / 不確定",
  "- Model 名稱或別名：",
  "- API key 是否已在 Hermes 自己的設定位置填好：是 / 否 / 不確定",
  "- .env 是否存在：是 / 否 / 不確定；不要貼內容",
  "- Test environment 結果摘要：pass / warn / fail / 尚未跑",
  "",
  "### 不要貼",
  "- API key、token、密碼。",
  "- 完整 .env 內容。",
  "- 含憑證的 URL、header、log 或截圖。",
  "- 正式客戶、公司、個人資料或私有文件內容。",
  "",
  "### Codex 只可做",
  "- 檢查這份表是否缺項。",
  "- 解讀只讀健康檢查或 Test environment 結果。",
  "- 若需要下一條命令，先回到第 1 階命令預覽表單。",
  "- 不建立 issue、不 Run now、不啟用 schedule trigger、不喚醒 Hermes 或其它本地模型。",
].join("\n");

const HERMES_INSTALL_READY_SNAPSHOT_ITEMS = [
  {
    label: "安裝前檢查包",
    value: "已可複製",
    detail: "先確認可自己先做、需要 Codex 陪同、現在先不要碰三區。",
  },
  {
    label: "安裝授權文字",
    value: "已可複製",
    detail: "真正開始前，使用者需貼出授權文字。",
  },
  {
    label: "安裝陪同紀錄",
    value: "已可複製",
    detail: "每個命令都要記錄目的、預覽、同意、結果與敏感資訊檢查。",
  },
  {
    label: "Hermes 喚醒",
    value: "仍未開始",
    detail: "目前不建立喚醒 issue、不 Run now、不啟用排程、不喚醒模型。",
  },
];

const HERMES_INSTALL_FLOW_GUIDE = [
  {
    step: "1",
    title: "先驗證預覽",
    detail: "跑 pnpm run office:verify，Backend OK / Frontend OK 後才繼續。",
    action: "不要略過",
  },
  {
    step: "2",
    title: "複製安裝前快照",
    detail: "交接目前仍未安裝、未填憑證、未喚醒 Hermes 的狀態。",
    action: "先留底",
  },
  {
    step: "3",
    title: "複製安裝前檢查包",
    detail: "確認可自己先做、需要 Codex 陪同、現在先不要碰三區。",
    action: "看停止條件",
  },
  {
    step: "4",
    title: "複製安裝授權",
    detail: "真正跨過安裝線前，由使用者貼出明確授權文字。",
    action: "使用者決定",
  },
  {
    step: "5",
    title: "複製陪同紀錄",
    detail: "每個命令都要先預覽、取得同意、記錄結果與敏感資訊檢查。",
    action: "逐步覆盤",
  },
];

const HERMES_INSTALL_BEGINNER_READING_ORDER = [
  {
    step: "0",
    title: "先看總檢",
    action: "複製總檢",
    detail: "判斷目前是 READY、WAIT 還是 PAUSE；READY 也只代表可以請使用者決定是否貼出安裝授權。",
  },
  {
    step: "1",
    title: "留下快照",
    action: "複製安裝前快照",
    detail: "記錄尚未安裝、尚未填憑證、尚未喚醒 Hermes，方便重開機或換對話後接續。",
  },
  {
    step: "2",
    title: "讀停止條件",
    action: "複製安裝前檢查包",
    detail: "確認哪些事可自己先做、哪些事需要 Codex 陪同、哪些事現在先不要碰。",
  },
  {
    step: "3",
    title: "先看命令",
    action: "複製命令預覽",
    detail: "要求 Codex 只列命令、目的、風險與停止條件，不下載、不寫檔、不改設定。",
  },
  {
    step: "4",
    title: "逐條確認",
    action: "複製逐條同意",
    detail: "任何會安裝、下載、寫檔、改 PATH 或設定的命令，都要一條一條確認。",
  },
  {
    step: "5",
    title: "再看授權線",
    action: "複製授權階梯",
    detail: "確認目前只走到第幾階；安裝、設定與沙盒喚醒是不同授權，不能混在一起。",
  },
  {
    step: "6",
    title: "最後交接",
    action: "複製最後交接",
    detail: "把快照、檢查包、命令預覽、授權與停手線整理成一份交接；它不是安裝授權。",
  },
];

const HERMES_AUTHORIZATION_LADDER = [
  {
    level: "0",
    title: "只讀準備",
    allowed: "可跑 office:verify、看 SOP、複製交接包與檢查包。",
    blocked: "不可安裝、下載、寫檔、改 PATH、設定或喚醒 Hermes。",
    userText: "我同意第 0 階：只讀準備。",
  },
  {
    level: "1",
    title: "命令預覽",
    allowed: "Codex 只列命令、目的、位置、風險與會修改什麼。",
    blocked: "不可執行命令，不可要求貼 API key、token、密碼或完整 .env。",
    userText: "我同意第 1 階：只列 Hermes 命令預覽，不執行。",
  },
  {
    level: "2",
    title: "安裝陪同",
    allowed: "在使用者逐條同意後，才可執行明確列出的安裝或檢查命令。",
    blocked: "不可填憑證、不可建立喚醒 issue、不可 Run now、不可啟用 schedule trigger。",
    userText: "我同意第 2 階：逐條確認後陪同安裝 Hermes。",
  },
  {
    level: "3",
    title: "設定檢查",
    allowed: "使用者在 Hermes 自己的設定位置填憑證後，Codex 只看非敏感狀態與 Test environment。",
    blocked: "不可把 API key、token、密碼或完整 .env 貼進對話、文件、prompt、skills 或 issue。",
    userText: "我同意第 3 階：只做 Hermes 設定完成後的非敏感檢查。",
  },
  {
    level: "4",
    title: "沙盒喚醒測試",
    allowed: "只用 Hermes Sandbox 員工與 Sandbox/Test issue 做第一次喚醒。",
    blocked: "不可接正式專案、不可啟用自動排程、不可連續 Run now、不可略過喚醒後覆盤。",
    userText: "我同意第 4 階：只做 Sandbox/Test Hermes 沙盒喚醒。",
  },
];

const ROUTINE_STARTER_TEMPLATES = [
  {
    label: "每日進度整理",
    cadence: "工作日早上",
    detail: "讓專案主管整理昨天完成、今天要做、卡住事項與需要你決定的問題。",
  },
  {
    label: "每週覆盤會議",
    cadence: "每週固定一次",
    detail: "把本週討論、決策理由、未完成風險與下週優先順序留在同一串。",
  },
  {
    label: "阻塞提醒",
    cadence: "每天檢查一次",
    detail: "只提醒被卡住的任務與上下游依賴，不自動改派或喚醒本地模型。",
  },
];

const ROUTINE_SAFETY_STEPS = [
  {
    label: "1. 先做草稿",
    detail: "只預填 Sandbox/Test routine，先確認目的、專案與員工，不直接啟用 trigger。",
  },
  {
    label: "2. 再過安全門",
    detail: "新增 trigger 或 Run now 前，先勾選 Sandbox/Test 確認，避免排程誤接正式工作。",
  },
  {
    label: "3. 最後覆盤",
    detail: "測完看 runs、active issues 與 recovery issues，再決定保留、調整、停用或刪除。",
  },
];

const BEGINNER_CODEX_HELP_PROMPT = [
  "請依照 docs/virtual-office-getting-started.zh-TW.md 與 docs/virtual-office-startup-sop.zh-TW.md 幫我檢查 Virtual Office。",
  "先只做健康檢查與安全說明。",
  "不要刪資料庫。",
  "不要建立或修改資料。",
  "不要新增 routine trigger。",
  "不要 Run now。",
  "不要指派或喚醒 Hermes。",
  "請先告訴我目前後端、前端、heartbeat、Routine safety 與 Hermes gate 的狀態。",
].join("\n");

const DAILY_START_CHECK_STEPS = [
  "跑 pnpm run office:check，確認 Backend OK / Frontend OK。",
  "打開 http://localhost:5173/AI/office。",
  "先看預覽服務、heartbeat、running/error 員工與 recovery issues。",
  "需要碰 routine、Hermes、員工停用或正式資料前，先複製對應檢查表。",
];

const DAILY_START_CHECK_PROMPT = [
  "Virtual Office 每日開工前安全檢查",
  "",
  ...DAILY_START_CHECK_STEPS.map((step, index) => `${index + 1}. ${step}`),
  "",
  "如果 office:check 沒通過，先不要建立、同步、保存、停用、Run now 或喚醒 Hermes。",
].join("\n");

const PREVIEW_RECOVERY_HELP_PROMPT = [
  "請依照 docs/virtual-office-startup-sop.zh-TW.md 幫我檢查 Virtual Office 預覽服務。",
  "請先查看 .virtual-office-preview-status.json 與 pnpm run office:check 的結果。",
  "請判斷是前端 localhost:5173、後端 127.0.0.1:3100/api/health，還是 embedded Postgres lock file 的問題。",
  "先只做健康檢查與安全復原建議。",
  "不要刪資料庫。",
  "不要手動刪 lock file。",
  "不要建立或修改資料。",
  "不要 Run now。",
  "不要喚醒 Hermes。",
].join("\n");

const PREVIEW_STATUS_REPORT_REVIEW_TEMPLATE = [
  "Virtual Office 預覽狀態報告覆盤",
  "",
  "請先跑 pnpm run office:check，再依 .virtual-office-preview-status.json 填寫：",
  "",
  "- generatedAt：",
  "- backendOk：",
  "- frontendOk：",
  "- heartbeatSchedulerEnabled：",
  "- embeddedPostgresLockFile.exists：",
  "- portOwnership：",
  "- nextAction：",
  "",
  "安全判斷：",
  "- 如果 backendOk 不是 true，先不要建立、同步、保存、停用或 Run now。",
  "- 如果 frontendOk 不是 true，先處理前端預覽，不代表資料庫壞掉。",
  "- 如果 lock file 需要處理，不手動刪；先照 SOP 重啟或重開 Windows。",
  "- 不喚醒 Hermes，除非 Hermes gate 與沙盒驗收都已通過。",
].join("\n");

const STARTUP_SAFETY_BUNDLE_PROMPT = [
  "Virtual Office 開機安全包",
  "",
  DAILY_START_CHECK_PROMPT,
  "",
  "---",
  "",
  PREVIEW_RECOVERY_HELP_PROMPT,
  "",
  "---",
  "",
  PREVIEW_STATUS_REPORT_REVIEW_TEMPLATE,
  "",
  "---",
  "",
  PREVIEW_STATUS_DECISION_PROMPT,
].join("\n");

function virtualOfficeRoutineDraftHref(template: (typeof ROUTINE_STARTER_TEMPLATES)[number]) {
  const params = new URLSearchParams({
    source: "virtual-office-routine",
    title: `Sandbox routine: ${template.label}`,
    description: [
      `## ${template.label}`,
      "",
      template.detail,
      "",
      "### 安全邊界",
      "- 先保持 draft 或 paused，不要直接啟用 schedule trigger。",
      "- 第一次只掛 Sandbox/Test 專案與測試員工。",
      "- 不指派 Hermes 或其它本地模型，直到本地模型 gate 通過。",
      "- 不自動改派任務、不停用員工、不清理正式資料。",
      "",
      "### 建議覆盤",
      "- 完成了什麼。",
      "- 卡住在哪裡。",
      "- 需要使用者決定什麼。",
      "- 下一次排程是否可以安全啟用。",
    ].join("\n"),
  });
  return `/routines?${params.toString()}`;
}

const HERMES_WSL_SETUP_STEPS = [
  {
    label: "1. 在 WSL2 確認 Hermes",
    command: "scripts\\hermes-wsl.cmd status",
    detail: "先只看狀態，確認 bridge 能從 Windows 呼叫 WSL2 內的 Hermes。",
  },
  {
    label: "2. 在 WSL2 設定模型",
    command: "wsl.exe -d Ubuntu -- hermes model",
    detail: "用 Hermes 自己的互動設定選 provider 與 model；API key 不放進 Paperclip 文件或 issue。",
  },
  {
    label: "3. 回 Office 重新檢查",
    command: "按重新檢查",
    detail: "狀態從需確認變成可使用後，才建立 Sandbox/Test 任務做第一次喚醒。",
  },
];

const HERMES_ACCESS_MODE_OPTIONS = [
  {
    label: "本機 Hermes",
    status: "可評估",
    detail: "走目前 WSL2 / Windows bridge 路線，先做只讀檢查與命令預覽，再由使用者逐條同意。",
    safeNextStep: "複製安裝前總檢或命令預覽，不自動安裝。",
  },
  {
    label: "遠端 Hermes API",
    status: "先暫緩",
    detail: "借鏡 Hermes Desktop 的 remote backend 概念；只記錄 URL 是否可用，不在 Office 內保存 API key。",
    safeNextStep: "先規劃遠端連線檢查表，不填 API key、不驗證憑證。",
  },
  {
    label: "尚未決定",
    status: "安全預設",
    detail: "新手還不確定時，先看教學、診斷包與需求，不安裝、不連線、不喚醒。",
    safeNextStep: "保持第 0 階只讀準備。",
  },
];

const HERMES_SANDBOX_WAKEUP_TEMPLATE = [
  "## Hermes Sandbox First Wake-up",
  "",
  "請只做這個沙盒任務，不修改任何正式資料。",
  "",
  "### 任務",
  "1. 回覆你已收到任務。",
  "2. 列出你能看到的公司、專案與任務標題。",
  "3. 說明你目前可用的 skills 或工具能力。",
  "4. 列出下一步你會先檢查哪些安全邊界。",
  "",
  "### 限制",
  "- 不要修改檔案。",
  "- 不要建立正式任務。",
  "- 不要停用、刪除或改名任何員工。",
  "- 不要讀取或回覆任何 API key、token、密碼或私密設定。",
  "- 如果環境缺少 model、provider 或 API key，請只回報缺少項目，不要重試多次。",
  "",
  "### 通過標準",
  "- Hermes 留下一段可覆盤回覆。",
  "- 員工沒有卡在 running/error。",
  "- 沒有大量 recovery issues。",
  "- 使用者可以看懂下一步該設定什麼。",
];

const HERMES_WAKEUP_RUNBOOK_STEPS = [
  {
    label: "1. 設定前",
    detail: "確認 Backend OK / Frontend OK，Hermes gate 不再提示缺 model、.env 或 API key。",
  },
  {
    label: "2. 建立前",
    detail: "確認 Hermes Sandbox/Test 員工與 Sandbox/Test 專案都存在，issue 草稿只掛測試資料。",
  },
  {
    label: "3. 喚醒前",
    detail: "確認任務內容只要求回覆上下文、skills 與安全邊界，不要求修改檔案或正式資料。",
  },
  {
    label: "4. 完成後",
    detail: "回到喚醒後檢查面板，確認沒有 running/error、沒有 live run 殘留，並覆盤 issue 回覆。",
  },
];

const HERMES_WAKEUP_PREFLIGHT_RULES = [
  {
    label: "環境通過",
    detail: "Test environment 必須是 pass，且不再提示缺 model、provider、.env 或 API key。",
  },
  {
    label: "只用沙盒",
    detail: "負責人必須是 Hermes Sandbox/Test 員工，專案必須是 Sandbox/Test 專案。",
  },
  {
    label: "任務最小",
    detail: "第一次 issue 只要求回覆上下文、skills、環境狀態與安全邊界，不要求修改檔案或正式資料。",
  },
  {
    label: "手動確認",
    detail: "使用者必須先勾選確認；Office 只可預填 issue 草稿，不自動建立、不 Run now、不連續喚醒。",
  },
];

const HERMES_POST_WAKEUP_REVIEW_FIELDS = [
  {
    label: "回覆可讀",
    detail: "Hermes Sandbox issue 內應有一段可理解、可追溯、沒有洩漏憑證的回覆。",
  },
  {
    label: "員工狀態",
    detail: "Hermes 員工不應停在 running 或 error；若卡住，先停下覆盤。",
  },
  {
    label: "工作殘留",
    detail: "不應有 Hermes queued/running live runs 殘留；若有，先不要建立下一個任務。",
  },
  {
    label: "復原訊號",
    detail: "若新增 recovery issues，先整理原因與截圖，不進正式專案。",
  },
];

function hermesEnvironmentHint(checks: { code: string; level: string; hint?: string | null }[]) {
  if (checks.some((check) => check.code === "hermes_cli_not_found")) {
    return "官方 Hermes Agent 不支援 Native Windows；這台機器已有 WSL2/Ubuntu，建議先在 WSL2 安裝，再補 Paperclip 可呼叫的橋接。";
  }
  return (
    checks.find((check) => check.level === "error")?.hint
    ?? checks.find((check) => check.level === "warn")?.hint
    ?? "Hermes CLI 基本檢查通過；真喚醒前仍要用沙盒 issue 測試。"
  );
}

function bestAgentForPhase(agents: Agent[], phase: StarterPhase, fallbackIndex: number): Agent | null {
  const activeAgents = agents.filter((agent) => agent.status !== "terminated");
  if (activeAgents.length === 0) return null;
  return (
    activeAgents.find((agent) =>
      phase.matcher.test(`${agent.name} ${agent.title ?? ""} ${agent.capabilities ?? ""} ${agent.adapterType}`),
    ) ?? activeAgents[fallbackIndex % activeAgents.length] ?? null
  );
}

function suggestedSkillAudience(skill: CompanySkillListItem): string {
  const text = `${skill.name} ${skill.description ?? ""} ${skill.key}`.toLowerCase();
  if (/test|qa|quality|驗收|測試/.test(text)) return "適合測試、品保、覆盤角色";
  if (/design|ui|ux|prototype|設計|原型/.test(text)) return "適合產品、設計、需求角色";
  if (/code|dev|repo|git|工程|程式|開發/.test(text)) return "適合工程、工具、自動化角色";
  if (/meeting|review|doc|plan|討論|文件|計畫|覆盤/.test(text)) return "適合主管、PM、會議整理角色";
  return "依任務需要指派給相關員工";
}

function skillMatchesProfile(skill: CompanySkillListItem, profile: "pm" | "engineering" | "quality") {
  const text = `${skill.name} ${skill.description ?? ""} ${skill.key}`.toLowerCase();
  if (profile === "pm") {
    return /pm|project|meeting|review|doc|plan|product|需求|產品|專案|討論|文件|計畫|覆盤/.test(text);
  }
  if (profile === "engineering") {
    return /code|dev|repo|git|test|tool|backend|frontend|工程|程式|開發|工具|自動化/.test(text);
  }
  return /test|qa|quality|review|check|驗收|測試|品保|檢查|覆盤/.test(text);
}

function WorkflowBuildPreview({
  phases,
  workflowShape,
  lead,
  getAssignee,
}: {
  phases: StarterPhase[];
  workflowShape: "serial" | "parallel";
  lead: Agent | null;
  getAssignee: (phase: StarterPhase, index: number) => Agent | null;
}) {
  function dependencyLabel(index: number) {
    if (index === 0) return "起點";
    if (workflowShape === "serial") return "等待上一階段";
    if (index === phases.length - 1) return "彙整平行成果";
    return "需求後可平行";
  }

  function laneLabel(index: number) {
    if (workflowShape === "serial") return `第 ${index + 1} 站`;
    if (index === 0) return "共同輸入";
    if (index === phases.length - 1) return "統整輸出";
    return "平行單位";
  }

  return (
    <div className="rounded-md border border-border/70 bg-muted/30 p-3">
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-medium">建立前預覽</div>
          <p className="mt-1 text-xs text-muted-foreground">
            按下建立後，會建立 1 個專案與 {phases.length} 個任務；這裡先確認主管、負責人與依賴關係。
          </p>
        </div>
        <span className="w-fit rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
          {workflowShape === "serial" ? "上下游順序" : "平行單位協作"}
        </span>
      </div>
      <div className="mb-3 rounded-md border border-border/70 bg-background px-3 py-2 text-xs text-muted-foreground">
        專案主管：<span className="font-medium text-foreground">{lead?.name ?? "尚無可用員工"}</span>
      </div>
      <div className="grid gap-2 lg:grid-cols-5">
        {phases.map((phase, index) => {
          const assignee = getAssignee(phase, index);
          return (
            <div
              key={phase.title}
              className={cn(
                "relative rounded-md border bg-background p-3",
                workflowShape === "parallel" && index > 0 && index < phases.length - 1
                  ? "border-primary/40"
                  : "border-border/70",
              )}
            >
              {index > 0 && workflowShape === "serial" && (
                <span className="absolute -left-2 top-1/2 hidden h-px w-2 bg-border lg:block" />
              )}
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full border border-primary/40 bg-primary/10 text-[11px] font-medium text-primary">
                  {index + 1}
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                    {laneLabel(index)}
                  </span>
                  <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
                    {dependencyLabel(index)}
                  </span>
                </span>
              </div>
              <div className="text-sm font-medium">{phase.title}</div>
              <p className="mt-1 line-clamp-3 text-xs leading-5 text-muted-foreground">{phase.description}</p>
              <div className="mt-3 rounded-sm bg-muted/60 px-2 py-1 text-xs">
                負責：<span className="font-medium text-foreground">{assignee?.name ?? "未指定"}</span>
              </div>
            </div>
          );
        })}
      </div>
      {workflowShape === "parallel" && (
        <div className="mt-3 rounded-md border border-primary/30 bg-primary/10 p-3 text-xs leading-5 text-primary">
          <div className="font-medium">平行單位協作規則</div>
          <p className="mt-1">
            需求整理是共同輸入；設計、實作與測試會被視為平行單位，可在需求後一起展開；覆盤階段會彙整前面成果。
          </p>
        </div>
      )}
    </div>
  );
}

function roleTemplatePrompt(template: AgencyRoleTemplate) {
  return [
    `你是 ${template.suggestedName}，角色是 ${template.suggestedTitle}。`,
    "",
    "能力重點：",
    template.capabilities,
    "",
    "適合先交辦的任務：",
    ...template.firstTasks.map((task) => `- ${task}`),
    "",
    "工作時請固定留下：",
    "- 你理解的目標",
    "- 做法與重要取捨",
    "- 需要使用者決定的問題",
    "- 下一步建議",
  ].join("\n");
}

function StarterConsole({
  agents,
  projects,
  issues,
  companyId,
  openNewAgent,
  openNewIssue,
  openManageAgent,
}: {
  agents: Agent[];
  projects: Project[];
  issues: Issue[];
  companyId: string;
  openNewAgent: () => void;
  openNewIssue: (defaults?: {
    status?: string;
    priority?: string;
    projectId?: string;
    assigneeAgentId?: string;
    title?: string;
    description?: string;
  }) => void;
  openManageAgent: (agent: Agent) => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pushToast } = useToastActions();
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const [meetingOpen, setMeetingOpen] = useState(false);
  const [skillOpen, setSkillOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [acceptanceOpen, setAcceptanceOpen] = useState(false);
  const [cleanWorkflowOpen, setCleanWorkflowOpen] = useState(false);
  const [cleanWorkflowPauseAgentIds, setCleanWorkflowPauseAgentIds] = useState<string[]>([]);
  const [cleanWorkflowCancelRunIds, setCleanWorkflowCancelRunIds] = useState<string[]>([]);
  const [cleanWorkflowPauseConfirm, setCleanWorkflowPauseConfirm] = useState(false);
  const [hermesWakeupUserConfirmed, setHermesWakeupUserConfirmed] = useState(false);
  const [projectName, setProjectName] = useState("我的第一個 AI 專案");
  const [projectDescription, setProjectDescription] = useState("請先從需求整理開始，逐步完成設計、實作、測試與覆盤。");
  const [leadAgentId, setLeadAgentId] = useState("auto");
  const [workflowShape, setWorkflowShape] = useState<"serial" | "parallel">("serial");
  const [phaseAssignees, setPhaseAssignees] = useState<Record<string, string>>({});
  const [workflowWakeRiskConfirmed, setWorkflowWakeRiskConfirmed] = useState(false);
  const [meetingTitle, setMeetingTitle] = useState("專案討論會議");
  const [meetingAgenda, setMeetingAgenda] = useState("請整理目前進度、卡住的問題、需要我決定的事項，以及下一步建議。");
  const [meetingProjectId, setMeetingProjectId] = useState("none");
  const [meetingFacilitatorId, setMeetingFacilitatorId] = useState("auto");
  const [meetingParticipantIds, setMeetingParticipantIds] = useState<string[]>([]);
  const [meetingTemplateId, setMeetingTemplateId] = useState(MEETING_TEMPLATES[0]!.id);
  const [meetingNeedsUserDecision, setMeetingNeedsUserDecision] = useState(true);
  const [meetingUserDecisionNote, setMeetingUserDecisionNote] = useState(
    "如果討論中遇到方向取捨、權限、成本或是否繼續投入，請先整理選項與建議，等我介入決定。",
  );
  const [skillAgentId, setSkillAgentId] = useState("");
  const [selectedSkillKeys, setSelectedSkillKeys] = useState<string[]>([]);
  const [starterSkillNotice, setStarterSkillNotice] = useState<string | null>(null);
  const [previewSkillTemplate, setPreviewSkillTemplate] = useState<StarterSkillTemplate | null>(null);
  const [previewRoleTemplate, setPreviewRoleTemplate] = useState<AgencyRoleTemplate | null>(null);
  const [checklistExpanded, setChecklistExpanded] = useState(false);
  const [reviewedStepIds, setReviewedStepIds] = useState<string[]>([]);
  const [loadedOnboardingStorageKey, setLoadedOnboardingStorageKey] = useState<string | null>(null);
  const onboardingStorageKey = `paperclip.virtualOffice.onboarding.${companyId}`;

  const activeAgents = useMemo(
    () => agents.filter((agent) => agent.status !== "terminated"),
    [agents],
  );
  const activeProjects = useMemo(
    () => projects.filter((project) => !project.archivedAt),
    [projects],
  );
  const { data: companyLiveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(companyId),
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId, { minCount: 20, limit: 50 }),
    enabled: Boolean(companyId),
    refetchInterval: 5_000,
  });
  const { data: routines = [] } = useQuery({
    queryKey: queryKeys.routines.list(companyId),
    queryFn: () => routinesApi.list(companyId),
    enabled: Boolean(companyId),
  });
  const workflowLead = useMemo(
    () =>
      leadAgentId === "auto"
        ? activeAgents.find((agent) => /lead|manager|pm|主管|專案/i.test(`${agent.title ?? ""} ${agent.capabilities ?? ""}`))
          ?? activeAgents[0]
          ?? null
        : activeAgents.find((agent) => agent.id === leadAgentId) ?? null,
    [activeAgents, leadAgentId],
  );
  const workflowWakeRiskAgents = useMemo(
    () => activeAgents.filter((agent) => agent.status === "running" || agent.status === "error"),
    [activeAgents],
  );
  const workflowWakeRiskRuns = useMemo(
    () => (companyLiveRuns ?? []).filter((run) => run.status === "queued" || run.status === "running"),
    [companyLiveRuns],
  );
  const workflowWakeRiskRunSummary = useMemo(() => {
    const byAgent = new Map<string, number>();
    for (const run of workflowWakeRiskRuns) {
      const label = run.agentName || "未指定員工";
      byAgent.set(label, (byAgent.get(label) ?? 0) + 1);
    }
    return [...byAgent.entries()].map(([agentName, count]) => `${agentName} ${count} 個工作`).join("、");
  }, [workflowWakeRiskRuns]);
  const workflowRequiresWakeRiskConfirmation = workflowWakeRiskAgents.length > 0 || workflowWakeRiskRuns.length > 0;
  const workflowCleanReadiness = useMemo(() => {
    if (workflowWakeRiskAgents.length === 0 && workflowWakeRiskRuns.length === 0) {
      return {
        status: "可驗收",
        value: "沒有 running/error 員工或舊工作",
        detail: "可以用沙盒專案做乾淨的上下游工作流驗收。",
      };
    }
    if (workflowWakeRiskAgents.length === 0) {
      return {
        status: "先暫停",
        value: workflowWakeRiskRunSummary || `${workflowWakeRiskRuns.length} 個 queued/running 工作`,
        detail: "還有舊工作正在排隊或執行；先等它結束或取消，再建立新的沙盒工作流。",
      };
    }
    return {
      status: "先暫停",
      value: workflowWakeRiskAgents.map((agent) => `${agent.name}（${agent.status}）`).join("、"),
      detail: workflowWakeRiskRuns.length > 0
        ? `目前不建議建立新的工作流；先處理員工狀態，並確認舊工作已結束或取消：${workflowWakeRiskRunSummary}。`
      : "目前不建議建立新的工作流；先處理這些員工狀態，或只做不改資料的畫面檢查。",
    };
  }, [workflowWakeRiskAgents, workflowWakeRiskRuns.length, workflowWakeRiskRunSummary]);
  const sandboxEditSafetyCards = useMemo(
    () => [
      {
        label: "目前 active run",
        status: workflowWakeRiskRuns.length === 0 ? "乾淨" : "先暫停",
        value: workflowWakeRiskRuns.length === 0 ? "0 個" : `${workflowWakeRiskRuns.length} 個`,
        detail:
          workflowWakeRiskRuns.length === 0
            ? "現在沒有 queued/running live run；沙盒任務沒有正在被模型處理。"
            : `仍有 queued/running live run：${workflowWakeRiskRunSummary || "請先檢查 live runs"}。`,
        tone: workflowWakeRiskRuns.length === 0 ? "success" : "warn",
      },
      {
        label: "沙盒編輯",
        status: "只編輯",
        value: "不喚醒",
        detail: "改描述、改派員工、預填草稿或安排工作流，只是更新資料，不等於 Run now 或喚醒 agent。",
        tone: "success",
      },
      {
        label: "喚醒門檻",
        status: "需授權",
        value: "逐字一次性",
        detail: "真正喚醒前，必須另行貼出指定 issue、指定員工、指定範圍的一次性授權句。",
        tone: "warn",
      },
      {
        label: "失敗處理",
        status: "停下覆盤",
        value: "不自動 retry",
        detail: "遇到 529、timeout 或 adapter failed，只記錄失敗並停止，不自動建立 recovery 或連續喚醒。",
        tone: "success",
      },
    ],
    [workflowWakeRiskRunSummary, workflowWakeRiskRuns.length],
  );
  const routineSafetyCards = useMemo(() => {
    const activeRoutines = routines.filter((routine) => routine.status === "active");
    const draftOrPausedRoutines = routines.filter((routine) => routine.status !== "active");
    const scheduleTriggers = routines.flatMap((routine) =>
      routine.triggers
        .filter((trigger) => trigger.kind === "schedule")
        .map((trigger) => ({ routine, trigger })),
    );
    const enabledScheduleTriggers = scheduleTriggers.filter(({ trigger }) => trigger.enabled);
    const activeRoutineIssues = routines.filter((routine) => routine.activeIssue);
    const sandboxRoutineCount = routines.filter((routine) =>
      isSandboxName(`${routine.title} ${routine.description ?? ""}`),
    ).length;

    return [
      {
        label: "Routine 數量",
        status: routines.length > 0 ? "可查看" : "尚未建立",
        value: `${routines.length} 個`,
        detail: routines.length > 0
          ? `${activeRoutines.length} 個 active，${draftOrPausedRoutines.length} 個草稿或暫停。`
          : "先到 Routines 建立例行工作草稿；草稿不會自動執行。",
        tone: routines.length > 0 ? "success" : "warn",
      },
      {
        label: "Schedule trigger",
        status: enabledScheduleTriggers.length > 0 ? "有啟用" : "安全",
        value: `${enabledScheduleTriggers.length} / ${scheduleTriggers.length} 啟用`,
        detail: enabledScheduleTriggers.length > 0
          ? "正式啟用前確認 assignee、project、variables 與 catch-up policy，避免重複喚醒。"
          : "目前沒有啟用中的 cron 排程，適合先做教學與草稿設計。",
        tone: enabledScheduleTriggers.length > 0 ? "warn" : "success",
      },
      {
        label: "執行中的 routine",
        status: activeRoutineIssues.length > 0 ? "需觀察" : "乾淨",
        value: `${activeRoutineIssues.length} 個 active issue`,
        detail: activeRoutineIssues.length > 0
          ? "先看最近 runs，確認是否已完成或需要人工介入。"
          : "沒有 routine execution issue 正在進行，現在做排程草稿較安全。",
        tone: activeRoutineIssues.length > 0 ? "warn" : "success",
      },
      {
        label: "Sandbox 排程",
        status: sandboxRoutineCount > 0 ? "已準備" : "可建立草稿",
        value: `${sandboxRoutineCount} 個`,
        detail: sandboxRoutineCount > 0
          ? "已有 Sandbox/Test routine，可優先用它測排程行為。"
          : "第一次建議只做 Sandbox/Test routine，不掛正式專案與 Hermes。",
        tone: sandboxRoutineCount > 0 ? "success" : "warn",
      },
    ];
  }, [routines]);
  const meetingParticipants = useMemo(
    () =>
      activeAgents.filter((agent) =>
        meetingParticipantIds.length > 0 ? meetingParticipantIds.includes(agent.id) : true,
      ),
    [activeAgents, meetingParticipantIds],
  );
  const selectedMeetingTemplate = useMemo(
    () => MEETING_TEMPLATES.find((template) => template.id === meetingTemplateId) ?? MEETING_TEMPLATES[0]!,
    [meetingTemplateId],
  );

  useEffect(() => {
    if (!cleanWorkflowOpen) return;
    setCleanWorkflowPauseAgentIds(workflowWakeRiskAgents.map((agent) => agent.id));
    setCleanWorkflowCancelRunIds(workflowWakeRiskRuns.map((run) => run.id));
    setCleanWorkflowPauseConfirm(false);
  }, [cleanWorkflowOpen, workflowWakeRiskAgents, workflowWakeRiskRuns]);
  const reviewThreadCount = useMemo(
    () => issues.filter((issue) => !isSystemRecoveryIssue(issue) && isMeetingLike(issue)).length,
    [issues],
  );
  const sandboxAgents = useMemo(
    () => activeAgents.filter((agent) => isSandboxName(`${agent.name} ${agent.title ?? ""}`)),
    [activeAgents],
  );
  const sandboxProjects = useMemo(
    () => activeProjects.filter((project) => isSandboxName(`${project.name} ${project.description ?? ""}`)),
    [activeProjects],
  );

  const { data: companySkills } = useQuery({
    queryKey: queryKeys.companySkills.list(companyId),
    queryFn: () => companySkillsApi.list(companyId),
    enabled: Boolean(companyId),
  });
  const { data: adapterRegistry = [] } = useQuery({
    queryKey: ["virtual-office", companyId, "adapters"],
    queryFn: () => adaptersApi.list(),
    enabled: Boolean(companyId),
  });
  const hermesAdapter = useMemo(
    () => adapterRegistry.find((adapter) => adapter.type === "hermes_local") ?? null,
    [adapterRegistry],
  );
  const hermesAgents = useMemo(
    () => activeAgents.filter((agent) => agent.adapterType === "hermes_local"),
    [activeAgents],
  );
  const {
    data: hermesEnvironmentTest,
    error: hermesEnvironmentError,
    isFetching: hermesEnvironmentFetching,
    refetch: refetchHermesEnvironment,
  } = useQuery({
    queryKey: ["virtual-office", companyId, "hermes-local-environment"],
    queryFn: () =>
      agentsApi.testEnvironment(companyId, "hermes_local", {
        adapterConfig: { hermesCommand: HERMES_WSL_BRIDGE_COMMAND },
      }),
    enabled: Boolean(companyId && hermesAdapter && !hermesAdapter.disabled),
    retry: false,
    staleTime: 60_000,
  });

  const visibleCompanySkills = useMemo(
    () => (companySkills ?? []).filter((skill) => !skill.key.startsWith("paperclipai/paperclip/")),
    [companySkills],
  );
  const visibleCompanySkillsByName = useMemo(
    () => new Map(visibleCompanySkills.map((skill) => [skill.name, skill])),
    [visibleCompanySkills],
  );
  const selectedSkillAgent = useMemo(
    () => activeAgents.find((agent) => agent.id === skillAgentId) ?? null,
    [activeAgents, skillAgentId],
  );
  const readyStarterSkillTemplates = useMemo(
    () => STARTER_SKILL_TEMPLATES.filter((template) => visibleCompanySkillsByName.has(template.name)),
    [visibleCompanySkillsByName],
  );
  const missingStarterSkillTemplates = useMemo(
    () => STARTER_SKILL_TEMPLATES.filter((template) => !visibleCompanySkillsByName.has(template.name)),
    [visibleCompanySkillsByName],
  );
  const skillWizardSteps = useMemo(
    () => [
      {
        label: "選員工",
        done: Boolean(selectedSkillAgent),
        hint: selectedSkillAgent ? `目前：${selectedSkillAgent.name}` : "先選一位要配置能力的員工",
      },
      {
        label: "選推薦包",
        done: selectedSkillKeys.length > 0,
        hint: selectedSkillKeys.length > 0 ? `已選 ${selectedSkillKeys.length} 個技能` : "可用 PM、工程、測試推薦包快速預選",
      },
      {
        label: "補 starter skill",
        done: readyStarterSkillTemplates.length === STARTER_SKILL_TEMPLATES.length,
        hint: `${readyStarterSkillTemplates.length} / ${STARTER_SKILL_TEMPLATES.length} 個 starter skills 已準備`,
      },
      {
        label: "同步技能",
        done: false,
        hint: "確認後再按同步，才會寫入員工設定",
      },
    ],
    [readyStarterSkillTemplates.length, selectedSkillAgent, selectedSkillKeys.length],
  );
  const e2eReadinessCards = useMemo(
    () => [
      {
        label: E2E_SANDBOX_SIGNALS[0]!.label,
        status: sandboxAgents.length > 0 ? "可驗收" : "先準備",
        value: sandboxAgents.length > 0 ? sandboxAgents.map((agent) => agent.name).slice(0, 3).join("、") : "尚未找到測試員工",
        detail: sandboxAgents.length > 0 ? E2E_SANDBOX_SIGNALS[0]!.pass : E2E_SANDBOX_SIGNALS[0]!.pause,
      },
      {
        label: E2E_SANDBOX_SIGNALS[1]!.label,
        status: sandboxProjects.length > 0 ? "可驗收" : "先準備",
        value: sandboxProjects.length > 0 ? sandboxProjects.map((project) => project.name).slice(0, 3).join("、") : "尚未找到測試專案",
        detail: sandboxProjects.length > 0 ? E2E_SANDBOX_SIGNALS[1]!.pass : E2E_SANDBOX_SIGNALS[1]!.pause,
      },
      {
        label: E2E_SANDBOX_SIGNALS[2]!.label,
        status: missingStarterSkillTemplates.length === 0 ? "可驗收" : "先補齊",
        value: `${readyStarterSkillTemplates.length} / ${STARTER_SKILL_TEMPLATES.length} 已準備`,
        detail:
          missingStarterSkillTemplates.length === 0
            ? E2E_SANDBOX_SIGNALS[2]!.pass
            : `缺少：${missingStarterSkillTemplates.map((template) => template.name).join("、")}。${E2E_SANDBOX_SIGNALS[2]!.pause}`,
      },
      {
        label: "工作流乾淨狀態",
        status: workflowCleanReadiness.status,
        value: workflowCleanReadiness.value,
        detail: workflowCleanReadiness.detail,
      },
      {
        label: E2E_SANDBOX_SIGNALS[3]!.label,
        status: reviewThreadCount > 0 ? "可覆盤" : "先建立",
        value: `${reviewThreadCount} 個會議/討論串`,
        detail: reviewThreadCount > 0 ? E2E_SANDBOX_SIGNALS[3]!.pass : E2E_SANDBOX_SIGNALS[3]!.pause,
      },
    ],
    [missingStarterSkillTemplates, readyStarterSkillTemplates.length, reviewThreadCount, sandboxAgents, sandboxProjects, workflowCleanReadiness],
  );
  const localModelReadinessCards = useMemo(
    () => [
      {
        label: "Hermes adapter",
        status: hermesAdapter && !hermesAdapter.disabled ? "已註冊" : "待檢查",
        value: hermesAdapter
          ? `builtin / ${hermesAdapter.capabilities.supportsSkills ? "skills OK" : "skills 未支援"}`
          : "尚未出現在後端 adapter 清單",
        detail: hermesAdapter
          ? "後端已註冊 hermes_local，可建立 Hermes Agent；真正執行前仍要確認本機 hermes 指令可用。"
          : "後端還沒提供 Hermes adapter，先不要建立 Hermes 測試員工。",
      },
      {
        label: "本地 CLI",
        status: hermesEnvironmentFetching
          ? "檢查中"
          : hermesEnvironmentTest?.status === "pass"
            ? "可使用"
            : hermesEnvironmentTest?.status === "warn"
              ? "需確認"
              : "待安裝",
        value: hermesEnvironmentTest
          ? hermesEnvironmentTest.checks.find((check) => check.code === "hermes_version")?.message
            ?? hermesEnvironmentTest.checks.find((check) => check.code === "hermes_cli_not_found")?.message
            ?? `Hermes environment: ${hermesEnvironmentTest.status}`
          : hermesEnvironmentError instanceof Error
            ? hermesEnvironmentError.message
            : "正在檢查 hermes 指令與環境",
        detail: hermesEnvironmentTest
          ? hermesEnvironmentHint(hermesEnvironmentTest.checks)
          : "先照 docs/virtual-office-hermes-sop.zh-TW.md 確認 Python、hermes CLI、模型憑證與 PATH，再做環境測試。",
      },
      {
        label: "Hermes 員工",
        status: hermesAgents.length > 0 ? "可檢查" : "尚未建立",
        value: hermesAgents.length > 0 ? hermesAgents.map((agent) => agent.name).slice(0, 2).join("、") : "0 位 hermes_local 員工",
        detail: hermesAgents.length > 0
          ? "已有 Hermes adapter 員工，可進一步做環境測試與安全喚醒。"
          : "先從草稿建立一位 Hermes 本地模型工程師；建立後只做 Test environment，不直接喚醒正式任務。",
      },
    ],
    [hermesAdapter, hermesAgents, hermesEnvironmentError, hermesEnvironmentFetching, hermesEnvironmentTest],
  );
  const hermesSetupGuideCards = useMemo(() => {
    const checks = hermesEnvironmentTest?.checks ?? [];
    const bridgeReady = checks.some((check) => check.code === "hermes_windows_wsl_bridge" || check.code === "hermes_version");
    const modelMissing = checks.some((check) => check.code === "hermes_model_missing");
    const envMissing = checks.some((check) => check.code === "hermes_env_missing" || check.code === "hermes_api_key_missing");
    const environmentPass = hermesEnvironmentTest?.status === "pass";

    return [
      {
        ...HERMES_WSL_SETUP_STEPS[0]!,
        status: bridgeReady ? "已完成" : hermesEnvironmentFetching ? "檢查中" : "先確認",
        tone: bridgeReady ? "success" : "warn",
      },
      {
        ...HERMES_WSL_SETUP_STEPS[1]!,
        status: modelMissing || envMissing ? "待設定" : environmentPass ? "已完成" : "先確認",
        tone: environmentPass ? "success" : "warn",
      },
      {
        ...HERMES_WSL_SETUP_STEPS[2]!,
        status: environmentPass ? "可進沙盒" : "先不要喚醒",
        tone: environmentPass ? "success" : "warn",
      },
    ];
  }, [hermesEnvironmentFetching, hermesEnvironmentTest]);
  const hermesSandboxWakeupCards = useMemo(() => {
    const environmentPass = hermesEnvironmentTest?.status === "pass";
    const hasHermesSandboxAgent = hermesAgents.some((agent) => isSandboxName(`${agent.name} ${agent.title ?? ""}`));
    const hasSandboxProject = sandboxProjects.length > 0;
    return [
      {
        label: "環境狀態",
        status: environmentPass ? "可測試" : "先等待",
        detail: environmentPass
          ? "Hermes Test environment 已通過，可以準備 Sandbox/Test issue。"
          : "目前仍缺模型或憑證；只複製模板，不建立任務、不喚醒員工。",
      },
      {
        label: "沙盒對象",
        status: hasHermesSandboxAgent && hasSandboxProject ? "可使用" : "先準備",
        detail: hasHermesSandboxAgent && hasSandboxProject
          ? "已有 Hermes Sandbox 員工與 Sandbox/Test 專案，可用來承接第一次測試。"
          : "先建立名稱含 Sandbox/Test 的 Hermes 員工與測試專案，不使用正式專案。",
      },
      {
        label: "測試任務",
        status: "只用模板",
        detail: "第一次任務只要求回覆可見上下文與安全邊界，不要求修改檔案或處理正式工作。",
      },
      {
        label: "結束判斷",
        status: "看三件事",
        detail: "確認有可覆盤回覆、沒有 running/error 員工、沒有大量 recovery issues，再進下一步。",
      },
    ];
  }, [hermesAgents, hermesEnvironmentTest?.status, sandboxProjects.length]);
  const hermesSandboxAgent = useMemo(
    () => hermesAgents.find((agent) => isSandboxName(`${agent.name} ${agent.title ?? ""}`)) ?? null,
    [hermesAgents],
  );
  const { data: hermesSandboxSkillSnapshot } = useQuery({
    queryKey: hermesSandboxAgent
      ? queryKeys.agents.skills(hermesSandboxAgent.id)
      : ["virtual-office", companyId, "hermes-sandbox-skills", "none"],
    queryFn: () => agentsApi.skills(hermesSandboxAgent!.id, companyId),
    enabled: Boolean(hermesSandboxAgent),
  });
  const hermesSandboxProject = sandboxProjects[0] ?? null;
  const hermesEnvironmentReady = hermesEnvironmentTest?.status === "pass";
  const canOpenHermesSandboxIssueDraft = Boolean(hermesEnvironmentReady && hermesSandboxAgent && hermesSandboxProject && hermesWakeupUserConfirmed);
  const hermesStarterSkillKeys = useMemo(
    () =>
      STARTER_SKILL_TEMPLATES
        .map((template) => visibleCompanySkillsByName.get(template.name)?.key)
        .filter((key): key is string => Boolean(key)),
    [visibleCompanySkillsByName],
  );
  const hermesSyncedStarterSkillCount = useMemo(() => {
    const desired = new Set(hermesSandboxSkillSnapshot?.desiredSkills ?? []);
    return hermesStarterSkillKeys.filter((key) => desired.has(key)).length;
  }, [hermesSandboxSkillSnapshot?.desiredSkills, hermesStarterSkillKeys]);
  const sandboxSkillSyncTestAgent = useMemo(
    () => activeAgents.find((agent) => `${agent.name} ${agent.title ?? ""}`.includes("Sandbox Skills Sync Test")) ?? null,
    [activeAgents],
  );
  const { data: sandboxSkillSyncTestSnapshot } = useQuery({
    queryKey: sandboxSkillSyncTestAgent
      ? queryKeys.agents.skills(sandboxSkillSyncTestAgent.id)
      : ["virtual-office", companyId, "sandbox-skill-sync-test-skills", "none"],
    queryFn: () => agentsApi.skills(sandboxSkillSyncTestAgent!.id, companyId),
    enabled: Boolean(sandboxSkillSyncTestAgent),
  });
  const sandboxSkillSyncReadOnlyCards = useMemo(() => {
    const desired = new Set(sandboxSkillSyncTestSnapshot?.desiredSkills ?? []);

    return STARTER_SKILL_TEMPLATES.map((template) => {
      const companySkill = visibleCompanySkillsByName.get(template.name);
      const synced = Boolean(companySkill?.key && desired.has(companySkill.key));

      return {
        name: template.name,
        key: companySkill?.key ?? "尚未建立",
        status: synced ? "已保存" : companySkill ? "未保存到測試員工" : "starter skill 未建立",
        synced,
      };
    });
  }, [sandboxSkillSyncTestSnapshot?.desiredSkills, visibleCompanySkillsByName]);
  const sandboxSkillSyncReadOnlyMatchedCount = sandboxSkillSyncReadOnlyCards.filter((card) => card.synced).length;
  const hermesRuntimeSkillLoadingCards = useMemo(() => {
    const adapterSupportsSkills = Boolean(hermesAdapter?.capabilities.supportsSkills);
    const starterSkillsReady = hermesStarterSkillKeys.length === STARTER_SKILL_TEMPLATES.length;
    const starterSkillsSynced = starterSkillsReady && hermesSyncedStarterSkillCount === hermesStarterSkillKeys.length;
    const sandboxReady = Boolean(hermesSandboxAgent && sandboxProjects.length > 0);
    const canStartRuntimeCheck = adapterSupportsSkills && starterSkillsSynced && sandboxReady;

    return [
      {
        label: "Adapter skills",
        status: adapterSupportsSkills ? "支援" : "待確認",
        value: hermesAdapter ? (adapterSupportsSkills ? "hermes_local 回報 supportsSkills" : "hermes_local 尚未回報 supportsSkills") : "尚未註冊 hermes_local",
        tone: adapterSupportsSkills ? "success" : "warn",
        detail: "先確認 adapter 本身明確支援 runtime skill loading，再讓本地模型接第一個測試任務。",
      },
      {
        label: "Starter skills",
        status: starterSkillsSynced ? "已同步" : "待同步",
        value: `${hermesSyncedStarterSkillCount} / ${hermesStarterSkillKeys.length} 已同步到 Hermes Sandbox`,
        tone: starterSkillsSynced ? "success" : "warn",
        detail: starterSkillsReady
          ? "三個 starter skills 已存在；還要確認它們已寫入 Hermes Sandbox 員工的 desired skills。"
          : "先補齊會議紀錄、需求分析與測試檢查三個 starter skills，再同步給 Hermes Sandbox 員工。",
      },
      {
        label: "Sandbox/Test",
        status: sandboxReady ? "可測" : "先準備",
        value: hermesSandboxAgent ? `${hermesSandboxAgent.name} / ${sandboxProjects[0]?.name ?? "尚未有 Sandbox 專案"}` : "尚未有 Hermes Sandbox 員工",
        tone: sandboxReady ? "success" : "warn",
        detail: "Runtime skill loading 只放在 Sandbox/Test issue 驗證，不掛正式專案、不修改正式資料。",
      },
      {
        label: "下一步",
        status: canStartRuntimeCheck ? "可驗收" : "先暫緩",
        value: canStartRuntimeCheck ? "可複製技能載入驗收" : "先補齊前面條件",
        tone: canStartRuntimeCheck ? "success" : "warn",
        detail: canStartRuntimeCheck
          ? "複製檢查清單中的技能載入驗收模板，貼到 Sandbox/Test issue 逐項記錄證據。"
          : "條件未齊前只看狀態與同步 skills，不喚醒 Hermes 或其它本地模型。",
      },
    ];
  }, [
    hermesAdapter,
    hermesSandboxAgent,
    hermesStarterSkillKeys.length,
    hermesSyncedStarterSkillCount,
    sandboxProjects,
  ]);
  const hermesRuntimeSkillLoadingDryRun = useMemo(() => {
    const desired = new Set(hermesSandboxSkillSnapshot?.desiredSkills ?? []);
    const rows = STARTER_SKILL_TEMPLATES.map((template) => {
      const companySkill = visibleCompanySkillsByName.get(template.name);
      const synced = Boolean(companySkill?.key && desired.has(companySkill.key));

      return {
        id: template.id,
        name: template.name,
        key: companySkill?.key ?? "尚未建立",
        status: synced ? "會進 payload" : companySkill ? "未同步到 Sandbox" : "缺公司技能",
        synced,
      };
    });
    const allSynced = rows.every((row) => row.synced);
    const adapterReady = Boolean(hermesAdapter?.capabilities.supportsSkills);
    const sandboxReady = Boolean(hermesSandboxAgent && hermesSandboxProject);
    const canBuildPayload = adapterReady && sandboxReady && allSynced;
    const blockers = [
      !adapterReady ? "adapter 尚未回報 supportsSkills" : null,
      !hermesSandboxAgent ? "缺 Hermes Sandbox 員工" : null,
      !hermesSandboxProject ? "缺 Sandbox/Test 專案" : null,
      ...rows.filter((row) => !row.synced).map((row) => `${row.name}: ${row.status}`),
    ].filter((item): item is string => Boolean(item));

    return {
      rows,
      blockers,
      canBuildPayload,
      status: canBuildPayload ? "可產生模擬 payload" : "仍有缺口",
      tone: canBuildPayload ? "success" : "warn",
      payloadPreview: {
        adapter: hermesAdapter?.type ?? "hermes_local",
        agent: hermesSandboxAgent?.name ?? "尚未建立",
        project: hermesSandboxProject?.name ?? "尚未建立",
        desiredSkills: rows.filter((row) => row.synced).map((row) => row.key),
        mode: "dry-run only, no issue, no Run now, no model wake",
      },
    };
  }, [
    hermesAdapter?.capabilities.supportsSkills,
    hermesAdapter?.type,
    hermesSandboxAgent,
    hermesSandboxProject,
    hermesSandboxSkillSnapshot?.desiredSkills,
    visibleCompanySkillsByName,
  ]);
  const hermesRuntimeSkillLoadingRepairSteps = useMemo(() => [
    {
      label: "1. 建立 Sandbox 員工草稿",
      status: hermesSandboxAgent ? "已準備" : "下一步",
      detail: hermesSandboxAgent
        ? `已找到 ${hermesSandboxAgent.name}，可以進入 skills 同步。`
        : "先開 Hermes Sandbox Engineer 草稿，確認 adapter 是 hermes_local，手動建立後再回來。",
    },
    {
      label: "2. 同步 starter skills",
      status: hermesSyncedStarterSkillCount === hermesStarterSkillKeys.length && hermesStarterSkillKeys.length > 0 ? "已同步" : "待同步",
      detail: hermesSandboxAgent
        ? "用預選 Hermes skills 打開技能精靈，確認後手動按同步技能。"
        : "等 Sandbox 員工存在後再同步，避免把 starter skills 裝到正式員工。",
    },
    {
      label: "3. 重跑 dry-run",
      status: hermesRuntimeSkillLoadingDryRun.canBuildPayload ? "可檢查" : "待補齊",
      detail: hermesRuntimeSkillLoadingDryRun.canBuildPayload
        ? "複製 dry-run，確認 payload 只含 Sandbox/Test 與 starter skills。"
        : "缺口補完後重新整理 Office，再看 dry-run 是否能組出 payload。",
    },
  ], [
    hermesRuntimeSkillLoadingDryRun.canBuildPayload,
    hermesSandboxAgent,
    hermesStarterSkillKeys.length,
    hermesSyncedStarterSkillCount,
  ]);
  const hermesStartReadinessCards = useMemo(() => {
    const adapterReady = Boolean(hermesAdapter && !hermesAdapter.disabled && hermesAdapter.capabilities.supportsSkills);
    const environmentReady = hermesEnvironmentReady;
    const sandboxAgentReady = Boolean(hermesSandboxAgent);
    const sandboxProjectReady = Boolean(hermesSandboxProject);
    const starterSkillsSynced = hermesStarterSkillKeys.length === STARTER_SKILL_TEMPLATES.length
      && hermesSyncedStarterSkillCount === hermesStarterSkillKeys.length;
    const allReady = adapterReady && environmentReady && sandboxAgentReady && sandboxProjectReady && starterSkillsSynced;

    return [
      {
        label: "預覽驗證",
        status: "需確認",
        value: "先跑 pnpm run office:verify",
        tone: "warn",
        detail: "開始設定或喚醒前，先確認 Backend OK / Frontend OK；office:verify 沒通過就先不要碰 Hermes。",
      },
      {
        label: "Adapter",
        status: adapterReady ? "可使用" : "先確認",
        value: hermesAdapter ? (hermesAdapter.capabilities.supportsSkills ? "hermes_local / skills OK" : "hermes_local / skills 待確認") : "尚未註冊 hermes_local",
        tone: adapterReady ? "success" : "warn",
        detail: "後端要能看到 hermes_local，且明確支援 skills，才進下一步。",
      },
      {
        label: "環境測試",
        status: environmentReady ? "通過" : "待設定",
        value: hermesEnvironmentTest?.status ?? "尚未通過",
        tone: environmentReady ? "success" : "warn",
        detail: environmentReady ? "Test environment 通過後，才可準備 Sandbox/Test issue。" : "先補 Hermes model、.env 或 API key；不要把憑證寫入 issue 或文件。",
      },
      {
        label: "沙盒資料",
        status: sandboxAgentReady && sandboxProjectReady ? "已準備" : "先準備",
        value: `${hermesSandboxAgent?.name ?? "缺 Hermes Sandbox 員工"} / ${hermesSandboxProject?.name ?? "缺 Sandbox/Test 專案"}`,
        tone: sandboxAgentReady && sandboxProjectReady ? "success" : "warn",
        detail: "第一次測試只掛 Sandbox/Test 員工與專案，不使用正式專案。",
      },
      {
        label: "Starter skills",
        status: starterSkillsSynced ? "已同步" : "待同步",
        value: `${hermesSyncedStarterSkillCount} / ${hermesStarterSkillKeys.length} 已同步`,
        tone: starterSkillsSynced ? "success" : "warn",
        detail: "先把會議紀錄、需求分析與測試檢查同步到 Hermes Sandbox 員工，再看 runtime skill loading。",
      },
      {
        label: "總判斷",
        status: allReady && hermesWakeupUserConfirmed ? "可以開始沙盒" : "先暫緩",
        value: allReady
          ? hermesWakeupUserConfirmed
            ? "可用 Sandbox/Test issue 做第一次喚醒"
            : "等待使用者手動確認"
          : "只做設定與檢查，不喚醒模型",
        tone: allReady && hermesWakeupUserConfirmed ? "success" : "warn",
        detail: allReady
          ? hermesWakeupUserConfirmed
            ? "仍只用沙盒任務，完成後回到喚醒後檢查面板覆盤。"
            : "全部條件通過後仍要由使用者勾選確認，才可預填第一次喚醒 issue。"
          : "任一條件未齊前，不建立喚醒 issue、不 Run now、不接正式工作。",
      },
    ];
  }, [
    hermesAdapter,
    hermesEnvironmentReady,
    hermesEnvironmentTest?.status,
    hermesSandboxAgent,
    hermesSandboxProject,
    hermesStarterSkillKeys.length,
    hermesSyncedStarterSkillCount,
    hermesWakeupUserConfirmed,
  ]);
  const hermesInstallRiskCards = useMemo(() => {
    const checks = hermesEnvironmentTest?.checks ?? [];
    const bridgeCheck = checks.find((check) => check.code === "hermes_version")
      ?? checks.find((check) => check.code === "hermes_windows_wsl_bridge")
      ?? checks.find((check) => check.code === "hermes_cli_not_found");
    const bridgeReady = Boolean(checks.some((check) => check.code === "hermes_version" || check.code === "hermes_windows_wsl_bridge"));
    const credentialMissing = checks.some((check) =>
      check.code === "hermes_model_missing" ||
      check.code === "hermes_env_missing" ||
      check.code === "hermes_api_key_missing"
    );
    const credentialReady = hermesEnvironmentReady && !credentialMissing;
    const sandboxBoundaryReady = Boolean(hermesSandboxAgent && hermesSandboxProject);

    return [
      {
        label: "預覽驗證",
        status: "先確認",
        value: "pnpm run office:verify",
        tone: "warn",
        detail: "安裝、設定或測試 Hermes 前，先確認 Backend OK / Frontend OK；沒通過就先修預覽。",
      },
      {
        label: "Bridge / CLI",
        status: bridgeReady ? "可呼叫" : "待確認",
        value: bridgeCheck?.message ?? "尚未看到 Hermes bridge 或 CLI 回應",
        tone: bridgeReady ? "success" : "warn",
        detail: bridgeReady
          ? "Windows 端已能透過 bridge 看到 Hermes；下一步只處理模型設定與沙盒驗收。"
          : "先只檢查 WSL2/Ubuntu 與 bridge，不要建立 Hermes 任務。",
      },
      {
        label: "模型與憑證",
        status: credentialReady ? "已通過" : "先暫緩",
        value: credentialReady ? "Test environment pass" : "model / .env / API key 尚未完整",
        tone: credentialReady ? "success" : "warn",
        detail: credentialReady
          ? "仍不要把憑證貼進聊天、文件、prompt、skills 或 issue。"
          : "可以準備 provider 與 model，但 API key 只放在 Hermes 自己的安全設定裡。",
      },
      {
        label: "沙盒邊界",
        status: sandboxBoundaryReady ? "已準備" : "先準備",
        value: `${hermesSandboxAgent?.name ?? "缺 Hermes Sandbox 員工"} / ${hermesSandboxProject?.name ?? "缺 Sandbox/Test 專案"}`,
        tone: sandboxBoundaryReady ? "success" : "warn",
        detail: "第一次只用 Sandbox/Test 員工與專案；正式專案、Run now、schedule trigger 都先不碰。",
      },
      {
        label: "跨線授權",
        status: "需使用者貼出",
        value: "複製安裝授權後再開始",
        tone: "warn",
        detail: "真正安裝或設定前，使用者要貼出授權文字；沒有授權就只做檢查與說明。",
      },
    ];
  }, [
    hermesEnvironmentReady,
    hermesEnvironmentTest?.checks,
    hermesSandboxAgent,
    hermesSandboxProject,
  ]);
  const hermesInstallNextSafeStep = useMemo(() => {
    const checks = hermesEnvironmentTest?.checks ?? [];
    const bridgeReady = checks.some((check) => check.code === "hermes_version" || check.code === "hermes_windows_wsl_bridge");
    const credentialMissing = checks.some((check) =>
      check.code === "hermes_model_missing" ||
      check.code === "hermes_env_missing" ||
      check.code === "hermes_api_key_missing"
    );
    const credentialReady = hermesEnvironmentReady && !credentialMissing;
    const sandboxBoundaryReady = Boolean(hermesSandboxAgent && hermesSandboxProject);

    if (!bridgeReady) {
      return {
        label: "下一個安全動作",
        status: "只檢查 bridge",
        value: "確認 WSL2/Ubuntu 與 scripts/hermes-wsl.cmd",
        detail: "先讓 Windows 端能看到 Hermes CLI；不要填憑證、不要建立任務、不要喚醒模型。",
      };
    }

    if (!credentialReady) {
      return {
        label: "下一個安全動作",
        status: "只設定模型",
        value: "補 Hermes model / .env / provider",
        detail: "只在 Hermes 自己的設定流程處理 API key；不要貼到聊天、文件、prompt、skills 或 issue。",
      };
    }

    if (!sandboxBoundaryReady) {
      return {
        label: "下一個安全動作",
        status: "只準備沙盒",
        value: "建立 Hermes Sandbox 員工與 Sandbox/Test 專案",
        detail: "只做草稿或測試資料；不要把 Hermes 放到正式專案主管或正式工作流。",
      };
    }

    return {
      label: "下一個安全動作",
      status: "等待授權",
      value: "複製安裝授權並由使用者貼出",
      detail: "所有前置條件看起來可進下一步；仍需明確授權，才可跨過安裝或設定線。",
    };
  }, [
    hermesEnvironmentReady,
    hermesEnvironmentTest?.checks,
    hermesSandboxAgent,
    hermesSandboxProject,
  ]);
  const hermesFormalLeadProjects = useMemo(
    () => activeProjects.filter((project) => hermesSandboxAgent && project.leadAgentId === hermesSandboxAgent.id && !isSandboxName(`${project.name} ${project.description ?? ""}`)),
    [activeProjects, hermesSandboxAgent],
  );
  const hermesPostCreateCards = useMemo(
    () => [
      {
        label: "Sandbox 員工",
        status: hermesSandboxAgent ? "已建立" : "先建立",
        value: hermesSandboxAgent?.name ?? "尚未找到 Hermes Sandbox 員工",
        tone: hermesSandboxAgent ? "success" : "warn",
        detail: hermesSandboxAgent
          ? "已找到 hermes_local 測試員工；建立後先同步 skills 與跑環境測試，不直接接正式任務。"
          : "按建立 Hermes 草稿，確認內容後再 Create agent。",
      },
      {
        label: "Starter skills",
        status: hermesStarterSkillKeys.length > 0 && hermesSyncedStarterSkillCount === hermesStarterSkillKeys.length ? "已同步" : "待同步",
        value: `${hermesSyncedStarterSkillCount} / ${hermesStarterSkillKeys.length} 已同步`,
        tone: hermesStarterSkillKeys.length > 0 && hermesSyncedStarterSkillCount === hermesStarterSkillKeys.length ? "success" : "warn",
        detail: hermesStarterSkillKeys.length === 0
          ? "先補齊 starter skills，再同步到 Hermes Sandbox 員工。"
          : "用預選按鈕打開技能視窗，最後仍需手動按同步技能。",
      },
      {
        label: "正式主管",
        status: hermesFormalLeadProjects.length === 0 ? "安全" : "需移除",
        value: hermesFormalLeadProjects.length === 0 ? "未管理正式專案" : hermesFormalLeadProjects.map((project) => project.name).join("、"),
        tone: hermesFormalLeadProjects.length === 0 ? "success" : "warn",
        detail: hermesFormalLeadProjects.length === 0
          ? "第一次喚醒前不讓 Hermes Sandbox 員工管理正式專案。"
          : "先移除正式專案主管設定，再做沙盒喚醒。",
      },
      {
        label: "環境測試",
        status: hermesEnvironmentReady ? "已通過" : "待通過",
        value: hermesEnvironmentTest?.status ?? "尚未通過",
        tone: hermesEnvironmentReady ? "success" : "warn",
        detail: hermesEnvironmentReady
          ? "可以準備 Sandbox issue 草稿，仍不要自動喚醒。"
          : "先設定 Hermes model/.env/API key，回 Office 按重新檢查。",
      },
    ],
    [
      hermesEnvironmentReady,
      hermesEnvironmentTest?.status,
      hermesFormalLeadProjects,
      hermesSandboxAgent,
      hermesStarterSkillKeys.length,
      hermesSyncedStarterSkillCount,
    ],
  );
  const hermesAgentIds = useMemo(() => new Set(hermesAgents.map((agent) => agent.id)), [hermesAgents]);
  const hermesWakeReviewCards = useMemo(() => {
    const hermesRiskAgents = hermesAgents.filter((agent) => agent.status === "running" || agent.status === "error");
    const hermesLiveRuns = (companyLiveRuns ?? []).filter(
      (run) => hermesAgentIds.has(run.agentId) && (run.status === "queued" || run.status === "running"),
    );
    const recoveryIssues = issues.filter(isSystemRecoveryIssue);
    const hermesSandboxIssues = issues
      .filter((issue) =>
        !isSystemRecoveryIssue(issue) &&
        (
          /hermes sandbox|sandbox first wake|first wake-up/i.test(`${issue.title} ${issue.description ?? ""}`) ||
          (issue.assigneeAgentId ? hermesAgentIds.has(issue.assigneeAgentId) : false)
        ),
      )
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    return [
      {
        label: "Hermes 員工狀態",
        status: hermesRiskAgents.length === 0 ? "乾淨" : "需處理",
        value: hermesRiskAgents.length === 0 ? "沒有 running/error" : hermesRiskAgents.map((agent) => `${agent.name}（${agent.status}）`).join("、"),
        detail: hermesRiskAgents.length === 0
          ? "第一次喚醒後也要回來確認這裡仍是乾淨狀態。"
          : "先不要開下一個任務；確認 Hermes 是否卡住、錯誤或需要手動暫停。",
      },
      {
        label: "Hermes 舊工作",
        status: hermesLiveRuns.length === 0 ? "乾淨" : "執行中",
        value: hermesLiveRuns.length === 0 ? "沒有 queued/running" : `${hermesLiveRuns.length} 個工作`,
        detail: hermesLiveRuns.length === 0
          ? "沒有 Hermes live run 排隊或執行。"
          : "等工作結束，或在確認是沙盒資料後再取消，不要連續重複喚醒。",
      },
      {
        label: "Recovery issues",
        status: recoveryIssues.length === 0 ? "乾淨" : "需覆盤",
        value: recoveryIssues.length === 0 ? "0 個" : `${recoveryIssues.length} 個`,
        detail: recoveryIssues.length === 0
          ? "目前沒有系統復原任務干擾判讀。"
          : "若喚醒後增加 recovery issues，先記錄原因，不要直接進正式任務。",
      },
      {
        label: "覆盤紀錄",
        status: hermesSandboxIssues.length > 0 ? "可查看" : "待建立",
        value: hermesSandboxIssues[0]?.title ?? "尚無 Hermes Sandbox issue",
        detail: hermesSandboxIssues.length > 0
          ? "打開最近的 Hermes Sandbox issue，確認回覆是否可讀、可覆盤、沒有洩漏憑證。"
          : "通過前置門檻後，先建立 Sandbox issue，再做第一次喚醒。",
      },
    ];
  }, [companyLiveRuns, hermesAgentIds, hermesAgents, issues]);
  const hermesAuthorizationControlCards = useMemo(() => {
    const commandPreviewReady = true;
    const installCompanionReady = true;
    const configurationCheckReady = Boolean(hermesEnvironmentTest);
    const sandboxPreflightReady = canOpenHermesSandboxIssueDraft;
    const postWakeupClean = hermesWakeReviewCards.every((card) => card.status === "乾淨" || card.status === "可查看");

    return [
      {
        level: "0",
        title: "只讀準備",
        status: "可做",
        tone: "success",
        detail: "可跑 office:verify、讀 SOP、複製交接包與檢查包；仍不安裝、不設定、不喚醒。",
      },
      {
        level: "1",
        title: "命令預覽",
        status: commandPreviewReady ? "可複製" : "先準備",
        tone: commandPreviewReady ? "success" : "warn",
        detail: "只允許列命令表；任何寫檔、下載、改設定、憑證、Run now 或喚醒都標成 PAUSE。",
      },
      {
        level: "2",
        title: "安裝陪同",
        status: installCompanionReady ? "需明確授權" : "先準備",
        tone: "warn",
        detail: "只有使用者明確授權且逐條同意後才可執行命令；不包含填憑證、Run now 或喚醒。",
      },
      {
        level: "3",
        title: "設定檢查",
        status: configurationCheckReady ? "可檢查" : "待回報",
        tone: configurationCheckReady ? "success" : "warn",
        detail: configurationCheckReady
          ? "只看非敏感狀態與 Test environment；API key、token、密碼與完整 .env 不貼出。"
          : "等使用者在 Hermes 自己的設定位置完成 provider/model/API key 後，只回報非敏感狀態。",
      },
      {
        level: "4",
        title: "沙盒喚醒",
        status: sandboxPreflightReady ? "可預填草稿" : "先暫緩",
        tone: sandboxPreflightReady ? "success" : "warn",
        detail: sandboxPreflightReady
          ? "只能預填 Sandbox/Test issue 草稿；最後建立與喚醒仍由使用者手動確認。"
          : "Test environment、Sandbox 員工、Sandbox/Test 專案與使用者確認未全過前，不建立 issue、不 Run now。",
      },
      {
        level: "後",
        title: "喚醒後覆盤",
        status: postWakeupClean ? "訊號乾淨" : "需覆盤",
        tone: postWakeupClean ? "success" : "warn",
        detail: postWakeupClean
          ? "若真測後仍乾淨，才考慮下一個 Sandbox/Test 任務。"
          : "若有 running/error、live run 殘留或 recovery issues，先停下，不進正式專案。",
      },
    ];
  }, [canOpenHermesSandboxIssueDraft, hermesEnvironmentTest, hermesWakeReviewCards]);
  const nextE2eBatch = useMemo(() => {
    if (sandboxAgents.length === 0 || sandboxProjects.length === 0) return ACCEPTANCE_TEST_BATCHES[0]!;
    if (missingStarterSkillTemplates.length > 0) return ACCEPTANCE_TEST_BATCHES[1]!;
    if (workflowWakeRiskAgents.length > 0 || workflowWakeRiskRuns.length > 0) return ACCEPTANCE_TEST_BATCHES[0]!;
    if (reviewThreadCount === 0) return ACCEPTANCE_TEST_BATCHES[4]!;
    return ACCEPTANCE_TEST_BATCHES[3]!;
  }, [missingStarterSkillTemplates.length, reviewThreadCount, sandboxAgents.length, sandboxProjects.length, workflowWakeRiskAgents.length, workflowWakeRiskRuns.length]);

  const { data: selectedAgentSkillSnapshot } = useQuery({
    queryKey: skillAgentId ? queryKeys.agents.skills(skillAgentId) : ["agents", "skills", "none"],
    queryFn: () => agentsApi.skills(skillAgentId, companyId),
    enabled: skillOpen && Boolean(skillAgentId),
  });

  useEffect(() => {
    if (!skillOpen) return;
    if (skillAgentId || activeAgents.length === 0) return;
    setSkillAgentId(activeAgents[0]!.id);
  }, [activeAgents, skillAgentId, skillOpen]);

  useEffect(() => {
    if (!skillOpen || !selectedAgentSkillSnapshot) return;
    setSelectedSkillKeys(selectedAgentSkillSnapshot.desiredSkills);
  }, [selectedAgentSkillSnapshot, skillOpen]);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(onboardingStorageKey);
      setReviewedStepIds(saved ? JSON.parse(saved) : []);
    } catch {
      setReviewedStepIds([]);
    }
    setLoadedOnboardingStorageKey(onboardingStorageKey);
  }, [onboardingStorageKey]);

  useEffect(() => {
    if (loadedOnboardingStorageKey !== onboardingStorageKey) return;
    try {
      window.localStorage.setItem(onboardingStorageKey, JSON.stringify(reviewedStepIds));
    } catch {
      // localStorage is a convenience only; the checklist still works without it.
    }
  }, [loadedOnboardingStorageKey, onboardingStorageKey, reviewedStepIds]);

  function selectedPhaseAssignee(phase: StarterPhase, index: number): Agent | null {
    const selectedId = phaseAssignees[phase.title];
    if (selectedId && selectedId !== "auto") {
      return activeAgents.find((agent) => agent.id === selectedId) ?? null;
    }
    return bestAgentForPhase(activeAgents, phase, index);
  }

  const createWorkflow = useMutation({
    mutationFn: async () => {
      const selectedLead = workflowLead;

      const project = await projectsApi.create(companyId, {
        name: projectName.trim(),
        description: projectDescription.trim() || undefined,
        status: "planned",
        color: "#3b82f6",
        ...(selectedLead ? { leadAgentId: selectedLead.id } : {}),
      });

      const createdIssues: Issue[] = [];
      for (const [index, phase] of STARTER_PHASES.entries()) {
        const assignee = selectedPhaseAssignee(phase, index);
        const previousIssue = createdIssues[index - 1];
        const parallelBlockers =
          workflowShape === "parallel" && index > 0
            ? (index === STARTER_PHASES.length - 1 ? createdIssues : createdIssues.slice(0, 1)).map((issue) => issue.id)
            : [];
        const blockedByIssueIds =
          workflowShape === "serial" && previousIssue
            ? [previousIssue.id]
            : parallelBlockers;

        const issue = await issuesApi.create(companyId, {
          projectId: project.id,
          title: `${phase.title}: ${project.name}`,
          description: `${phase.description}\n\n專案主管：${selectedLead?.name ?? "未指定"}\n工作流：${workflowShape === "serial" ? "上下游順序" : "平行單位協作"}`,
          status: index === 0 ? "todo" : "backlog",
          priority: "medium",
          ...(assignee ? { assigneeAgentId: assignee.id } : {}),
          ...(blockedByIssueIds.length > 0 ? { blockedByIssueIds } : {}),
        });
        createdIssues.push(issue);
      }

      return project;
    },
    onSuccess: async (project) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(companyId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(project.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) }),
      ]);
      setWorkflowOpen(false);
      pushToast({
        title: "已建立專案工作流",
        body: `${project.name} 已建立五個階段任務，可以開始指派與追蹤。`,
        tone: "success",
        action: { label: "開啟專案", href: `/projects/${projectRouteRef(project)}` },
      });
      navigate(`/projects/${projectRouteRef(project)}`);
    },
  });

  const createMeeting = useMutation({
    mutationFn: async () => {
      const facilitator =
        meetingFacilitatorId === "auto"
          ? activeAgents.find((agent) => /lead|manager|pm|主管|專案/i.test(`${agent.title ?? ""} ${agent.capabilities ?? ""}`))
            ?? activeAgents[0]
          : activeAgents.find((agent) => agent.id === meetingFacilitatorId);
      const selectedProject =
        meetingProjectId === "none"
          ? null
          : activeProjects.find((project) => project.id === meetingProjectId) ?? null;
      const participants = meetingParticipants;
      const participantNames = participants.length > 0
        ? participants.map((agent) => agent.name).join("、")
        : "未指定";
      const userDecisionSection = meetingNeedsUserDecision
        ? [
            "",
            "## 使用者介入規則",
            meetingUserDecisionNote.trim() || "遇到需要使用者決定的問題時，請先整理選項、風險與建議，再等待使用者回覆。",
            "",
            "員工討論時請把需要使用者決定的問題集中列在 `需要使用者介入` 區塊，方便使用者補充或拍板。",
          ]
        : [
            "",
            "## 使用者介入規則",
            "本次會議先由員工自行討論；若出現無法判斷的風險，再標記需要使用者介入。",
          ];

      return issuesApi.create(companyId, {
        title: `討論會議: ${meetingTitle.trim()}`,
        description: [
          meetingAgenda.trim(),
          "",
          `主持人：${facilitator?.name ?? "未指定"}`,
          `參與者：${participantNames}`,
          selectedProject ? `關聯專案：${selectedProject.name}` : "關聯專案：未指定",
          "",
          "請在這個任務串中留下討論過程、決策理由、待確認問題與下一步。",
          ...userDecisionSection,
          "",
          selectedMeetingTemplate.body,
        ].join("\n"),
        status: "todo",
        priority: "medium",
        ...(selectedProject ? { projectId: selectedProject.id } : {}),
        ...(facilitator ? { assigneeAgentId: facilitator.id } : {}),
      });
    },
    onSuccess: async (issue) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
      setMeetingOpen(false);
      pushToast({
        title: "已建立討論會議",
        body: "會議任務已建立，可以讓員工在同一串留下討論與結論。",
        tone: "success",
        action: { label: "開啟會議", href: `/issues/${issue.id}` },
      });
      navigate(`/issues/${issue.id}`);
    },
  });

  const syncSelectedAgentSkills = useMutation({
    mutationFn: async () => {
      if (!skillAgentId) throw new Error("No agent selected");
      return agentsApi.syncSkills(skillAgentId, selectedSkillKeys, companyId);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.skills(skillAgentId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(skillAgentId) }),
      ]);
      const agent = activeAgents.find((entry) => entry.id === skillAgentId);
      setSkillOpen(false);
      pushToast({
        title: "已更新員工技能",
        body: `${agent?.name ?? "員工"} 的技能配置已同步。`,
        tone: "success",
        action: agent ? { label: "查看員工", href: `/agents/${agentRouteRef(agent)}` } : undefined,
      });
    },
  });

  const pauseCleanWorkflowAgents = useMutation({
    mutationFn: async () => {
      const selectedIds = new Set(cleanWorkflowPauseAgentIds);
      const selectedRunIds = new Set(cleanWorkflowCancelRunIds);
      const selectedAgents = workflowWakeRiskAgents.filter((agent) => selectedIds.has(agent.id));
      const selectedRuns = workflowWakeRiskRuns.filter((run) => selectedRunIds.has(run.id));
      if (selectedAgents.length === 0 && selectedRuns.length === 0) throw new Error("No agents or runs selected");
      await Promise.all([
        ...selectedAgents.map((agent) => agentsApi.pause(agent.id, companyId)),
        ...selectedRuns.map((run) => heartbeatsApi.cancel(run.id)),
      ]);
      return { selectedAgents, selectedRuns };
    },
    onSuccess: async ({ selectedAgents, selectedRuns }) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.liveRuns(companyId) });
      await Promise.all(selectedAgents.map((agent) => queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) })));
      setCleanWorkflowOpen(false);
      setCleanWorkflowPauseConfirm(false);
      setCleanWorkflowCancelRunIds([]);
      pushToast({
        title: "已處理乾淨驗收風險",
        body: [
          selectedAgents.length > 0 ? `${selectedAgents.map((agent) => agent.name).join("、")} 已暫停` : null,
          selectedRuns.length > 0 ? `${selectedRuns.length} 個舊工作已取消` : null,
        ].filter(Boolean).join("；") || "已處理乾淨驗收風險。",
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "暫停員工失敗",
        body: error instanceof Error ? error.message : "請先保留目前狀態，稍後再試。",
        tone: "error",
      });
    },
  });

  const createStarterSkill = useMutation({
    mutationFn: (template: StarterSkillTemplate) =>
      companySkillsApi.create(companyId, {
        name: template.name,
        slug: template.id,
        description: template.description,
        markdown: template.markdown,
      }),
    onSuccess: async (skill) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(companyId) });
      setSelectedSkillKeys((current) => [...new Set([...current, skill.key])]);
      setStarterSkillNotice(`${skill.name} 已建立並勾選。下一步按「同步技能」即可配置給目前員工。`);
      pushToast({
        title: "已建立 starter skill",
        body: `${skill.name} 已加入公司技能庫，可以配置給員工。`,
        tone: "success",
        action: { label: "查看技能", href: `/skills/${skill.id}` },
      });
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectName.trim() || createWorkflow.isPending) return;
    if (workflowRequiresWakeRiskConfirmation && !workflowWakeRiskConfirmed) {
      pushToast({
        title: "請先確認自動喚醒風險",
        body: "目前有執行中或錯誤狀態的員工。建立工作流前，請先勾選風險確認，避免 recovery 任務干擾驗收。",
        tone: "warn",
      });
      return;
    }
    createWorkflow.mutate();
  }

  function handleMeetingSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!meetingTitle.trim() || createMeeting.isPending) return;
    createMeeting.mutate();
  }

  function toggleMeetingParticipant(agentId: string, checked: boolean) {
    setMeetingParticipantIds((current) =>
      checked ? [...new Set([...current, agentId])] : current.filter((id) => id !== agentId),
    );
  }

  function toggleSelectedSkill(key: string, checked: boolean) {
    setSelectedSkillKeys((current) =>
      checked ? [...new Set([...current, key])] : current.filter((value) => value !== key),
    );
  }

  function applySkillProfile(profile: "pm" | "engineering" | "quality") {
    const matchingKeys = visibleCompanySkills
      .filter((skill) => skillMatchesProfile(skill, profile))
      .map((skill) => skill.key);
    setSelectedSkillKeys((current) => [...new Set([...current, ...matchingKeys])]);
  }

  function handleStarterSkillTemplate(template: StarterSkillTemplate) {
    const existingSkill = visibleCompanySkillsByName.get(template.name);
    if (existingSkill) {
      setSelectedSkillKeys((current) => [...new Set([...current, existingSkill.key])]);
      setStarterSkillNotice(`${existingSkill.name} 已在技能庫中，並已幫你勾選。下一步按「同步技能」。`);
      return;
    }
    createStarterSkill.mutate(template);
  }

  function selectReadyStarterSkills() {
    const keys = readyStarterSkillTemplates
      .map((template) => visibleCompanySkillsByName.get(template.name)?.key)
      .filter((key): key is string => Boolean(key));
    setSelectedSkillKeys((current) => [...new Set([...current, ...keys])]);
    setStarterSkillNotice(
      keys.length > 0
        ? `已勾選 ${keys.length} 個已存在的 starter skills。下一步按「同步技能」。`
        : "目前還沒有可勾選的 starter skills，請先預覽並建立缺少項目。",
    );
  }

  function prepareHermesSkillSync() {
    if (!hermesSandboxAgent) {
      pushToast({
        title: "先建立 Hermes Sandbox 員工",
        body: "建立後才能把 starter skills 預選到這位本地模型員工身上。",
        tone: "warn",
      });
      return;
    }
    if (hermesStarterSkillKeys.length === 0) {
      pushToast({
        title: "starter skills 尚未準備",
        body: "請先建立會議紀錄、需求分析與測試檢查三個 starter skills，再回來同步給 Hermes。",
        tone: "warn",
      });
      return;
    }

    setSkillAgentId(hermesSandboxAgent.id);
    setSelectedSkillKeys((current) => [...new Set([...current, ...hermesStarterSkillKeys])]);
    setStarterSkillNotice("已預選 Hermes Sandbox starter skills。請最後手動按「同步技能」，確認後才會寫入。");
    setSkillOpen(true);
  }

  function openRoleDraft(template: AgencyRoleTemplate) {
    const params = new URLSearchParams({
      source: "virtual-office-role",
      template: template.name,
      name: template.suggestedName,
      title: template.suggestedTitle,
      role: template.suggestedRole,
      starterSkills: template.starterSkills.join(","),
      promptTemplate: roleTemplatePrompt(template),
    });
    setPreviewRoleTemplate(null);
    setSkillOpen(false);
    navigate(`/agents/new?${params.toString()}`);
  }

  function openSandboxAgentDraft() {
    const params = new URLSearchParams({
      source: "virtual-office-role",
      template: "E2E Sandbox PM",
      name: "Sandbox PM",
      title: "Virtual Office Sandbox PM",
      role: "pm",
      starterSkills: STARTER_SKILL_TEMPLATES.map((template) => template.name).join(","),
      promptTemplate: [
        "你是 Virtual Office 的端到端驗收 PM，只能使用 Sandbox 或 Test 相關資料。",
        "你的任務是協助新手檢查技能、工作流、會議與覆盤是否符合設計。",
        "遇到正式資料、刪除、停用或不確定決策時，先整理風險並等待使用者確認。",
      ].join("\n"),
    });
    navigate(`/agents/new?${params.toString()}`);
  }

  function openHermesAgentDraft() {
    const params = new URLSearchParams({
      source: "virtual-office-role",
      template: HERMES_SANDBOX_AGENT_DRAFT.template,
      name: HERMES_SANDBOX_AGENT_DRAFT.name,
      title: HERMES_SANDBOX_AGENT_DRAFT.title,
      role: HERMES_SANDBOX_AGENT_DRAFT.role,
      adapterType: HERMES_SANDBOX_AGENT_DRAFT.adapterType,
      command: HERMES_SANDBOX_AGENT_DRAFT.command,
      starterSkills: STARTER_SKILL_TEMPLATES.map((template) => template.name).join(","),
      promptTemplate: HERMES_SANDBOX_AGENT_DRAFT.promptLines.join("\n"),
    });
    navigate(`/agents/new?${params.toString()}`);
  }

  function openHermesSandboxIssueDraft() {
    if (!hermesEnvironmentReady) {
      pushToast({
        title: "Hermes 尚未可喚醒",
        body: "先完成 model、.env 與 API key 設定，並按重新檢查通過後，再建立沙盒 issue 草稿。",
        tone: "warn",
      });
      return;
    }
    if (!hermesSandboxAgent) {
      pushToast({
        title: "缺少 Hermes Sandbox 員工",
        body: "請先建立名稱含 Sandbox/Test 的 Hermes 員工草稿，並確認 adapter 是 hermes_local。",
        tone: "warn",
      });
      return;
    }
    if (!hermesSandboxProject) {
      pushToast({
        title: "缺少 Sandbox/Test 專案",
        body: "請先建立測試專案，避免第一次 Hermes 喚醒掛到正式資料。",
        tone: "warn",
      });
      return;
    }

    openNewIssue({
      title: "Hermes Sandbox First Wake-up",
      description: HERMES_SANDBOX_WAKEUP_TEMPLATE.join("\n"),
      status: "todo",
      priority: "medium",
      projectId: hermesSandboxProject.id,
      assigneeAgentId: hermesSandboxAgent.id,
    });
  }

  function buildHermesSecondSandboxIssueTemplate() {
    return [
      "## Hermes Sandbox Second Controlled Check",
      "",
      "這是第二個 Sandbox/Test 任務草稿。這張 issue 只用來準備下一次受控測試，不代表喚醒授權。",
      "",
      "### 任務目的",
      "1. 只測一件小事：請 Hermes Sandbox Engineer 讀取這張 issue，回覆可用 skills、受控邊界與下一步建議。",
      "2. 確認第二次 Sandbox/Test 仍可留下可覆盤留言。",
      "3. 確認沒有碰正式專案、正式資料、排程或連續喚醒。",
      "",
      "### 安全邊界",
      "- 不 Run now。",
      "- 不啟用 schedule trigger。",
      "- 不打開 heartbeat scheduler。",
      "- 不接正式專案、不處理正式資料。",
      "- 不讀取、要求或回覆 API key、token、密碼、完整 .env 或私人 URL。",
      "- 不沿用 AI-97978 的一次性喚醒授權；若要真的喚醒，必須重新取得使用者逐字授權。",
      "",
      "### 建立前檢查",
      "- [ ] Backend OK / Frontend OK。",
      "- [ ] Hermes Sandbox Engineer 仍是 Sandbox/Test 員工。",
      "- [ ] Sandbox/Test 專案存在且沒有正式資料。",
      "- [ ] 沒有 queued/running Hermes runs。",
      "- [ ] 沒有 recovery issue 或 blocker。",
      "- [ ] 使用者知道建立 issue 不是喚醒授權。",
      "",
      "### Hermes 若未來被授權喚醒，只能回覆",
      "- 可用 skills 清單。",
      "- 本次是否仍符合 Sandbox/Test 邊界。",
      "- 下一個最小安全步驟。",
      "- 若遇到正式資料、密鑰、排程、連續喚醒或不明指令，回覆 PAUSE 並停下。",
      "",
      "### 停手線",
      "- 建立這張 issue 後先停下覆盤。",
      "- 沒有新的逐字授權前，不喚醒 Hermes。",
    ].join("\n");
  }

  function openHermesSecondSandboxIssueDraft() {
    if (!canOpenHermesSandboxIssueDraft) {
      pushToast({
        title: "第二沙盒 issue 還不能預填",
        body: "請先確認環境、Hermes Sandbox 員工、Sandbox/Test 專案與使用者確認都通過；這個入口只建立草稿，不喚醒 Hermes。",
        tone: "warn",
      });
      return;
    }

    openNewIssue({
      title: "Hermes Sandbox Second Controlled Check",
      description: buildHermesSecondSandboxIssueTemplate(),
      status: "todo",
      priority: "medium",
      projectId: hermesSandboxProject!.id,
      assigneeAgentId: hermesSandboxAgent!.id,
    });
  }

  function openSandboxWorkflowDraft() {
    setProjectName("Virtual Office Sandbox");
    setProjectDescription("端到端驗收專用測試專案。只用來檢查測試員工、starter skills、五階段工作流、會議與覆盤紀錄。");
    setLeadAgentId(sandboxAgents[0]?.id ?? "auto");
    setWorkflowShape("serial");
    setWorkflowOpen(true);
  }

  function openSandboxMeetingDraft() {
    setMeetingTitle("Virtual Office Sandbox Review");
    setMeetingAgenda("請用端到端驗收格式覆盤：測試範圍、實際完成、卡住位置、需要使用者決定的問題與下一步。");
    setMeetingProjectId(sandboxProjects[0]?.id ?? "none");
    setMeetingFacilitatorId(sandboxAgents[0]?.id ?? "auto");
    setMeetingParticipantIds(sandboxAgents.map((agent) => agent.id));
    setMeetingTemplateId("review");
    setMeetingNeedsUserDecision(true);
    setMeetingUserDecisionNote("如果驗收牽涉正式資料、停用員工、清理測試資料或是否接 Hermes，本次會議必須先等使用者確認。");
    setMeetingOpen(true);
  }

  async function copySandboxDraftMarkdown() {
    const lines = [
      "## Virtual Office 沙盒資料包",
      "",
      "- 測試員工：Sandbox PM",
      "- 測試專案：Virtual Office Sandbox",
      "- 測試會議：Virtual Office Sandbox Review",
      `- starter skills：${STARTER_SKILL_TEMPLATES.map((template) => template.name).join("、")}`,
      "",
      "### 操作順序",
      "1. 建立測試員工草稿，確認名稱含 Sandbox。",
      "2. 補齊 starter skills，再同步到測試員工。",
      "3. 建立 Virtual Office Sandbox 工作流，只產生一個測試專案。",
      "4. 建立 Sandbox Review 覆盤會議，確認使用者介入規則。",
      "5. 重新整理畫面，確認端到端驗收控制台顯示可驗收。",
      "",
      "### 暫停規則",
      "- 不用正式員工測停用。",
      "- 不把測試會議掛到正式專案。",
      "- 如果建立後看不到資料，不連續重按，先記錄畫面與錯誤訊息。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製沙盒資料包",
        body: "測試員工、測試專案與測試會議規格已放到剪貼簿。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從檢查清單複製。",
        tone: "warn",
      });
    }
  }

  async function copySandboxSuccessExampleMarkdown() {
    const lines = [
      "## Virtual Office 沙盒成功範例：AI-98533",
      "",
      "這是一個普通 Sandbox/Test 任務成功走完整個安全流程的範例。",
      "",
      "### 情境",
      "- 任務：晨間財經新聞 AI 團隊方案設計",
      "- issue：AI-98533",
      "- 員工：Eve / Hermes local",
      "- 目標：只產出方案設計 comment，不處理真實投資建議、不讀取密鑰、不啟用正式資料流程。",
      "",
      "### 成功路徑",
      "1. 先建立或更新 Sandbox/Test issue，內容只描述方案設計需求。",
      "2. 可以改派員工或修改描述；這些只是編輯，不會自動喚醒 agent。",
      "3. 喚醒前確認 active run、live runs、recovery chain 都是乾淨狀態。",
      "4. 使用者貼出逐字一次性授權，明確指定單一 issue、單一員工、允許與禁止事項。",
      "5. Eve/Hermes 只讀 issue 內容並回覆一則方案設計 comment。",
      "6. 完成後立刻把員工停回 paused/manual，issue 回到 backlog，確認沒有 retry、recovery 或 continuation。",
      "7. 使用者人工看留言方向，確認內容方向 OK。",
      "",
      "### AI-98533 實測結果",
      "- run：a1780d70-48fb-432f-9b51-dd91d4b4029e",
      "- comment：17096b6c-cfb9-40ab-bc26-8a773b0a970a",
      "- 結果：succeeded",
      "- 安全狀態：無 active run、無 live runs、無 retry、無 recovery、無 continuation。",
      "- 人工判定：內容方向 OK。",
      "",
      "### 新手要記住",
      "- 編輯沙盒任務不是授權喚醒。",
      "- 請繼續、下一步、OK 都不是喚醒授權。",
      "- 每次真正喚醒都要新的逐字一次性授權。",
      "- transient error 只記錄失敗並停下，不自動 retry、不建立 recovery issue。",
      "- 成功後也先停下覆盤，不連續喚醒下一個任務。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製沙盒成功範例",
        body: "AI-98533 的安全流程與人工確認結果已放到剪貼簿。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從新手文件複製。",
        tone: "warn",
      });
    }
  }

  async function copyHermesSandboxWakeupMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_SANDBOX_WAKEUP_TEMPLATE.join("\n"));
      pushToast({
        title: "已複製 Hermes 沙盒喚醒模板",
        body: "第一次喚醒任務已放到剪貼簿；Hermes gate 變成可使用後再貼到 Sandbox/Test issue。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改到 Hermes SOP 複製模板。",
        tone: "warn",
      });
    }
  }

  async function copyHermesSandboxIssueCreateCheckMarkdown() {
    const lines = [
      "## Hermes Sandbox issue 建立前確認",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 用途：Office 預填 Sandbox/Test issue 草稿後、使用者按建立前，逐項確認草稿內容安全；這不是自動建立授權。",
      "",
      "### 草稿預期內容",
      "- 標題：Hermes Sandbox First Wake-up",
      `- 專案：${hermesSandboxProject?.name ?? "尚未準備 Sandbox/Test 專案"}`,
      `- 負責人：${hermesSandboxAgent?.name ?? "尚未準備 Hermes Sandbox/Test 員工"}`,
      "- 描述：第一次沙盒喚醒模板，僅要求回覆上下文、skills、環境狀態與安全邊界。",
      "",
      "### 建立前必須確認",
      "- [ ] 專案名稱含 Sandbox、Test、沙盒或測試，不是正式專案。",
      "- [ ] 負責人是 Hermes Sandbox/Test 員工，不是正式主管或一般正式員工。",
      "- [ ] 描述沒有 API key、token、密碼、完整 .env、私密 URL、正式客戶或公司資料。",
      "- [ ] 任務不要求修改檔案、不建立正式任務、不改名或刪除員工。",
      "- [ ] 不勾選 Run now，不啟用 schedule trigger，不打開 heartbeat scheduler。",
      "- [ ] 使用者知道最後建立按鈕必須自己手動按，Codex 不代按。",
      "",
      "### 判斷",
      "- READY TO CREATE MANUALLY：所有項目都確認，使用者可自行按建立。",
      "- WAIT：有欄位缺少或不確定，先修正草稿。",
      "- PAUSE：出現密鑰、正式資料、正式專案、Run now、排程、連續喚醒或 Codex 代按要求。",
      "",
      "### 停手線",
      "- Codex 不按建立、不 Run now、不啟用排程、不連續喚醒、不接正式專案。",
      "- 建立後必須回到喚醒後檢查面板與覆盤回報。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製建立前確認",
        body: "這份確認表只檢查草稿內容，不會替你建立 issue 或喚醒 Hermes。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製建立前確認失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理建立前確認。",
        tone: "warn",
      });
    }
  }

  async function copyHermesSandboxIssuePrefillHandoffMarkdown() {
    const lines = [
      "## Hermes Sandbox issue 預填交接",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 用途：READY TO PREFILL 後，只交接到打開 Office 預填 Sandbox/Test issue 草稿；這不是建立 issue、Run now、排程或喚醒授權。",
      "",
      "### 打開草稿前必須確認",
      "- [ ] 第 4 階 READY 交接已完成。",
      "- [ ] Office 的 `預填 issue 草稿` 可用。",
      "- [ ] Hermes Sandbox/Test 員工存在。",
      "- [ ] Sandbox/Test 專案存在。",
      "- [ ] 使用者已勾選 Sandbox/Test 確認。",
      "- [ ] 沒有 API key、token、密碼、完整 .env、正式專案或正式客戶資料。",
      "",
      "### 打開草稿後只檢查",
      "- 標題是否為 `Hermes Sandbox First Wake-up`。",
      "- 專案是否仍是 Sandbox/Test。",
      "- 負責人是否仍是 Hermes Sandbox/Test 員工。",
      "- 描述是否只要求回覆上下文、skills、環境狀態與安全邊界。",
      "- 草稿中沒有密鑰、完整 .env、正式資料、Run now 或 schedule trigger。",
      "",
      "### 下一步",
      "- 按 `複製建立前確認`。",
      "- 使用者自行判斷是否手動建立；Codex 不代按建立。",
      "- 建立後先按 `複製建立後觀察`，仍不喚醒 Hermes。",
      "",
      "### 仍然禁止",
      "- 不自動建立 issue、不代按建立。",
      "- 不 Run now、不啟用 schedule trigger、不打開 heartbeat scheduler。",
      "- 不連續喚醒、不接正式專案、不處理正式資料。",
      "- 不喚醒 Hermes 或其它本地模型；真正喚醒仍需使用者另行貼出一次性喚醒授權。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製預填交接",
        body: "這份交接只允許打開與檢查 Sandbox/Test issue 草稿，不會建立或喚醒。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製預填交接失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理預填交接。",
        tone: "warn",
      });
    }
  }

  async function copyHermesSandboxIssueManualCreateHandoffMarkdown() {
    const lines = [
      "## Hermes Sandbox issue 手動建立交接",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 用途：建立前確認判斷為 READY TO CREATE MANUALLY 後，只交接給使用者自己決定是否按建立；Codex 不代按建立。",
      "",
      "### READY TO CREATE MANUALLY 必須代表",
      "- [ ] 草稿標題是 `Hermes Sandbox First Wake-up`。",
      "- [ ] 專案只限 Sandbox/Test。",
      "- [ ] 負責人只限 Hermes Sandbox/Test 員工。",
      "- [ ] 描述只要求回覆上下文、skills、環境狀態與安全邊界。",
      "- [ ] 草稿沒有 API key、token、密碼、完整 .env、私密 URL、正式客戶或公司資料。",
      "- [ ] 沒有 Run now、schedule trigger、heartbeat scheduler、連續喚醒或正式專案要求。",
      "",
      "### 使用者若選擇建立",
      "- 只能由使用者本人在建立 issue 對話框按建立。",
      "- 建立後不要 Run now，不要啟用排程，不要喚醒 Hermes。",
      "- 建立後第一步是回 Office 按 `複製建立後觀察`。",
      "",
      "### 使用者若不確定",
      "- 不要按建立。",
      "- 回到 `複製建立前確認`，把 WAIT 或 PAUSE 原因補齊。",
      "- 出現密鑰、正式資料、正式專案或 Run now 要求時，直接 PAUSE。",
      "",
      "### 仍然禁止",
      "- Codex 不代按建立、不幫忙送出表單。",
      "- 不 Run now、不啟用 schedule trigger、不打開 heartbeat scheduler。",
      "- 不連續喚醒、不接正式專案、不處理正式資料。",
      "- 不喚醒 Hermes 或其它本地模型；真正喚醒仍需使用者另行貼出一次性喚醒授權。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製手動建立交接",
        body: "這份交接只給使用者手動建立前確認，Codex 不代按建立或喚醒。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製手動建立交接失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理手動建立交接。",
        tone: "warn",
      });
    }
  }

  async function copyHermesSandboxIssuePostCreateObservationMarkdown() {
    const lines = [
      "## Hermes Sandbox issue 建立後觀察",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 用途：使用者手動建立 Sandbox/Test issue 後，先觀察是否安全乾淨；這不是 Run now、排程或喚醒授權。",
      "",
      "### 請填非敏感觀察",
      `- 最近 Hermes Sandbox issue：${hermesWakeReviewCards.find((card) => card.label === "覆盤紀錄")?.value ?? "尚未找到"}`,
      `- Sandbox/Test 專案：${hermesSandboxProject?.name ?? "尚未準備"}`,
      `- Hermes Sandbox 員工：${hermesSandboxAgent?.name ?? "尚未準備"}`,
      `- Hermes 員工狀態：${hermesAgents.map((agent) => `${agent.name}:${agent.status}`).join("、") || "尚未找到"}`,
      `- Hermes live runs：${hermesWakeReviewCards.find((card) => card.label === "Hermes 舊工作")?.value ?? "未檢查"}`,
      `- Recovery issues：${hermesWakeReviewCards.find((card) => card.label === "Recovery issues")?.value ?? "未檢查"}`,
      "",
      "### 建立後必須確認",
      "- [ ] issue 仍掛在 Sandbox/Test 專案，不是正式專案。",
      "- [ ] issue 負責人仍是 Hermes Sandbox/Test 員工。",
      "- [ ] issue 描述沒有 API key、token、密碼、完整 .env、私密 URL、正式客戶或公司資料。",
      "- [ ] 沒有自動 Run now，沒有啟用 schedule trigger，沒有打開 heartbeat scheduler。",
      "- [ ] Hermes 員工沒有卡在 running/error。",
      "- [ ] 沒有 queued/running live runs 或新增 recovery issues。",
      "",
      "### 判斷",
      "- CLEAN：issue 與狀態都乾淨；下一步也只能進喚醒後檢查或等待使用者明確喚醒授權。",
      "- WAIT：issue 已建立但狀態尚未更新或資料不完整，先等待或只讀重新檢查。",
      "- PAUSE：出現正式資料、密鑰、Run now、排程、running/error、live run 或 recovery issue。",
      "",
      "### 停手線",
      "- Codex 不 Run now、不啟用 schedule trigger、不連續喚醒、不接正式專案。",
      "- 若要真正喚醒，必須由使用者另行明確授權。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製建立後觀察",
        body: "這份觀察表只確認手動建立後狀態，不會 Run now 或喚醒 Hermes。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製建立後觀察失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理建立後觀察。",
        tone: "warn",
      });
    }
  }

  async function copyHermesSandboxIssueCleanHandoffMarkdown() {
    const lines = [
      "## Hermes Sandbox issue CLEAN 交接",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 用途：建立後觀察判斷為 CLEAN 後，確認下一步只可準備一次性喚醒授權文字；這仍不是喚醒授權。",
      "",
      "### CLEAN 必須代表",
      "- [ ] issue 仍掛在 Sandbox/Test 專案。",
      "- [ ] issue 負責人仍是 Hermes Sandbox/Test 員工。",
      "- [ ] issue 描述沒有 API key、token、密碼、完整 .env、私密 URL、正式客戶或公司資料。",
      "- [ ] 沒有自動 Run now，沒有啟用 schedule trigger，沒有打開 heartbeat scheduler。",
      "- [ ] Hermes 員工沒有卡在 running/error。",
      "- [ ] 沒有 queued/running live runs 或新增 recovery issues。",
      "",
      "### 下一步只允許",
      "- 複製 `Hermes Sandbox 喚醒授權文字` 給使用者閱讀。",
      "- 由使用者決定是否另行貼出一次性喚醒授權句。",
      "- 若使用者沒有貼出授權句，就停在 CLEAN 交接，不喚醒 Hermes。",
      "",
      "### 仍然禁止",
      "- CLEAN 不是喚醒授權，不可直接喚醒 Hermes。",
      "- 不 Run now、不啟用 schedule trigger、不打開 heartbeat scheduler。",
      "- 不連續喚醒、不接正式專案、不處理正式資料。",
      "- 不建立第二個 issue、不修改檔案、不改名或刪除員工。",
      "",
      "### 交接結論",
      "- 判斷：CLEAN 只代表可以準備授權文字。",
      "- 下一個安全動作：複製喚醒授權文字，等待使用者明確貼出一次性授權句。",
      "- 不是授權：不是 Run now 授權、不是排程授權、不是喚醒授權。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製 CLEAN 交接",
        body: "CLEAN 只代表可準備喚醒授權文字，不代表已授權喚醒 Hermes。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製 CLEAN 交接失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理 CLEAN 交接。",
        tone: "warn",
      });
    }
  }

  async function copyHermesSandboxWakeupAuthorizationMarkdown() {
    const lines = [
      "## Hermes Sandbox 喚醒授權文字",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 授權範圍：我只授權第 4 階的一次性 Sandbox/Test Hermes 喚醒。",
      "- 前提：已完成建立前確認、手動建立 Sandbox issue、建立後觀察為 CLEAN，且沒有密鑰、正式資料、Run now、排程、running/error、live run 或 recovery 風險。",
      "",
      "### 本次只允許",
      "- 只針對單一 Hermes Sandbox First Wake-up issue。",
      "- 只讓 Hermes Sandbox/Test 員工回覆該 Sandbox/Test issue。",
      "- 只要求回覆收到任務、可見上下文、可用 skills、環境狀態與下一步安全檢查。",
      "- 完成後立即回到喚醒後檢查面板與覆盤回報。",
      "",
      "### 仍然禁止",
      "- 不接正式專案、不處理正式客戶或公司資料。",
      "- 不建立第二個 issue、不連續喚醒、不 Run now、不啟用 schedule trigger、不打開 heartbeat scheduler。",
      "- 不讀取、不貼出、不整理 API key、token、密碼、完整 .env 或私密 URL。",
      "- 不修改檔案、不改名或刪除員工、不改設定、不安裝或下載任何東西。",
      "",
      "### 停止條件",
      "- 找不到單一 Sandbox/Test issue 或負責人不是 Hermes Sandbox/Test 員工。",
      "- 出現 running/error、queued/running live runs、recovery issues 或憑證疑慮。",
      "- 任何步驟要求正式資料、排程、連續喚醒或 Codex 代按建立。",
      "",
      "### 授權句",
      "- 我同意第 4 階：只對單一 Sandbox/Test issue 做一次 Hermes Sandbox 喚醒；完成後立刻停下覆盤。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製喚醒授權",
        body: "這只授權一次性 Sandbox/Test 喚醒，不包含 Run now、排程或正式專案。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製喚醒授權失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動複製授權文字。",
        tone: "warn",
      });
    }
  }

  async function copyHermesWakeupAuthorizationIntakeCheckMarkdown() {
    const lines = [
      "## Hermes 喚醒授權貼出前確認",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 用途：使用者貼出一次性喚醒授權句前，先確認授權句是否足夠明確；這張卡本身不是喚醒授權。",
      "",
      "### 授權句必須同時包含",
      "- [ ] 明確寫出 `我同意第 4 階`。",
      "- [ ] 明確寫出 `只對單一 Sandbox/Test issue`。",
      "- [ ] 明確寫出 `一次 Hermes Sandbox 喚醒`。",
      "- [ ] 明確寫出 `完成後立刻停下覆盤`。",
      "- [ ] 沒有正式專案、正式資料、Run now、schedule trigger、heartbeat scheduler、連續喚醒或第二個 issue。",
      "",
      "### 可以接受的授權句",
      "- 我同意第 4 階：只對單一 Sandbox/Test issue 做一次 Hermes Sandbox 喚醒；完成後立刻停下覆盤。",
      "",
      "### 不可接受的模糊句",
      "- 可以。",
      "- 繼續。",
      "- 幫我跑。",
      "- 你決定。",
      "- 直接做。",
      "- 喚醒 Hermes 看看。",
      "",
      "### 判斷",
      "- ACCEPT：授權句完全符合，可以進入一次性 Sandbox/Test 喚醒前最後交接。",
      "- WAIT：授權句缺少單一 issue、一次性、Sandbox/Test 或完成後停下覆盤，請使用者重貼完整授權句。",
      "- PAUSE：授權句包含正式專案、正式資料、Run now、排程、連續喚醒、第二個 issue、密鑰或 Codex 代按要求。",
      "",
      "### 仍然禁止",
      "- 沒有 ACCEPT 前不喚醒 Hermes。",
      "- 不把模糊句視為喚醒授權。",
      "- 不 Run now、不啟用 schedule trigger、不打開 heartbeat scheduler。",
      "- 不接正式專案、不處理正式資料、不連續喚醒。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製授權貼出前確認",
        body: "這張卡只檢查授權句是否明確，不會喚醒 Hermes。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製授權貼出前確認失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理授權句檢查。",
        tone: "warn",
      });
    }
  }

  async function copyHermesWakeupAuthorizationAcceptHandoffMarkdown() {
    const lines = [
      "## Hermes 喚醒授權 ACCEPT 交接",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 用途：授權句檢查判斷為 ACCEPT 後，整理一次性 Sandbox/Test 喚醒前最後交接；這不擴張任何授權範圍。",
      "",
      "### ACCEPT 必須代表",
      "- [ ] 使用者貼出的授權句完整包含 `我同意第 4 階`。",
      "- [ ] 授權只限單一 Sandbox/Test issue。",
      "- [ ] 授權只限一次 Hermes Sandbox 喚醒。",
      "- [ ] 授權要求完成後立刻停下覆盤。",
      "- [ ] 沒有正式專案、正式資料、Run now、schedule trigger、heartbeat scheduler、連續喚醒、第二個 issue 或 Codex 代按要求。",
      "",
      "### 下一步只允許",
      "- 針對該單一 Sandbox/Test issue 做一次 Hermes Sandbox 喚醒前最後確認。",
      "- 喚醒後立即回到 Office 的喚醒後檢查面板。",
      "- 複製 `喚醒後覆盤`，把回覆、員工狀態、live runs 與 recovery issues 記錄下來。",
      "",
      "### 仍然禁止",
      "- 不 Run now、不啟用 schedule trigger、不打開 heartbeat scheduler。",
      "- 不連續喚醒、不建立第二個 issue、不接正式專案。",
      "- 不處理正式資料、不讀取或整理 API key、token、密碼、完整 .env 或私密 URL。",
      "- 不安裝、不下載、不修改檔案、不改名或刪除員工。",
      "",
      "### 停止條件",
      "- 找不到單一 Sandbox/Test issue。",
      "- 負責人不是 Hermes Sandbox/Test 員工。",
      "- Hermes 員工已是 running/error，或存在 queued/running live runs。",
      "- 出現 recovery issues、憑證疑慮、正式資料或正式專案要求。",
      "",
      "### 交接結論",
      "- 判斷：ACCEPT 只允許一次性 Sandbox/Test 喚醒。",
      "- 下一個安全動作：做最後確認；完成後立刻停下覆盤。",
      "- 不是授權：不是 Run now 授權、不是排程授權、不是正式專案授權、不是連續喚醒授權。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製 ACCEPT 交接",
        body: "ACCEPT 只允許一次 Sandbox/Test 喚醒，不擴張到 Run now、排程或正式專案。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製 ACCEPT 交接失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理 ACCEPT 交接。",
        tone: "warn",
      });
    }
  }

  async function copyHermesOneShotWakeupFinalCheckMarkdown() {
    const lines = [
      "## Hermes 一次性喚醒前最後確認",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 用途：在已取得 ACCEPT 授權後、真正進行一次性 Sandbox/Test 喚醒前，做最後只讀確認；這張卡本身不執行喚醒。",
      "",
      "### 最後確認必須全部通過",
      "- [ ] 只有一個目標 issue，且是 Sandbox/Test issue。",
      "- [ ] 目標 issue 負責人是 Hermes Sandbox/Test 員工。",
      "- [ ] Hermes Sandbox/Test 員工目前不是 running/error。",
      "- [ ] 沒有 Hermes queued/running live runs。",
      "- [ ] 沒有新增或未覆盤的 recovery issues。",
      "- [ ] issue 描述沒有 API key、token、密碼、完整 .env、私密 URL、正式客戶或公司資料。",
      "- [ ] 使用者授權句仍只限一次 Sandbox/Test Hermes 喚醒，完成後立刻停下覆盤。",
      "",
      "### 若全部通過",
      "- 下一步只能針對這個單一 Sandbox/Test issue 做一次 Hermes Sandbox 喚醒。",
      "- 完成後立刻回到 Office 的喚醒後檢查面板。",
      "- 立刻複製 `喚醒後覆盤`，記錄回覆、員工狀態、live runs 與 recovery issues。",
      "",
      "### 任一項不通過就停下",
      "- 目標 issue 不唯一或不是 Sandbox/Test。",
      "- 負責人不是 Hermes Sandbox/Test 員工。",
      "- 員工 running/error、存在 queued/running live runs 或 recovery issues。",
      "- 出現正式資料、密鑰、Run now、排程、第二個 issue 或連續喚醒要求。",
      "",
      "### 仍然禁止",
      "- 不 Run now、不啟用 schedule trigger、不打開 heartbeat scheduler。",
      "- 不連續喚醒、不建立第二個 issue、不接正式專案。",
      "- 不處理正式資料、不讀取或整理 API key、token、密碼、完整 .env 或私密 URL。",
      "- 不把本卡視為額外授權；授權只限前述單一 Sandbox/Test issue 的一次喚醒。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製喚醒前最後確認",
        body: "這張卡只做一次性喚醒前最後確認，不會執行喚醒。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製喚醒前最後確認失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理最後確認。",
        tone: "warn",
      });
    }
  }

  async function copyHermesOneShotWakeupExecutionHandoffMarkdown() {
    const lines = [
      "## Hermes 一次性喚醒執行交接",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 用途：所有前置檢查通過且使用者授權句為 ACCEPT 後，交接單次 Sandbox/Test 喚醒的執行範圍；這張卡不自動執行喚醒。",
      "",
      "### 執行前必須已完成",
      "- [ ] 授權句檢查為 ACCEPT。",
      "- [ ] 已複製並通過 `喚醒前最後確認`。",
      "- [ ] 目標只有單一 Sandbox/Test issue。",
      "- [ ] 負責人只有單一 Hermes Sandbox/Test 員工。",
      "- [ ] 沒有 running/error 員工、queued/running live runs、recovery issues、密鑰或正式資料。",
      "",
      "### 本次只允許",
      "- 對該單一 Sandbox/Test issue 做一次 Hermes Sandbox 喚醒。",
      "- 只要求 Hermes 回覆收到任務、可見上下文、可用 skills、環境狀態與下一步安全檢查。",
      "- 完成後立刻停下，不開第二個任務。",
      "- 完成後立刻回 Office 按 `複製喚醒後覆盤`。",
      "",
      "### 執行中若發生任一狀況就停止",
      "- 目標 issue 或負責人不符合 Sandbox/Test。",
      "- 出現 API key、token、密碼、完整 .env、私密 URL、正式客戶或公司資料。",
      "- Hermes 員工卡在 running/error，或產生 queued/running live runs、recovery issues。",
      "- 任何要求 Run now、schedule trigger、heartbeat scheduler、第二個 issue、連續喚醒或正式專案。",
      "",
      "### 仍然禁止",
      "- 不 Run now、不啟用 schedule trigger、不打開 heartbeat scheduler。",
      "- 不連續喚醒、不建立第二個 issue、不接正式專案。",
      "- 不安裝、不下載、不修改檔案、不改名或刪除員工。",
      "- 不把本次授權延伸到下一次任務；完成後授權即結束。",
      "",
      "### 完成後必做",
      "- 回到喚醒後檢查面板。",
      "- 複製 `喚醒後覆盤`。",
      "- 記錄 Hermes 回覆是否可讀、員工是否卡住、live runs/recovery 是否乾淨。",
      "- 在覆盤完成前，不進下一個 Hermes 任務。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製喚醒執行交接",
        body: "這張卡只交接單次 Sandbox/Test 喚醒範圍，不會自動執行。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製喚醒執行交接失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理執行交接。",
        tone: "warn",
      });
    }
  }

  async function copyHermesOneShotWakeupCompletionStopMarkdown() {
    const lines = [
      "## Hermes 一次性喚醒完成停手",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 用途：一次性 Sandbox/Test Hermes 喚醒完成後，立刻停下並轉入覆盤；這張卡不授權下一個任務。",
      "",
      "### 完成後第一動作",
      "- [ ] 停止所有後續 Hermes 動作。",
      "- [ ] 回到 Office 的喚醒後檢查面板。",
      "- [ ] 複製 `喚醒後覆盤`。",
      "- [ ] 記錄 Hermes 回覆是否可讀、是否可追溯、是否沒有洩漏憑證。",
      "- [ ] 記錄 Hermes 員工是否沒有 running/error。",
      "- [ ] 記錄是否沒有 queued/running live runs 或 recovery issues。",
      "",
      "### 完成後仍然禁止",
      "- 不建立第二個 issue。",
      "- 不再次喚醒 Hermes。",
      "- 不 Run now、不啟用 schedule trigger、不打開 heartbeat scheduler。",
      "- 不接正式專案、不處理正式資料。",
      "- 不把本次成功視為永久授權或下一次授權。",
      "",
      "### 判斷",
      "- CLEAN：回覆可讀、員工狀態乾淨、沒有 live runs/recovery、沒有憑證外洩；仍先停下覆盤。",
      "- WAIT：回覆或狀態尚未更新，等待或只讀重新檢查，不開新任務。",
      "- PAUSE：running/error、queued/running live runs、recovery issues、密鑰外洩、正式資料或正式專案訊號。",
      "",
      "### 下一步只允許",
      "- 完成 `喚醒後覆盤`。",
      "- 把結果記錄到今天進度。",
      "- 在覆盤完成前，不進下一個 Hermes 任務。",
      "- 若要下一個 Hermes 任務，必須重新從 Sandbox/Test 範圍與授權流程開始。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製完成停手交接",
        body: "這張卡要求喚醒完成後先停下覆盤，不延伸到下一個任務。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製完成停手交接失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理完成停手交接。",
        tone: "warn",
      });
    }
  }

  async function copyHermesSecondSandboxTaskPrepMarkdown() {
    const lines = [
      "## Hermes 第二個 Sandbox/Test 任務準備卡",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 用途：在第一次 AI-97978 成功後，準備下一個只讀或低風險 Sandbox/Test issue。這張卡只做準備，不是喚醒授權。",
      "",
      "### 1. 候選任務",
      "- 候選 issue：尚未建立 / 已建立，編號：",
      "- 專案：必須是 Virtual Office Sandbox 或明確 Sandbox/Test 專案。",
      "- 負責人：只能是 Hermes Sandbox Engineer 或另一位明確 Sandbox/Test 員工。",
      "- 任務目的：只驗證一個能力，例如讀取 issue 上下文、回報 skills、產出安全下一步、或整理測試紀錄。",
      "",
      "### 2. 任務邊界",
      "- 不 Run now。",
      "- 不啟用 schedule trigger。",
      "- 不打開 heartbeat scheduler。",
      "- 不接正式專案。",
      "- 不處理正式資料。",
      "- 不讀取、貼上或回覆 API key、token、密碼、完整 .env 或私密 URL。",
      "- 不把 AI-97978 的成功結果延伸成第二次喚醒授權。",
      "",
      "### 3. 建議任務描述",
      "- 請只回覆你能看到的 Sandbox/Test issue 上下文。",
      "- 請列出本次會用到的 skills。",
      "- 請確認沒有修改檔案、正式任務、正式專案或員工狀態。",
      "- 請提出下一個安全檢查，不要自行建立下一個 issue。",
      "",
      "### 4. 建立前檢查",
      "- [ ] Backend OK / Frontend OK。",
      "- [ ] Hermes Sandbox Engineer 狀態是 paused/manual。",
      "- [ ] 沒有 queued/running Hermes runs。",
      "- [ ] 沒有 recovery issue 或 blocker 需要先處理。",
      "- [ ] 任務名稱含 Sandbox/Test/沙盒/測試。",
      "- [ ] 描述中沒有敏感資訊。",
      "- [ ] 使用者另行貼出明確一次性喚醒授權前，不喚醒 Hermes。",
      "",
      "### 5. 判斷",
      "- READY：可以建立 Sandbox/Test issue 草稿，仍不喚醒。",
      "- WAIT：資訊不足，先補候選 issue、目的或安全邊界。",
      "- PAUSE：有正式資料、敏感資訊、running run、recovery 或授權不清楚，立刻停下。",
      "",
      "### 6. 下一步",
      "- 若 READY，先建立或確認 Sandbox/Test issue，然後回到 `喚醒前最後確認`。",
      "- 真正喚醒前，使用者必須重新貼出明確的一次性授權句。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製第二沙盒任務準備卡",
        body: "這張卡只準備下一個 Sandbox/Test issue，不會喚醒 Hermes。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製第二沙盒任務準備卡失敗",
        body: "可到 Hermes SOP 查看第二個 Sandbox/Test 任務準備規則。",
        tone: "warn",
      });
    }
  }

  async function copyHermesSecondSandboxIssueDraftMarkdown() {
    try {
      await navigator.clipboard.writeText(buildHermesSecondSandboxIssueTemplate());
      pushToast({
        title: "已複製第二沙盒 issue 草稿",
        body: "這份草稿只用來手動建立 Sandbox/Test issue，不是 Hermes 喚醒授權。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製第二沙盒 issue 草稿失敗",
        body: "可到 Hermes SOP 查看第二個 Sandbox/Test issue 草稿模板。",
        tone: "warn",
      });
    }
  }

  async function copyHermesSecondSandboxIssueReviewMarkdown() {
    const lines = [
      "## Hermes 第二沙盒 issue 建立後覆盤",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 用途：確認第二個 Sandbox/Test issue 只是待辦草稿，沒有喚醒 Hermes。",
      "",
      "### issue 狀態",
      "- issue 編號：",
      "- issue 標題：Hermes Sandbox Second Controlled Check / 其他明確 Sandbox/Test 標題",
      "- issue 狀態：todo / backlog，不能是 running。",
      "- 專案：Virtual Office Sandbox 或明確 Sandbox/Test 專案。",
      "- 負責人：Hermes Sandbox Engineer 或另一位明確 Sandbox/Test 員工。",
      "",
      "### 覆盤檢查",
      "- [ ] issue 內容仍寫明：這不是喚醒授權。",
      "- [ ] issue 內容仍寫明：不沿用 AI-97978 授權。",
      "- [ ] 沒有新增 Run now。",
      "- [ ] 沒有啟用 schedule trigger。",
      "- [ ] heartbeat scheduler 仍是 false。",
      "- [ ] 沒有 queued/running Hermes runs。",
      "- [ ] 沒有新的 recovery issue 或 blocker。",
      "- [ ] 沒有正式專案、正式資料、API key、token、密碼、完整 .env 或私人 URL。",
      "",
      "### 判斷",
      "- CLEAN：issue 可保留為待辦草稿，等待使用者未來重新授權。",
      "- WAIT：issue 內容缺少 Sandbox/Test 邊界或停手線，先補文字。",
      "- PAUSE：任何 run、排程、heartbeat、正式資料、密鑰或連續喚醒跡象，立刻停下處理。",
      "",
      "### 下一步",
      "- CLEAN 時，只記錄結果，不喚醒 Hermes。",
      "- 若未來要真的喚醒，必須重新貼出明確一次性授權句。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製第二沙盒 issue 覆盤",
        body: "這張表只確認草稿安全狀態，不會喚醒 Hermes。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製第二沙盒 issue 覆盤失敗",
        body: "可到 Hermes SOP 查看第二個 Sandbox/Test issue 覆盤規則。",
        tone: "warn",
      });
    }
  }

  async function copyHermesSecondSandboxAuthorizationTemplateMarkdown() {
    const lines = [
      "## Hermes 第二個 Sandbox/Test 一次性喚醒授權模板",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 用途：這只是第二個 Sandbox/Test issue 的授權模板，方便使用者閱讀與填空；模板本身不是授權。",
      "",
      "### 使用前必須先填",
      "- issue 編號：AI-____",
      "- issue 標題：",
      "- 專案：Virtual Office Sandbox 或明確 Sandbox/Test 專案",
      `- 員工：${hermesSandboxAgent?.name ?? "Hermes Sandbox Engineer"} 或另一位明確 Sandbox/Test 員工`,
      "",
      "### 必須已完成",
      "- [ ] 第二沙盒任務準備卡為 READY。",
      "- [ ] 第二個 Sandbox/Test issue 已建立或已確認為待辦草稿。",
      "- [ ] 第二 issue 覆盤為 CLEAN。",
      "- [ ] Backend OK / Frontend OK。",
      "- [ ] heartbeat scheduler 仍是 false。",
      "- [ ] 沒有 queued/running Hermes runs。",
      "- [ ] 沒有 recovery issue 或 blocker。",
      "- [ ] 沒有正式專案、正式資料、API key、token、密碼、完整 .env 或私人 URL。",
      "",
      "### 授權句範本",
      "我同意第 4 階，只對 AI-____ 做一次 Hermes Sandbox/Test 喚醒；只由 Hermes Sandbox Engineer 回覆該 issue，完成後立刻停下覆盤。不 Run now、不啟用 schedule trigger、不打開 heartbeat scheduler、不接正式專案、不處理正式資料、不連續喚醒。",
      "",
      "### 仍然禁止",
      "- 不沿用 AI-97978 的授權。",
      "- 不同時處理多個 issue。",
      "- 不建立下一個 issue。",
      "- 不修改正式資料或正式專案。",
      "- 不處理或回覆任何憑證。",
      "",
      "### 判斷",
      "- ACCEPT：使用者親自貼出的授權句已填入單一 issue、單一員工、一次性、完成後停下覆盤，且明確列出所有禁止事項。",
      "- WAIT：缺 issue 編號、員工、一次性、停手線或禁止事項，請使用者重貼完整授權句。",
      "- PAUSE：包含 Run now、排程、heartbeat、正式資料、憑證、連續喚醒或多 issue。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製第二沙盒授權模板",
        body: "這只是授權模板；使用者未填入並另行貼出前，不算喚醒授權。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製第二沙盒授權模板失敗",
        body: "可到 Hermes SOP 查看第二個 Sandbox/Test 授權模板。",
        tone: "warn",
      });
    }
  }

  async function copyHermesSecondSandboxAuthorizationIntakeMarkdown() {
    const lines = [
      "## Hermes 第二沙盒授權句貼出後判讀",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 用途：使用者貼出第二次 Sandbox/Test 授權句後，先判斷是否 ACCEPT / WAIT / PAUSE；這張判讀卡本身不是喚醒授權。",
      "",
      "### 授權句必須同時包含",
      "- [ ] 明確寫出 `我同意第 4 階`。",
      "- [ ] 明確寫出單一 issue 編號，例如 `AI-____`，且不能是已完成的 AI-97978。",
      "- [ ] 明確寫出 `只由 Hermes Sandbox Engineer` 或另一位單一 Sandbox/Test 員工回覆。",
      "- [ ] 明確寫出 `一次 Hermes Sandbox/Test 喚醒`。",
      "- [ ] 明確寫出 `完成後立刻停下覆盤`。",
      "- [ ] 明確寫出不 Run now、不啟用 schedule trigger、不打開 heartbeat scheduler。",
      "- [ ] 明確寫出不接正式專案、不處理正式資料、不連續喚醒。",
      "",
      "### 必須先確認的現場狀態",
      "- [ ] 第二沙盒任務準備卡 READY。",
      "- [ ] 第二 issue 草稿已建立或已確認。",
      "- [ ] 第二 issue 覆盤 CLEAN。",
      "- [ ] Backend OK / Frontend OK。",
      "- [ ] Hermes Sandbox Engineer 是 paused/manual。",
      "- [ ] heartbeat scheduler 仍是 false。",
      "- [ ] 沒有 queued/running Hermes runs。",
      "- [ ] 沒有 recovery issue 或 blocker。",
      "",
      "### 不可接受的句子",
      "- 可以。",
      "- 繼續。",
      "- 你決定。",
      "- 喚醒 Hermes 看看。",
      "- 跑第二個看看。",
      "- 沿用上次授權。",
      "",
      "### 判斷",
      "- ACCEPT：授權句和現場狀態全部符合，才可進入第二沙盒喚醒前最後確認。",
      "- WAIT：缺 issue、員工、一次性、停手線或禁止事項，請使用者重貼完整授權句。",
      "- PAUSE：出現 Run now、排程、heartbeat、正式資料、憑證、連續喚醒、多 issue、沿用 AI-97978 授權、running run 或 recovery。",
      "",
      "### 下一步",
      "- ACCEPT 也不是立刻喚醒；下一步只能複製第二沙盒喚醒前最後確認。",
      "- WAIT 或 PAUSE 時不喚醒 Hermes。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製第二沙盒授權判讀",
        body: "未判讀為 ACCEPT 前，不可喚醒 Hermes。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製第二沙盒授權判讀失敗",
        body: "可到 Hermes SOP 查看第二次授權句判讀規則。",
        tone: "warn",
      });
    }
  }

  async function copyHermesSecondSandboxFinalCheckMarkdown() {
    const lines = [
      "## Hermes 第二沙盒喚醒前最後確認",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 用途：第二次 Sandbox/Test 授權句判讀為 ACCEPT 後，最後確認是否仍可進入一次性喚醒。這張卡不是喚醒執行授權。",
      "",
      "### 單一目標確認",
      "- issue 編號：AI-____",
      "- issue 標題：",
      "- 專案：Virtual Office Sandbox 或明確 Sandbox/Test 專案。",
      "- 員工：Hermes Sandbox Engineer 或另一位單一 Sandbox/Test 員工。",
      "",
      "### 必須全部通過",
      "- [ ] 授權句判讀結果是 ACCEPT。",
      "- [ ] issue 編號不是 AI-97978，且不是已完成的舊 issue。",
      "- [ ] issue 狀態仍是 todo / backlog，不能是 running / done / cancelled。",
      "- [ ] issue 描述仍明確寫 Sandbox/Test 邊界。",
      "- [ ] Hermes Sandbox Engineer 是 paused/manual。",
      "- [ ] Backend OK / Frontend OK。",
      "- [ ] heartbeat scheduler 仍是 false。",
      "- [ ] 沒有 queued/running Hermes runs。",
      "- [ ] 沒有 recovery issue 或 blocker。",
      "- [ ] 沒有 Run now、schedule trigger 或連續喚醒跡象。",
      "- [ ] 沒有正式專案、正式資料、API key、token、密碼、完整 .env 或私人 URL。",
      "",
      "### 判斷",
      "- GO：全部通過，下一步才可準備單次執行交接；仍不可連續喚醒。",
      "- WAIT：缺少 issue、員工、狀態或證據，先補資料。",
      "- PAUSE：出現 run/recovery/排程/heartbeat/正式資料/憑證/多 issue，立刻停下。",
      "",
      "### 下一步",
      "- GO 時，只能進 `第二沙盒單次執行交接`。",
      "- WAIT 或 PAUSE 時，不喚醒 Hermes。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製第二沙盒喚醒前最後確認",
        body: "這是最後確認卡，不會喚醒 Hermes。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製第二沙盒最後確認失敗",
        body: "可到 Hermes SOP 查看第二沙盒喚醒前最後確認規則。",
        tone: "warn",
      });
    }
  }

  async function copyHermesWakeupRunbookMarkdown() {
    const lines = [
      "## Hermes 一次性沙盒喚醒操作紀錄",
      "",
      `- 環境狀態：${hermesEnvironmentTest?.status ?? "未檢查"}`,
      `- Hermes Sandbox 員工：${hermesSandboxAgent?.name ?? "尚未準備"}`,
      `- Sandbox/Test 專案：${hermesSandboxProject?.name ?? "尚未準備"}`,
      "",
      "### 操作步驟",
      ...HERMES_WAKEUP_RUNBOOK_STEPS.map((step) => `- [ ] ${step.label}：${step.detail}`),
      "",
      "### 喚醒後檢查",
      ...hermesWakeReviewCards.map((card) => `- ${card.label}（${card.status}）：${card.value}。${card.detail}`),
      "",
      "### 停止條件",
      "- 如果 Hermes 員工卡在 running/error，先停下並記錄，不建立下一個任務。",
      "- 如果出現 recovery issues，先覆盤原因，不進正式專案。",
      "- 如果回覆含 API key、token、密碼或私密設定，立即停止並清理紀錄。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製 Hermes 操作紀錄",
        body: "一次性沙盒喚醒的步驟與檢查項目已放到剪貼簿。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 複製操作步驟。",
        tone: "warn",
      });
    }
  }

  async function copyHermesStageFourEntryHandoffMarkdown() {
    const lines = [
      "## Hermes 第 4 階入口交接",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 用途：只讀 PASS 後，準備進第 4 階喚醒前檢查；這不是建立 issue、Run now、排程或喚醒授權。",
      "",
      "### 入口前提",
      "- [ ] 只讀結果判讀是 PASS。",
      "- [ ] 已完成 PASS 後交接，確認 PASS 只代表 preview / bridge / status / Test environment 乾淨。",
      "- [ ] 沒有 active sessions、scheduled jobs、running task、recovery issue 或喚醒中的任務。",
      "- [ ] 沒有 API key、token、密碼、完整 .env、含憑證 URL/header/log 或正式資料。",
      "",
      "### 第 4 階只允許先檢查",
      "- 檢查 Hermes Sandbox/Test 員工是否存在。",
      "- 檢查 Sandbox/Test 專案是否存在。",
      "- 檢查使用者是否已勾選 Sandbox/Test 確認。",
      "- 複製第 4 階喚醒前檢查表。",
      "- 若條件不足，只補 Sandbox/Test 條件，不建立 issue。",
      "",
      "### 仍然禁止",
      "- 不自動建立 issue。",
      "- 不 Run now、不啟用 schedule trigger、不打開 heartbeat scheduler。",
      "- 不連續喚醒、不接正式專案、不處理正式客戶或公司資料。",
      "- 不喚醒 Hermes 或其它本地模型；真正喚醒仍需使用者另行貼出一次性喚醒授權。",
      "",
      "### 下一步",
      "- GO：複製喚醒前檢查。",
      "- WAIT：補 Sandbox/Test 員工、專案或使用者確認。",
      "- PAUSE：出現密鑰、正式資料、active/running/recovery、Run now、排程或喚醒要求。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製第 4 階入口交接",
        body: "PASS 後進第 4 階前的安全邊界已放到剪貼簿。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製第 4 階入口交接失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理第 4 階入口交接。",
        tone: "warn",
      });
    }
  }

  async function copyHermesStageFourWaitRepairMarkdown() {
    const missingItems = [
      hermesSandboxAgent ? null : "Hermes Sandbox/Test 員工尚未準備。",
      hermesSandboxProject ? null : "Sandbox/Test 專案尚未準備。",
      hermesWakeupUserConfirmed ? null : "使用者尚未勾選 Sandbox/Test 確認。",
      hermesEnvironmentReady ? null : "Test environment 尚未 pass。",
    ].filter((item): item is string => Boolean(item));
    const lines = [
      "## Hermes 第 4 階 WAIT 補齊包",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 用途：第 4 階入口或喚醒前檢查若是 WAIT，只補 Sandbox/Test 條件；這不是建立 issue、Run now、排程或喚醒授權。",
      "",
      "### 目前缺項",
      ...(missingItems.length > 0 ? missingItems.map((item) => `- [ ] ${item}`) : ["- [ ] 目前未偵測到缺項；若仍不確定，重新複製第 4 階入口交接。"]),
      "",
      "### 只允許補",
      "- 建立或確認 Hermes Sandbox/Test 員工。",
      "- 建立或確認 Sandbox/Test 專案。",
      "- 勾選使用者 Sandbox/Test 確認。",
      "- 重新跑只讀檢查或 Test environment 的非敏感摘要。",
      "- 重新複製第 4 階入口交接或喚醒前檢查表。",
      "",
      "### 仍然禁止",
      "- 不預填 issue 草稿，除非第 4 階喚醒前檢查已 READY TO PREFILL。",
      "- 不自動建立 issue、不代按建立。",
      "- 不 Run now、不啟用 schedule trigger、不打開 heartbeat scheduler。",
      "- 不連續喚醒、不接正式專案、不處理正式資料。",
      "- 不喚醒 Hermes 或其它本地模型。",
      "",
      "### 補齊後回來做",
      "- 重新按 `複製第 4 階入口`。",
      "- 再按 `複製喚醒前檢查`。",
      "- 仍是 WAIT 就只補下一個 Sandbox/Test 缺項；出現密鑰、正式資料、Run now、排程或喚醒要求就 PAUSE。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製第 4 階 WAIT 補齊",
        body: "Sandbox/Test 缺項與禁止跨線項目已放到剪貼簿。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製第 4 階 WAIT 補齊失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理第 4 階缺項。",
        tone: "warn",
      });
    }
  }

  async function copyHermesWakeupPreflightMarkdown() {
    const lines = [
      "## Hermes 第 4 階喚醒前檢查表",
      "",
      "我同意第 4 階前置檢查：只確認 Sandbox/Test 喚醒條件，不代表可以接正式專案或啟用自動排程。",
      "",
      "### 目前狀態",
      `- Test environment：${hermesEnvironmentTest?.status ?? "未檢查"}`,
      `- Hermes Sandbox 員工：${hermesSandboxAgent?.name ?? "尚未準備"}`,
      `- Sandbox/Test 專案：${hermesSandboxProject?.name ?? "尚未準備"}`,
      `- 使用者 Sandbox/Test 確認：${hermesWakeupUserConfirmed ? "已勾選" : "尚未勾選"}`,
      `- 是否可預填 issue 草稿：${canOpenHermesSandboxIssueDraft ? "可以" : "不可以"}`,
      "",
      "### 必須全部通過",
      ...HERMES_WAKEUP_PREFLIGHT_RULES.map((rule) => `- [ ] ${rule.label}：${rule.detail}`),
      "",
      "### issue 內容限制",
      "- 只掛到 Sandbox/Test 專案。",
      "- 只指派 Hermes Sandbox/Test 員工。",
      "- 任務只要求回覆收到任務、可見上下文、可用 skills、環境狀態與下一步安全檢查。",
      "- 不要求修改檔案、不建立正式任務、不改名或刪除員工、不讀取或回覆 API key、token、密碼或私密設定。",
      "",
      "### 固定停手線",
      "- Office 只可預填 issue 草稿，最後建立仍由使用者手動確認。",
      "- 不 Run now、不連續 Run now、不啟用 schedule trigger、不打開 heartbeat scheduler。",
      "- 第一次喚醒後，必須回到喚醒後檢查面板確認 running/error、live runs、recovery issues 與覆盤 issue。",
      "- 任何一步不確定就停下，不進正式專案。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製喚醒前檢查表",
        body: "第 4 階喚醒前檢查表已放到剪貼簿；它只做 Sandbox/Test 前置確認，不會喚醒 Hermes。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製喚醒前檢查表失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 整理第 4 階檢查表。",
        tone: "warn",
      });
    }
  }

  async function copyHermesWakeupDraftDecisionMarkdown() {
    const lines = [
      "## Hermes 喚醒前預填判讀",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 用途：第 4 階喚醒前檢查表填完後，Codex 只判斷是否可預填 Sandbox/Test issue 草稿；不自動建立 issue、不 Run now、不啟用 schedule trigger、不喚醒 Hermes。",
      "",
      "### 請貼非敏感狀態",
      `- Test environment：${hermesEnvironmentTest?.status ?? "未檢查"}`,
      `- Hermes Sandbox 員工：${hermesSandboxAgent?.name ?? "尚未準備"}`,
      `- Sandbox/Test 專案：${hermesSandboxProject?.name ?? "尚未準備"}`,
      `- 使用者 Sandbox/Test 確認：${hermesWakeupUserConfirmed ? "已勾選" : "尚未勾選"}`,
      `- Office 是否可預填 issue 草稿：${canOpenHermesSandboxIssueDraft ? "可以" : "不可以"}`,
      "",
      "### 判讀規則",
      "- READY TO PREFILL：Test environment pass、Sandbox/Test 員工存在、Sandbox/Test 專案存在、使用者已勾選確認，且沒有密鑰或正式資料風險。",
      "- WAIT：任一條件缺少或尚未確認；只補條件，不建立 issue。",
      "- PAUSE：出現 API key、token、密碼、完整 .env、正式專案、正式客戶資料、Run now、排程、連續喚醒或 active/running/recovery 風險。",
      "",
      "### 回覆格式",
      "- 判讀：READY TO PREFILL / WAIT / PAUSE",
      "- 依據：",
      "- 若 READY TO PREFILL：只可開啟 Office 的預填 issue 草稿；最後建立仍由使用者手動確認。",
      "- 仍然禁止：不自動建立 issue、不 Run now、不啟用 schedule trigger、不連續喚醒、不接正式專案。",
      "- 下一個安全動作：",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製預填判讀",
        body: "這份規則只判斷是否可預填草稿，不會建立任務或喚醒 Hermes。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製預填判讀失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理預填判讀。",
        tone: "warn",
      });
    }
  }

  async function copyHermesStageFourReadyHandoffMarkdown() {
    const lines = [
      "## Hermes 第 4 階 READY 交接",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 用途：喚醒前預填判讀為 READY TO PREFILL 後，只交接到預填 Sandbox/Test issue 草稿；這不是建立 issue、Run now、排程或喚醒授權。",
      "",
      "### READY 必須代表",
      "- [ ] Test environment pass。",
      "- [ ] Hermes Sandbox/Test 員工存在。",
      "- [ ] Sandbox/Test 專案存在。",
      "- [ ] 使用者已勾選 Sandbox/Test 確認。",
      "- [ ] Office 顯示可預填 issue 草稿。",
      "- [ ] 沒有 API key、token、密碼、完整 .env、正式專案、正式客戶資料、active/running/recovery 風險。",
      "",
      "### 下一步只允許",
      "- 開啟 Office 的預填 Sandbox/Test issue 草稿。",
      "- 檢查標題、描述、專案與負責人都只限 Sandbox/Test。",
      "- 使用 `複製建立前確認` 做送出前檢查。",
      "- 最後建立仍由使用者手動確認；Codex 不代按建立。",
      "",
      "### 仍然禁止",
      "- 不自動建立 issue、不代按建立。",
      "- 不 Run now、不啟用 schedule trigger、不打開 heartbeat scheduler。",
      "- 不連續喚醒、不接正式專案、不處理正式資料。",
      "- 不喚醒 Hermes 或其它本地模型；真正喚醒仍需使用者另行貼出一次性喚醒授權。",
      "",
      "### 交接結論",
      "- 判斷：READY TO PREFILL 只代表可開預填草稿。",
      "- 下一個安全動作：預填 Sandbox/Test issue 草稿，然後複製建立前確認。",
      "- 不是授權：不是建立授權、不是 Run now 授權、不是排程授權、不是喚醒授權。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製第 4 階 READY 交接",
        body: "READY 只代表可預填 Sandbox/Test issue 草稿，不代表建立或喚醒。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製第 4 階 READY 交接失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理 READY 交接。",
        tone: "warn",
      });
    }
  }

  async function copyHermesPostWakeupReviewMarkdown() {
    const lines = [
      "## Hermes 喚醒後覆盤回報",
      "",
      "這份回報只整理第一次 Sandbox/Test Hermes 喚醒後的結果，不代表可以接正式專案、啟用排程或連續 Run now。",
      "",
      "### 本次沙盒喚醒",
      `- Hermes Sandbox 員工：${hermesSandboxAgent?.name ?? "尚未確認"}`,
      `- Sandbox/Test 專案：${hermesSandboxProject?.name ?? "尚未確認"}`,
      `- 覆盤紀錄：${hermesWakeReviewCards.find((card) => card.label === "覆盤紀錄")?.value ?? "尚未找到"}`,
      "",
      "### 喚醒後四項檢查",
      ...hermesWakeReviewCards.map((card) => `- ${card.label}（${card.status}）：${card.value}。${card.detail}`),
      "",
      "### 使用者覆盤欄位",
      ...HERMES_POST_WAKEUP_REVIEW_FIELDS.map((field) => `- [ ] ${field.label}：${field.detail}`),
      "",
      "### 結論",
      "- 本次結果：通過 / 需覆盤 / 先暫停",
      "- 可以進下一步嗎：可以繼續 Sandbox/Test / 只可修設定 / 不可繼續",
      "- 需要 Codex 協助：解讀回覆 / 看 recovery issue / 修正設定 / 重新整理檢查表",
      "",
      "### 固定停手線",
      "- 若員工卡在 running/error，先不要建立下一個 issue。",
      "- 若有 queued/running live runs 殘留，先不要 Run now。",
      "- 若出現 recovery issues，先覆盤原因，不進正式專案。",
      "- 若回覆含 API key、token、密碼、完整 .env 或私密設定，立即停止並不要貼出敏感內容。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製喚醒後覆盤",
        body: "沙盒喚醒後覆盤回報已放到剪貼簿；先判斷是否乾淨，再決定下一步。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製喚醒後覆盤失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 整理喚醒後結果。",
        tone: "warn",
      });
    }
  }

  async function copyHermesPostWakeupReviewDecisionMarkdown() {
    const lines = [
      "## Hermes 喚醒後覆盤判讀",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 用途：整理一次性 Sandbox/Test Hermes 喚醒後的覆盤結果；這不是下一個 Hermes 任務授權。",
      "",
      "### 請貼非敏感覆盤摘要",
      `- Hermes Sandbox 員工：${hermesSandboxAgent?.name ?? "尚未確認"}`,
      `- Sandbox/Test 專案：${hermesSandboxProject?.name ?? "尚未確認"}`,
      `- 覆盤紀錄：${hermesWakeReviewCards.find((card) => card.label === "覆盤紀錄")?.value ?? "尚未找到"}`,
      ...hermesWakeReviewCards.map((card) => `- ${card.label}：${card.status} / ${card.value}`),
      "",
      "### 判讀規則",
      "- CLEAN：Hermes 回覆可讀可追溯、沒有憑證外洩、員工沒有 running/error、沒有 queued/running live runs、沒有 recovery issues。",
      "- WAIT：回覆或狀態尚未更新、還看不到覆盤 issue、需要等待或只讀重新檢查。",
      "- PAUSE：員工 running/error、queued/running live runs、recovery issues、密鑰外洩、正式資料、正式專案或任何自動化擴張訊號。",
      "",
      "### 若判讀 CLEAN",
      "- 只代表這一次 Sandbox/Test 喚醒可記錄為乾淨。",
      "- 先把結果記錄到今天進度與驗收清單。",
      "- 不直接建立下一個 issue，不再次喚醒 Hermes。",
      "- 若要下一個 Hermes 任務，必須重新走 Sandbox/Test 範圍與授權流程。",
      "",
      "### 若判讀 WAIT",
      "- 等待或只讀重新檢查。",
      "- 不建立下一個 issue，不 Run now，不啟用排程。",
      "- 不把不完整結果當成成功。",
      "",
      "### 若判讀 PAUSE",
      "- 停止 Hermes 後續動作。",
      "- 先覆盤原因，不貼出敏感內容。",
      "- 不進正式專案，不再次喚醒，不接續任何自動化。",
      "",
      "### 固定停手線",
      "- 覆盤判讀不是下一次喚醒授權。",
      "- CLEAN 不是下一次喚醒授權。",
      "- 不 Run now、不啟用 schedule trigger、不打開 heartbeat scheduler。",
      "- 不連續喚醒、不建立第二個 issue、不接正式專案。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製覆盤判讀",
        body: "覆盤結果判讀已放到剪貼簿；CLEAN 也先停下記錄，不直接進下一個任務。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製覆盤判讀失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理覆盤判讀。",
        tone: "warn",
      });
    }
  }

  async function copyHermesPostWakeupCleanRecordMarkdown() {
    const lines = [
      "## Hermes 覆盤 CLEAN 記錄交接",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 用途：喚醒後覆盤判讀為 CLEAN 時，把本次結果寫入進度與驗收清單；這不是下一次 Hermes 任務授權。",
      "",
      "### CLEAN 記錄前提",
      "- [ ] 覆盤判讀是 CLEAN。",
      "- [ ] Hermes 回覆可讀、可追溯，且沒有憑證外洩。",
      "- [ ] Hermes 員工沒有 running/error。",
      "- [ ] 沒有 queued/running live runs。",
      "- [ ] 沒有 recovery issues。",
      "- [ ] 沒有正式資料、正式專案、Run now、排程或連續喚醒訊號。",
      "",
      "### 必須記錄到",
      "- [ ] 今日進度紀錄。",
      "- [ ] 驗收檢查表。",
      "- [ ] Hermes SOP 的實測備註或後續待辦。",
      "- [ ] 若有截圖或 issue 連結，只記非敏感摘要，不貼 API key、token、密碼或完整 .env。",
      "",
      "### 記錄結論格式",
      "- 本次 Sandbox/Test Hermes 喚醒：CLEAN。",
      "- 回覆可讀：是 / 否。",
      "- 員工狀態：乾淨 / 需覆盤。",
      "- live runs / recovery：乾淨 / 需覆盤。",
      "- 下一步：停下；若要下一個 Hermes 任務，重新走 Sandbox/Test 範圍與授權流程。",
      "",
      "### 固定停手線",
      "- CLEAN 記錄不是下一次喚醒授權。",
      "- 不建立第二個 issue、不再次喚醒 Hermes。",
      "- 不 Run now、不啟用 schedule trigger、不打開 heartbeat scheduler。",
      "- 不接正式專案、不處理正式資料、不連續喚醒。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製 CLEAN 記錄交接",
        body: "CLEAN 結果記錄交接已放到剪貼簿；它不是下一次喚醒授權。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製 CLEAN 記錄交接失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理 CLEAN 記錄。",
        tone: "warn",
      });
    }
  }

  async function copyHermesPostWakeupWaitPauseHandlingMarkdown() {
    const lines = [
      "## Hermes 覆盤 WAIT/PAUSE 處理交接",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 用途：喚醒後覆盤判讀為 WAIT 或 PAUSE 時，固定下一步處理；這不是重試授權，也不是下一個 Hermes 任務授權。",
      "",
      "### WAIT 代表",
      "- 回覆或狀態尚未更新。",
      "- 還看不到覆盤 issue。",
      "- 喚醒後檢查面板仍需要等待或只讀重新檢查。",
      "- 沒有明確錯誤，但資料不足以判斷 CLEAN。",
      "",
      "### WAIT 只允許",
      "- 等待狀態更新。",
      "- 只讀重新檢查喚醒後檢查面板。",
      "- 補非敏感摘要到覆盤紀錄。",
      "- 不建立下一個 issue，不再次喚醒，不 Run now，不啟用排程。",
      "",
      "### PAUSE 代表",
      "- 員工 running/error。",
      "- queued/running live runs 殘留。",
      "- recovery issues 出現或未覆盤。",
      "- 回覆疑似包含 API key、token、密碼、完整 .env、私密 URL、正式客戶或公司資料。",
      "- 出現正式專案、第二個 issue、連續喚醒、Run now 或 schedule trigger 要求。",
      "",
      "### PAUSE 只允許",
      "- 停止 Hermes 後續動作。",
      "- 記錄非敏感症狀與時間點。",
      "- 回到預覽/後端健康檢查或 recovery issue 覆盤。",
      "- 需要時請使用者貼出不含憑證的錯誤摘要。",
      "",
      "### 固定停手線",
      "- WAIT/PAUSE 都不是下一次喚醒授權。",
      "- 不建立第二個 issue、不再次喚醒 Hermes。",
      "- 不 Run now、不啟用 schedule trigger、不打開 heartbeat scheduler。",
      "- 不接正式專案、不處理正式資料、不連續喚醒。",
      "- 不貼出、不整理 API key、token、密碼或完整 .env。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製 WAIT/PAUSE 處理",
        body: "WAIT/PAUSE 處理交接已放到剪貼簿；不會重試或喚醒 Hermes。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製 WAIT/PAUSE 處理失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理 WAIT/PAUSE 處理。",
        tone: "warn",
      });
    }
  }

  async function copyHermesNextTaskRestartEntryMarkdown() {
    const lines = [
      "## Hermes 下一任務重啟入口",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 用途：完成一次性 Sandbox/Test 喚醒覆盤後，若要開始下一個 Hermes 任務，先重新建立安全入口；這不是下一次喚醒授權。",
      "",
      "### 進入前提",
      "- [ ] 上一次喚醒後覆盤已完成。",
      "- [ ] 若上次判讀是 CLEAN，已完成 `CLEAN 記錄`。",
      "- [ ] 若上次判讀是 WAIT/PAUSE，已完成 WAIT/PAUSE 處理，不再往下一個任務前進。",
      "- [ ] 沒有 Hermes running/error 員工。",
      "- [ ] 沒有 queued/running live runs 或未覆盤 recovery issues。",
      "",
      "### 下一個 Hermes 任務必須重新確認",
      "- [ ] 任務仍屬於 Sandbox/Test。",
      "- [ ] 只鎖定單一 Sandbox/Test issue。",
      "- [ ] 只指派單一 Hermes Sandbox/Test 員工。",
      "- [ ] 任務描述沒有 API key、token、密碼、完整 .env、私密 URL、正式客戶或公司資料。",
      "- [ ] 使用者重新貼出新的明確授權句；不能沿用上一次授權。",
      "",
      "### 下一步只允許",
      "- 回到第 4 階喚醒前檢查。",
      "- 重新做預填判讀、建立前確認、建立後觀察、授權句檢查與喚醒前最後確認。",
      "- 每次只處理一個 Sandbox/Test 任務。",
      "",
      "### 固定停手線",
      "- 重新走 Sandbox/Test 範圍與授權流程。",
      "- 上一次 CLEAN 不是下一次授權。",
      "- 上一次授權句不可沿用。",
      "- 不 Run now、不啟用 schedule trigger、不打開 heartbeat scheduler。",
      "- 不連續喚醒、不建立多個 issue、不接正式專案。",
      "- 不處理正式資料、不貼出或整理密鑰。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製下一任務重啟入口",
        body: "下一個 Hermes 任務必須重新走 Sandbox/Test 檢查與授權流程。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製下一任務重啟入口失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理下一任務入口。",
        tone: "warn",
      });
    }
  }

  async function copyHermesSandboxCycleSummaryMarkdown() {
    const lines = [
      "## Hermes 沙盒循環總結",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 用途：彙整一次 Sandbox/Test Hermes 任務循環的狀態、覆盤結果與下一個安全動作；這不是下一次喚醒授權。",
      "",
      "### 本次範圍",
      `- Hermes Sandbox 員工：${hermesSandboxAgent?.name ?? "尚未確認"}`,
      `- Sandbox/Test 專案：${hermesSandboxProject?.name ?? "尚未確認"}`,
      `- 覆盤紀錄：${hermesWakeReviewCards.find((card) => card.label === "覆盤紀錄")?.value ?? "尚未找到"}`,
      "",
      "### 循環狀態",
      "- [ ] 已完成喚醒前最後確認。",
      "- [ ] 已完成一次性喚醒執行交接。",
      "- [ ] 已完成喚醒完成停手。",
      "- [ ] 已完成喚醒後覆盤回報。",
      "- [ ] 已完成覆盤判讀：CLEAN / WAIT / PAUSE。",
      "",
      "### 喚醒後訊號",
      ...hermesWakeReviewCards.map((card) => `- ${card.label}（${card.status}）：${card.value}。${card.detail}`),
      "",
      "### 下一個安全動作",
      "- 若 CLEAN：先完成 CLEAN 記錄，不進下一個任務。",
      "- 若 WAIT：等待或只讀重新檢查，不建立下一個 issue。",
      "- 若 PAUSE：停下排查，不再次喚醒 Hermes。",
      "- 若要下一個 Hermes 任務：重新走 Sandbox/Test 範圍與授權流程。",
      "",
      "### 固定停手線",
      "- 本總結不是下一次喚醒授權。",
      "- 上一次 CLEAN 不是下一次授權。",
      "- 上一次授權句不可沿用。",
      "- 不 Run now、不啟用 schedule trigger、不打開 heartbeat scheduler。",
      "- 不連續喚醒、不建立多個 issue、不接正式專案。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製沙盒循環總結",
        body: "Hermes Sandbox/Test 循環總結已放到剪貼簿；它不是下一次喚醒授權。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製沙盒循環總結失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理循環總結。",
        tone: "warn",
      });
    }
  }

  async function copyHermesAuthorizationControlMarkdown() {
    const lines = [
      "## Hermes 授權總控狀態",
      "",
      "這份總控只整理目前停在哪一階與下一個最小安全動作；它不是安裝授權、不是憑證授權、不是 Run now 授權，也不是模型喚醒授權。",
      "",
      "### 階段狀態",
      ...hermesAuthorizationControlCards.map((card) => `- 第 ${card.level} 階 ${card.title}（${card.status}）：${card.detail}`),
      "",
      "### 下一個最小安全動作",
      `- ${hermesInstallNextSafeStep.status}：${hermesInstallNextSafeStep.value}`,
      `- ${hermesInstallNextSafeStep.detail}`,
      "",
      "### 固定停手線",
      "- 沒有明確授權階級時，只停在第 0 階只讀準備。",
      "- 第 1 階只列命令，不執行。",
      "- 第 2 階只執行逐條同意的命令，不填憑證、不 Run now、不喚醒。",
      "- 第 3 階只看非敏感設定狀態，不貼 API key、token、密碼或完整 .env。",
      "- 第 4 階只可使用 Sandbox/Test；Office 最多預填 issue 草稿，不自動建立、不連續喚醒、不啟用排程。",
      "- 喚醒後若訊號不乾淨，先覆盤，不進正式專案。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製授權總控",
        body: "Hermes 階段狀態與下一個最小安全動作已放到剪貼簿。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製授權總控失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 整理目前階段。",
        tone: "warn",
      });
    }
  }

  async function copyHermesStartReadinessMarkdown() {
    const lines = [
      "## Hermes 開始設定判斷",
      "",
      "開始設定或第一次沙盒喚醒前，請先確認這些項目：",
      "",
      ...hermesStartReadinessCards.map((card) => `- [ ] ${card.label}（${card.status}）：${card.value}。${card.detail}`),
      "",
      "### 安全邊界",
      "- office:verify 沒通過前，不建立 issue、不同步正式員工、不 Run now。",
      "- 條件未齊前，只做設定與檢查，不喚醒 Hermes 或其它本地模型。",
      "- 即使條件都通過，也必須由使用者手動勾選確認，才可預填第一次喚醒 issue。",
      "- API key、token、密碼不要寫進文件、prompt、skills 或 issue。",
      "- 第一次喚醒只使用 Sandbox/Test issue，不接正式專案或自動排程。",
      "",
      "### 決定",
      "- [ ] 可以開始 Sandbox/Test 設定或第一次喚醒。",
      "- [ ] 先暫緩，補齊上面未通過項目。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製 Hermes 開始判斷",
        body: "Hermes 前置檢查與安全邊界已放到剪貼簿。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 複製前置檢查。",
        tone: "warn",
      });
    }
  }

  async function copyHermesAccessModeDecisionMarkdown() {
    const lines = [
      "## Hermes 接入模式選擇",
      "",
      "用途：先決定 Virtual Office 要接本機 Hermes、遠端 Hermes API，或暫時不接。這不是安裝、連線或憑證授權。",
      "",
      "### 可選模式",
      ...HERMES_ACCESS_MODE_OPTIONS.flatMap((mode) => [
        `- ${mode.label}（${mode.status}）`,
        `  - 說明：${mode.detail}`,
        `  - 下一個安全動作：${mode.safeNextStep}`,
      ]),
      "",
      "### 建議判斷",
      "- 如果要自己學安裝與本地模型，選本機 Hermes，但先走 WSL2 / bridge 的命令預覽與逐條同意。",
      "- 如果已有團隊維護 Hermes server，才評估遠端 Hermes API；Office 不保存 API key、token 或密碼。",
      "- 如果還不確定，選尚未決定，維持第 0 階只讀準備。",
      "",
      "### 固定禁止",
      "- 不執行一鍵安裝腳本。",
      "- 不連線遠端 Hermes API。",
      "- 不填 API key、token、密碼或完整 .env。",
      "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
      "- 不喚醒 Hermes 或其它本地模型。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製接入判斷",
        body: "Hermes 本機/遠端/未決定的接入判斷已放到剪貼簿；這不是安裝或連線授權。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製接入判斷失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理接入模式。",
        tone: "warn",
      });
    }
  }

  async function copyHermesSetupGuideMarkdown() {
    const lines = [
      "## Hermes WSL2 設定指引",
      "",
      "這份指引只用來人工確認與交接，不會自動安裝、不會填 API key、不會喚醒模型。",
      "",
      "### 目前設定路線",
      ...hermesSetupGuideCards.map((step) => [
        `- [ ] ${step.label}（${step.status}）`,
        `  - 指令或入口：${step.command}`,
        `  - 說明：${step.detail}`,
      ].join("\n")),
      "",
      "### 安全邊界",
      "- 先跑 office:verify，確認 Backend OK / Frontend OK。",
      "- API key、token、密碼不要寫進 Paperclip 文件、prompt、skills 或 issue。",
      "- 設定模型與憑證時只使用 Hermes 自己的互動設定或本機安全儲存。",
      "- 狀態未通過前，不建立喚醒 issue、不 Run now、不喚醒 Hermes。",
      "- 真要第一次喚醒前，還要回 Office 勾選使用者確認。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製 Hermes 設定指引",
        body: "WSL2 設定路線、命令與安全邊界已放到剪貼簿。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 複製設定步驟。",
        tone: "warn",
      });
    }
  }

  async function copyHermesPreInstallPackageMarkdown() {
    const lines = [
      "## Hermes 安裝前最後檢查包",
      "",
      "目標：做到安裝 Hermes 的前一刻，但不自動安裝、不填 API key、不喚醒模型。",
      "",
      ...HERMES_PRE_INSTALL_PACKAGE.flatMap((group) => [
        `### ${group.title}（${group.status}）`,
        ...group.items.map((item) => `- [ ] ${item}`),
        "",
      ]),
      "### 使用者確認",
      "- [ ] 我確認要開始安裝或設定 Hermes。",
      "- [ ] 我知道 API key、token、密碼不能貼進文件、prompt、skills、issue 或聊天紀錄。",
      "- [ ] 我知道安裝完成後仍需回 Office 重新檢查，不會直接喚醒 Hermes。",
      "",
      "### 停止條件",
      "- office:verify 沒通過。",
      "- WSL2/Ubuntu 或 Hermes 命令輸出不清楚。",
      "- 任何畫面要求輸入或顯示私密憑證。",
      "- 不確定是否會建立正式任務、Run now、schedule trigger 或喚醒 Hermes。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製安裝前檢查包",
        body: "Hermes 安裝前最後檢查與停止條件已放到剪貼簿。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 複製安裝前檢查。",
        tone: "warn",
      });
    }
  }

  async function copyHermesInstallAuthorizationPrompt() {
    try {
      await navigator.clipboard.writeText(HERMES_INSTALL_AUTHORIZATION_PROMPT);
      pushToast({
        title: "已複製 Hermes 安裝授權",
        body: "開始安裝前要貼給 Codex 的授權文字已放到剪貼簿。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 複製授權文字。",
        tone: "warn",
      });
    }
  }

  async function copyHermesInstallAuthorizationIntakeCheck() {
    try {
      await navigator.clipboard.writeText(HERMES_INSTALL_AUTHORIZATION_INTAKE_TEMPLATE);
      pushToast({
        title: "已複製安裝授權句檢查",
        body: "安裝授權貼出前確認已放到剪貼簿；未 ACCEPT 前不安裝、不設定、不喚醒。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製授權句檢查失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理安裝授權判斷。",
        tone: "warn",
      });
    }
  }

  async function copyHermesInstallAuthorizationWaitPauseMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_INSTALL_AUTHORIZATION_WAIT_PAUSE_TEMPLATE);
      pushToast({
        title: "已複製授權 WAIT/PAUSE",
        body: "Hermes 安裝授權 WAIT/PAUSE 處理已放到剪貼簿；未 ACCEPT 前不安裝、不重試。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製授權 WAIT/PAUSE 失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理授權 WAIT/PAUSE 處理。",
        tone: "warn",
      });
    }
  }

  async function copyHermesInstallAuthorizationAcceptHandoff() {
    const lines = [
      "## Hermes 安裝授權 ACCEPT 交接",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 用途：安裝授權句檢查為 ACCEPT 後，交接到逐條命令陪同；這不擴張任何授權範圍。",
      "- 狀態：只允許進入 Hermes 安裝或設定陪同；尚未授權填憑證、建立喚醒 issue、Run now、排程或喚醒模型。",
      "",
      "### ACCEPT 前提",
      "- [ ] `複製授權句檢查` 判斷為 ACCEPT。",
      "- [ ] `複製二次確認` 判斷為 GO。",
      "- [ ] 已跑 office:verify，Backend OK / Frontend OK。",
      "- [ ] 已複製命令預覽或命令表單，下一步命令目的與風險已列出。",
      "",
      "### 下一步只允許",
      "- 逐條確認命令。",
      "- 只執行使用者明確同意的單一命令。",
      "- 每條命令完成後記錄結果、是否含敏感資訊、是否需要停下。",
      "- 若需要下一條命令，先更新逐條同意紀錄，再等使用者確認。",
      "",
      "### 仍然禁止",
      "- 不自動填 API key、token、密碼或完整 .env。",
      "- 不把憑證貼進聊天、文件、prompt、skills、issue 或 Office。",
      "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
      "- 不喚醒 Hermes 或其它本地模型。",
      "- 不把一次 ACCEPT 當成全部後續命令同意。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製 ACCEPT 交接",
        body: "Hermes 安裝授權 ACCEPT 後交接已放到剪貼簿；只進逐條命令陪同，不填憑證、不喚醒。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製 ACCEPT 交接失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理 ACCEPT 後交接。",
        tone: "warn",
      });
    }
  }

  async function copyHermesAcceptFirstCommandPreviewMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_ACCEPT_FIRST_COMMAND_PREVIEW_TEMPLATE);
      pushToast({
        title: "已複製第一命令預覽",
        body: "HERMES-INSTALL-001 預覽卡已放到剪貼簿；ACCEPT 後仍只列一條命令，不執行。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製第一命令預覽失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理第一命令預覽。",
        tone: "warn",
      });
    }
  }

  async function copyHermesInstallFirstCommandConsentMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_INSTALL_FIRST_COMMAND_CONSENT_TEMPLATE);
      pushToast({
        title: "已複製第一命令同意",
        body: "HERMES-INSTALL-001 單一命令同意卡已放到剪貼簿；它只允許這一條命令，不延伸下一條。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製第一命令同意失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理 HERMES-INSTALL-001 同意卡。",
        tone: "warn",
      });
    }
  }

  async function copyHermesInstallFirstCommandResultMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_INSTALL_FIRST_COMMAND_RESULT_TEMPLATE);
      pushToast({
        title: "已複製第一命令結果",
        body: "HERMES-INSTALL-001 結果回報卡已放到剪貼簿；未回報 PASS/WAIT/PAUSE 前不跑下一條。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製第一命令結果失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理 HERMES-INSTALL-001 結果。",
        tone: "warn",
      });
    }
  }

  async function copyHermesInstallFirstCommandDecisionMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_INSTALL_FIRST_COMMAND_DECISION_TEMPLATE);
      pushToast({
        title: "已複製第一命令判讀",
        body: "HERMES-INSTALL-001 結果判讀卡已放到剪貼簿；PASS 也不是下一條命令授權。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製第一命令判讀失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理 HERMES-INSTALL-001 判讀。",
        tone: "warn",
      });
    }
  }

  async function copyHermesInstallFirstCommandCycleSummaryMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_INSTALL_FIRST_COMMAND_CYCLE_SUMMARY_TEMPLATE);
      pushToast({
        title: "已複製第一命令循環總結",
        body: "HERMES-INSTALL-001 循環總結已放到剪貼簿；它只做交接，不授權下一條命令。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製第一命令循環總結失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理 HERMES-INSTALL-001 循環總結。",
        tone: "warn",
      });
    }
  }

  async function copyHermesInstallNextCommandPreviewMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_INSTALL_NEXT_COMMAND_PREVIEW_TEMPLATE);
      pushToast({
        title: "已複製第二命令預覽",
        body: "HERMES-INSTALL-002 候選命令預覽已放到剪貼簿；只列一條，不執行。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製第二命令預覽失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理 HERMES-INSTALL-002 預覽。",
        tone: "warn",
      });
    }
  }

  async function copyHermesInstallSecondCommandConsentMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_INSTALL_SECOND_COMMAND_CONSENT_TEMPLATE);
      pushToast({
        title: "已複製第二命令同意",
        body: "HERMES-INSTALL-002 單一命令同意卡已放到剪貼簿；它只允許這一條命令，不延伸下一條。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製第二命令同意失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理 HERMES-INSTALL-002 同意卡。",
        tone: "warn",
      });
    }
  }

  async function copyHermesInstallSecondCommandResultMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_INSTALL_SECOND_COMMAND_RESULT_TEMPLATE);
      pushToast({
        title: "已複製第二命令結果",
        body: "HERMES-INSTALL-002 結果回報卡已放到剪貼簿；未回報 PASS/WAIT/PAUSE 前不跑下一條。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製第二命令結果失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理 HERMES-INSTALL-002 結果。",
        tone: "warn",
      });
    }
  }

  async function copyHermesInstallSecondCommandDecisionMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_INSTALL_SECOND_COMMAND_DECISION_TEMPLATE);
      pushToast({
        title: "已複製第二命令判讀",
        body: "HERMES-INSTALL-002 結果判讀卡已放到剪貼簿；PASS 也不是下一條命令授權。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製第二命令判讀失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理 HERMES-INSTALL-002 判讀。",
        tone: "warn",
      });
    }
  }

  async function copyHermesInstallSecondCommandCycleSummaryMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_INSTALL_SECOND_COMMAND_CYCLE_SUMMARY_TEMPLATE);
      pushToast({
        title: "已複製第二命令循環總結",
        body: "HERMES-INSTALL-002 循環總結已放到剪貼簿；它只做交接，不授權下一條命令。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製第二命令循環總結失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理 HERMES-INSTALL-002 循環總結。",
        tone: "warn",
      });
    }
  }

  async function copyHermesInstallThirdCommandPreviewMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_INSTALL_THIRD_COMMAND_PREVIEW_TEMPLATE);
      pushToast({
        title: "已複製第三命令預覽",
        body: "HERMES-INSTALL-003 候選命令預覽已放到剪貼簿；只列一條，不執行。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製第三命令預覽失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理 HERMES-INSTALL-003 預覽。",
        tone: "warn",
      });
    }
  }

  async function copyHermesInstallThirdCommandConsentMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_INSTALL_THIRD_COMMAND_CONSENT_TEMPLATE);
      pushToast({
        title: "已複製第三命令同意",
        body: "HERMES-INSTALL-003 單一命令同意卡已放到剪貼簿；它只允許這一條命令，不延伸下一條。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製第三命令同意失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理 HERMES-INSTALL-003 同意卡。",
        tone: "warn",
      });
    }
  }

  async function copyHermesInstallThirdCommandResultMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_INSTALL_THIRD_COMMAND_RESULT_TEMPLATE);
      pushToast({
        title: "已複製第三命令結果",
        body: "HERMES-INSTALL-003 結果回報卡已放到剪貼簿；未回報 PASS/WAIT/PAUSE 前不跑下一條。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製第三命令結果失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理 HERMES-INSTALL-003 結果。",
        tone: "warn",
      });
    }
  }

  async function copyHermesInstallThirdCommandDecisionMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_INSTALL_THIRD_COMMAND_DECISION_TEMPLATE);
      pushToast({
        title: "已複製第三命令判讀",
        body: "HERMES-INSTALL-003 結果判讀卡已放到剪貼簿；PASS 也不是下一條命令授權。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製第三命令判讀失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理 HERMES-INSTALL-003 判讀。",
        tone: "warn",
      });
    }
  }

  async function copyHermesInstallThirdCommandCycleSummaryMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_INSTALL_THIRD_COMMAND_CYCLE_SUMMARY_TEMPLATE);
      pushToast({
        title: "已複製第三命令循環總結",
        body: "HERMES-INSTALL-003 循環總結已放到剪貼簿；它只做交接，不授權下一條命令。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製第三命令循環總結失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理 HERMES-INSTALL-003 循環總結。",
        tone: "warn",
      });
    }
  }

  async function copyHermesInstallFourthCommandPreviewMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_INSTALL_FOURTH_COMMAND_PREVIEW_TEMPLATE);
      pushToast({
        title: "已複製第四命令預覽",
        body: "HERMES-INSTALL-004 候選命令預覽已放到剪貼簿；只列一條，不執行。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製第四命令預覽失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理 HERMES-INSTALL-004 預覽。",
        tone: "warn",
      });
    }
  }

  async function copyHermesInstallFourthCommandConsentMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_INSTALL_FOURTH_COMMAND_CONSENT_TEMPLATE);
      pushToast({
        title: "已複製第四命令同意",
        body: "HERMES-INSTALL-004 單一命令同意卡已放到剪貼簿；它只允許這一條命令，不延伸下一條。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製第四命令同意失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理 HERMES-INSTALL-004 同意卡。",
        tone: "warn",
      });
    }
  }

  async function copyHermesInstallFourthCommandResultMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_INSTALL_FOURTH_COMMAND_RESULT_TEMPLATE);
      pushToast({
        title: "已複製第四命令結果",
        body: "HERMES-INSTALL-004 結果回報卡已放到剪貼簿；未回報 PASS/WAIT/PAUSE 前不跑下一條。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製第四命令結果失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理 HERMES-INSTALL-004 結果。",
        tone: "warn",
      });
    }
  }

  async function copyHermesInstallFourthCommandDecisionMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_INSTALL_FOURTH_COMMAND_DECISION_TEMPLATE);
      pushToast({
        title: "已複製第四命令判讀",
        body: "HERMES-INSTALL-004 結果判讀卡已放到剪貼簿；PASS 也不是下一條命令授權。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製第四命令判讀失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理 HERMES-INSTALL-004 判讀。",
        tone: "warn",
      });
    }
  }

  async function copyHermesInstallFourthCommandCycleSummaryMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_INSTALL_FOURTH_COMMAND_CYCLE_SUMMARY_TEMPLATE);
      pushToast({
        title: "已複製第四命令循環總結",
        body: "HERMES-INSTALL-004 循環總結已放到剪貼簿；它只做交接，不授權下一條命令。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製第四命令循環總結失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理 HERMES-INSTALL-004 循環總結。",
        tone: "warn",
      });
    }
  }

  async function copyHermesInstallFifthCommandPreviewMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_INSTALL_FIFTH_COMMAND_PREVIEW_TEMPLATE);
      pushToast({
        title: "已複製第五命令預覽",
        body: "HERMES-INSTALL-005 候選命令預覽已放到剪貼簿；只列一條，不執行。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製第五命令預覽失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理 HERMES-INSTALL-005 預覽。",
        tone: "warn",
      });
    }
  }

  async function copyHermesInstallFifthCommandConsentMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_INSTALL_FIFTH_COMMAND_CONSENT_TEMPLATE);
      pushToast({
        title: "已複製第五命令同意",
        body: "HERMES-INSTALL-005 單一命令同意卡已放到剪貼簿；它只允許這一條命令，不延伸下一條。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製第五命令同意失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理 HERMES-INSTALL-005 同意卡。",
        tone: "warn",
      });
    }
  }

  async function copyHermesInstallFifthCommandResultMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_INSTALL_FIFTH_COMMAND_RESULT_TEMPLATE);
      pushToast({
        title: "已複製第五命令結果",
        body: "HERMES-INSTALL-005 結果回報卡已放到剪貼簿；未回報 PASS/WAIT/PAUSE 前不跑下一條。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製第五命令結果失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理 HERMES-INSTALL-005 結果。",
        tone: "warn",
      });
    }
  }

  async function copyHermesInstallFifthCommandDecisionMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_INSTALL_FIFTH_COMMAND_DECISION_TEMPLATE);
      pushToast({
        title: "已複製第五命令判讀",
        body: "HERMES-INSTALL-005 結果判讀卡已放到剪貼簿；PASS 也不是下一條命令授權。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製第五命令判讀失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理 HERMES-INSTALL-005 判讀。",
        tone: "warn",
      });
    }
  }

  async function copyHermesAuthorizationSecondCheck() {
    try {
      await navigator.clipboard.writeText(HERMES_AUTHORIZATION_SECOND_CHECK_TEMPLATE);
      pushToast({
        title: "已複製二次確認卡",
        body: "Hermes 授權前 GO/PAUSE 二次確認已放到剪貼簿；它不允許直接安裝或喚醒。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製二次確認失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 複製二次確認項目。",
        tone: "warn",
      });
    }
  }

  async function copyHermesInstallFinalGateMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_INSTALL_FINAL_GATE_TEMPLATE);
      pushToast({
        title: "已複製最終閘門",
        body: "Hermes 安裝前最終閘門已放到剪貼簿；GO 也只代表可請使用者決定是否貼出安裝授權。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製最終閘門失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理安裝前最終閘門。",
        tone: "warn",
      });
    }
  }

  async function copyHermesInstallFinalGateDecisionMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_INSTALL_FINAL_GATE_DECISION_TEMPLATE);
      pushToast({
        title: "已複製閘門判斷",
        body: "Hermes 最終閘門 GO/PAUSE 回覆卡已放到剪貼簿；GO 仍不是安裝授權。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製閘門判斷失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理最終閘門判斷。",
        tone: "warn",
      });
    }
  }

  async function copyHermesInstallFinalGateGoHandoffMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_INSTALL_FINAL_GATE_GO_HANDOFF_TEMPLATE);
      pushToast({
        title: "已複製 GO 後交接",
        body: "Hermes 最終閘門 GO 後交接已放到剪貼簿；GO 後仍只讓使用者決定是否貼授權文字。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製 GO 後交接失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理 GO 後交接。",
        tone: "warn",
      });
    }
  }

  async function copyHermesInstallFinalGatePauseHandoffMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_INSTALL_FINAL_GATE_PAUSE_HANDOFF_TEMPLATE);
      pushToast({
        title: "已複製 PAUSE 修補交接",
        body: "Hermes 最終閘門 PAUSE 修補交接已放到剪貼簿；只補最小缺項，不重試、不安裝。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製 PAUSE 修補交接失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理 PAUSE 修補交接。",
        tone: "warn",
      });
    }
  }

  async function copyHermesAuthorizationLadderMarkdown() {
    const lines = [
      "## Hermes 授權階梯",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 用途：把 Hermes 前置、命令預覽、安裝、設定與沙盒測試分成逐階授權，避免一句「可以開始」被誤解成全部都能做。",
      "",
      ...HERMES_AUTHORIZATION_LADDER.flatMap((step) => [
        `### 第 ${step.level} 階：${step.title}`,
        `- 可以做：${step.allowed}`,
        `- 仍然禁止：${step.blocked}`,
        `- 使用者授權句：${step.userText}`,
        "",
      ]),
      "### 固定停手線",
      "- 沒有明確授權階級時，只能停在第 0 階。",
      "- 跨到下一階前，要先回報上一階結果與是否含敏感資訊。",
      "- 任何步驟要求 API key、token、密碼或完整 .env，都要停下來讓使用者自己在 Hermes 設定位置處理。",
      "- 第 4 階以前，不建立喚醒 issue、不 Run now、不啟用 schedule trigger、不喚醒 Hermes。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製授權階梯",
        body: "Hermes 逐階授權文字已放到剪貼簿；沒有明確階級時只停在只讀準備。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製授權階梯失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 複製授權階梯。",
        tone: "warn",
      });
    }
  }

  async function copyHermesInstallCompanionLog() {
    try {
      await navigator.clipboard.writeText(HERMES_INSTALL_COMPANION_LOG_TEMPLATE);
      pushToast({
        title: "已複製安裝陪同紀錄",
        body: "Hermes 安裝命令預覽、同意與結果紀錄表已放到剪貼簿。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 複製紀錄表。",
        tone: "warn",
      });
    }
  }

  async function copyHermesCommandPreviewRequest() {
    try {
      await navigator.clipboard.writeText(HERMES_COMMAND_PREVIEW_REQUEST_TEMPLATE);
      pushToast({
        title: "已複製命令預覽請求",
        body: "命令預覽格式已放到剪貼簿；它只要求先列命令，不允許直接執行或喚醒 Hermes。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製命令預覽請求失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 複製命令預覽格式。",
        tone: "warn",
      });
    }
  }

  async function copyHermesCommandPreviewForm() {
    try {
      await navigator.clipboard.writeText(HERMES_COMMAND_PREVIEW_FORM_TEMPLATE);
      pushToast({
        title: "已複製命令預覽表單",
        body: "第 1 階命令預覽表單已放到剪貼簿；它只允許列命令，不允許執行。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製命令預覽表單失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 複製第 1 階表單。",
        tone: "warn",
      });
    }
  }

  async function copyHermesCommandApprovalLog() {
    try {
      await navigator.clipboard.writeText(HERMES_COMMAND_APPROVAL_LOG_TEMPLATE);
      pushToast({
        title: "已複製逐條同意紀錄",
        body: "第 2 階逐條同意表已放到剪貼簿；每條命令都要單獨同意與回報結果。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製逐條同意紀錄失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 複製第 2 階紀錄。",
        tone: "warn",
      });
    }
  }

  async function copyHermesSingleCommandResultMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_SINGLE_COMMAND_RESULT_TEMPLATE);
      pushToast({
        title: "已複製命令結果回報",
        body: "單一命令執行後回報卡已放到剪貼簿；未回報 PASS/WAIT/PAUSE 前不跑下一條。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製命令結果回報失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理單一命令結果。",
        tone: "warn",
      });
    }
  }

  async function copyHermesSingleCommandDecisionMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_SINGLE_COMMAND_DECISION_TEMPLATE);
      pushToast({
        title: "已複製結果判讀",
        body: "命令結果判讀卡已放到剪貼簿；PASS 也不是下一條命令授權。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製結果判讀失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理命令結果判讀。",
        tone: "warn",
      });
    }
  }

  async function copyHermesSingleCommandPassHandoffMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_SINGLE_COMMAND_PASS_HANDOFF_TEMPLATE);
      pushToast({
        title: "已複製 PASS 後交接",
        body: "命令 PASS 後交接卡已放到剪貼簿；PASS 只代表本條乾淨，不授權下一條。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製 PASS 後交接失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理 PASS 後交接。",
        tone: "warn",
      });
    }
  }

  async function copyHermesSingleCommandWaitPauseMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_SINGLE_COMMAND_WAIT_PAUSE_TEMPLATE);
      pushToast({
        title: "已複製 WAIT/PAUSE 處理",
        body: "命令 WAIT/PAUSE 處理卡已放到剪貼簿；不重試、不跑下一條、不喚醒。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製 WAIT/PAUSE 處理失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理 WAIT/PAUSE 處理。",
        tone: "warn",
      });
    }
  }

  async function copyHermesInstallCompanionCycleSummaryMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_INSTALL_COMPANION_CYCLE_SUMMARY_TEMPLATE);
      pushToast({
        title: "已複製陪同循環總結",
        body: "Hermes 安裝陪同循環總結已放到剪貼簿；它只做交接，不授權下一條命令。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製陪同循環總結失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理陪同循環總結。",
        tone: "warn",
      });
    }
  }

  async function copyHermesInstallCompanionShutdownHandoffMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_INSTALL_COMPANION_SHUTDOWN_HANDOFF_TEMPLATE);
      pushToast({
        title: "已複製收工交接",
        body: "Hermes 安裝陪同收工交接已放到剪貼簿；明天需重新檢查與重新授權。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製收工交接失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理收工交接。",
        tone: "warn",
      });
    }
  }

  async function copyHermesInstallCompanionStartupResumeMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_INSTALL_COMPANION_STARTUP_RESUME_TEMPLATE);
      pushToast({
        title: "已複製開工接續",
        body: "Hermes 安裝陪同開工接續判斷已放到剪貼簿；先確認預覽與交接，再決定下一張安全卡。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製開工接續失敗",
        body: "瀏覽器暫時不能寫入剪貼簿，請改到 Hermes SOP 手動複製開工接續判斷。",
        tone: "warn",
      });
    }
  }

  async function copyHermesStartupNextCommandPreviewMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_STARTUP_NEXT_COMMAND_PREVIEW_TEMPLATE);
      pushToast({
        title: "已複製下一命令預覽",
        body: "開工後下一條命令預覽已放到剪貼簿；它只要求列一條候選命令，不允許執行。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製下一命令預覽失敗",
        body: "瀏覽器暫時不能寫入剪貼簿，請改到 Hermes SOP 手動複製下一條命令預覽格式。",
        tone: "warn",
      });
    }
  }

  async function copyHermesStartupSingleCommandApprovalMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_STARTUP_SINGLE_COMMAND_APPROVAL_TEMPLATE);
      pushToast({
        title: "已複製單一命令同意",
        body: "開工後單一命令同意卡已放到剪貼簿；它只允許 HERMES-NEXT-001 這一條命令。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製單一命令同意失敗",
        body: "瀏覽器暫時不能寫入剪貼簿，請改到 Hermes SOP 手動複製單一命令同意格式。",
        tone: "warn",
      });
    }
  }

  async function copyHermesStartupSingleCommandResultMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_STARTUP_SINGLE_COMMAND_RESULT_TEMPLATE);
      pushToast({
        title: "已複製單一命令結果",
        body: "HERMES-NEXT-001 結果回報卡已放到剪貼簿；未判讀前不允許執行下一條。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製單一命令結果失敗",
        body: "瀏覽器暫時不能寫入剪貼簿，請改到 Hermes SOP 手動整理單一命令結果。",
        tone: "warn",
      });
    }
  }

  async function copyHermesStartupSingleCommandDecisionMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_STARTUP_SINGLE_COMMAND_DECISION_TEMPLATE);
      pushToast({
        title: "已複製單一命令判讀",
        body: "HERMES-NEXT-001 判讀卡已放到剪貼簿；PASS 也只允許回到下一條命令預覽。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製單一命令判讀失敗",
        body: "瀏覽器暫時不能寫入剪貼簿，請改到 Hermes SOP 手動整理單一命令判讀。",
        tone: "warn",
      });
    }
  }

  async function copyHermesStartupSingleCommandCycleSummaryMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_STARTUP_SINGLE_COMMAND_CYCLE_SUMMARY_TEMPLATE);
      pushToast({
        title: "已複製單一命令循環總結",
        body: "HERMES-NEXT-001 循環總結已放到剪貼簿；它只做交接，不授權下一條命令。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製單一命令循環總結失敗",
        body: "瀏覽器暫時不能寫入剪貼簿，請改到 Hermes SOP 手動整理單一命令循環總結。",
        tone: "warn",
      });
    }
  }

  async function copyHermesFinalPreInstallHandoffMarkdown() {
    const lines = [
      "## Hermes 安裝前最後交接包",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 狀態：已準備到安裝前一刻；尚未安裝、尚未填憑證、尚未喚醒 Hermes。",
      "- 用途：交接給 Codex 或明天繼續時使用，提醒先做預覽與確認，不代表已授權安裝。",
      "",
      "### 已準備工具",
      "- 複製安裝前快照：記錄目前可開始前置檢查，但尚未跨過安裝線。",
      "- 複製安裝前檢查包：確認環境、資料保護、停止條件與驗收方式。",
      "- 複製命令預覽：要求 Codex 先列出每一條命令、目的、風險與會修改什麼。",
      "- 複製安裝授權：只有在使用者明確同意後，才可作為跨過安裝線的文字。",
      "- 複製陪同紀錄：逐條記錄命令、結果、風險與是否需要回復。",
      "- 複製設定回報：只回報 provider/model/Test environment 狀態，不貼任何密鑰。",
      "",
      "### 建議順序",
      "1. 先跑 pnpm run office:verify，確認 Backend OK / Frontend OK。",
      "2. 複製安裝前快照與安裝前檢查包，確認沒有資料庫或預覽阻塞。",
      "3. 先使用命令預覽請求，要求 Codex 只列命令表，不執行。",
      "4. 使用者逐條確認命令後，才可進入安裝或設定。",
      "5. 若需要填 API key、token、密碼或 .env，只在 Hermes 自己的設定位置處理，不貼進對話、文件、issue 或 Office。",
      "6. 安裝後只做健康檢查與 Test environment；不要建立喚醒 issue、不要 Run now、不要啟用 schedule trigger。",
      "",
      "### 下一個安全動作",
      `- 狀態：${hermesInstallNextSafeStep.status}`,
      `- 動作：${hermesInstallNextSafeStep.value}`,
      `- 說明：${hermesInstallNextSafeStep.detail}`,
      "",
      "### 風險判斷",
      ...hermesInstallRiskCards.map((card) => `- ${card.label}（${card.status}）：${card.value}。${card.detail}`),
      "",
      "### 停手線",
      "- 這不是安裝授權。",
      "- 不直接安裝、不下載套件、不寫檔、不改 PATH、不改設定。",
      "- 不要求貼 API key、token、密碼或完整 .env。",
      "- 不建立 issue、不 Run now、不啟用 schedule trigger。",
      "- 不喚醒 Hermes 或其它本地模型。",
      "- 任何會修改系統或專案的命令，都要先列出命令預覽並等使用者明確同意。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製最後交接包",
        body: "Hermes 安裝前最後交接包已放到剪貼簿；它只做交接與停手線，不代表安裝授權。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製最後交接包失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 與驗收清單整理交接內容。",
        tone: "warn",
      });
    }
  }

  async function copyHermesBeginnerInstallReadingOrderMarkdown() {
    const lines = [
      "## Hermes 新手安裝前閱讀順序",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 用途：給第一次使用 Hermes / local model 的新手照順序閱讀與複製，不代表安裝授權。",
      "- 狀態：仍停在安裝前；尚未安裝、尚未填憑證、尚未喚醒 Hermes。",
      "",
      "### 建議順序",
      ...HERMES_INSTALL_BEGINNER_READING_ORDER.map(
        (step) => `${step.step}. ${step.title}：${step.action}。${step.detail}`,
      ),
      "",
      "### 固定停手線",
      "- 這份閱讀順序不是安裝授權。",
      "- 不自動下載、不安裝、不寫檔、不改 PATH、不填 API key、token、密碼或完整 .env。",
      "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger、不喚醒 Hermes。",
      "- 使用者只說「繼續」「下一步」「可以」時，不等於安裝、設定或喚醒授權。",
      "- 需要跨過安裝線時，必須另行貼出明確的 Hermes 安裝授權文字。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製新手閱讀順序",
        body: "Hermes 安裝前閱讀順序已放到剪貼簿；它只整理路線，不代表安裝或喚醒授權。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製閱讀順序失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理安裝前閱讀順序。",
        tone: "warn",
      });
    }
  }

  async function copyHermesInstallReadySnapshot() {
    const lines = [
      "## Hermes 安裝前狀態快照",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 狀態：已準備到安裝前一刻；尚未安裝、尚未填憑證、尚未喚醒 Hermes。",
      "",
      "### 目前已準備",
      ...HERMES_INSTALL_READY_SNAPSHOT_ITEMS.map((item) => `- ${item.label}：${item.value}。${item.detail}`),
      "",
      "### 下一步順序",
      "1. 先跑 pnpm run office:verify，確認 Backend OK / Frontend OK。",
      "2. 複製安裝前檢查包，確認停止條件。",
      "3. 若要開始，複製安裝授權文字並貼給 Codex。",
      "4. 複製陪同紀錄，用來記錄每個命令。",
      "5. 每個命令都先預覽，使用者同意後才執行。",
      "",
      "### 仍然禁止",
      "- 不自動安裝。",
      "- 不自動填 API key、token、密碼。",
      "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
      "- 不喚醒 Hermes 或其它本地模型。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製安裝前快照",
        body: "Hermes 安裝前狀態與下一步順序已放到剪貼簿。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 複製狀態快照。",
        tone: "warn",
      });
    }
  }

  async function copyRoutineSafetyMarkdown() {
    const lines = [
      "## Routine / schedule 啟用前檢查表",
      "",
      `- routines：${routines.length} 個`,
      `- schedule triggers：${routineSafetyCards.find((card) => card.label === "Schedule trigger")?.value ?? "未讀取"}`,
      `- active routine issues：${routineSafetyCards.find((card) => card.label === "執行中的 routine")?.value ?? "未讀取"}`,
      "",
      "### 建立草稿前",
      "- [ ] routine 名稱含 Sandbox/Test，或描述明確標示只做測試。",
      "- [ ] 預設專案只選 Sandbox/Test 專案。",
      "- [ ] 預設員工只選測試員工，不選 Hermes 或正式主管。",
      "- [ ] 描述含覆盤欄位：完成了什麼、卡住在哪裡、需要使用者決定什麼、下一次是否可安全啟用。",
      "",
      "### 新增 trigger 前",
      "- [ ] 已讀 RoutineDetail 的 Virtual Office routine 安全門。",
      "- [ ] 已確認不會啟用正式 cron 或 webhook。",
      "- [ ] catch-up policy 不會補跑大量舊排程。",
      "- [ ] 如果只是測試，先保持 paused，不開 active。",
      "",
      "### 手動 Run now 前",
      "- [ ] 已確認這次會立刻建立 routine execution。",
      "- [ ] 已確認 assignee 與 project 都是 Sandbox/Test。",
      "- [ ] 已確認不會喚醒 Hermes 或其它本地模型。",
      "- [ ] 已確認不會修改正式資料、停用員工或清理正式任務。",
      "",
      "### 完成後覆盤",
      "- [ ] runs 裡有可讀紀錄。",
      "- [ ] 沒有 queued/running live runs 卡住。",
      "- [ ] 沒有 recovery issues 被大量建立。",
      "- [ ] 下一步是否能啟用 schedule trigger 已由使用者確認。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製排程檢查表",
        body: "Routine / schedule 啟用前檢查表已放到剪貼簿。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從驗收文件查看排程檢查表。",
        tone: "warn",
      });
    }
  }

  async function copyBeginnerCodexHelpPrompt() {
    try {
      await navigator.clipboard.writeText(BEGINNER_CODEX_HELP_PROMPT);
      pushToast({
        title: "已複製求助文字",
        body: "這段文字只要求健康檢查與安全說明，不會要求建立資料、Run now 或喚醒 Hermes。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製失敗",
        body: "瀏覽器暫時無法寫入剪貼簿，請改從新手入門文件複製求助文字。",
        tone: "warn",
      });
    }
  }

  async function copyHermesInstallRiskDecisionMarkdown() {
    const blockingCards = hermesInstallRiskCards.filter((card) => card.tone !== "success");
    const lines = [
      "## Hermes 安裝前風險判斷",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      `- 總判斷：${blockingCards.length === 0 ? "GO，可進入沙盒安裝陪同" : "PAUSE，先補齊風險項目"}`,
      "",
      "### 目前訊號",
      ...hermesInstallRiskCards.map((card) => `- ${card.label}（${card.status}）：${card.value}。${card.detail}`),
      "",
      "### 可以做",
      "- 跑 pnpm run office:verify。",
      "- 複製安裝前檢查包、安裝授權與陪同紀錄。",
      "- 檢查 WSL2/Ubuntu、Hermes bridge 與 Test environment 的非敏感輸出。",
      "",
      "### 先不要做",
      "- 不貼 API key、token、密碼。",
      "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
      "- 不把 Hermes 指派到正式專案，也不喚醒 Hermes 或其它本地模型。",
      "",
      "### 需要先補齊",
      ...(blockingCards.length > 0
        ? blockingCards.map((card) => `- ${card.label}：${card.detail}`)
        : ["- 目前風險訊號都已通過；仍需使用者明確授權才可跨過安裝線。"]),
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製安裝前風險判斷",
        body: "GO/PAUSE 判斷與安全邊界已放到剪貼簿。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理風險判斷。",
        tone: "warn",
      });
    }
  }

  async function copyHermesInstallFinalReadinessReportMarkdown() {
    const unmetCards = hermesInstallRiskCards.filter((card) => card.label !== "跨線授權" && card.tone !== "success");
    const readyForAuthorization = unmetCards.length === 0;
    const lines = [
      "## Hermes 安裝前總檢回報",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      `- 總判斷：${readyForAuthorization ? "READY FOR USER AUTHORIZATION" : "WAIT"}`,
      `- 下一步：${readyForAuthorization ? "使用者可閱讀並決定是否貼出 Hermes 安裝授權文字" : "先補齊未通過項目，不進入安裝授權"}`,
      "",
      "### 目前總檢訊號",
      ...hermesInstallRiskCards.map((card) => `- ${card.label}（${card.status}）：${card.value}。${card.detail}`),
      "",
      "### READY 條件",
      "- [ ] pnpm run office:verify 通過，Backend OK / Frontend OK。",
      "- [ ] Bridge / CLI 狀態清楚，且命令來源符合 WSL2/Ubuntu 或官方建議路線。",
      "- [ ] provider、model 與 API key 狀態清楚；API key 只在 Hermes 自己的安全設定位置。",
      "- [ ] Hermes Sandbox/Test 員工與 Sandbox/Test 專案已準備，不接正式專案。",
      "- [ ] 已看過命令預覽、逐條同意規則、二次確認與安裝授權文字。",
      "",
      "### WAIT 條件",
      ...(unmetCards.length > 0
        ? unmetCards.map((card) => `- ${card.label}：${card.detail}`)
        : ["- 目前沒有缺項；若使用者尚未決定，仍停在等待授權。"]),
      "",
      "### PAUSE 條件",
      "- 出現 API key、token、密碼、完整 .env、含憑證 URL/header/log 或正式資料。",
      "- 預覽健康不穩、後端未通過、命令用途不清楚或安裝來源不明。",
      "- 任何步驟要求建立 issue、Run now、啟用 schedule trigger、連續喚醒或喚醒模型。",
      "",
      "### 固定停手線",
      "- 這份總檢不是安裝授權、不是憑證授權、不是 Run now 授權、不是模型喚醒授權。",
      "- 只有使用者明確貼出 Hermes 安裝授權文字後，才可進入下一個被授權的安裝或設定步驟。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製安裝前總檢",
        body: "READY/WAIT/PAUSE 與停手線已放到剪貼簿；這不是安裝授權。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製總檢失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理安裝前總檢。",
        tone: "warn",
      });
    }
  }

  async function copyHermesInstallWaitRepairPackageMarkdown() {
    const unmetCards = hermesInstallRiskCards.filter((card) => card.label !== "跨線授權" && card.tone !== "success");
    const lines = [
      "## Hermes 安裝前 WAIT 補齊包",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      `- WAIT 狀態：${unmetCards.length > 0 ? "仍有前置條件未通過" : "前置條件已齊，等待使用者是否貼出安裝授權"}`,
      `- 下一個安全動作：${hermesInstallNextSafeStep.value}`,
      `- 說明：${hermesInstallNextSafeStep.detail}`,
      "",
      "### 先補齊",
      ...(unmetCards.length > 0
        ? unmetCards.map((card) => `- [ ] ${card.label}：${card.value}。${card.detail}`)
        : ["- [ ] 使用者閱讀 Hermes 安裝授權文字後，再決定是否貼出授權。"]),
      "",
      "### 只允許",
      "- 跑 pnpm run office:verify，確認 Backend OK / Frontend OK。",
      "- 只讀確認 WSL2/Ubuntu、Hermes bridge、Test environment 與 provider/model 非敏感狀態。",
      "- 複製命令預覽或第 1 階命令表單，先列命令，不執行。",
      "- 使用者自行在 Hermes 自己的安全設定位置處理 API key；Codex 只看非敏感回報。",
      "",
      "### 仍然禁止",
      "- 不安裝、不下載、不寫檔、不改 PATH、不改設定，除非使用者另行逐條同意。",
      "- 不要求、不讀取、不貼出 API key、token、密碼、完整 .env 或私密 URL。",
      "- 不建立 issue、不 Run now、不啟用 schedule trigger、不打開 heartbeat scheduler。",
      "- 不喚醒 Hermes 或其它本地模型，不接正式專案。",
      "",
      "### 完成後回來做",
      "- 重新跑 office:verify。",
      "- 再按一次複製總檢。",
      "- 若總檢仍是 WAIT，只補下一個缺項；若是 READY，也只代表可以請使用者決定是否貼出安裝授權。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製 WAIT 補齊包",
        body: "缺項、下一個安全動作與禁止跨線項目已放到剪貼簿。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製 WAIT 補齊包失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理缺項。",
        tone: "warn",
      });
    }
  }

  async function copyHermesInstallNextSafeStepMarkdown() {
    const lines = [
      "## Hermes 下一個安全動作",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      `- 狀態：${hermesInstallNextSafeStep.status}`,
      `- 下一步：${hermesInstallNextSafeStep.value}`,
      `- 說明：${hermesInstallNextSafeStep.detail}`,
      "",
      "### 先做",
      "- 跑 pnpm run office:verify，確認預覽與檢查表仍穩定。",
      "- 只做上面列出的單一步驟。",
      "- 只記錄非敏感輸出與畫面狀態。",
      "",
      "### 先不要做",
      "- 不貼 API key、token、密碼。",
      "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
      "- 不安裝、不設定、不喚醒 Hermes，除非使用者明確授權。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製下一個安全動作",
        body: "下一步與安全邊界已放到剪貼簿。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理下一步。",
        tone: "warn",
      });
    }
  }

  async function copyHermesCredentialHandoffMarkdown() {
    const lines = [
      "## Hermes 設定完成回報",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 回報目的：讓 Codex 判斷是否可以重新跑 Test environment；不要貼任何 API key、token、密碼或完整 .env。",
      "",
      "### 請填非敏感狀態",
      "- WSL2/Ubuntu 是否可開啟：是 / 否 / 不確定",
      "- scripts/hermes-wsl.cmd --version 是否可回版本：是 / 否 / 不確定",
      "- Hermes model 是否已設定：是 / 否 / 不確定",
      "- Provider 名稱：ollama / openai / openrouter / 其他 / 不確定",
      "- API key 是否已在 Hermes 自己的設定位置填好：是 / 否 / 不確定",
      "- 是否已重新跑 Office 的 Test environment：是 / 否 / 不確定",
      "- Test environment 結果摘要：pass / warn / fail / 尚未跑",
      "",
      "### 請不要貼",
      "- API key、token、密碼。",
      "- 完整 .env 內容。",
      "- 私人模型服務 URL 若含帳號、token 或內網敏感資訊。",
      "- 任何正式客戶、公司或個人資料。",
      "",
      "### 下一步請 Codex 只做",
      "- 檢查回報文字是否缺項。",
      "- 若資訊足夠，協助重新跑只讀健康檢查或 Test environment。",
      "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger、不喚醒 Hermes。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製設定回報模板",
        body: "模板只要求非敏感狀態，不需要貼 API key 或 .env。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理設定回報。",
        tone: "warn",
      });
    }
  }

  async function copyHermesProviderModelPostSetupHandoffMarkdown() {
    const lines = [
      "## Hermes provider/model 設定後交接",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 用途：使用者自行完成 provider/model/API key 設定後，只交接非敏感狀態，讓 Codex 判斷是否可進入設定完成回報或只讀檢查。",
      "",
      "### 使用者已自行處理",
      "- [ ] provider 已選定；名稱：",
      "- [ ] model 已選定；名稱：",
      "- [ ] API key/token/密碼已只放在 Hermes 自己的安全設定位置。",
      "- [ ] 沒有把密鑰貼進聊天、Office、文件、prompt、skills、issue 或截圖。",
      "- [ ] 若有錯誤訊息，已移除或遮蔽任何憑證。",
      "",
      "### 可交接給 Codex 的非敏感資訊",
      "- provider 名稱：",
      "- model 名稱：",
      "- API key 是否已由使用者自己設定：是 / 否 / 不確定",
      "- Hermes bridge 是否可回版本：是 / 否 / 不確定",
      "- Test environment 是否已跑：是 / 否 / 不確定",
      "- 不含憑證錯誤摘要：無 / 有，摘要：",
      "",
      "### Codex 只可判斷",
      "- 欄位是否完整。",
      "- 是否可使用 `複製設定回報` 整理正式非敏感回報。",
      "- 是否可進 `複製判讀規則` 或 `複製只讀檢查`。",
      "- 若資訊不足，只要求補非敏感欄位。",
      "",
      "### 必須停止",
      "- 回報包含 API key、token、密碼、完整 .env 或含憑證 URL/header/log。",
      "- 需要登入、OAuth、建立 key、代填 key、修改設定檔或寫入憑證。",
      "- 要求建立 issue、Run now、啟用 schedule trigger、打開 heartbeat scheduler 或喚醒 Hermes。",
      "",
      "### 下一步",
      "- 若欄位完整：複製設定回報。",
      "- 若欄位不足：只補非敏感欄位。",
      "- 若出現敏感資訊或喚醒要求：PAUSE。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製設定後交接",
        body: "非敏感設定交接與停手線已放到剪貼簿。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製設定後交接失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理設定後交接。",
        tone: "warn",
      });
    }
  }

  async function copyHermesSettingsReportReviewMarkdown() {
    const lines = [
      "## Hermes 設定回報判讀規則",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 用途：使用者貼回 Hermes 設定完成回報後，Codex 只判斷是否可跑只讀健康檢查或 Test environment；不登入、不填 key、不建立 issue、不 Run now、不啟用 schedule trigger、不喚醒 Hermes。",
      "",
      "### 必要欄位",
      "- WSL2/Ubuntu 是否可開啟：是 / 否 / 不確定",
      "- scripts/hermes-wsl.cmd --version 是否可回版本：是 / 否 / 不確定",
      "- Hermes model 是否已設定：是 / 否 / 不確定",
      "- Provider 名稱：已填 / 缺少 / 不確定",
      "- API key 是否已在 Hermes 自己的設定位置填好：是 / 否 / 不確定",
      "- Test environment 結果摘要：pass / warn / fail / 尚未跑",
      "",
      "### Codex 可判斷",
      "- 若 provider、model、key 狀態都清楚，下一步可只跑健康檢查或 Test environment。",
      "- 若尚未跑 Test environment，但設定狀態清楚，可建議先跑第 3 階設定檢查。",
      "- 若欄位缺少或不確定，先補回報，不跑新命令。",
      "- 若出現錯誤摘要，只能先整理錯誤與下一個只讀排查方向。",
      "",
      "### 必須 PAUSE",
      "- 回報中包含 API key、token、密碼、完整 .env 或含憑證 URL/header/log。",
      "- 使用者要求 Codex 登入、填 key、改設定或處理 OAuth。",
      "- 使用者要求建立 issue、Run now、啟用 schedule trigger、喚醒 Hermes 或開始正式任務。",
      "- provider/model/key 狀態仍不清楚，卻要求直接測或喚醒。",
      "",
      "### 回覆格式",
      "- 判斷：GO read-only check / WAIT for missing report / PAUSE",
      "- 可做的只讀檢查：",
      "- 缺少或不確定欄位：",
      "- 停手線：不登入、不填 key、不改設定、不建立 issue、不 Run now、不啟用 schedule trigger、不喚醒 Hermes。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製設定回報判讀",
        body: "這份規則只判斷能否做只讀檢查，不會啟動任務或喚醒 Hermes。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理設定回報判讀規則。",
        tone: "warn",
      });
    }
  }

  async function copyHermesReadOnlyPrecheckMarkdown() {
    const lines = [
      "## Hermes 只讀檢查前確認",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 用途：在執行任何只讀健康檢查或 Test environment 前，先確認資訊乾淨、範圍只讀、沒有跨到設定或喚醒。",
      "",
      "### 必須已完成",
      "- [ ] 使用者已自行處理 provider/model/API key；Codex 沒有登入、填 key 或處理 OAuth。",
      "- [ ] 已貼 `Hermes 設定完成回報` 或等效非敏感摘要。",
      "- [ ] 回報中沒有 API key、token、密碼、完整 .env、含憑證 URL/header/log 或正式資料。",
      "- [ ] `Hermes 設定回報判讀規則` 的結論是 GO read-only check。",
      "",
      "### 本次只允許看",
      "- Office preview：Backend OK / Frontend OK。",
      "- Hermes bridge 是否可回版本。",
      "- Hermes status 是否仍無 active sessions、無 scheduled jobs、無喚醒中的任務。",
      "- Test environment 的非敏感摘要：pass / warn / fail，以及缺 model、provider、.env 或 key 的狀態。",
      "",
      "### 本次仍禁止",
      "- 不登入、不處理 OAuth、不建立或查看 API key。",
      "- 不貼、不讀出、不整理 API key、token、密碼、完整 .env 或私密 URL。",
      "- 不安裝、不下載、不寫檔、不改 PATH、不改設定。",
      "- 不建立 issue、不 Run now、不啟用 schedule trigger、不打開 heartbeat scheduler。",
      "- 不喚醒 Hermes 或其它本地模型，不接正式專案。",
      "",
      "### 判斷",
      "- GO：上述條件都通過，才可複製只讀檢查請求。",
      "- WAIT：欄位不足或尚未貼設定完成回報，只補非敏感欄位。",
      "- PAUSE：出現敏感資訊、登入/改設定要求、Run now、排程、issue 或喚醒要求。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製只讀前確認",
        body: "只讀檢查前的 GO/WAIT/PAUSE 條件已放到剪貼簿。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製只讀前確認失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理只讀前確認。",
        tone: "warn",
      });
    }
  }

  async function copyHermesReadOnlyCheckRequestMarkdown() {
    const lines = [
      "## Hermes 只讀檢查請求",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 前提：設定完成回報已判定為 GO read-only check。",
      "- 用途：只確認 Hermes 設定後的健康狀態與 Test environment，不寫檔、不下載、不改設定、不登入、不填 key、不建立 issue、不 Run now、不啟用 schedule trigger、不喚醒 Hermes。",
      "",
      "### 可做的只讀檢查",
      "- 確認 Office preview：Backend OK / Frontend OK。",
      "- 確認 Hermes bridge 是否可回版本。",
      "- 確認 Hermes status 是否仍無 active sessions、無 scheduled jobs、無喚醒中的任務。",
      "- 讀取 Test environment 的非敏感摘要：pass / warn / fail，以及缺 model、provider、.env 或 key 的狀態。",
      "",
      "### 不可做",
      "- 不貼、不讀出、不整理 API key、token、密碼或完整 .env。",
      "- 不登入、不處理 OAuth、不建立或更新密鑰。",
      "- 不安裝、不下載、不寫檔、不改 PATH、不改設定。",
      "- 不建立 issue、不 Run now、不啟用 schedule trigger、不喚醒 Hermes、不接正式專案。",
      "",
      "### 回報格式",
      "- Preview health：OK / blocked / 未檢查",
      "- Hermes bridge：OK / blocked / 未檢查",
      "- Hermes status：jobs 0 / sessions 0 / 有活動需暫停 / 未檢查",
      "- Test environment：pass / warn / fail / 未檢查",
      "- 可否進第 4 階喚醒前檢查：否，除非使用者另行明確授權",
      "- 下一個安全動作：",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製只讀檢查請求",
        body: "這份請求只允許健康檢查與 Test environment，不會修改設定或喚醒 Hermes。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理只讀檢查請求。",
        tone: "warn",
      });
    }
  }

  async function copyHermesReadOnlyResultHandoffMarkdown() {
    const lines = [
      "## Hermes 只讀檢查結果交接",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 用途：只讀健康檢查或 Test environment 跑完後，只交接非敏感結果，讓 Codex 用結果判讀規則判斷 PASS/WARN/FAIL/PAUSE。",
      "",
      "### 請只填這些狀態",
      "- Preview health：OK / blocked / 未檢查",
      "- Hermes bridge：OK / blocked / 未檢查",
      "- Hermes status：jobs 0 / sessions 0 / 有活動需暫停 / 未檢查",
      "- Test environment：pass / warn / fail / 未檢查",
      "- Test environment 非敏感摘要：",
      "- 下一個安全動作候選：只讀修正 / 重新檢查 / 第 4 階喚醒前檢查 / 先暫停",
      "",
      "### 不要貼",
      "- API key、token、密碼、完整 .env。",
      "- 含憑證的 URL、header、log、截圖或終端輸出。",
      "- 完整 raw log；只貼非敏感摘要與錯誤類型。",
      "- 正式客戶、公司或個人資料。",
      "",
      "### Codex 只可做",
      "- 用 `複製結果判讀` 的規則判斷 PASS / WARN / FAIL / PAUSE。",
      "- 若資訊不足，只要求補非敏感欄位。",
      "- 若出現敏感資訊，立即 PAUSE，不整理、不重貼、不擴散。",
      "",
      "### 仍然禁止",
      "- 不登入、不填 key、不改設定、不寫檔、不下載、不安裝。",
      "- 不建立 issue、不 Run now、不啟用 schedule trigger、不打開 heartbeat scheduler。",
      "- 不喚醒 Hermes 或其它本地模型，不接正式專案。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製只讀結果交接",
        body: "非敏感結果交接格式已放到剪貼簿，不包含 raw log 或密鑰。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製只讀結果交接失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理只讀結果。",
        tone: "warn",
      });
    }
  }

  async function copyHermesReadOnlyResultReviewMarkdown() {
    const lines = [
      "## Hermes 只讀檢查結果判讀",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 用途：只讀健康檢查或 Test environment 跑完後，請 Codex 只判讀結果與下一個安全動作，不建立 issue、不 Run now、不啟用 schedule trigger、不喚醒 Hermes。",
      "",
      "### 請貼非敏感結果",
      "- Preview health：OK / blocked / 未檢查",
      "- Hermes bridge：OK / blocked / 未檢查",
      "- Hermes status：jobs 0 / sessions 0 / 有活動需暫停 / 未檢查",
      "- Test environment：pass / warn / fail / 未檢查",
      "- Test environment 摘要：",
      "",
      "### 判讀規則",
      "- PASS：Preview、bridge、status 與 Test environment 都乾淨；下一步只能準備第 4 階喚醒前檢查，不代表可喚醒。",
      "- WARN：有非阻塞警告或 Test environment warn；先整理原因與只讀修正建議，不進第 4 階。",
      "- FAIL：preview、bridge 或 Test environment 失敗；先停下排查，不進第 4 階。",
      "- PAUSE：出現 API key、token、密碼、完整 .env、含憑證 URL/header/log、active sessions、scheduled jobs、running task 或任何喚醒要求。",
      "",
      "### 回覆格式",
      "- 判讀：PASS / WARN / FAIL / PAUSE",
      "- 依據：",
      "- 不能做的事：不建立 issue、不 Run now、不啟用 schedule trigger、不喚醒 Hermes、不接正式專案。",
      "- 下一個安全動作：",
      "- 若 PASS：只可建議複製第 4 階喚醒前檢查，仍需使用者另行明確授權。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製結果判讀",
        body: "這份規則只判讀只讀檢查結果，不會直接進入喚醒。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理只讀結果判讀。",
        tone: "warn",
      });
    }
  }

  async function copyHermesReadOnlyPassHandoffMarkdown() {
    const lines = [
      "## Hermes 只讀 PASS 後交接",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 用途：只讀結果判讀為 PASS 後，交接到第 4 階喚醒前檢查；PASS 不代表可以直接建立 issue、Run now、排程或喚醒 Hermes。",
      "",
      "### PASS 必須代表",
      "- [ ] Preview health：OK。",
      "- [ ] Hermes bridge：OK。",
      "- [ ] Hermes status：jobs 0 / sessions 0，沒有 active sessions、scheduled jobs 或喚醒中的任務。",
      "- [ ] Test environment：pass，且摘要不含 API key、token、密碼、完整 .env 或正式資料。",
      "- [ ] 結果判讀沒有 WARN / FAIL / PAUSE。",
      "",
      "### 下一步只允許",
      "- 複製第 4 階喚醒前檢查表。",
      "- 檢查 Hermes Sandbox/Test 員工、Sandbox/Test 專案與使用者 Sandbox/Test 確認。",
      "- 若條件不足，只補 Sandbox/Test 條件，不建立 issue。",
      "- 若條件完整，也只可進預填 Sandbox/Test issue 草稿，最後仍由使用者手動確認。",
      "",
      "### 仍然禁止",
      "- 不自動建立 issue。",
      "- 不 Run now、不啟用 schedule trigger、不打開 heartbeat scheduler。",
      "- 不連續喚醒、不接正式專案、不處理正式客戶或公司資料。",
      "- 不喚醒 Hermes 或其它本地模型，除非使用者另行貼出明確第 4 階一次性喚醒授權。",
      "",
      "### 交接結論",
      "- 判斷：PASS 後只可準備第 4 階喚醒前檢查。",
      "- 下一個安全動作：複製喚醒前檢查。",
      "- 不是授權：不是安裝授權、不是憑證授權、不是 Run now 授權、不是喚醒授權。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製 PASS 後交接",
        body: "PASS 後只可進喚醒前檢查，不代表可以直接喚醒。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製 PASS 後交接失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理 PASS 後交接。",
        tone: "warn",
      });
    }
  }

  async function copyHermesProviderModelChoiceMarkdown() {
    const lines = [
      "## Hermes provider/model 設定前選擇表",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 目的：先選一個 provider 與 model，讓下一步只做 Hermes 自己的設定流程；不要貼任何 API key、token、密碼或完整 .env。",
      "",
      "### 候選 provider",
      "- [ ] OpenRouter：想先用單一入口測多種模型。",
      "- [ ] OpenAI / Codex：已有 OpenAI 或 Codex 可用帳號。",
      "- [ ] Anthropic：想用 Claude 系列模型。",
      "- [ ] Nous Portal：想走 Hermes / Nous 原生路線。",
      "- [ ] Qwen / Kimi / MiniMax / Z.AI：已有對應帳號或區域服務。",
      "- [ ] 其它：",
      "",
      "### 我的選擇（只填非敏感資訊）",
      "- 想先使用的 provider：",
      "- 想先使用的 model：",
      "- 是否已有帳號或額度：是 / 否 / 不確定",
      "- 是否準備由我自己在 Hermes 設定位置填 API key：是 / 否 / 不確定",
      "- 是否需要 Codex 先只列設定命令預覽：是 / 否 / 不確定",
      "",
      "### 不要貼",
      "- API key、token、密碼。",
      "- 完整 .env。",
      "- 含憑證的 URL、header、log。",
      "- 正式客戶、公司或個人資料。",
      "",
      "### 下一步邊界",
      "- Codex 只能檢查這份選擇表是否缺項。",
      "- 若需要命令，先回到第 1 階命令預覽表單。",
      "- 不登入、不填 key、不建立 issue、不 Run now、不啟用 schedule trigger、不喚醒 Hermes。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製 provider/model 選擇表",
        body: "只包含非敏感選項，不需要貼 API key 或登入資訊。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理 provider/model 選擇。",
        tone: "warn",
      });
    }
  }

  async function copyHermesProviderModelReviewMarkdown() {
    const lines = [
      "## Hermes provider/model 選擇回覆檢查",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 用途：使用者貼回 provider/model 選擇表後，Codex 只檢查缺項與下一步，不登入、不填 key、不執行命令、不建立 issue、不 Run now、不啟用 schedule trigger、不喚醒 Hermes。",
      "",
      "### 必要欄位",
      "- 想先使用的 provider：已填 / 缺少 / 不確定",
      "- 想先使用的 model：已填 / 缺少 / 不確定",
      "- 是否已有帳號或額度：是 / 否 / 不確定",
      "- 是否準備由使用者自己在 Hermes 設定位置填 API key：是 / 否 / 不確定",
      "- 是否需要 Codex 先只列設定命令預覽：是 / 否 / 不確定",
      "",
      "### Codex 可做",
      "- 摘要使用者選的 provider 與 model。",
      "- 指出缺少或不確定欄位。",
      "- 判斷下一步是 GO to command preview / WAIT for user self-setup / PAUSE。",
      "- 若需要命令，只導回第 1 階命令預覽表單。",
      "",
      "### 必須 PAUSE",
      "- 使用者貼了 API key、token、密碼或完整 .env。",
      "- 使用者要求 Codex 登入、填 key、代填憑證或處理 OAuth。",
      "- 使用者要求直接 Run now、建立喚醒 issue、啟用 schedule trigger 或喚醒 Hermes。",
      "- provider 或 model 缺少，或帳號/額度仍不確定。",
      "",
      "### 回覆格式",
      "- 判斷：GO to command preview / WAIT for user self-setup / PAUSE",
      "- 原因：",
      "- 缺少欄位：",
      "- 下一個安全動作：",
      "- 仍然禁止：不登入、不填 key、不執行命令、不建立 issue、不 Run now、不啟用 schedule trigger、不喚醒 Hermes。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製 provider/model 檢查規則",
        body: "收到選擇表後，只檢查缺項與下一步，不碰憑證或喚醒。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理檢查規則。",
        tone: "warn",
      });
    }
  }

  async function copyHermesProviderModelCommandPreviewMarkdown() {
    const lines = [
      "## Hermes provider/model 設定命令預覽",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 用途：在 provider/model 選擇表通過後，請 Codex 只列出設定前可能需要的命令、目的、風險與停手線；不要直接執行任何命令。",
      "",
      "### 我的非敏感選擇",
      "- provider：",
      "- model：",
      "- 是否已有帳號或額度：是 / 否 / 不確定",
      "- 是否由我自己在 Hermes 設定位置填 API key：是 / 否 / 不確定",
      "",
      "### 請 Codex 只列預覽表",
      "| 編號 | 類型 | 命令或人工步驟摘要 | 目的 | 是否會下載/寫檔/改設定/登入/碰憑證 | 風險 | 是否需要我逐條同意 |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| 1 | 只讀檢查 / 互動設定 / 人工操作 / 暫停 |  |  |  |  | 是 / 否 / PAUSE |",
      "",
      "### 可列但不可執行",
      "- 只讀狀態檢查，例如確認 Hermes 版本、bridge 狀態或目前 model/provider 是否已設定。",
      "- 互動設定入口，例如 Hermes 自己的 model/provider 設定流程；若會進入 key 或登入步驟，必須標成使用者自行操作。",
      "- 設定完成後的只讀驗證，例如重新跑 Test environment 或讀取非敏感狀態摘要。",
      "",
      "### 必須 PAUSE",
      "- 任何會代填 API key、token、密碼或完整 .env 的步驟。",
      "- 任何登入、OAuth、開啟帳號授權頁或建立密鑰的步驟。",
      "- 任何未逐條同意就會下載、安裝、寫檔、改 PATH、改設定或執行互動命令的步驟。",
      "- 任何建立 issue、Run now、啟用 schedule trigger 或喚醒 Hermes 的步驟。",
      "",
      "### 回覆格式",
      "- 先回命令預覽表，不執行。",
      "- 標出哪幾步只能由使用者自己操作。",
      "- 標出哪幾步需要逐條同意。",
      "- 最後寫明：目前仍不登入、不填 key、不執行命令、不建立 issue、不 Run now、不啟用 schedule trigger、不喚醒 Hermes。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製設定命令預覽",
        body: "這份請求只列命令與風險，不會直接執行或碰憑證。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理設定命令預覽。",
        tone: "warn",
      });
    }
  }

  async function copyHermesProviderModelSelfSetupGuideMarkdown() {
    const lines = [
      "## Hermes provider/model 自行設定陪跑卡",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 目的：陪使用者自己在 Hermes 的安全設定位置處理 provider、model 與 API key；Codex 只看非敏感狀態，不登入、不填 key、不讀密鑰。",
      "",
      "### 使用者自己操作",
      "- [ ] 選定一個 provider：OpenRouter / OpenAI / Anthropic / Nous / Qwen / Kimi / MiniMax / Z.AI / 其它。",
      "- [ ] 選定一個 model，先以成本可控、可測試為主。",
      "- [ ] 只在 Hermes 自己的設定位置輸入 API key、token 或密碼。",
      "- [ ] 若畫面顯示密鑰，先遮住或不要貼出；只回報「已設定 / 未設定 / 不確定」。",
      "- [ ] 設定完後回 Office，使用 `複製設定回報` 填非敏感狀態。",
      "",
      "### Codex 可陪同",
      "- 解釋每個非敏感欄位代表什麼。",
      "- 協助選擇先測哪個 provider/model，但不要求使用者提供密鑰。",
      "- 檢查不含憑證的錯誤訊息、版本、bridge 狀態與 Test environment 摘要。",
      "- 若需要命令，只先回到第 1 階命令預覽或逐條同意流程。",
      "",
      "### Codex 不可做",
      "- 不登入帳號、不處理 OAuth、不建立或查看 API key。",
      "- 不要求、不讀取、不貼出 API key、token、密碼、完整 .env 或私密 URL。",
      "- 不代填 provider/model/key，不改設定檔，不寫入憑證。",
      "- 不建立 issue、不 Run now、不啟用 schedule trigger、不喚醒 Hermes 或其它本地模型。",
      "",
      "### 可回報格式",
      "- provider：已選 / 未選 / 不確定；名稱：",
      "- model：已選 / 未選 / 不確定；名稱：",
      "- API key 是否已由使用者自己放在 Hermes 安全設定位置：是 / 否 / 不確定",
      "- 是否有不含憑證的錯誤訊息：無 / 有，摘要：",
      "- 下一步想做：只讀檢查 / Test environment / 先暫停",
      "",
      "### 完成後下一步",
      "- 使用 `複製設定回報`，只貼非敏感狀態。",
      "- 使用 `複製判讀規則`，讓 Codex 判斷是否可做只讀檢查。",
      "- 仍然不建立 issue、不 Run now、不啟用排程、不喚醒 Hermes。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製自行設定陪跑卡",
        body: "provider/model/key 的自行操作邊界已放到剪貼簿；不包含任何密鑰。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製陪跑卡失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 手動整理自行設定步驟。",
        tone: "warn",
      });
    }
  }

  async function copyHermesConfigurationCheckMarkdown() {
    try {
      await navigator.clipboard.writeText(HERMES_CONFIGURATION_CHECK_TEMPLATE);
      pushToast({
        title: "已複製設定檢查表",
        body: "第 3 階設定檢查表已放到剪貼簿；只允許回報非敏感狀態與只讀檢查結果。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製設定檢查表失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改從 Hermes SOP 複製第 3 階設定檢查表。",
        tone: "warn",
      });
    }
  }

  async function copyDailyStartCheckPrompt() {
    try {
      await navigator.clipboard.writeText(DAILY_START_CHECK_PROMPT);
      pushToast({
        title: "已複製開工檢查",
        body: "這段文字會提醒先確認 Backend OK / Frontend OK，再進入資料變更、Routine 或 Hermes 操作。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製失敗",
        body: "瀏覽器暫時無法寫入剪貼簿，請改從使用教學的每日開工前安全檢查手動複製。",
        tone: "warn",
      });
    }
  }

  async function copyPreviewRecoveryHelpPrompt() {
    try {
      await navigator.clipboard.writeText(PREVIEW_RECOVERY_HELP_PROMPT);
      pushToast({
        title: "已複製預覽求助文字",
        body: "這段文字會要求先看狀態報告與 office:check，不刪資料庫、不手動刪 lock file，也不喚醒 Hermes。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製失敗",
        body: "瀏覽器暫時無法寫入剪貼簿，請改從預覽服務區塊手動複製求助重點。",
        tone: "warn",
      });
    }
  }

  async function copyPreviewStatusReportReviewTemplate() {
    try {
      await navigator.clipboard.writeText(PREVIEW_STATUS_REPORT_REVIEW_TEMPLATE);
      pushToast({
        title: "已複製狀態報告模板",
        body: "這份模板會保留 backendOk、frontendOk、lock file、port 與 nextAction，方便重開機後覆盤。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製失敗",
        body: "瀏覽器暫時無法寫入剪貼簿，請改從狀態報告欄位翻譯區塊手動整理。",
        tone: "warn",
      });
    }
  }

  async function copyPreviewStatusDecisionPrompt() {
    try {
      await navigator.clipboard.writeText(PREVIEW_STATUS_DECISION_PROMPT);
      pushToast({
        title: "已複製故障決策表",
        body: "這份決策表會提醒每種預覽故障先做什麼，以及哪些資料變更先不要做。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製失敗",
        body: "瀏覽器暫時無法寫入剪貼簿，請改從預覽故障決策表手動複製。",
        tone: "warn",
      });
    }
  }

  async function copyStartupSafetyBundlePrompt() {
    try {
      await navigator.clipboard.writeText(STARTUP_SAFETY_BUNDLE_PROMPT);
      pushToast({
        title: "已複製開機安全包",
        body: "這包包含每日開工檢查、預覽求助文字、狀態報告模板與故障決策表。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製失敗",
        body: "瀏覽器暫時無法寫入剪貼簿，請改用每日檢查、預覽求助或狀態模板的單獨複製按鈕。",
        tone: "warn",
      });
    }
  }

  function toggleReviewedStep(stepId: string) {
    setReviewedStepIds((current) =>
      current.includes(stepId) ? current.filter((id) => id !== stepId) : [...current, stepId],
    );
  }

  const actions: StarterAction[] = [
    {
      label: "建立員工",
      description: "新增一位 AI 員工，之後可替他安裝技能。",
      icon: Plus,
      testId: "starter-action-agent",
      onClick: openNewAgent,
    },
    {
      label: "安裝技能",
      description: "用新手精靈替員工配置能力。",
      icon: Boxes,
      testId: "starter-action-skills",
      onClick: () => setSkillOpen(true),
    },
    {
      label: "管理員工",
      description: activeAgents.length > 0 ? "改名、職稱或安全停用。" : "先建立員工再管理。",
      icon: UserRoundCog,
      testId: "starter-action-manage-agent",
      onClick: () => {
        if (activeAgents.length === 0) {
          openNewAgent();
          return;
        }
        openManageAgent(activeAgents[0]!);
      },
    },
    {
      label: "建立工作流",
      description: "一鍵建立專案與五個階段任務。",
      icon: ClipboardList,
      testId: "starter-action-workflow",
      onClick: () => setWorkflowOpen(true),
    },
    {
      label: "開討論任務",
      description: "建立會議或覆盤討論串，方便之後回看。",
      icon: CalendarClock,
      testId: "starter-action-meeting",
      onClick: () => setMeetingOpen(true),
    },
  ];

  const starterSteps: StarterStep[] = [
    {
      id: "agents",
      label: "建立員工",
      description:
        activeAgents.length > 0
          ? `已有 ${activeAgents.length} 位員工，可以開始分工。`
          : "先建立 PM、工程、測試或設計角色。",
      done: activeAgents.length > 0,
      statusLabel: activeAgents.length > 0 ? "已完成" : "待處理",
      checkItems: [
        "至少有一位 AI 員工。",
        "員工名稱與職責能讓新手看懂。",
        "員工能在辦公室平面中被看見。",
        "可以從操作檯或右側清單開啟員工管理。",
      ],
      actionLabel: activeAgents.length > 0 ? "新增員工" : "開始建立",
      onClick: openNewAgent,
    },
    {
      id: "skills",
      label: "配置技能",
      description:
        visibleCompanySkills.length > 0
          ? `技能庫已有 ${visibleCompanySkills.length} 個可配置技能。`
          : "用 starter skills 先建立會議、需求、測試能力。",
      done: visibleCompanySkills.length > 0,
      statusLabel: visibleCompanySkills.length > 0 ? "可驗收" : "待處理",
      checkItems: [
        "技能精靈可以選擇員工。",
        "starter skill 可以預覽再建立。",
        "同步前能看懂哪些技能會被勾選。",
      ],
      actionLabel: visibleCompanySkills.length > 0 ? "調整技能" : "建立技能",
      onClick: () => setSkillOpen(true),
    },
    {
      id: "workflow",
      label: "建立工作流",
      description:
        activeProjects.length > 0
          ? `已有 ${activeProjects.length} 個專案，可追蹤上下游任務。`
          : "建立第一個五階段專案流程。",
      done: activeProjects.length > 0,
      statusLabel: activeProjects.length > 0 ? "已完成" : "待處理",
      checkItems: [
        "專案有主管或自動選擇主管。",
        "任務有需求、設計、實作、測試、覆盤階段。",
        "專案頁能看到工作流地圖與上游提示。",
      ],
      actionLabel: activeProjects.length > 0 ? "新增流程" : "建立流程",
      onClick: () => setWorkflowOpen(true),
    },
    {
      id: "meetings",
      label: "留下討論紀錄",
      description:
        reviewThreadCount > 0
          ? `已有 ${reviewThreadCount} 串會議或覆盤紀錄。`
          : "需要決策時開一串會議任務，之後可覆盤。",
      done: reviewThreadCount > 0,
      statusLabel: reviewThreadCount > 0 ? "已完成" : "待處理",
      checkItems: [
        "會議任務有主持人與參與員工。",
        "可以標記哪些問題需要使用者介入。",
        "會議模板會寫入討論格式。",
        "之後能在 issue 中回看討論過程與下一步。",
      ],
      actionLabel: reviewThreadCount > 0 ? "再開會議" : "開討論",
      onClick: () => setMeetingOpen(true),
    },
  ];
  const completedStepCount = starterSteps.filter((step) => step.done).length;
  const reviewedStepCount = starterSteps.filter((step) => reviewedStepIds.includes(step.id)).length;
  const completionPercent = Math.round((completedStepCount / starterSteps.length) * 100);
  const acceptanceItems = ACCEPTANCE_SECTIONS.flatMap((section) => section.items);
  const verifiedAcceptanceCount = acceptanceItems.filter((item) => item.status === "已驗證").length;
  const partialAcceptanceCount = acceptanceItems.filter((item) => item.status === "部分完成").length;
  const pendingAcceptanceCount = acceptanceItems.filter((item) => item.status === "待開發").length;
  const manualAcceptanceCount = acceptanceItems.filter((item) => item.status === "需人工驗收").length;
  const verifiedAcceptancePercent = Math.round((verifiedAcceptanceCount / acceptanceItems.length) * 100);
  const remainingAcceptanceItems = ACCEPTANCE_SECTIONS.flatMap((section) =>
    section.items
      .filter((item) => item.status !== "已驗證")
      .map((item) => ({ ...item, sectionTitle: section.title })),
  );
  const nextAcceptanceItems = ACCEPTANCE_SECTIONS.flatMap((section) =>
    section.items
      .filter((item) => item.status !== "已驗證")
      .map((item) => ({ ...item, sectionTitle: section.title })),
  ).slice(0, 5);

  async function copyAcceptanceMarkdown() {
    const summary = [
      "# Virtual Office 驗收檢查清單",
      "",
      `目前可驗收程度：${verifiedAcceptanceCount} / ${acceptanceItems.length} 項已驗證（${verifiedAcceptancePercent}%）`,
      "",
      `- 已驗證：${verifiedAcceptanceCount}`,
      `- 部分完成：${partialAcceptanceCount}`,
      `- 待開發：${pendingAcceptanceCount}`,
      `- 需人工驗收：${manualAcceptanceCount}`,
      "",
    ];
    const sections = ACCEPTANCE_SECTIONS.flatMap((section) => [
      `## ${section.title}`,
      "",
      "| 狀態 | 檢查項目 | 紀錄 |",
      "| --- | --- | --- |",
      ...section.items.map((item) => `| ${item.status} | ${item.label} | ${item.note.replaceAll("|", "｜")} |`),
      "",
    ]);
    const nextSteps = [
      "## 下一步優先檢查",
      "",
      ...nextAcceptanceItems.map(
        (item, index) =>
          `${index + 1}. ${item.label}（${item.sectionTitle}，${item.status}）：${item.note}\n   建議驗收：${acceptanceNextCheck(item.label)}`,
      ),
      "",
    ];
    const sessionLog = [
      "## 今日驗收紀錄摘要",
      "",
      ...ACCEPTANCE_SESSION_LOG.map((entry) => `- ${entry.title}（${entry.result}）：${entry.detail}`),
      "",
    ];
    const remainingRoadmap = buildRemainingRoadmapMarkdown();
    const recordTemplate = [...ACCEPTANCE_RECORD_TEMPLATE, ""];
    const testBatches = [
      "## 端到端驗收批次計畫",
      "",
      ...ACCEPTANCE_TEST_BATCHES.map(
        (batch, index) =>
          `${index + 1}. ${batch.title}\n   重點：${batch.focus}\n   注意：${batch.caution}\n   通過標準：${batch.pass}\n   未通過時：${batch.fail}`,
      ),
      "",
    ];
    const cleanupChecks = [
      "## 測試資料清理前檢查",
      "",
      ...ACCEPTANCE_CLEANUP_CHECKS.map((item) => `- ${item}`),
      "",
    ];
    const snapshotChecks = [
      "## 正式驗收前快照",
      "",
      ...ACCEPTANCE_SNAPSHOT_CHECKS.map((item) => `- ${item}`),
      "",
      ...ACCEPTANCE_SNAPSHOT_TEMPLATE,
      "",
    ];
    const dataChangeActions = [
      "## 資料變更按鈕索引",
      "",
      ...ACCEPTANCE_DATA_CHANGE_ACTIONS.map(
        (action) => `- ${action.button}\n  - 會修改：${action.changes}\n  - 先看：${action.preview}`,
      ),
      "",
    ];
    const dataChangeRiskLanes = [
      "## 資料變更風險分流",
      "",
      ...ACCEPTANCE_DATA_CHANGE_RISK_LANES.map(
        (lane) => `- ${lane.label}（${lane.badge}）\n  - 動作：${lane.actions.join("、")}\n  - 規則：${lane.rule}`,
      ),
      "",
    ];
    const dataChangeConfirmationCards = [
      "## 資料變更操作確認表",
      "",
      ...ACCEPTANCE_DATA_CHANGE_CONFIRMATION_CARDS.map(
        (card) => `- ${card.action}\n  - 操作前：${card.before}\n  - 操作中：${card.during}\n  - 操作後：${card.after}`,
      ),
      "",
    ];
    const executionRecords = [
      "## 驗收批次執行紀錄",
      "",
      ...ACCEPTANCE_EXECUTION_RECORDS.map(
        (record) => `- ${record.batch}\n  - 結果欄：${record.result}\n  - 證據欄：${record.evidence}\n  - 暫停條件：${record.pause}`,
      ),
      "",
    ];
    const readinessGates = [
      "## 端到端驗收準備度",
      "",
      ...ACCEPTANCE_READINESS_GATES.map((gate) => `- ${gate.label}（${gate.status}）：${gate.note}`),
      "",
    ];
    const decisionRules = [
      "## 端到端驗收決策規則",
      "",
      ...ACCEPTANCE_DECISION_RULES.map(
        (rule) => `- ${rule.label}\n  - 何時使用：${rule.when}\n  - 下一步：${rule.next}`,
      ),
      "",
    ];

    try {
      await navigator.clipboard.writeText(
        [
          ...summary,
          ...sessionLog,
          ...remainingRoadmap,
          ...nextSteps,
          ...recordTemplate,
          ...testBatches,
          ...cleanupChecks,
          ...snapshotChecks,
          ...dataChangeActions,
          ...dataChangeRiskLanes,
          ...dataChangeConfirmationCards,
          ...executionRecords,
          ...readinessGates,
          ...decisionRules,
          ...sections,
        ].join("\n"),
      );
      pushToast({
        title: "已複製檢查清單",
        body: "Markdown 驗收清單已放到剪貼簿，可貼到文件、issue 或開源說明中。",
        tone: "success",
      });
    } catch (error) {
      pushToast({
        title: "複製檢查清單失敗",
        body: error instanceof Error ? error.message : "瀏覽器暫時不允許寫入剪貼簿。",
        tone: "error",
      });
    }
  }

  async function copyNearCompleteSummaryMarkdown() {
    const lines = [
      "## Virtual Office 接近完成總結",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      `- UI 摘要：${verifiedAcceptanceCount} / ${acceptanceItems.length} 已驗證（${verifiedAcceptancePercent}%）`,
      `- 部分完成：${partialAcceptanceCount}`,
      `- 待開發：${pendingAcceptanceCount}`,
      `- 需人工驗收：${manualAcceptanceCount}`,
      "",
      "### 目前可交接",
      "- 預覽健康檢查、檢查表同步、文件連結檢查與英文文件可讀性檢查都可用 `pnpm run office:verify` 一次確認。",
      "- Office 已具備 starter console、員工/skills/專案/會議/排程安全/Hermes 前置 gate 的可視化操作與交接模板。",
      "- 開源新手可用 `複製新手自評`、`複製閱讀準備`、`複製 Gate 交接` 逐步回報，不需要懂程式。",
      "",
      "### 剩餘 gate",
      ...ACCEPTANCE_REMAINING_ROADMAP.map((item) => `- ${item.title}（${item.status}）：${item.next}`),
      "",
      "### 下一個安全動作",
      `- ${hermesInstallNextSafeStep.status}：${hermesInstallNextSafeStep.value}`,
      `- ${hermesInstallNextSafeStep.detail}`,
      "",
      "### 先不要越線",
      "- 不把 skills UI 同步當成 runtime skill loading 已驗證。",
      "- 不把文件工具當成真人已讀懂。",
      "- 不安裝、不設定、不喚醒 Hermes，除非使用者明確授權。",
      "- 不貼 API key、token、密碼或完整 `.env`。",
      "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製接近完成總結",
        body: "完成度、剩餘 gate 與下一個安全動作已放到剪貼簿。",
        tone: "success",
      });
    } catch (error) {
      pushToast({
        title: "複製接近完成總結失敗",
        body: error instanceof Error ? error.message : "瀏覽器暫時不允許寫入剪貼簿。",
        tone: "error",
      });
    }
  }

  async function copyIdealDeliveryDecisionMarkdown() {
    const lines = [
      "## Virtual Office 理想版交付判斷卡",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      `- UI 摘要：${verifiedAcceptanceCount} / ${acceptanceItems.length} 已驗證（${verifiedAcceptancePercent}%）`,
      `- 部分完成：${partialAcceptanceCount}`,
      `- 待開發：${pendingAcceptanceCount}`,
      "",
      ...ACCEPTANCE_DELIVERY_DECISIONS.flatMap((decision) => [
        `### ${decision.title}（${decision.status}）`,
        decision.detail,
        ...decision.checks.map((check) => `- [ ] ${check}`),
        "",
      ]),
      "### 結論格式",
      "- 目前交付狀態：可開源試用 / 只可內測 / 暫緩交付",
      "- 還缺的證據：",
      "- 下一個最小安全動作：",
      "- 不可越線動作：Hermes 安裝、憑證、Run now、schedule trigger、正式專案喚醒。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製交付判斷",
        body: "可交付、仍需證據與不可越線項目已放到剪貼簿。",
        tone: "success",
      });
    } catch (error) {
      pushToast({
        title: "複製交付判斷失敗",
        body: error instanceof Error ? error.message : "瀏覽器暫時不允許寫入剪貼簿。",
        tone: "error",
      });
    }
  }

  async function copyOpenSourceReleaseSafetyMarkdown() {
    const lines = [
      "## Virtual Office 開源發布前安全包",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 用途：發布或交付別人試用前，先確認本機資料、文件入口、驗證指令與 Hermes 停手線。",
      "",
      ...OPEN_SOURCE_RELEASE_SAFETY_ITEMS.flatMap((item) => [
        `### ${item.title}`,
        `- [ ] ${item.detail}`,
        "",
      ]),
      "### 必跑檢查",
      "- [ ] pnpm run office:verify 已通過。",
      "- [ ] Backend OK / Frontend OK。",
      "- [ ] 文件連結檢查 0 missing references。",
      "- [ ] 英文文件檢查 0 readability findings。",
      "",
      "### 固定不可越線",
      "- 不提交 API key、token、密碼、完整 .env 或本機 log。",
      "- 不把可開源試用當成 Hermes 真喚醒已完成。",
      "- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger、不打開 heartbeat scheduler。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製開源安全包",
        body: "發布前安全檢查、本機檔案邊界與 Hermes 停手線已放到剪貼簿。",
        tone: "success",
      });
    } catch (error) {
      pushToast({
        title: "複製開源安全包失敗",
        body: error instanceof Error ? error.message : "瀏覽器暫時不允許寫入剪貼簿。",
        tone: "error",
      });
    }
  }

  async function copyRemainingRoadmapMarkdown() {
    try {
      await navigator.clipboard.writeText(buildRemainingRoadmapMarkdown().join("\n"));
      pushToast({
        title: "已複製剩餘路線",
        body: "完成前剩餘 gate 檢查點已放到剪貼簿，可貼給 Codex 或測試者逐項確認。",
        tone: "success",
      });
    } catch (error) {
      pushToast({
        title: "複製剩餘路線失敗",
        body: error instanceof Error ? error.message : "瀏覽器暫時不允許寫入剪貼簿。",
        tone: "error",
      });
    }
  }

  async function copyGateDecisionBoardMarkdown() {
    try {
      await navigator.clipboard.writeText(buildGateDecisionBoardMarkdown().join("\n"));
      pushToast({
        title: "已複製 Gate 決策板",
        body: "今天可做、先暫緩與授權後才做的判斷已放到剪貼簿。",
        tone: "success",
      });
    } catch (error) {
      pushToast({
        title: "複製 Gate 決策板失敗",
        body: error instanceof Error ? error.message : "瀏覽器暫時不允許寫入剪貼簿。",
        tone: "error",
      });
    }
  }

  async function copyRemainingAcceptanceGapsMarkdown() {
    const lines = [
      "## Virtual Office 98% 剩餘缺口交接",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      `- 目前完成度：${verifiedAcceptanceCount} / ${acceptanceItems.length} 已驗證（${verifiedAcceptancePercent}%）`,
      `- 部分完成：${partialAcceptanceCount}`,
      `- 待開發：${pendingAcceptanceCount}`,
      `- 需人工驗收：${manualAcceptanceCount}`,
      "",
      "### 剩餘缺口",
      ...remainingAcceptanceItems.flatMap((item) => [
        `- ${item.label}（${item.sectionTitle} / ${item.status}）`,
        `  - 目前狀態：${item.note}`,
        `  - 下一步：${acceptanceNextCheck(item.label)}`,
      ]),
      "",
      "### 安全邊界",
      "- skills runtime loading 的 Sandbox/Test exact key proof 已由 AI-98530 驗證；正式員工仍需另行安全驗收。",
      "- 文件可讀性需要真人試讀回饋，不能只靠程式檢查。",
      "- Hermes 真喚醒仍需使用者明確授權，不安裝、不填 API key、不建立喚醒 issue、不 Run now。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製 98% 缺口交接",
        body: "剩餘缺口、下一步與安全邊界已放到剪貼簿。",
        tone: "success",
      });
    } catch (error) {
      pushToast({
        title: "複製 98% 缺口交接失敗",
        body: error instanceof Error ? error.message : "瀏覽器暫時不允許寫入剪貼簿。",
        tone: "error",
      });
    }
  }

  async function copyFinalGateHandoffMarkdown() {
    try {
      await navigator.clipboard.writeText(buildFinalGateHandoffMarkdown().join("\n"));
      pushToast({
        title: "已複製 Gate 交接包",
        body: "最後 gate、完成條件與不可越線動作已放到剪貼簿。",
        tone: "success",
      });
    } catch (error) {
      pushToast({
        title: "複製 Gate 交接包失敗",
        body: error instanceof Error ? error.message : "瀏覽器暫時不允許寫入剪貼簿。",
        tone: "error",
      });
    }
  }

  async function copyDocumentReviewFeedbackTemplate() {
    try {
      await navigator.clipboard.writeText(DOCUMENT_REVIEW_FEEDBACK_TEMPLATE.join("\n"));
      pushToast({
        title: "已複製文件回饋模板",
        body: "文件人工閱讀回饋格式已放到剪貼簿，可請新手照欄位回報卡住位置。",
        tone: "success",
      });
    } catch (error) {
      pushToast({
        title: "複製文件回饋失敗",
        body: error instanceof Error ? error.message : "瀏覽器暫時不允許寫入剪貼簿。",
        tone: "error",
      });
    }
  }

  async function copyDocumentReviewReadinessMarkdown() {
    try {
      await navigator.clipboard.writeText(buildDocumentReviewReadinessMarkdown().join("\n"));
      pushToast({
        title: "已複製文件閱讀準備",
        body: "文件閱讀範圍與檢查問題已放到剪貼簿，可交給新手逐項試讀。",
        tone: "success",
      });
    } catch (error) {
      pushToast({
        title: "複製文件閱讀準備失敗",
        body: error instanceof Error ? error.message : "瀏覽器暫時不允許寫入剪貼簿。",
        tone: "error",
      });
    }
  }

  async function copyBeginnerDocumentSelfCheckMarkdown() {
    try {
      await navigator.clipboard.writeText(BEGINNER_DOCUMENT_SELF_CHECK_TEMPLATE.join("\n"));
      pushToast({
        title: "已複製新手文件自評表",
        body: "自評表已放到剪貼簿，可請非工程新手照欄位回報文件卡點。",
        tone: "success",
      });
    } catch (error) {
      pushToast({
        title: "複製新手文件自評失敗",
        body: error instanceof Error ? error.message : "瀏覽器暫時不允許寫入剪貼簿。",
        tone: "error",
      });
    }
  }

  async function copyChineseDocumentCompletionDecisionMarkdown() {
    try {
      await navigator.clipboard.writeText(CHINESE_DOCUMENT_COMPLETION_DECISION_TEMPLATE.join("\n"));
      pushToast({
        title: "已複製中文文件完成判斷",
        body: "完成判斷已放到剪貼簿，可區分文件工具已準備與仍需非工程新手實際試讀。",
        tone: "success",
      });
    } catch (error) {
      pushToast({
        title: "複製中文文件完成判斷失敗",
        body: error instanceof Error ? error.message : "瀏覽器暫時不允許寫入剪貼簿。",
        tone: "error",
      });
    }
  }

  async function copyHumanDocumentReviewTaskCardMarkdown() {
    try {
      await navigator.clipboard.writeText(HUMAN_DOCUMENT_REVIEW_TASK_CARD_TEMPLATE.join("\n"));
      pushToast({
        title: "已複製真人試讀任務卡",
        body: "任務卡已放到剪貼簿，可直接交給新手試讀並回報卡點。",
        tone: "success",
      });
    } catch (error) {
      pushToast({
        title: "複製真人試讀任務卡失敗",
        body: error instanceof Error ? error.message : "瀏覽器暫時不允許寫入剪貼簿。",
        tone: "error",
      });
    }
  }

  async function copyOpenSourceReviewInviteMarkdown() {
    try {
      await navigator.clipboard.writeText(OPEN_SOURCE_REVIEW_INVITE_TEMPLATE.join("\n"));
      pushToast({
        title: "已複製開源試讀邀請包",
        body: "邀請文字已放到剪貼簿，可交給朋友或開源讀者試讀並回報卡點。",
        tone: "success",
      });
    } catch (error) {
      pushToast({
        title: "複製開源試讀邀請包失敗",
        body: error instanceof Error ? error.message : "瀏覽器暫時不允許寫入剪貼簿。",
        tone: "error",
      });
    }
  }

  async function copyOpenSourceTrialReportMarkdown() {
    try {
      await navigator.clipboard.writeText(OPEN_SOURCE_TRIAL_REPORT_TEMPLATE.join("\n"));
      pushToast({
        title: "已複製開源試用回報包",
        body: "試用回報格式已放到剪貼簿，可收集環境、預覽狀態與卡住點，但不要求貼密鑰或完整 log。",
        tone: "success",
      });
    } catch (error) {
      pushToast({
        title: "複製開源試用回報包失敗",
        body: error instanceof Error ? error.message : "瀏覽器暫時不允許寫入剪貼簿。",
        tone: "error",
      });
    }
  }

  async function copyOpenSourceIssueReportMarkdown() {
    try {
      await navigator.clipboard.writeText(OPEN_SOURCE_ISSUE_REPORT_TEMPLATE.join("\n"));
      pushToast({
        title: "已複製開源 issue 回報模板",
        body: "GitHub issue 格式已放到剪貼簿，可分流啟動、文件、畫面與安全疑慮，且提醒不要貼敏感資料。",
        tone: "success",
      });
    } catch (error) {
      pushToast({
        title: "複製開源 issue 回報模板失敗",
        body: error instanceof Error ? error.message : "瀏覽器暫時不允許寫入剪貼簿。",
        tone: "error",
      });
    }
  }

  async function copyDocumentReviewSynthesisMarkdown() {
    try {
      await navigator.clipboard.writeText(DOCUMENT_REVIEW_SYNTHESIS_TEMPLATE.join("\n"));
      pushToast({
        title: "已複製試讀回饋彙整表",
        body: "彙整表已放到剪貼簿，可把讀者回饋整理成必修、建議修、可延後與安全風險。",
        tone: "success",
      });
    } catch (error) {
      pushToast({
        title: "複製試讀回饋彙整表失敗",
        body: error instanceof Error ? error.message : "瀏覽器暫時不允許寫入剪貼簿。",
        tone: "error",
      });
    }
  }

  async function copyDocumentReviewBackfillMarkdown() {
    try {
      await navigator.clipboard.writeText(DOCUMENT_REVIEW_BACKFILL_TEMPLATE.join("\n"));
      pushToast({
        title: "已複製試讀回饋回填卡",
        body: "回填卡已放到剪貼簿，可把讀者意見轉成文件修改、UI 文字、安全提醒與驗收狀態更新。",
        tone: "success",
      });
    } catch (error) {
      pushToast({
        title: "複製試讀回饋回填卡失敗",
        body: error instanceof Error ? error.message : "瀏覽器暫時不允許寫入剪貼簿。",
        tone: "error",
      });
    }
  }

  async function copyDocumentReviewEvidenceLogMarkdown() {
    try {
      await navigator.clipboard.writeText(DOCUMENT_REVIEW_EVIDENCE_LOG_TEMPLATE.join("\n"));
      pushToast({
        title: "已複製試讀證據紀錄表",
        body: "證據紀錄表已放到剪貼簿，可逐位記錄讀者是否看懂第一步、安全邊界與卡住位置。",
        tone: "success",
      });
    } catch (error) {
      pushToast({
        title: "複製試讀證據紀錄表失敗",
        body: error instanceof Error ? error.message : "瀏覽器暫時不允許寫入剪貼簿。",
        tone: "error",
      });
    }
  }

  async function copyOpenSourceFinalManualEvidenceMarkdown() {
    try {
      await navigator.clipboard.writeText(OPEN_SOURCE_FINAL_MANUAL_EVIDENCE_TEMPLATE.join("\n"));
      pushToast({
        title: "已複製人工驗收總表",
        body: "總表已放到剪貼簿，可用同一張表收攏中文試讀、英文試讀、重開機與長時間穩定性證據。",
        tone: "success",
      });
    } catch (error) {
      pushToast({
        title: "複製人工驗收總表失敗",
        body: error instanceof Error ? error.message : "瀏覽器暫時不允許寫入剪貼簿。",
        tone: "error",
      });
    }
  }

  async function copyEnglishDocumentReviewPacketMarkdown() {
    try {
      await navigator.clipboard.writeText(ENGLISH_DOCUMENT_REVIEW_PACKET_TEMPLATE.join("\n"));
      pushToast({
        title: "已複製英文文件試讀包",
        body: "英文試讀包已放到剪貼簿，可請英文讀者檢查語氣、UI 對照與安全提醒。",
        tone: "success",
      });
    } catch (error) {
      pushToast({
        title: "複製英文文件試讀包失敗",
        body: error instanceof Error ? error.message : "瀏覽器暫時不允許寫入剪貼簿。",
        tone: "error",
      });
    }
  }

  async function copyEnglishDocumentCompletionDecisionMarkdown() {
    try {
      await navigator.clipboard.writeText(ENGLISH_DOCUMENT_COMPLETION_DECISION_TEMPLATE.join("\n"));
      pushToast({
        title: "已複製英文文件完成判斷",
        body: "完成判斷已放到剪貼簿，可區分自動檢查已通過與仍需英文讀者人工確認。",
        tone: "success",
      });
    } catch (error) {
      pushToast({
        title: "複製英文文件完成判斷失敗",
        body: error instanceof Error ? error.message : "瀏覽器暫時不允許寫入剪貼簿。",
        tone: "error",
      });
    }
  }

  async function copyRuntimeSkillLoadingCheckTemplate() {
    try {
      await navigator.clipboard.writeText(RUNTIME_SKILL_LOADING_CHECK_TEMPLATE.join("\n"));
      pushToast({
        title: "已複製 runtime skill 驗收",
        body: "Runtime skill loading 驗收格式已放到剪貼簿；AI-98530 的 Sandbox/Test 真測證據也已可覆盤。",
        tone: "success",
      });
    } catch (error) {
      pushToast({
        title: "複製 runtime skill 驗收失敗",
        body: error instanceof Error ? error.message : "瀏覽器暫時不允許寫入剪貼簿。",
        tone: "error",
      });
    }
  }

  async function copySkillSyncE2eTaskCardMarkdown() {
    try {
      await navigator.clipboard.writeText(SKILL_SYNC_E2E_TASK_CARD_TEMPLATE.join("\n"));
      pushToast({
        title: "已複製技能同步 E2E 任務卡",
        body: "任務卡已放到剪貼簿，可用 Sandbox/Test 員工驗收 UI 與資料同步。",
        tone: "success",
      });
    } catch (error) {
      pushToast({
        title: "複製技能同步 E2E 任務卡失敗",
        body: error instanceof Error ? error.message : "瀏覽器暫時不允許寫入剪貼簿。",
        tone: "error",
      });
    }
  }

  async function copySkillWizardCompletionDecisionMarkdown() {
    try {
      await navigator.clipboard.writeText(SKILL_WIZARD_COMPLETION_DECISION_TEMPLATE.join("\n"));
      pushToast({
        title: "已複製技能精靈完成判斷",
        body: "判斷卡已放到剪貼簿，可區分 UI/資料同步、Sandbox runtime proof 與正式員工驗收。",
        tone: "success",
      });
    } catch (error) {
      pushToast({
        title: "複製技能精靈完成判斷失敗",
        body: error instanceof Error ? error.message : "瀏覽器暫時不允許寫入剪貼簿。",
        tone: "error",
      });
    }
  }

  async function copySkillSyncReadOnlyRecheckMarkdown() {
    const lines = [
      "## Virtual Office 技能同步只讀復查",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      `- 測試員工：${sandboxSkillSyncTestAgent?.name ?? "尚未找到 Sandbox Skills Sync Test"}`,
      `- Starter skills 保存狀態：${sandboxSkillSyncReadOnlyMatchedCount} / ${STARTER_SKILL_TEMPLATES.length}`,
      "- 安全界線：只讀讀取 agent skills；不按同步、不建立 issue、不 Run now、不喚醒 Hermes/local model。",
      "",
      "### 明細",
      ...sandboxSkillSyncReadOnlyCards.map((card) => `- ${card.name}：${card.status}（${card.key}）`),
      "",
      "### 判讀",
      sandboxSkillSyncReadOnlyMatchedCount === STARTER_SKILL_TEMPLATES.length
        ? "- 可以回報：starter skills 的 desired skills 保存狀態已通過只讀復查。"
        : "- 需要回報：仍有 starter skills 未保存到測試員工；先不要進入 runtime skill loading 驗收。",
      "- 這項只證明 UI/資料保存，不代表 runtime skill loading 已完成；runtime 仍留給 Hermes/local adapter 階段。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製技能同步只讀復查",
        body: "復查回報已放到剪貼簿，可用來記錄 desired skills 是否仍保存。",
        tone: "success",
      });
    } catch (error) {
      pushToast({
        title: "複製技能同步只讀復查失敗",
        body: error instanceof Error ? error.message : "瀏覽器暫時不允許寫入剪貼簿。",
        tone: "error",
      });
    }
  }

  async function copySkillSyncHandoffMarkdown() {
    const lines = [
      "## Virtual Office 技能同步驗收交接",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 目的：確認 UI 已保存 desired skills，並把 runtime skill loading 留到 Hermes/local adapter 可用後再驗證。",
      "",
      "### 目前可以回報",
      `- Starter skills 準備數：${readyStarterSkillTemplates.length} / ${STARTER_SKILL_TEMPLATES.length}`,
      `- Hermes Sandbox 員工：${hermesSandboxAgent?.name ?? "尚未建立"}`,
      `- Hermes Sandbox 專案：${hermesSandboxProject?.name ?? "尚未建立"}`,
      `- Runtime readiness：${hermesRuntimeSkillLoadingCards.map((card) => `${card.label}=${card.status}`).join("；")}`,
      "",
      "### 已保存與未驗證要分清楚",
      "- desired skills 已保存：代表員工設定裡看得到想安裝的技能。",
      "- runtime skill loading 已驗證：代表本地模型接 Sandbox/Test issue 時，回覆中能看出它真的使用指定技能。",
      "- 目前若 adapter 回報 unsupported，就只能算 UI/資料已準備，不能算模型已真正載入技能。",
      "",
      "### 下一次驗收才做",
      "- 只使用 Sandbox/Test issue。",
      "- 記錄 adapter 是否支援 runtime skill loading。",
      "- 記錄模型回覆中是否引用會議紀錄、需求分析或測試檢查的指定流程。",
      "- 完成後回到喚醒後檢查面板，確認沒有 running/error 或 recovery issue 殘留。",
      "",
      "### 先不要做",
      "- 不把技能同步到正式員工做第一次驗收。",
      "- 不建立正式專案 issue。",
      "- 不 Run now、不啟用 schedule trigger、不喚醒 Hermes。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製技能同步交接",
        body: "交接模板已區分 desired skills 與 runtime skill loading，不會建立任務或喚醒模型。",
        tone: "success",
      });
    } catch (error) {
      pushToast({
        title: "複製技能同步交接失敗",
        body: error instanceof Error ? error.message : "瀏覽器暫時不允許寫入剪貼簿。",
        tone: "error",
      });
    }
  }

  async function copyRuntimeSkillLoadingDryRunMarkdown() {
    const lines = [
      "## Virtual Office Runtime Skill Loading 模擬自檢",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 性質：只讀 dry-run，不建立 issue、不 Run now、不啟用 schedule trigger、不喚醒 Hermes。",
      `- 狀態：${hermesRuntimeSkillLoadingDryRun.status}`,
      "",
      "### 模擬 payload",
      "```json",
      JSON.stringify(hermesRuntimeSkillLoadingDryRun.payloadPreview, null, 2),
      "```",
      "",
      "### Starter skills",
      ...hermesRuntimeSkillLoadingDryRun.rows.map((row) => `- ${row.name}：${row.status}（key: ${row.key}）`),
      "",
      "### 缺口",
      ...(hermesRuntimeSkillLoadingDryRun.blockers.length > 0
        ? hermesRuntimeSkillLoadingDryRun.blockers.map((blocker) => `- [ ] ${blocker}`)
        : ["- [x] 目前沒有資料缺口；仍需等 Sandbox/Test issue 才能驗證模型真的使用技能。"]),
      "",
      "### 仍不能當成完成",
      "- dry-run 只能證明 UI 與資料可組成 payload。",
      "- runtime skill loading 完成仍要看 Hermes/local model 在 Sandbox/Test issue 的回覆證據。",
      "- 不要把這份自檢貼成正式模型已載入技能的證明。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製技能 dry-run",
        body: "模擬自檢只整理 payload 與缺口，不會建立任務或喚醒模型。",
        tone: "success",
      });
    } catch (error) {
      pushToast({
        title: "複製技能 dry-run 失敗",
        body: error instanceof Error ? error.message : "瀏覽器暫時不允許寫入剪貼簿。",
        tone: "error",
      });
    }
  }

  async function copyRuntimeSkillLoadingRepairPlanMarkdown() {
    const lines = [
      "## Virtual Office Runtime Skill Loading 缺口修補順序",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 邊界：只補 Sandbox dry-run 前置資料；不建立正式 issue、不 Run now、不啟用 schedule trigger、不喚醒 Hermes。",
      "",
      "### 修補順序",
      ...hermesRuntimeSkillLoadingRepairSteps.map((step) => [
        `- ${step.label}：${step.status}`,
        `  - ${step.detail}`,
      ]).flat(),
      "",
      "### 目前 dry-run 缺口",
      ...(hermesRuntimeSkillLoadingDryRun.blockers.length > 0
        ? hermesRuntimeSkillLoadingDryRun.blockers.map((blocker) => `- [ ] ${blocker}`)
        : ["- [x] dry-run 沒有資料缺口；下一步仍只能做 Sandbox/Test runtime 驗收。"]),
      "",
      "### 完成後再檢查",
      "- 回到 Office Hermes 區塊。",
      "- 看 `Runtime skill loading 模擬自檢` 是否變成可產生模擬 payload。",
      "- 只在使用者明確授權後，才進入 Hermes 安裝、設定或沙盒喚醒。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製缺口修補順序",
        body: "修補順序只指向 Sandbox 前置資料，不會建立任務或喚醒模型。",
        tone: "success",
      });
    } catch (error) {
      pushToast({
        title: "複製缺口修補順序失敗",
        body: error instanceof Error ? error.message : "瀏覽器暫時不允許寫入剪貼簿。",
        tone: "error",
      });
    }
  }

  async function copyHermesSandboxAgentDraftMarkdown() {
    const lines = [
      "## Hermes Sandbox 員工草稿確認包",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 性質：草稿確認包，只整理即將帶到新員工頁的內容；不會建立員工、不會安裝 Hermes、不會填 API key、不會喚醒模型。",
      "",
      "### 草稿欄位",
      `- Template：${HERMES_SANDBOX_AGENT_DRAFT.template}`,
      `- Name：${HERMES_SANDBOX_AGENT_DRAFT.name}`,
      `- Title：${HERMES_SANDBOX_AGENT_DRAFT.title}`,
      `- Role：${HERMES_SANDBOX_AGENT_DRAFT.role}`,
      `- Adapter：${HERMES_SANDBOX_AGENT_DRAFT.adapterType}`,
      `- Command：${HERMES_SANDBOX_AGENT_DRAFT.command}`,
      `- Starter skills：${STARTER_SKILL_TEMPLATES.map((template) => template.name).join("、")}`,
      "",
      "### Prompt 草稿",
      ...HERMES_SANDBOX_AGENT_DRAFT.promptLines.map((line) => `- ${line}`),
      "",
      "### 建立前手動確認",
      "- [ ] 新員工名稱含 Sandbox/Test。",
      "- [ ] adapter 是 hermes_local。",
      "- [ ] command 是 WSL bridge，不是 API key、token 或密碼。",
      "- [ ] prompt 有明確限制只處理 Sandbox/Test。",
      "- [ ] 建立後先同步 starter skills，再重跑 dry-run。",
      "- [ ] 不建立正式 issue、不 Run now、不啟用 schedule trigger、不喚醒 Hermes。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製 Hermes 草稿確認包",
        body: "確認包只整理草稿內容，不會建立員工、安裝或喚醒模型。",
        tone: "success",
      });
    } catch (error) {
      pushToast({
        title: "複製 Hermes 草稿確認包失敗",
        body: error instanceof Error ? error.message : "瀏覽器暫時不允許寫入剪貼簿。",
        tone: "error",
      });
    }
  }

  async function copyHermesPostCreateReportMarkdown() {
    const lines = [
      "## Hermes 建立後檢查回報",
      "",
      `- 日期：${new Date().toLocaleDateString("zh-TW")}`,
      "- 性質：建立後只讀回報；不建立 issue、不 Run now、不啟用 schedule trigger、不喚醒 Hermes。",
      "",
      "### 狀態摘要",
      ...hermesPostCreateCards.map((card) => [
        `- ${card.label}：${card.status}`,
        `  - 值：${card.value}`,
        `  - 說明：${card.detail}`,
      ]).flat(),
      "",
      "### 建議下一步",
      hermesSandboxAgent
        ? "- [ ] 若 starter skills 尚未同步，按 `預選 Hermes skills`，確認後手動按 `同步技能`。"
        : "- [ ] 先建立 Hermes Sandbox 員工草稿，確認後再回 Office。",
      "- [ ] 確認 Hermes Sandbox 員工沒有管理正式專案。",
      "- [ ] 環境測試未通過前，不建立 Sandbox wake-up issue。",
      "- [ ] 不貼 API key、token、密碼或完整 .env。",
      "",
      "### 仍不能做",
      "- 不建立正式 issue。",
      "- 不 Run now。",
      "- 不啟用 schedule trigger。",
      "- 不喚醒 Hermes 或其它本地模型。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製建立後回報",
        body: "回報只整理目前狀態，不會建立任務或喚醒模型。",
        tone: "success",
      });
    } catch (error) {
      pushToast({
        title: "複製建立後回報失敗",
        body: error instanceof Error ? error.message : "瀏覽器暫時不允許寫入剪貼簿。",
        tone: "error",
      });
    }
  }

  async function copySnapshotMarkdown() {
    try {
      await navigator.clipboard.writeText(ACCEPTANCE_SNAPSHOT_TEMPLATE.join("\n"));
      pushToast({
        title: "已複製快照模板",
        body: "正式驗收前快照模板已放到剪貼簿，可貼到文件或 issue 中。",
        tone: "success",
      });
    } catch (error) {
      pushToast({
        title: "複製快照模板失敗",
        body: error instanceof Error ? error.message : "瀏覽器暫時不允許寫入剪貼簿。",
        tone: "error",
      });
    }
  }

  async function copyE2eReadinessMarkdown() {
    const lines = [
      "## Virtual Office 端到端驗收狀態",
      "",
      `- 建議下一批：${nextE2eBatch.title}`,
      `- 重點：${nextE2eBatch.focus}`,
      `- 注意：${nextE2eBatch.caution}`,
      "",
      "### 沙盒訊號",
      ...e2eReadinessCards.map((card) => `- ${card.label}（${card.status}）：${card.value}。${card.detail}`),
      "",
      "### 建議沙盒資料包",
      ...E2E_SANDBOX_DRAFTS.map((draft) => `- ${draft.label}：${draft.value}。${draft.detail}`),
      "",
      "### 仍需避免",
      "- 不用正式員工測停用。",
      "- 不把測試會議掛到正式專案。",
      "- 不連續重按建立、同步、保存或停用。",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({
        title: "已複製端到端驗收狀態",
        body: "沙盒訊號與下一批建議已放到剪貼簿，可貼回驗收紀錄。",
        tone: "success",
      });
    } catch {
      pushToast({
        title: "複製失敗",
        body: "瀏覽器沒有開放剪貼簿權限，請改用檢查清單內的 Markdown。",
        tone: "warn",
      });
    }
  }

  return (
    <section className="rounded-md border border-border bg-card p-4">
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center">
        <Sparkles className="h-4 w-4 text-primary" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">新手操作檯</h2>
          <p className="text-xs text-muted-foreground">先用按鈕把團隊、技能、專案流程搭起來。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setAcceptanceOpen(true)}
            data-testid="starter-action-acceptance-checklist"
          >
            <ListChecks className="mr-1.5 h-4 w-4" />
            檢查清單
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setGuideOpen(true)}>
            <BookOpen className="mr-1.5 h-4 w-4" />
            使用教學
          </Button>
        </div>
      </div>
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-5">
        {actions.map((action) => {
          const Icon = action.icon;
          const content = (
            <>
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0 text-left">
                <span className="block text-sm font-medium">{action.label}</span>
                <span className="block text-xs text-muted-foreground">{action.description}</span>
              </span>
            </>
          );

          if (action.href !== undefined) {
            return (
              <Link
                key={action.label}
                to={action.href}
                data-testid={action.testId}
                className="flex min-h-20 items-center gap-3 rounded-md border border-border/70 bg-background p-3 hover:bg-accent"
              >
                {content}
              </Link>
            );
          }

          return (
            <button
                key={action.label}
                type="button"
                data-testid={action.testId}
                onClick={action.onClick}
                className="flex min-h-20 items-center gap-3 rounded-md border border-border/70 bg-background p-3 hover:bg-accent"
              >
              {content}
            </button>
          );
        })}
      </div>
      <div className="mt-4 grid gap-3 rounded-md border border-border/70 bg-background p-3 lg:grid-cols-[minmax(0,1fr)_minmax(220px,0.7fr)]">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
              驗收模式
            </span>
            <h3 className="text-sm font-medium">主畫面驗收摘要</h3>
          </div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            目前建議先走 {ACCEPTANCE_TEST_BATCHES[0].title}，確認測試員工、測試專案、快照與紀錄位置都準備好，再進入會改資料的批次。
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <div className="rounded-md border border-border/70 bg-muted/30 p-2">
              <div className="text-[11px] text-muted-foreground">準備門檻</div>
              <div className="mt-1 text-sm font-medium">
                {ACCEPTANCE_READINESS_GATES.length} / {ACCEPTANCE_READINESS_GATES.length} 已準備
              </div>
            </div>
            <div className="rounded-md border border-border/70 bg-muted/30 p-2">
              <div className="text-[11px] text-muted-foreground">驗收批次</div>
              <div className="mt-1 text-sm font-medium">{ACCEPTANCE_TEST_BATCHES.length} 批</div>
            </div>
            <div className="rounded-md border border-border/70 bg-muted/30 p-2">
              <div className="text-[11px] text-muted-foreground">決策規則</div>
              <div className="mt-1 text-sm font-medium">{ACCEPTANCE_DECISION_RULES.length} 條</div>
            </div>
          </div>
        </div>
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
          <div className="flex items-center gap-2 text-xs font-medium text-amber-700">
            <TriangleAlert className="h-3.5 w-3.5" />
            下一個安全動作
          </div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            先打開檢查清單複製 Markdown，記下目前狀態。還沒記錄前，不建議按建立、同步、保存或停用。
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-3 h-8"
            onClick={() => setAcceptanceOpen(true)}
            data-testid="starter-action-open-acceptance-checklist"
          >
            <ListChecks className="mr-1.5 h-4 w-4" />
            打開檢查清單
          </Button>
        </div>
      </div>
      <div className="mt-4 rounded-md border border-border/70 bg-background p-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                端到端驗收
              </span>
              <h3 className="text-sm font-medium">沙盒資料與下一批建議</h3>
            </div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              進入會改資料的測試前，先看這裡是否已有測試員工、測試專案、starter skills 與會議覆盤資料。
            </p>
          </div>
          <Button type="button" size="sm" variant="outline" className="h-8" onClick={copyE2eReadinessMarkdown}>
            <Copy className="mr-1.5 h-4 w-4" />
            複製狀態
          </Button>
        </div>
        <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-5">
          {e2eReadinessCards.map((card) => (
            <div key={card.label} className="rounded-md border border-border/70 bg-card p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-medium">{card.label}</div>
                <span
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[11px]",
                    card.status.startsWith("可")
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700"
                      : "border-amber-500/40 bg-amber-500/10 text-amber-700",
                  )}
                >
                  {card.status}
                </span>
              </div>
              <div className="mt-2 truncate text-xs font-medium">{card.value}</div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{card.detail}</p>
            </div>
          ))}
        </div>
        <div className="mt-3 rounded-md border border-emerald-500/25 bg-emerald-500/5 p-3" data-testid="sandbox-edit-safety-status">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-emerald-700" />
                <h4 className="text-xs font-medium">沙盒安心狀態</h4>
                <span className="rounded-full border border-emerald-500/30 bg-background px-2 py-0.5 text-[11px] text-emerald-700">
                  編輯不會喚醒
                </span>
              </div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                這裡把最容易誤會的狀態放在主畫面：沙盒中修改描述、改派負責人或安排流程，不代表模型已開始工作。
              </p>
            </div>
            {workflowRequiresWakeRiskConfirmation && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={() => setCleanWorkflowOpen(true)}
              >
                <TriangleAlert className="mr-1.5 h-4 w-4" />
                處理 active run
              </Button>
            )}
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {sandboxEditSafetyCards.map((card) => (
              <div key={card.label} className="rounded-md border border-border/70 bg-background p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs font-medium">{card.label}</div>
                  <span
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[11px]",
                      card.tone === "success"
                        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700"
                        : "border-amber-500/40 bg-amber-500/10 text-amber-700",
                    )}
                  >
                    {card.status}
                  </span>
                </div>
                <div className="mt-2 text-xs font-medium">{card.value}</div>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">{card.detail}</p>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-3 rounded-md border border-primary/30 bg-primary/10 p-3 text-xs leading-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="font-medium text-primary">建議下一批：{nextE2eBatch.title}</div>
              <p className="mt-1 text-muted-foreground">{nextE2eBatch.focus}</p>
              <p className="mt-1 text-amber-700">注意：{nextE2eBatch.caution}</p>
            </div>
            {workflowRequiresWakeRiskConfirmation && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={() => setCleanWorkflowOpen(true)}
              >
                <TriangleAlert className="mr-1.5 h-4 w-4" />
                處理乾淨驗收
              </Button>
            )}
          </div>
        </div>
        <div className="mt-3 rounded-md border border-border/70 bg-card p-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h4 className="text-xs font-medium">沙盒資料包</h4>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                這裡只會預填草稿或複製規格；要等你在表單最後按建立，才會寫入本地資料。
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" className="h-8" onClick={copySandboxDraftMarkdown}>
                <Copy className="mr-1.5 h-4 w-4" />
                複製資料包
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8"
                onClick={copySandboxSuccessExampleMarkdown}
                data-testid="sandbox-action-copy-success-example"
              >
                <CheckCircle2 className="mr-1.5 h-4 w-4" />
                複製成功範例
              </Button>
            </div>
          </div>
          <div className="mt-3 grid gap-2 lg:grid-cols-3">
            {E2E_SANDBOX_DRAFTS.map((draft, index) => (
              <div key={draft.label} className="rounded-md border border-border/70 bg-background p-3">
                <div className="text-xs font-medium">{draft.label}</div>
                <div className="mt-1 truncate text-xs text-primary">{draft.value}</div>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">{draft.detail}</p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-3 h-8 w-full"
                  onClick={
                    index === 0
                      ? openSandboxAgentDraft
                      : index === 1
                        ? openSandboxWorkflowDraft
                        : openSandboxMeetingDraft
                  }
                >
                  {index === 0 ? (
                    <Plus className="mr-1.5 h-4 w-4" />
                  ) : index === 1 ? (
                    <ClipboardList className="mr-1.5 h-4 w-4" />
                  ) : (
                    <CalendarClock className="mr-1.5 h-4 w-4" />
                  )}
                  預填草稿
                </Button>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-4 rounded-md border border-border/70 bg-background p-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-700">
                預覽服務
              </span>
              <h3 className="text-sm font-medium">開機後先看這三個訊號</h3>
            </div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              前端可開不代表後端資料也正常。若要測建立、同步、保存或停用，先確認 health 回應正常。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <code className="rounded-md border border-border/70 bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground">
              pnpm run office:check
            </code>
            <code className="rounded-md border border-border/70 bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground">
              pnpm run office:verify
            </code>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 shrink-0"
              onClick={copyPreviewRecoveryHelpPrompt}
              data-testid="starter-action-preview-recovery-help"
            >
              <Copy className="mr-1.5 h-4 w-4" />
              複製預覽求助
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 shrink-0"
              onClick={copyStartupSafetyBundlePrompt}
              data-testid="starter-action-startup-safety-bundle"
            >
              <Copy className="mr-1.5 h-4 w-4" />
              複製開機安全包
            </Button>
          </div>
        </div>
        <div className="mt-3 grid gap-2 lg:grid-cols-3">
          {PREVIEW_SERVICE_CHECKS.map((check) => (
            <div key={check.label} className="rounded-md border border-border/70 bg-card p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-medium">{check.label}</div>
                <span className="rounded-full border border-border/70 bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  {check.status}
                </span>
              </div>
              <div className="mt-2 truncate text-[11px] text-muted-foreground">{check.value}</div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{check.note}</p>
            </div>
          ))}
        </div>
        <div className="mt-3 rounded-md border border-border/70 bg-card p-3" data-testid="preview-status-report-fields">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="text-xs font-medium">狀態報告欄位翻譯</div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                `.virtual-office-preview-status.json` 是重開機後最有用的交接紀錄；先看這些欄位，再決定要不要繼續做資料變更。
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <code className="rounded-md border border-border/70 bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground">
                .virtual-office-preview-status.json
              </code>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyPreviewStatusReportReviewTemplate}
                data-testid="starter-action-preview-status-template"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製狀態模板
              </Button>
            </div>
          </div>
          <div className="mt-3 grid gap-2 lg:grid-cols-2">
            {PREVIEW_STATUS_REPORT_FIELDS.map((item) => (
              <div key={item.field} className="rounded-md border border-border/70 bg-background p-3">
                <code className="text-[11px] font-medium text-foreground">{item.field}</code>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">{item.meaning}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{item.safeNextStep}</p>
              </div>
            ))}
          </div>
          <div className="mt-3 rounded-md border border-amber-500/25 bg-amber-500/5 p-3" data-testid="preview-status-decision-rules">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="text-xs font-medium">預覽故障決策表</div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyPreviewStatusDecisionPrompt}
                data-testid="starter-action-preview-decision-copy"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製決策表
              </Button>
            </div>
            <div className="mt-3 grid gap-2 lg:grid-cols-2">
              {PREVIEW_STATUS_DECISION_RULES.map((rule) => (
                <div key={rule.condition} className="rounded-md border border-border/70 bg-background p-3">
                  <div className="text-xs font-medium">{rule.condition}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">先做：{rule.doFirst}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">先不要做：{rule.avoid}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="mt-4 rounded-md border border-border/70 bg-background p-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-indigo-500/30 bg-indigo-500/10 px-2 py-0.5 text-[11px] font-medium text-indigo-700">
                本地模型預檢
              </span>
              <h3 className="text-sm font-medium">Hermes / local model gate</h3>
            </div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              這裡先確認 Paperclip 是否已看見 Hermes adapter、是否支援 skills，以及是否已建立 Hermes 測試員工；真正喚醒前再做 CLI 安裝與環境測試。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 shrink-0"
              onClick={() => void refetchHermesEnvironment()}
              disabled={!hermesAdapter || hermesAdapter.disabled || hermesEnvironmentFetching}
              data-testid="starter-action-hermes-environment"
            >
              <RefreshCw className={cn("mr-1.5 h-4 w-4", hermesEnvironmentFetching && "animate-spin")} />
              重新檢查
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 shrink-0"
              onClick={openHermesAgentDraft}
              data-testid="starter-action-hermes-agent"
            >
              <Bot className="mr-1.5 h-4 w-4" />
              建立 Hermes 草稿
            </Button>
          </div>
        </div>
        <div className="mt-3 grid gap-2 lg:grid-cols-3">
          {localModelReadinessCards.map((card) => (
            <div key={card.label} className="rounded-md border border-border/70 bg-card p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-medium">{card.label}</div>
                <span
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[11px]",
                    card.status === "已註冊" || card.status === "可檢查" || card.status === "可使用"
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700"
                      : "border-amber-500/40 bg-amber-500/10 text-amber-700",
                  )}
                >
                  {card.status}
                </span>
              </div>
              <div className="mt-2 truncate text-xs font-medium">{card.value}</div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{card.detail}</p>
            </div>
          ))}
        </div>
        <div className="mt-3 rounded-md border border-border/70 bg-muted/20 p-3" data-testid="hermes-access-mode-selection">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h4 className="text-xs font-medium">Hermes 接入模式選擇</h4>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                借鏡 Hermes Desktop 的 local / remote 分流；先選路線，不安裝、不連線、不保存憑證。
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 shrink-0"
              onClick={copyHermesAccessModeDecisionMarkdown}
              data-testid="hermes-action-copy-access-mode-decision"
            >
              <Copy className="mr-1.5 h-4 w-4" />
              複製接入判斷
            </Button>
          </div>
          <div className="mt-3 grid gap-2 lg:grid-cols-3">
            {HERMES_ACCESS_MODE_OPTIONS.map((mode) => (
              <div key={mode.label} className="rounded-md border border-border/70 bg-card p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs font-medium">{mode.label}</div>
                  <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                    {mode.status}
                  </span>
                </div>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">{mode.detail}</p>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">下一步：{mode.safeNextStep}</p>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-3 rounded-md border border-border/70 bg-card p-3" data-testid="hermes-sandbox-agent-draft-package">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h4 className="text-xs font-medium">Hermes Sandbox 草稿確認包</h4>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                建立前先核對新員工頁會帶入的名稱、adapter、bridge command、starter skills 與安全 prompt；這裡只複製確認包，不會建立員工。
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 shrink-0"
              onClick={copyHermesSandboxAgentDraftMarkdown}
              data-testid="hermes-action-copy-sandbox-agent-draft-package"
            >
              <Copy className="mr-1.5 h-4 w-4" />
              複製草稿確認包
            </Button>
          </div>
          <div className="mt-3 grid gap-2 lg:grid-cols-3">
            {[
              ["員工草稿", `${HERMES_SANDBOX_AGENT_DRAFT.name} / ${HERMES_SANDBOX_AGENT_DRAFT.title}`],
              ["Adapter / command", `${HERMES_SANDBOX_AGENT_DRAFT.adapterType} / ${HERMES_SANDBOX_AGENT_DRAFT.command}`],
              ["Starter skills", STARTER_SKILL_TEMPLATES.map((template) => template.name).join("、")],
            ].map(([title, detail]) => (
              <div key={title} className="rounded-md border border-border/70 bg-background p-3">
                <div className="text-xs font-medium">{title}</div>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
              </div>
            ))}
          </div>
          <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-5 text-amber-800">
            建立前仍要人工確認：不要把 API key、token、密碼或完整 .env 寫進 prompt、skills、issue 或截圖。
          </div>
        </div>
        <div className="mt-3 rounded-md border border-border/70 bg-muted/20 p-3" data-testid="hermes-wsl-setup-guide">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h4 className="text-xs font-medium">Hermes WSL2 設定路線</h4>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Bridge 已能回報狀態時，下一步只設定 Hermes 自己的模型與憑證；完成前不要喚醒員工或指派正式任務。
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
                不記錄 API key
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesSetupGuideMarkdown}
                data-testid="hermes-action-copy-setup-guide"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製設定指引
              </Button>
            </div>
          </div>
          <div className="mt-3 grid gap-2 lg:grid-cols-3">
            {hermesSetupGuideCards.map((step) => (
              <div key={step.label} className="rounded-md border border-border/70 bg-card p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs font-medium">{step.label}</div>
                  <span
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[11px]",
                      step.tone === "success"
                        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700"
                        : "border-amber-500/40 bg-amber-500/10 text-amber-700",
                    )}
                  >
                    {step.status}
                  </span>
                </div>
                <code className="mt-2 block truncate rounded border border-border/70 bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground">
                  {step.command}
                </code>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">{step.detail}</p>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-3 rounded-md border border-border/70 bg-muted/20 p-3" data-testid="hermes-post-create-checklist">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h4 className="text-xs font-medium">Hermes 建立後檢查</h4>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                建立 Hermes Sandbox 員工後，先檢查 starter skills、正式主管權限與環境測試，再決定是否進入第一次沙盒喚醒。
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesPostCreateReportMarkdown}
                data-testid="hermes-action-copy-post-create-report"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製建立後回報
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={prepareHermesSkillSync}
                disabled={!hermesSandboxAgent || hermesStarterSkillKeys.length === 0}
                title={!hermesSandboxAgent ? "先建立 Hermes Sandbox 員工" : "打開技能精靈並預選 starter skills"}
              >
                <Sparkles className="mr-1.5 h-4 w-4" />
                預選 Hermes skills
              </Button>
            </div>
          </div>
          <div className="mt-3 grid gap-2 lg:grid-cols-4">
            {hermesPostCreateCards.map((card) => (
              <div key={card.label} className="rounded-md border border-border/70 bg-card p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs font-medium">{card.label}</div>
                  <span
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[11px]",
                      card.tone === "success"
                        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700"
                        : "border-amber-500/40 bg-amber-500/10 text-amber-700",
                    )}
                  >
                    {card.status}
                  </span>
                </div>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">{card.detail}</p>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-3 rounded-md border border-border/70 bg-muted/20 p-3" data-testid="hermes-runtime-skill-loading-readiness">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h4 className="text-xs font-medium">技能載入驗收準備度</h4>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                這裡只讀判斷 Hermes/local adapter 是否適合進 runtime skill loading 測試；條件沒齊前不建立 issue、不喚醒模型。
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
                Sandbox only
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copySkillSyncHandoffMarkdown}
                data-testid="hermes-action-copy-skill-sync-handoff"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製技能交接
              </Button>
            </div>
          </div>
          <div className="mt-3 grid gap-2 lg:grid-cols-4">
            {hermesRuntimeSkillLoadingCards.map((card) => (
              <div key={card.label} className="rounded-md border border-border/70 bg-card p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs font-medium">{card.label}</div>
                  <span
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[11px]",
                      card.tone === "success"
                        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700"
                        : "border-amber-500/40 bg-amber-500/10 text-amber-700",
                    )}
                  >
                    {card.status}
                  </span>
                </div>
                <div className="mt-2 truncate text-xs font-medium">{card.value}</div>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">{card.detail}</p>
              </div>
            ))}
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-card p-3" data-testid="hermes-skill-sync-handoff">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs font-medium">技能同步驗收交接</div>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                不等於已執行
              </span>
            </div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              desired skills 已保存只代表員工設定裡看得到技能；AI-98530 已補上 Hermes Sandbox/Test runtime capability key 回覆證據，正式員工仍需另行驗收。
            </p>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-card p-3" data-testid="hermes-runtime-skill-loading-dry-run">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="text-xs font-medium">Runtime skill loading 模擬自檢</div>
                  <span
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[11px]",
                      hermesRuntimeSkillLoadingDryRun.tone === "success"
                        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700"
                        : "border-amber-500/40 bg-amber-500/10 text-amber-700",
                    )}
                  >
                    {hermesRuntimeSkillLoadingDryRun.status}
                  </span>
                </div>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  這一步只把 adapter、Hermes Sandbox 員工、Sandbox/Test 專案與 starter skills 組成 dry-run payload；它不建立 issue、不 Run now、不喚醒 Hermes。
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyRuntimeSkillLoadingDryRunMarkdown}
                data-testid="hermes-action-copy-runtime-skill-loading-dry-run"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製 dry-run
              </Button>
            </div>
            <div className="mt-3 grid gap-2 lg:grid-cols-3">
              {hermesRuntimeSkillLoadingDryRun.rows.map((row) => (
                <div key={row.id} className="rounded-md border border-border/70 bg-background p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs font-medium">{row.name}</div>
                    <span
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-[11px]",
                        row.synced
                          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700"
                          : "border-amber-500/40 bg-amber-500/10 text-amber-700",
                      )}
                    >
                      {row.status}
                    </span>
                  </div>
                  <div className="mt-2 truncate text-xs text-muted-foreground">{row.key}</div>
                </div>
              ))}
            </div>
            <div className="mt-3 rounded-md border border-border/70 bg-muted/20 p-3 text-xs leading-5 text-muted-foreground">
              {hermesRuntimeSkillLoadingDryRun.blockers.length > 0
                ? `缺口：${hermesRuntimeSkillLoadingDryRun.blockers.join("；")}`
                : "目前資料可以組成 dry-run payload；真正通過仍要等 Sandbox/Test issue 留下模型使用技能的證據。"}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-card p-3" data-testid="hermes-runtime-skill-loading-repair-plan">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="text-xs font-medium">缺口修補順序</div>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  依 dry-run 缺口一步一步補齊前置資料；每一步都需要使用者手動確認，不會自動寫入正式資料。
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyRuntimeSkillLoadingRepairPlanMarkdown}
                data-testid="hermes-action-copy-runtime-skill-loading-repair-plan"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製修補順序
              </Button>
            </div>
            <div className="mt-3 grid gap-2 lg:grid-cols-3">
              {hermesRuntimeSkillLoadingRepairSteps.map((step) => (
                <div key={step.label} className="rounded-md border border-border/70 bg-background p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs font-medium">{step.label}</div>
                    <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                      {step.status}
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{step.detail}</p>
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" className="h-8" onClick={openHermesAgentDraft}>
                <Plus className="mr-1.5 h-4 w-4" />
                建立 Hermes 草稿
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8"
                onClick={prepareHermesSkillSync}
                disabled={!hermesSandboxAgent || hermesStarterSkillKeys.length === 0}
                title={!hermesSandboxAgent ? "先建立 Hermes Sandbox 員工" : "打開技能精靈並預選 starter skills"}
              >
                <Sparkles className="mr-1.5 h-4 w-4" />
                預選 Hermes skills
              </Button>
            </div>
          </div>
        </div>
        <div className="mt-3 rounded-md border border-border/70 bg-muted/20 p-3" data-testid="hermes-start-readiness-gate">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h4 className="text-xs font-medium">Hermes 開始設定判斷</h4>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                先把預覽驗證、adapter、環境、沙盒資料與 starter skills 合在一起看；未全部通過前只做設定與檢查。
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 shrink-0"
              onClick={copyHermesStartReadinessMarkdown}
              data-testid="hermes-action-copy-start-readiness"
            >
              <Copy className="mr-1.5 h-4 w-4" />
              複製開始判斷
            </Button>
          </div>
          <div className="mt-3 grid gap-2 lg:grid-cols-3">
            {hermesStartReadinessCards.map((card) => (
              <div key={card.label} className="rounded-md border border-border/70 bg-card p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs font-medium">{card.label}</div>
                  <span
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[11px]",
                      card.tone === "success"
                        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700"
                        : "border-amber-500/40 bg-amber-500/10 text-amber-700",
                    )}
                  >
                    {card.status}
                  </span>
                </div>
                <div className="mt-2 truncate text-xs font-medium">{card.value}</div>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">{card.detail}</p>
              </div>
            ))}
          </div>
          <label className="mt-3 flex items-start gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-5">
            <Checkbox
              checked={hermesWakeupUserConfirmed}
              onCheckedChange={(checked) => setHermesWakeupUserConfirmed(checked === true)}
              data-testid="hermes-wakeup-user-confirmation"
            />
            <span>
              我確認下一步只會使用 Sandbox/Test issue 做第一次喚醒，不接正式專案、不啟用 Run now 或排程，也不把 API key、token、密碼寫進 issue。
            </span>
          </label>
        </div>
        <div className="mt-3 rounded-md border border-border/70 bg-muted/20 p-3" data-testid="hermes-sandbox-wakeup-plan">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h4 className="text-xs font-medium">第一次沙盒喚醒計畫</h4>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Hermes gate 變成可使用後，先用這個最小任務確認 agent 能回覆與留下紀錄；目前只提供模板，不會自動建立任務。
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" className="h-8 shrink-0" onClick={copyHermesSandboxWakeupMarkdown}>
                <Copy className="mr-1.5 h-4 w-4" />
                複製模板
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesSandboxIssuePrefillHandoffMarkdown}
                data-testid="hermes-action-copy-sandbox-issue-prefill-handoff"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製預填交接
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesSandboxIssueCreateCheckMarkdown}
                data-testid="hermes-action-copy-sandbox-issue-create-check"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製建立前確認
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesSandboxIssueManualCreateHandoffMarkdown}
                data-testid="hermes-action-copy-sandbox-issue-manual-create-handoff"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製手動建立交接
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesSandboxIssuePostCreateObservationMarkdown}
                data-testid="hermes-action-copy-sandbox-issue-post-create-observation"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製建立後觀察
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesSandboxIssueCleanHandoffMarkdown}
                data-testid="hermes-action-copy-sandbox-issue-clean-handoff"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製 CLEAN 交接
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={openHermesSandboxIssueDraft}
                disabled={!canOpenHermesSandboxIssueDraft}
                title={canOpenHermesSandboxIssueDraft ? "預填 Sandbox/Test issue 草稿" : "Hermes 環境、沙盒員工、沙盒專案與使用者確認都通過後才可用"}
              >
                <CircleDot className="mr-1.5 h-4 w-4" />
                預填 issue 草稿
              </Button>
            </div>
          </div>
          <div className="mt-3 grid gap-2 lg:grid-cols-4">
            {hermesSandboxWakeupCards.map((card) => (
              <div key={card.label} className="rounded-md border border-border/70 bg-card p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs font-medium">{card.label}</div>
                  <span
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[11px]",
                      card.status === "可測試"
                        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700"
                        : "border-amber-500/40 bg-amber-500/10 text-amber-700",
                    )}
                  >
                    {card.status}
                  </span>
                </div>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">{card.detail}</p>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-3 rounded-md border border-border/70 bg-muted/20 p-3" data-testid="hermes-wakeup-preflight">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h4 className="text-xs font-medium">Hermes 第 4 階喚醒前檢查表</h4>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                真的建立 Sandbox/Test issue 前，先確認環境、沙盒員工、測試專案與使用者確認；這一步仍不會 Run now 或啟用排程。
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesStageFourEntryHandoffMarkdown}
                data-testid="hermes-action-copy-stage-four-entry-handoff"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製第 4 階入口
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesStageFourWaitRepairMarkdown}
                data-testid="hermes-action-copy-stage-four-wait-repair"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製第 4 階 WAIT
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesWakeupPreflightMarkdown}
                data-testid="hermes-action-copy-wakeup-preflight"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製喚醒前檢查
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesWakeupDraftDecisionMarkdown}
                data-testid="hermes-action-copy-wakeup-draft-decision"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製預填判讀
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesStageFourReadyHandoffMarkdown}
                data-testid="hermes-action-copy-stage-four-ready-handoff"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製第 4 階 READY
              </Button>
            </div>
          </div>
          <div className="mt-3 grid gap-2 lg:grid-cols-4">
            {HERMES_WAKEUP_PREFLIGHT_RULES.map((rule) => (
              <div key={rule.label} className="rounded-md border border-border/70 bg-card p-3">
                <div className="flex items-center gap-2 text-xs font-medium">
                  <ShieldCheck className="h-4 w-4 text-primary" />
                  <span>{rule.label}</span>
                </div>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">{rule.detail}</p>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-3 rounded-md border border-border/70 bg-muted/20 p-3" data-testid="hermes-post-wakeup-review">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h4 className="text-xs font-medium">喚醒後檢查面板</h4>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                第一次 Sandbox/Test 任務完成後，回來看這四個訊號；全部乾淨再考慮下一個 Hermes 任務。
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
                只讀檢查
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesPostWakeupReviewMarkdown}
                data-testid="hermes-action-copy-post-wakeup-review"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製喚醒後覆盤
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesPostWakeupReviewDecisionMarkdown}
                data-testid="hermes-action-copy-post-wakeup-review-decision"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製覆盤判讀
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesPostWakeupCleanRecordMarkdown}
                data-testid="hermes-action-copy-post-wakeup-clean-record"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製 CLEAN 記錄
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesPostWakeupWaitPauseHandlingMarkdown}
                data-testid="hermes-action-copy-post-wakeup-wait-pause-handling"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製 WAIT/PAUSE 處理
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesNextTaskRestartEntryMarkdown}
                data-testid="hermes-action-copy-next-task-restart-entry"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製下一任務入口
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesSandboxCycleSummaryMarkdown}
                data-testid="hermes-action-copy-sandbox-cycle-summary"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製沙盒循環總結
              </Button>
            </div>
          </div>
          <div className="mt-3 grid gap-2 lg:grid-cols-4">
            {hermesWakeReviewCards.map((card) => (
              <div key={card.label} className="rounded-md border border-border/70 bg-card p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs font-medium">{card.label}</div>
                  <span
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[11px]",
                      card.status === "乾淨" || card.status === "可查看"
                        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700"
                        : "border-amber-500/40 bg-amber-500/10 text-amber-700",
                    )}
                  >
                    {card.status}
                  </span>
                </div>
                <div className="mt-2 truncate text-xs font-medium">{card.value}</div>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">{card.detail}</p>
              </div>
            ))}
          </div>
          <div className="mt-3 grid gap-2 lg:grid-cols-4" data-testid="hermes-post-wakeup-review-fields">
            {HERMES_POST_WAKEUP_REVIEW_FIELDS.map((field) => (
              <div key={field.label} className="rounded-md border border-border/70 bg-card p-3">
                <div className="flex items-center gap-2 text-xs font-medium">
                  <Eye className="h-4 w-4 text-primary" />
                  <span>{field.label}</span>
                </div>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">{field.detail}</p>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-3 rounded-md border border-border/70 bg-muted/20 p-3" data-testid="hermes-wakeup-runbook">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h4 className="text-xs font-medium">一次性沙盒喚醒操作紀錄</h4>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                真測前先複製這份紀錄，逐項勾選；任何一步出現 error、recovery 或憑證外洩疑慮，就停下覆盤。
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesSandboxWakeupAuthorizationMarkdown}
                data-testid="hermes-action-copy-sandbox-wakeup-authorization"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製喚醒授權
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesWakeupAuthorizationIntakeCheckMarkdown}
                data-testid="hermes-action-copy-wakeup-authorization-intake-check"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製授權句檢查
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesInstallAuthorizationWaitPauseMarkdown}
                data-testid="hermes-action-copy-install-authorization-wait-pause"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製授權 WAIT/PAUSE
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesWakeupAuthorizationAcceptHandoffMarkdown}
                data-testid="hermes-action-copy-wakeup-authorization-accept-handoff"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製 ACCEPT 交接
              </Button>
              <div className="hidden" data-testid="hermes-install-legacy-numbered-command-actions">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesAcceptFirstCommandPreviewMarkdown}
                data-testid="hermes-action-copy-accept-first-command-preview"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製第一命令預覽
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesInstallFirstCommandConsentMarkdown}
                data-testid="hermes-action-copy-install-first-command-consent"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製第一命令同意
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesInstallFirstCommandResultMarkdown}
                data-testid="hermes-action-copy-install-first-command-result"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製第一命令結果
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesInstallFirstCommandDecisionMarkdown}
                data-testid="hermes-action-copy-install-first-command-decision"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製第一命令判讀
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesInstallFirstCommandCycleSummaryMarkdown}
                data-testid="hermes-action-copy-install-first-command-cycle-summary"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製第一循環總結
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesInstallNextCommandPreviewMarkdown}
                data-testid="hermes-action-copy-install-next-command-preview"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製第二命令預覽
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesInstallSecondCommandConsentMarkdown}
                data-testid="hermes-action-copy-install-second-command-consent"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製第二命令同意
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesInstallSecondCommandResultMarkdown}
                data-testid="hermes-action-copy-install-second-command-result"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製第二命令結果
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesInstallSecondCommandDecisionMarkdown}
                data-testid="hermes-action-copy-install-second-command-decision"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製第二命令判讀
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesInstallSecondCommandCycleSummaryMarkdown}
                data-testid="hermes-action-copy-install-second-command-cycle-summary"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製第二循環總結
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesInstallThirdCommandPreviewMarkdown}
                data-testid="hermes-action-copy-install-third-command-preview"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製第三命令預覽
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesInstallThirdCommandConsentMarkdown}
                data-testid="hermes-action-copy-install-third-command-consent"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製第三命令同意
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesInstallThirdCommandResultMarkdown}
                data-testid="hermes-action-copy-install-third-command-result"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製第三命令結果
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesInstallThirdCommandDecisionMarkdown}
                data-testid="hermes-action-copy-install-third-command-decision"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製第三命令判讀
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesInstallThirdCommandCycleSummaryMarkdown}
                data-testid="hermes-action-copy-install-third-command-cycle-summary"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製第三循環總結
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesInstallFourthCommandPreviewMarkdown}
                data-testid="hermes-action-copy-install-fourth-command-preview"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製第四命令預覽
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesInstallFourthCommandConsentMarkdown}
                data-testid="hermes-action-copy-install-fourth-command-consent"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製第四命令同意
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesInstallFourthCommandResultMarkdown}
                data-testid="hermes-action-copy-install-fourth-command-result"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製第四命令結果
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesInstallFourthCommandDecisionMarkdown}
                data-testid="hermes-action-copy-install-fourth-command-decision"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製第四命令判讀
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesInstallFourthCommandCycleSummaryMarkdown}
                data-testid="hermes-action-copy-install-fourth-command-cycle-summary"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製第四循環總結
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesInstallFifthCommandPreviewMarkdown}
                data-testid="hermes-action-copy-install-fifth-command-preview"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製第五命令預覽
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesInstallFifthCommandConsentMarkdown}
                data-testid="hermes-action-copy-install-fifth-command-consent"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製第五命令同意
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesInstallFifthCommandResultMarkdown}
                data-testid="hermes-action-copy-install-fifth-command-result"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製第五命令結果
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesInstallFifthCommandDecisionMarkdown}
                data-testid="hermes-action-copy-install-fifth-command-decision"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製第五命令判讀
              </Button>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesOneShotWakeupFinalCheckMarkdown}
                data-testid="hermes-action-copy-one-shot-wakeup-final-check"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製喚醒前最後確認
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesOneShotWakeupExecutionHandoffMarkdown}
                data-testid="hermes-action-copy-one-shot-wakeup-execution-handoff"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製喚醒執行交接
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesOneShotWakeupCompletionStopMarkdown}
                data-testid="hermes-action-copy-one-shot-wakeup-completion-stop"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製完成停手交接
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesSecondSandboxTaskPrepMarkdown}
                data-testid="hermes-action-copy-second-sandbox-task-prep"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製第二沙盒準備
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesSecondSandboxIssueDraftMarkdown}
                data-testid="hermes-action-copy-second-sandbox-issue-draft"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製第二 issue 草稿
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={openHermesSecondSandboxIssueDraft}
                disabled={!canOpenHermesSandboxIssueDraft}
                title={canOpenHermesSandboxIssueDraft ? "預填第二個 Sandbox/Test issue 草稿" : "環境、沙盒員工、沙盒專案與使用者確認都通過後才可用"}
                data-testid="hermes-action-open-second-sandbox-issue-draft"
              >
                <CircleDot className="mr-1.5 h-4 w-4" />
                預填第二 issue
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesSecondSandboxIssueReviewMarkdown}
                data-testid="hermes-action-copy-second-sandbox-issue-review"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製第二 issue 覆盤
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesSecondSandboxAuthorizationTemplateMarkdown}
                data-testid="hermes-action-copy-second-sandbox-authorization-template"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製第二授權模板
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesSecondSandboxAuthorizationIntakeMarkdown}
                data-testid="hermes-action-copy-second-sandbox-authorization-intake"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製第二授權判讀
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesSecondSandboxFinalCheckMarkdown}
                data-testid="hermes-action-copy-second-sandbox-final-check"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製第二最後確認
              </Button>
              <Button type="button" size="sm" variant="outline" className="h-8 shrink-0" onClick={copyHermesWakeupRunbookMarkdown}>
                <Copy className="mr-1.5 h-4 w-4" />
                複製紀錄
              </Button>
            </div>
          </div>
          <div className="mt-3 grid gap-2 lg:grid-cols-4">
            {HERMES_WAKEUP_RUNBOOK_STEPS.map((step) => (
              <div key={step.label} className="rounded-md border border-border/70 bg-card p-3">
                <div className="flex items-center gap-2 text-xs font-medium">
                  <ClipboardList className="h-4 w-4 text-primary" />
                  <span>{step.label}</span>
                </div>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">{step.detail}</p>
              </div>
            ))}
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-second-sandbox-task-prep">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h4 className="text-xs font-medium">第二個 Sandbox/Test 任務準備</h4>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  第一次 AI-97978 成功後，下一個沙盒任務仍要重新準備候選 issue、測試目的與停手線；這不是喚醒授權。
                </p>
              </div>
              <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                no wake
              </span>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {[
                ["候選 issue", "必須屬於 Sandbox/Test 專案，任務名稱或描述要明確標示測試用途。"],
                ["只測一件事", "例如回報 skills、整理上下文或提出下一個安全檢查，不混入正式工作。"],
                ["重新授權", "準備卡通過後仍需使用者另貼一次性喚醒授權，不能沿用 AI-97978。"],
                ["issue 草稿", "可複製或預填待辦草稿；建立後先停下覆盤，不自動 Run now。"],
                ["建立後覆盤", "確認仍是待辦草稿，沒有 run、排程、heartbeat 或正式資料。"],
                ["授權模板", "只提供填空文字；使用者未另行貼出完整授權句前不喚醒。"],
                ["授權判讀", "貼回授權句後先判斷 ACCEPT/WAIT/PAUSE；ACCEPT 前不喚醒。"],
                ["最後確認", "ACCEPT 後再核對 issue、員工、run、recovery、heartbeat 與敏感資料。"],
              ].map(([label, detail]) => (
                <div key={label} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{label}</div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-3 rounded-md border border-border/70 bg-muted/20 p-3" data-testid="hermes-install-preflight">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h4 className="text-xs font-medium">安裝前確認</h4>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                先照這幾項確認，再安裝 Hermes CLI 或做沙盒喚醒。
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
                {HERMES_INSTALL_PREFLIGHT_CHECKS.length} 項
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesPreInstallPackageMarkdown}
                data-testid="hermes-action-copy-pre-install-package"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製安裝前檢查包
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesInstallAuthorizationPrompt}
                data-testid="hermes-action-copy-install-authorization"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製安裝授權
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesInstallAuthorizationIntakeCheck}
                data-testid="hermes-action-copy-install-authorization-intake"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製授權句檢查
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesInstallAuthorizationAcceptHandoff}
                data-testid="hermes-action-copy-install-authorization-accept-handoff"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製 ACCEPT 交接
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesAuthorizationSecondCheck}
                data-testid="hermes-action-copy-authorization-second-check"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製二次確認
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesInstallFinalGateMarkdown}
                data-testid="hermes-action-copy-install-final-gate"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製最終閘門
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesInstallFinalGateDecisionMarkdown}
                data-testid="hermes-action-copy-install-final-gate-decision"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製閘門判斷
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesInstallFinalGateGoHandoffMarkdown}
                data-testid="hermes-action-copy-install-final-gate-go-handoff"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製 GO 後交接
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesInstallFinalGatePauseHandoffMarkdown}
                data-testid="hermes-action-copy-install-final-gate-pause-handoff"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製 PAUSE 修補
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesAuthorizationLadderMarkdown}
                data-testid="hermes-action-copy-authorization-ladder"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製授權階梯
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesAuthorizationControlMarkdown}
                data-testid="hermes-action-copy-authorization-control"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製授權總控
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesBeginnerInstallReadingOrderMarkdown}
                data-testid="hermes-action-copy-beginner-install-reading-order"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製新手順序
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesInstallCompanionLog}
                data-testid="hermes-action-copy-install-companion-log"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製陪同紀錄
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesInstallReadySnapshot}
                data-testid="hermes-action-copy-install-ready-snapshot"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製安裝前快照
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesInstallFinalReadinessReportMarkdown}
                data-testid="hermes-action-copy-install-final-readiness"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製總檢
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesInstallWaitRepairPackageMarkdown}
                data-testid="hermes-action-copy-install-wait-repair"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製 WAIT 補齊
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesInstallRiskDecisionMarkdown}
                data-testid="hermes-action-copy-install-risk-decision"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製風險判斷
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesInstallNextSafeStepMarkdown}
                data-testid="hermes-action-copy-install-next-safe-step"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製下一步
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesCredentialHandoffMarkdown}
                data-testid="hermes-action-copy-credential-handoff"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製設定回報
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesConfigurationCheckMarkdown}
                data-testid="hermes-action-copy-configuration-check"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製設定檢查
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesCommandPreviewRequest}
                data-testid="hermes-action-copy-command-preview-request"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製命令預覽
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesCommandPreviewForm}
                data-testid="hermes-action-copy-command-preview-form"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製命令表單
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesCommandApprovalLog}
                data-testid="hermes-action-copy-command-approval-log"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製逐條同意
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesSingleCommandResultMarkdown}
                data-testid="hermes-action-copy-single-command-result"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製命令回報
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesSingleCommandDecisionMarkdown}
                data-testid="hermes-action-copy-single-command-decision"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製結果判讀
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesSingleCommandPassHandoffMarkdown}
                data-testid="hermes-action-copy-single-command-pass-handoff"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製 PASS 交接
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesSingleCommandWaitPauseMarkdown}
                data-testid="hermes-action-copy-single-command-wait-pause"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製 WAIT/PAUSE
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesInstallCompanionCycleSummaryMarkdown}
                data-testid="hermes-action-copy-install-companion-cycle-summary"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製陪同總結
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesInstallCompanionShutdownHandoffMarkdown}
                data-testid="hermes-action-copy-install-companion-shutdown-handoff"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製收工交接
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesInstallCompanionStartupResumeMarkdown}
                data-testid="hermes-action-copy-install-companion-startup-resume"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製開工接續
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesStartupNextCommandPreviewMarkdown}
                data-testid="hermes-action-copy-startup-next-command-preview"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製下一命令預覽
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesStartupSingleCommandApprovalMarkdown}
                data-testid="hermes-action-copy-startup-single-command-approval"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製單一命令同意
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesStartupSingleCommandResultMarkdown}
                data-testid="hermes-action-copy-startup-single-command-result"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製單一命令結果
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesStartupSingleCommandDecisionMarkdown}
                data-testid="hermes-action-copy-startup-single-command-decision"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製單一命令判讀
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesStartupSingleCommandCycleSummaryMarkdown}
                data-testid="hermes-action-copy-startup-single-command-cycle-summary"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製單一循環總結
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesFinalPreInstallHandoffMarkdown}
                data-testid="hermes-action-copy-final-pre-install-handoff"
              >
                <Copy className="mr-1.5 h-4 w-4" />
                複製最後交接
              </Button>
            </div>
          </div>
          <div className="mt-3 grid gap-2 lg:grid-cols-5">
            {HERMES_INSTALL_PREFLIGHT_CHECKS.map((check) => (
              <div key={check.label} className="rounded-md border border-border/70 bg-card p-3">
                <div className="flex items-center gap-2 text-xs font-medium">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  <span>{check.label}</span>
                </div>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">{check.detail}</p>
              </div>
            ))}
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-install-flow-guide">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h5 className="text-xs font-medium">Hermes 安裝前流程導引</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  真要開始前照順序走；任何一步卡住都停下，不往安裝或喚醒推進。
                </p>
              </div>
              <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                {HERMES_INSTALL_FLOW_GUIDE.length} 步
              </span>
            </div>
            <div className="mt-3 grid gap-2 lg:grid-cols-5">
              {HERMES_INSTALL_FLOW_GUIDE.map((step) => (
                <div key={step.step} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="flex items-center gap-2">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                      {step.step}
                    </span>
                    <div className="text-xs font-medium">{step.title}</div>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{step.detail}</p>
                  <div className="mt-2 text-[11px] font-medium text-muted-foreground">{step.action}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-beginner-install-reading-order">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes 新手安裝前閱讀順序</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  第一次接觸 Hermes 時，先照這條路看卡片；閱讀順序不是安裝、設定或喚醒授權。
                </p>
              </div>
              <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                {HERMES_INSTALL_BEGINNER_READING_ORDER.length} 張卡
              </span>
            </div>
            <div className="mt-3 grid gap-2 lg:grid-cols-7">
              {HERMES_INSTALL_BEGINNER_READING_ORDER.map((step) => (
                <div key={step.step} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="flex items-center gap-2">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                      {step.step}
                    </span>
                    <div className="text-xs font-medium">{step.title}</div>
                  </div>
                  <div className="mt-2 text-[11px] font-medium text-muted-foreground">{step.action}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{step.detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 grid gap-2 lg:grid-cols-3" data-testid="hermes-pre-install-package">
            {HERMES_PRE_INSTALL_PACKAGE.map((group) => (
              <div key={group.title} className="rounded-md border border-border/70 bg-card p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs font-medium">{group.title}</div>
                  <span
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[11px]",
                      group.status === "可準備"
                        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700"
                        : "border-amber-500/40 bg-amber-500/10 text-amber-700",
                    )}
                  >
                    {group.status}
                  </span>
                </div>
                <ul className="mt-2 space-y-1 text-xs leading-5 text-muted-foreground">
                  {group.items.map((item) => (
                    <li key={item} className="flex gap-2">
                      <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/70" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <div className="mt-3 grid gap-2 lg:grid-cols-4" data-testid="hermes-install-ready-snapshot">
            {HERMES_INSTALL_READY_SNAPSHOT_ITEMS.map((item) => (
              <div key={item.label} className="rounded-md border border-border/70 bg-card p-3">
                <div className="text-xs font-medium">{item.label}</div>
                <div className="mt-2 text-xs font-semibold">{item.value}</div>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">{item.detail}</p>
              </div>
            ))}
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-install-next-safe-step">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">{hermesInstallNextSafeStep.label}</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  Office 只指出一個最小安全步驟；跨過安裝、設定或喚醒線仍需要使用者明確授權。
                </p>
              </div>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                {hermesInstallNextSafeStep.status}
              </span>
            </div>
            <div className="mt-3 rounded-md border border-border/70 bg-card p-3">
              <div className="text-xs font-semibold">{hermesInstallNextSafeStep.value}</div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{hermesInstallNextSafeStep.detail}</p>
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-command-preview-request">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes 命令預覽請求</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  安裝前先要求 Codex 只列命令、目的、風險與停止條件；任何安裝、寫檔、下載、改 PATH 或設定動作都要等使用者逐條同意。
                </p>
              </div>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                Preview only
              </span>
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-command-preview-form">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes 第 1 階命令預覽表單</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  只要求 Codex 用表格列出命令、類型、執行位置、會修改什麼與是否需要逐條同意；這不是執行授權。
                </p>
              </div>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                Level 1 only
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["表格欄位", "命令、類型、位置、目的、修改範圍、下載/安裝、憑證、風險、逐條同意。"],
                ["固定限制", "只列命令，不執行；不是只讀的命令一律標成需要逐條同意。"],
                ["PAUSE 條件", "碰到憑證、正式資料、issue、Run now、schedule trigger 或模型喚醒就停下。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-command-approval-log">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes 第 2 階逐條同意紀錄</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  只有表內明確標為同意的單一命令可以執行；每執行一條就先回報結果，再決定下一條。
                </p>
              </div>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                One command at a time
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["逐條同意", "沒有列在表內、沒有編號、或沒有使用者同意的命令都不可執行。"],
                ["執行後回報", "每條命令執行後先記錄成功/失敗、是否含敏感資訊，再問是否繼續。"],
                ["立即暫停", "命令不同於預覽、碰到憑證、正式資料、Run now、schedule trigger 或喚醒就停下。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-authorization-second-check">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes 授權前二次確認</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  在貼出安裝授權前，先用 GO / PAUSE 檢查預覽、憑證、資料、安全邊界與喚醒限制；未確認 GO 前仍不安裝、不設定、不喚醒。
                </p>
              </div>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                GO / PAUSE
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["GO 條件", "預覽健康、檢查包已讀、命令已先列出、WSL2 路線清楚，且不貼任何密鑰。"],
                ["PAUSE 條件", "健康檢查不穩、命令用途不明、涉及正式資料、排程、Run now、喚醒或未知下載。"],
                ["回覆格式", "只回覆 GO / PAUSE、原因、下一步允許做什麼，以及仍然禁止做什麼。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-install-final-gate">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes 安裝前最終閘門</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  在貼出安裝授權文字前，最後確認預覽健康、交接完整、命令鏈完整且沒有憑證、排程或喚醒風險。
                </p>
              </div>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                final gate
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["GO 前提", "office:verify 通過、已讀最後交接、二次確認 GO，且下一步只會先列命令預覽。"],
                ["PAUSE 條件", "不知道停在哪、想一次同意多條、要貼憑證、Run now、排程、live run 或喚醒。"],
                ["GO 也只代表", "只可請使用者決定是否貼出安裝授權文字；仍不直接執行命令。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-install-final-gate-decision">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes 最終閘門判斷回覆</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  讀完最終閘門後，用固定格式記錄 GO / PAUSE、原因、缺項、下一個最小動作與仍禁止事項。
                </p>
              </div>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                GO / PAUSE note
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["GO", "只允許請使用者決定是否貼出安裝授權文字；仍不直接執行命令。"],
                ["PAUSE", "列出下一個最小修補動作，修補後回到最終閘門或二次確認。"],
                ["留痕", "記錄原因、缺項與仍禁止事項，避免把 GO 或 PAUSE 誤當成授權。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-install-final-gate-go-handoff">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes 最終閘門 GO 後交接</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  閘門判斷為 GO 後，只交接到使用者閱讀並決定是否貼出安裝授權文字；仍不執行命令。
                </p>
              </div>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                read only
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["GO 只代表", "目前沒有阻擋項，可以請使用者閱讀授權文字。"],
                ["使用者決定", "使用者不想開始就不要貼；貼出後仍要走授權句檢查。"],
                ["仍禁止", "不安裝、不執行命令、不填憑證、不 Run now、不排程、不喚醒。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-install-final-gate-pause-handoff">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes 最終閘門 PAUSE 修補交接</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  閘門判斷為 PAUSE 時，只記錄風險並選一個最小修補動作；修補後回到最終閘門重判。
                </p>
              </div>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                repair only
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["PAUSE 原因", "記錄觸發項目、風險摘要與是否含敏感資訊，不重貼密鑰。"],
                ["最小修補", "只選一個：健康檢查、補交接、回開工接續、回命令預覽或回二次確認。"],
                ["修補後", "重新複製最終閘門並重判 GO / PAUSE；未 GO 前不顯示授權文字。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-authorization-ladder">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes 授權階梯</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  沒有明確授權階級時只停在第 0 階。每跨一階都要先回報結果，再由使用者決定是否繼續。
                </p>
              </div>
              <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                0 到 4 階
              </span>
            </div>
            <div className="mt-3 grid gap-2 lg:grid-cols-5">
              {HERMES_AUTHORIZATION_LADDER.map((step) => (
                <div key={step.level} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="flex items-center gap-2">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                      {step.level}
                    </span>
                    <div className="text-xs font-medium">{step.title}</div>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{step.allowed}</p>
                  <p className="mt-2 text-[11px] leading-5 text-muted-foreground">禁止：{step.blocked}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-authorization-control">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes 授權總控狀態</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  把第 0 到第 4 階與喚醒後覆盤放在同一張卡上；任何階段未乾淨時，只做下一個最小安全動作。
                </p>
              </div>
              <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                {hermesAuthorizationControlCards.filter((card) => card.tone === "success").length} / {hermesAuthorizationControlCards.length} 可做
              </span>
            </div>
            <div className="mt-3 grid gap-2 lg:grid-cols-6">
              {hermesAuthorizationControlCards.map((card) => (
                <div key={`${card.level}-${card.title}`} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
                        {card.level}
                      </span>
                      <div className="text-xs font-medium">{card.title}</div>
                    </div>
                    <span
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-[11px]",
                        card.tone === "success"
                          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700"
                          : "border-amber-500/40 bg-amber-500/10 text-amber-700",
                      )}
                    >
                      {card.status}
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{card.detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-install-authorization-intake">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes 安裝授權貼出前確認</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  「好的、繼續、下一步、可以」都不是安裝授權；只有明確寫出 Hermes 安裝或設定範圍，才可進 ACCEPT。
                </p>
              </div>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                ACCEPT / WAIT / PAUSE
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["不算授權", "好的、繼續、下一步、可以、請繼續、照你建議。"],
                ["可接受文字", "我確認要開始 Hermes 安裝或設定，請 Codex 陪同進行。"],
                ["仍然禁止", "不填憑證、不建立 issue、不 Run now、不啟用 trigger、不喚醒 Hermes。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-install-authorization-wait-pause">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes 安裝授權 WAIT/PAUSE 處理</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  授權句檢查未 ACCEPT 時，只補明確授權或停下排查；不把「好的、繼續、下一步」當成安裝授權。
                </p>
              </div>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                wait / pause
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["WAIT", "文字不夠明確，只能請使用者補明確授權或回去閱讀授權文字。"],
                ["PAUSE", "出現憑證、Run now、排程、喚醒、跳過預覽或正式資料就停下。"],
                ["仍禁止", "不把 WAIT/PAUSE 當 ACCEPT；不安裝、不執行命令、不填憑證、不喚醒。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-install-authorization-accept-handoff">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes 安裝授權 ACCEPT 交接</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  ACCEPT 後只進逐條命令陪同；它不是憑證、Run now、排程或喚醒授權。
                </p>
              </div>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                Install only
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["前提", "授權句檢查為 ACCEPT，二次確認為 GO，且命令預覽已列出。"],
                ["只允許", "逐條確認命令，只執行使用者明確同意的單一命令。"],
                ["仍禁止", "不填憑證、不建立 issue、不 Run now、不啟用 trigger、不喚醒 Hermes。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-install-command-cycle-consolidated">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes 安裝逐條命令通用流程</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  001 到 005 的專屬卡已收攏為同一套流程；每一條命令都只重複使用預覽、同意、結果、判讀與總結，不再新增無限編號卡。
                </p>
              </div>
              <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-700">
                通用流程
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-5">
              {[
                ["1 預覽", "複製命令預覽，只列一條候選命令、目的、風險與停手線，不執行。"],
                ["2 同意", "複製逐條同意，確認命令完全一致，只同意或拒絕本條。"],
                ["3 結果", "複製命令回報，記錄 PASS / WAIT / PAUSE、下載安裝與敏感資訊。"],
                ["4 判讀", "複製結果判讀，PASS 也只代表本條乾淨，不授權下一條。"],
                ["5 總結", "複製陪同總結或收工交接，方便重開機與覆盤。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="hidden" data-testid="hermes-install-legacy-numbered-command-cards">
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-accept-first-command-preview">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes ACCEPT 後第一命令預覽</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  ACCEPT 後第一步仍只列 HERMES-INSTALL-001 的候選命令、目的、風險與停手線，不直接執行。
                </p>
              </div>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                preview only
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["前提", "授權句已 ACCEPT、ACCEPT 交接完成，且 Backend/Frontend OK。"],
                ["只列一條", "只列 HERMES-INSTALL-001，不連續列多條，也不要求一次同意。"],
                ["仍禁止", "不執行、不填憑證、不建 issue、不 Run now、不排程、不喚醒。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-install-first-command-consent">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes HERMES-INSTALL-001 單一命令同意</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  第一命令預覽後，只能同意或拒絕 HERMES-INSTALL-001；命令不同就回預覽，不延伸下一條。
                </p>
              </div>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                one command
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["前提", "授權句已 ACCEPT、第一命令預覽已完成，且實際命令完全一致。"],
                ["只同意一條", "只允許 HERMES-INSTALL-001；不同意或不同命令就回到預覽。"],
                ["執行後停下", "立刻回報結果與敏感資訊檢查；未回報前不列下一條。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-install-first-command-result">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes HERMES-INSTALL-001 單一命令結果</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  第一條命令執行後立刻停下，檢查命令一致、安裝下載、PATH/設定、敏感資訊與 PASS/WAIT/PAUSE。
                </p>
              </div>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                report first
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["先停下", "HERMES-INSTALL-001 執行後先回報結果，不列也不執行下一條。"],
                ["檢查越線", "確認是否下載安裝、修改設定、出現憑證、Run now、排程或模型喚醒。"],
                ["判斷出口", "PASS 只進結果判讀或下一張安全卡；WAIT/PAUSE 都不執行下一條。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-install-first-command-decision">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes HERMES-INSTALL-001 結果判讀</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  讀完第一命令結果後，把 PASS / WAIT / PAUSE 收斂到下一張安全卡、只讀補查或停下排查。
                </p>
              </div>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                decide first
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["PASS", "只代表第一條命令乾淨；可請使用者決定是否回到下一條命令預覽。"],
                ["WAIT", "資訊不足或需要只讀補查；不列下一條，也不執行下一條。"],
                ["PAUSE", "命令不一致、敏感資訊或越線行為時停下排查。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-install-first-command-cycle-summary">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes HERMES-INSTALL-001 循環總結</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  彙整第一命令的預覽、同意、結果、判讀與下一張安全卡；只做交接與覆盤，不授權下一條。
                </p>
              </div>
              <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                loop note
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["本輪狀態", "記錄第一命令預覽、同意、命令一致性、結果回報與最後判讀。"],
                ["安全檢查", "確認下載安裝、PATH/設定、憑證、Run now、trigger、live run 與喚醒狀態。"],
                ["下一張卡", "PASS 也只回安全卡或下一命令預覽；WAIT/PAUSE 都停下處理。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-install-next-command-preview">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes HERMES-INSTALL-002 候選命令預覽</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  第一循環 PASS 後，只列 HERMES-INSTALL-002 的候選命令、目的、風險與停手線，不直接執行。
                </p>
              </div>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                preview only
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["前提", "HERMES-INSTALL-001 循環總結完成，且最後判讀是 PASS。"],
                ["只列一條", "只列 HERMES-INSTALL-002；不把 PASS 當成執行授權。"],
                ["仍禁止", "不執行、不下載、不安裝、不填憑證、不建 issue、不 Run now、不喚醒。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-install-second-command-consent">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes HERMES-INSTALL-002 單一命令同意</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  第二命令預覽後，只能同意或拒絕 HERMES-INSTALL-002；命令不同就回預覽，不延伸下一條。
                </p>
              </div>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                one command
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["前提", "第一循環 PASS、第二命令預覽已完成，且實際命令完全一致。"],
                ["只同意一條", "只允許 HERMES-INSTALL-002；不同意或不同命令就回到預覽。"],
                ["執行後停下", "立刻回報結果與敏感資訊檢查；未回報前不列下一條。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-install-second-command-result">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes HERMES-INSTALL-002 單一命令結果</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  第二條命令執行後立刻停下，檢查命令一致、安裝下載、PATH/設定、敏感資訊與 PASS/WAIT/PAUSE。
                </p>
              </div>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                report second
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["先停下", "HERMES-INSTALL-002 執行後先回報結果，不列也不執行下一條。"],
                ["檢查越線", "確認是否下載安裝、修改設定、出現憑證、Run now、排程或模型喚醒。"],
                ["判斷出口", "PASS 只進結果判讀或下一張安全卡；WAIT/PAUSE 都不執行下一條。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-install-second-command-decision">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes HERMES-INSTALL-002 結果判讀</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  讀完第二命令結果後，把 PASS / WAIT / PAUSE 收斂到下一張安全卡、只讀補查或停下排查。
                </p>
              </div>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                decide second
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["PASS", "只代表第二條命令乾淨；可請使用者決定是否回到下一條命令預覽。"],
                ["WAIT", "資訊不足或需要只讀補查；不列下一條，也不執行下一條。"],
                ["PAUSE", "命令不一致、敏感資訊或越線行為時停下排查。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-install-second-command-cycle-summary">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes HERMES-INSTALL-002 循環總結</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  彙整第二命令的預覽、同意、結果、判讀與下一張安全卡；只做交接與覆盤，不授權下一條。
                </p>
              </div>
              <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                loop note
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["本輪狀態", "記錄第二命令預覽、同意、命令一致性、結果回報與最後判讀。"],
                ["安全檢查", "確認下載安裝、PATH/設定、憑證、Run now、trigger、live run 與喚醒狀態。"],
                ["下一張卡", "PASS 也只回安全卡或下一命令預覽；WAIT/PAUSE 都停下處理。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-install-third-command-preview">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes HERMES-INSTALL-003 候選命令預覽</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  第二循環 PASS 後，只列 HERMES-INSTALL-003 的候選命令、目的、風險與停手線，不直接執行。
                </p>
              </div>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                preview only
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["前提", "HERMES-INSTALL-002 循環總結完成，且最後判讀是 PASS。"],
                ["只列一條", "只列 HERMES-INSTALL-003；不把 PASS 當成執行授權。"],
                ["仍禁止", "不執行、不下載、不安裝、不填憑證、不建 issue、不 Run now、不喚醒。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-install-third-command-consent">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes HERMES-INSTALL-003 單一命令同意</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  第三命令預覽後，只能同意或拒絕 HERMES-INSTALL-003；命令不同就回預覽，不延伸下一條。
                </p>
              </div>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                one command
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["前提", "第二循環 PASS、第三命令預覽已完成，且實際命令完全一致。"],
                ["只同意一條", "只允許 HERMES-INSTALL-003；不同意或不同命令就回到預覽。"],
                ["執行後停下", "立刻回報結果與敏感資訊檢查；未回報前不列下一條。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-install-third-command-result">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes HERMES-INSTALL-003 單一命令結果</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  第三條命令執行後立刻停下，檢查命令一致、安裝下載、PATH/設定、敏感資訊與 PASS/WAIT/PAUSE。
                </p>
              </div>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                report third
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["先停下", "HERMES-INSTALL-003 執行後先回報結果，不列也不執行下一條。"],
                ["檢查越線", "確認是否下載安裝、修改設定、出現憑證、Run now、排程或模型喚醒。"],
                ["判斷出口", "PASS 只進結果判讀或下一張安全卡；WAIT/PAUSE 都不執行下一條。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-install-third-command-decision">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes HERMES-INSTALL-003 結果判讀</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  讀完第三命令結果後，把 PASS / WAIT / PAUSE 收斂到下一張安全卡、只讀補查或停下排查。
                </p>
              </div>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                decide third
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["PASS", "只代表第三條命令乾淨；可請使用者決定是否回到下一條命令預覽。"],
                ["WAIT", "資訊不足或需要只讀補查；不列下一條，也不執行下一條。"],
                ["PAUSE", "命令不一致、敏感資訊或越線行為時停下排查。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-install-third-command-cycle-summary">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes HERMES-INSTALL-003 循環總結</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  彙整第三命令的預覽、同意、結果、判讀與下一張安全卡；只做交接與覆盤，不授權下一條。
                </p>
              </div>
              <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                loop note
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["本輪狀態", "記錄第三命令預覽、同意、命令一致性、結果回報與最後判讀。"],
                ["安全檢查", "確認下載安裝、PATH/設定、憑證、Run now、trigger、live run 與喚醒狀態。"],
                ["下一張卡", "PASS 也只回安全卡或下一命令預覽；WAIT/PAUSE 都停下處理。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-install-fourth-command-preview">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes HERMES-INSTALL-004 候選命令預覽</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  第三循環 PASS 後，只列 HERMES-INSTALL-004 的候選命令、目的、風險與停手線，不直接執行。
                </p>
              </div>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                preview only
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["前提", "HERMES-INSTALL-003 循環總結完成，且最後判讀是 PASS。"],
                ["只列一條", "只列 HERMES-INSTALL-004；不把 PASS 當成執行授權。"],
                ["仍禁止", "不執行、不下載、不安裝、不填憑證、不建 issue、不 Run now、不喚醒。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-install-fourth-command-consent">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes HERMES-INSTALL-004 單一命令同意</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  第四命令預覽後，只能同意或拒絕 HERMES-INSTALL-004；命令不同就回預覽，不延伸下一條。
                </p>
              </div>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                one command
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["前提", "第三循環 PASS、第四命令預覽已完成，且實際命令完全一致。"],
                ["只同意一條", "只允許 HERMES-INSTALL-004；不同意或不同命令就回到預覽。"],
                ["執行後停下", "立刻回報結果與敏感資訊檢查；未回報前不列下一條。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-install-fourth-command-result">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes HERMES-INSTALL-004 單一命令結果</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  第四條命令執行後立刻停下，檢查命令一致、安裝下載、PATH/設定、敏感資訊與 PASS/WAIT/PAUSE。
                </p>
              </div>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                report fourth
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["先停下", "HERMES-INSTALL-004 執行後先回報結果，不列也不執行下一條。"],
                ["檢查越線", "確認是否下載安裝、修改設定、出現憑證、Run now、排程或模型喚醒。"],
                ["判斷出口", "PASS 只進結果判讀或下一張安全卡；WAIT/PAUSE 都不執行下一條。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-install-fourth-command-decision">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes HERMES-INSTALL-004 結果判讀</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  讀完第四命令結果後，把 PASS / WAIT / PAUSE 收斂到下一張安全卡、只讀補查或停下排查。
                </p>
              </div>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                decide fourth
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["PASS", "只代表第四條命令乾淨；可請使用者決定是否回到下一條命令預覽。"],
                ["WAIT", "資訊不足或需要只讀補查；不列下一條，也不執行下一條。"],
                ["PAUSE", "命令不一致、敏感資訊或越線行為時停下排查。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-install-fourth-command-cycle-summary">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes HERMES-INSTALL-004 循環總結</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  彙整第四命令的預覽、同意、結果、判讀與下一張安全卡；只做交接與覆盤，不授權下一條。
                </p>
              </div>
              <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                loop note
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["本輪狀態", "記錄第四命令預覽、同意、命令一致性、結果回報與最後判讀。"],
                ["安全檢查", "確認下載安裝、PATH/設定、憑證、Run now、trigger、live run 與喚醒狀態。"],
                ["下一張卡", "PASS 也只回安全卡或下一命令預覽；WAIT/PAUSE 都停下處理。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-install-fifth-command-preview">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes HERMES-INSTALL-005 候選命令預覽</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  第四循環 PASS 後，只列 HERMES-INSTALL-005 的候選命令、目的、風險與停手線，不直接執行。
                </p>
              </div>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                preview only
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["前提", "HERMES-INSTALL-004 循環總結完成，且最後判讀是 PASS。"],
                ["只列一條", "只列 HERMES-INSTALL-005；不把 PASS 當成執行授權。"],
                ["仍禁止", "不執行、不下載、不安裝、不填憑證、不建 issue、不 Run now、不喚醒。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-install-fifth-command-consent">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes HERMES-INSTALL-005 單一命令同意</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  第五命令預覽後，只能同意或拒絕 HERMES-INSTALL-005；命令不同就回預覽，不延伸下一條。
                </p>
              </div>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                one command
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["前提", "第四循環 PASS、第五命令預覽已完成，且實際命令完全一致。"],
                ["只同意一條", "只允許 HERMES-INSTALL-005；不同意或不同命令就回到預覽。"],
                ["執行後停下", "立刻回報結果與敏感資訊檢查；未回報前不列下一條。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-install-fifth-command-result">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes HERMES-INSTALL-005 單一命令結果</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  第五條命令執行後立刻停下，檢查命令一致、安裝下載、PATH/設定、敏感資訊與 PASS/WAIT/PAUSE。
                </p>
              </div>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                report fifth
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["先停下", "HERMES-INSTALL-005 執行後先回報結果，不列也不執行下一條。"],
                ["檢查越線", "確認是否下載安裝、修改設定、出現憑證、Run now、排程或模型喚醒。"],
                ["判斷出口", "PASS 只進結果判讀或下一張安全卡；WAIT/PAUSE 都不執行下一條。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-install-fifth-command-decision">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes HERMES-INSTALL-005 結果判讀</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  讀完第五命令結果後，把 PASS / WAIT / PAUSE 收斂到下一張安全卡、只讀補查或停下排查。
                </p>
              </div>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                decide fifth
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["PASS", "只代表第五條命令乾淨；可請使用者決定是否回到下一條命令預覽。"],
                ["WAIT", "資訊不足或需要只讀補查；不列下一條，也不執行下一條。"],
                ["PAUSE", "命令不一致、敏感資訊或越線行為時停下排查。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-single-command-result">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes 單一命令結果回報</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  每執行完一條命令就先回報 PASS / WAIT / PAUSE；未完成回報前不執行下一條。
                </p>
              </div>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                one command
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["結果", "PASS / WAIT / PAUSE，附輸出摘要與錯誤摘要。"],
                ["敏感資訊", "檢查 API key、token、密碼、正式資料、Run now 與 live run。"],
                ["下一步", "PASS 也只能請使用者決定是否同意下一條，不連續執行。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-single-command-decision">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes 命令結果判讀</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  把單一命令回報轉成下一個安全動作；PASS 也不是下一條命令授權。
                </p>
              </div>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                decide next
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["PASS", "結果乾淨；只能請使用者決定是否同意下一條命令。"],
                ["WAIT", "資訊不足或需只讀補查；不執行下一條命令。"],
                ["PAUSE", "出現風險、錯誤或敏感資訊；立刻停下排查。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-single-command-pass-handoff">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes 命令 PASS 後交接</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  PASS 只代表本條命令乾淨；下一條仍要回到命令預覽或逐條同意。
                </p>
              </div>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                no auto next
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["代表", "本條完成且未發現敏感資訊、正式資料或模型喚醒。"],
                ["只允許", "回命令預覽，或請使用者逐條同意下一個單一命令。"],
                ["禁止", "不連續執行、不延伸同意、不填憑證、不建立 issue、不喚醒。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-single-command-wait-pause">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes 命令 WAIT/PAUSE 處理</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  WAIT 只補資訊或只讀重查；PAUSE 只停下排查。兩者都不是重試或下一條命令授權。
                </p>
              </div>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                stop first
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["WAIT", "等待補充、只讀檢查、回命令預覽；不執行下一條。"],
                ["PAUSE", "停止命令，整理非敏感錯誤與復原建議，不自行修復。"],
                ["禁止", "不重試、不填憑證、不建立 issue、不 Run now、不喚醒 Hermes。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-install-companion-cycle-summary">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes 安裝陪同循環總結</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  整理本輪命令數、最後判讀、敏感資訊檢查與下一張安全卡；它不是下一條命令授權。
                </p>
              </div>
              <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                handoff
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["範圍", "記錄授權階級、執行環境、已執行命令數與最後判讀。"],
                ["安全", "確認沒有憑證、正式資料、Run now、trigger、live run 或模型喚醒。"],
                ["下一張卡", "PASS 用 PASS 交接；WAIT/PAUSE 用 WAIT/PAUSE；收工用最後交接。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-install-companion-shutdown-handoff">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes 安裝陪同收工交接</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  關機、重開機或換對話前，記錄預覽狀態、最後安全卡與明天開工入口；它不是明天的授權。
                </p>
              </div>
              <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                shutdown
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["收工前", "記錄 Backend/Frontend、最後安全卡、最後判讀與明天第一步。"],
                ["明天入口", "先確認預覽健康，再讀交接；命令同意不可沿用。"],
                ["仍未授權", "不填憑證、不建 issue、不 Run now、不排程、不喚醒 Hermes。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-install-companion-startup-resume">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes 安裝陪同開工接續判斷</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  隔天、重開機或換對話後，先確認預覽與收工交接，再決定回命令預覽、逐條同意或暫停。
                </p>
              </div>
              <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                startup
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["開工前", "先確認 Backend/Frontend，讀收工交接，不沿用昨天同意。"],
                ["接續入口", "預覽 blocked 先復原；PASS 回命令預覽或逐條同意；WAIT/PAUSE 先停。"],
                ["仍禁止", "不填憑證、不建 issue、不 Run now、不排程、不喚醒 Hermes。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-startup-next-command-preview">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes 開工後下一條命令預覽</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  只在開工接續判斷為 PASS HANDOFF 後使用；先列一條候選命令、目的、風險與停手線，不執行。
                </p>
              </div>
              <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                preview only
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["前提", "Backend/Frontend OK、已讀開工接續，且狀態是 PASS HANDOFF。"],
                ["只列一條", "列出命令、執行位置、目的、會讀/改什麼、成功判斷與停手線。"],
                ["仍禁止", "不執行、不下載、不安裝、不填憑證、不建 issue、不 Run now、不喚醒。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-startup-single-command-approval">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes 開工後單一命令同意</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  下一條命令預覽完成後，只同意或拒絕 HERMES-NEXT-001；命令不同就回預覽，執行後立刻停下回報。
                </p>
              </div>
              <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                one command
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["同意前", "Backend/Frontend OK、PASS HANDOFF、已讀下一命令預覽，且命令完全一致。"],
                ["只准一條", "只能同意 HERMES-NEXT-001；不同意或不同命令就回到預覽。"],
                ["執行後", "立刻停止並回報結果，再進命令結果回報或結果判讀。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-startup-single-command-result">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes 開工後單一命令結果</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  HERMES-NEXT-001 執行後先停下，確認命令一致、結果、敏感資訊與 PASS/WAIT/PAUSE，再決定下一張卡。
                </p>
              </div>
              <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                result gate
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["一致性", "實際命令與執行位置必須符合預覽；不一致就 PAUSE，不補跑。"],
                ["結果檢查", "回報 PASS/WAIT/PAUSE、錯誤、修改範圍、下載安裝與敏感資訊。"],
                ["下一步", "PASS 才能請使用者決定是否回預覽；WAIT/PAUSE 都不跑下一條。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-startup-single-command-decision">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes 開工後單一命令判讀</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  讀完 HERMES-NEXT-001 結果後，將 PASS/WAIT/PAUSE 收斂成回預覽、只讀補查或停下排查。
                </p>
              </div>
              <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                decision
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["PASS", "只代表本條乾淨；只能請使用者決定是否回到下一條命令預覽。"],
                ["WAIT", "只補資訊或只讀檢查，不執行下一條命令。"],
                ["PAUSE", "命令不一致、錯誤、敏感資訊、Run now、trigger 或喚醒都立刻停下。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-startup-single-command-cycle-summary">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes 開工後單一命令循環總結</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  整理 HERMES-NEXT-001 的預覽、同意、結果、判讀與下一張安全卡；它只做交接，不授權下一條。
                </p>
              </div>
              <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                loop note
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["本輪狀態", "記錄預覽、同意、命令一致性、結果回報與最後判讀。"],
                ["安全檢查", "確認沒有憑證、正式資料、Run now、trigger、live run 或模型喚醒。"],
                ["下一張卡", "PASS 回下一命令預覽；WAIT/PAUSE 停下處理；收工用收工交接。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-final-pre-install-handoff">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes 安裝前最後交接包</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  把安裝前快照、檢查包、命令預覽、授權文字、陪同紀錄與停手線整理成一份交接內容；它只是交接，不是安裝授權。
                </p>
              </div>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                不跨線
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["交接內容", "目前狀態、可用工具、建議順序、下一個安全動作與風險判斷。"],
                ["停手線", "安裝、下載、寫檔、改 PATH、設定、憑證與喚醒都必須再次確認。"],
                ["適用時機", "換新對話、重開機後、準備安裝前，先讓 Codex 讀這份交接包。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-provider-model-precheck">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes provider/model 設定前判斷</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  先選一個你已有帳號或額度的 provider 與一個成本可控的 model；這裡只整理選項，不登入、不填 key、不建立任務、不喚醒 Hermes。
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                  設定前
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8 shrink-0"
                  onClick={copyHermesProviderModelChoiceMarkdown}
                  data-testid="hermes-action-copy-provider-model-choice"
                >
                  複製選擇表
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8 shrink-0"
                  onClick={copyHermesProviderModelReviewMarkdown}
                  data-testid="hermes-action-copy-provider-model-review"
                >
                  複製檢查規則
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8 shrink-0"
                  onClick={copyHermesProviderModelCommandPreviewMarkdown}
                  data-testid="hermes-action-copy-provider-model-command-preview"
                >
                  複製命令預覽
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8 shrink-0"
                  onClick={copyHermesProviderModelSelfSetupGuideMarkdown}
                  data-testid="hermes-action-copy-provider-model-self-setup"
                >
                  複製自行設定陪跑
                </Button>
              </div>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["先選一個", "OpenRouter、OpenAI/Codex、Anthropic、Nous、Qwen、Kimi、MiniMax 或 Z.AI 擇一開始。"],
                ["可以回報", "provider 名稱、model 名稱、是否已有帳號或額度、是否準備在 Hermes 自己的設定位置填 key。"],
                ["不要回報", "API key、token、密碼、完整 .env、含憑證的 URL/header/log、正式客戶或公司資料。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-credential-handoff">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes 設定完成回報</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  當你在 Hermes 自己的設定位置填好 model / provider / API key 後，只回報非敏感狀態；不要把密鑰或完整 .env 貼進 Office、文件、issue 或對話。
                </p>
              </div>
              <span className="rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[11px] text-sky-700">
                不收密鑰
              </span>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesProviderModelPostSetupHandoffMarkdown}
                data-testid="hermes-action-copy-provider-model-post-setup"
              >
                複製設定後交接
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesSettingsReportReviewMarkdown}
                data-testid="hermes-action-copy-settings-report-review"
              >
                複製判讀規則
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesReadOnlyPrecheckMarkdown}
                data-testid="hermes-action-copy-read-only-precheck"
              >
                複製只讀前確認
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesReadOnlyCheckRequestMarkdown}
                data-testid="hermes-action-copy-read-only-check-request"
              >
                複製只讀檢查
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesReadOnlyResultHandoffMarkdown}
                data-testid="hermes-action-copy-read-only-result-handoff"
              >
                複製結果交接
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesReadOnlyResultReviewMarkdown}
                data-testid="hermes-action-copy-read-only-result-review"
              >
                複製結果判讀
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={copyHermesReadOnlyPassHandoffMarkdown}
                data-testid="hermes-action-copy-read-only-pass-handoff"
              >
                複製 PASS 後交接
              </Button>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["可以回報", "bridge 是否可用、model 是否已設定、provider 名稱、Test environment 結果摘要。"],
                ["不要回報", "API key、token、密碼、完整 .env、含憑證的私人 URL 或正式資料。"],
                ["下一步", "資訊足夠後只做健康檢查或 Test environment；不建立喚醒 issue，也不 Run now。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-configuration-check">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-medium">Hermes 第 3 階設定檢查表</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  設定完成後只整理非敏感狀態與只讀檢查結果；若需要新命令，先回到第 1 階命令預覽，不把這一步當成喚醒授權。
                </p>
              </div>
              <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-700">
                第 3 階
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {[
                ["可回報", "版本、provider、model、API key 是否已在正確位置、Test environment 摘要。"],
                ["不可貼", "API key、token、密碼、完整 .env、含憑證的 URL/header/log 或正式資料。"],
                ["只讀邊界", "只檢查缺項與解讀結果；不建立 issue、不 Run now、不啟用排程、不喚醒模型。"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="text-xs font-medium">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-md border border-border/70 bg-background p-3" data-testid="hermes-install-risk-decision">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h5 className="text-xs font-medium">Hermes 安裝前風險判斷</h5>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  這裡只做 GO/PAUSE 判斷；真正跨過安裝線前仍需要使用者明確授權。
                </p>
              </div>
              <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                {hermesInstallRiskCards.filter((card) => card.tone === "success").length} / {hermesInstallRiskCards.length} 通過
              </span>
            </div>
            <div className="mt-3 grid gap-2 lg:grid-cols-5">
              {hermesInstallRiskCards.map((card) => (
                <div key={card.label} className="rounded-md border border-border/70 bg-card p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs font-medium">{card.label}</div>
                    <span
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-[11px]",
                        card.tone === "success"
                          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700"
                          : "border-amber-500/40 bg-amber-500/10 text-amber-700",
                      )}
                    >
                      {card.status}
                    </span>
                  </div>
                  <div className="mt-2 truncate text-xs font-medium">{card.value}</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{card.detail}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="mt-4 rounded-md border border-border/70 bg-background p-3" data-testid="virtual-office-routine-safety">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-[11px] font-medium text-violet-700">
                排程
              </span>
              <h3 className="text-sm font-medium">Routine / schedule 安全面板</h3>
            </div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              例行工作適合每日整理、每週覆盤與阻塞提醒；這裡只讀目前狀態並連到既有 Routines 頁，不會直接啟用 cron 或喚醒本地模型。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 shrink-0"
              onClick={copyRoutineSafetyMarkdown}
              data-testid="starter-action-routine-checklist"
            >
              <Copy className="mr-1.5 h-4 w-4" />
              複製排程檢查表
            </Button>
            <Button
              asChild
              type="button"
              size="sm"
              variant="outline"
              className="h-8 shrink-0"
              data-testid="starter-action-routine-draft"
            >
              <Link to={virtualOfficeRoutineDraftHref(ROUTINE_STARTER_TEMPLATES[0]!)}>
                <Plus className="mr-1.5 h-4 w-4" />
                預填 routine 草稿
              </Link>
            </Button>
            <Button asChild type="button" size="sm" variant="outline" className="h-8 shrink-0">
              <Link to="/routines">
                <CalendarClock className="mr-1.5 h-4 w-4" />
                打開 Routines
              </Link>
            </Button>
            <Button asChild type="button" size="sm" variant="ghost" className="h-8 shrink-0">
              <Link to="/routines?tab=runs">查看最近執行</Link>
            </Button>
          </div>
        </div>
        <div className="mt-3 grid gap-2 lg:grid-cols-4">
          {routineSafetyCards.map((card) => (
            <div key={card.label} className="rounded-md border border-border/70 bg-card p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-medium">{card.label}</div>
                <span
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[11px]",
                    card.tone === "success"
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700"
                      : "border-amber-500/40 bg-amber-500/10 text-amber-700",
                  )}
                >
                  {card.status}
                </span>
              </div>
              <div className="mt-2 truncate text-xs font-medium">{card.value}</div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{card.detail}</p>
            </div>
          ))}
        </div>
        <div className="mt-3 grid gap-2 lg:grid-cols-3" data-testid="routine-safety-steps">
          {ROUTINE_SAFETY_STEPS.map((step) => (
            <div key={step.label} className="rounded-md border border-blue-500/20 bg-blue-500/5 p-3">
              <div className="text-xs font-medium text-blue-700">{step.label}</div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{step.detail}</p>
            </div>
          ))}
        </div>
        <div className="mt-3 grid gap-2 lg:grid-cols-3">
          {ROUTINE_STARTER_TEMPLATES.map((template) => (
            <div key={template.label} className="rounded-md border border-border/70 bg-muted/20 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-medium">{template.label}</div>
                <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
                  {template.cadence}
                </span>
              </div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{template.detail}</p>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-4 border-t border-border/70 pt-4">
        <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h3 className="text-sm font-medium">新手進度</h3>
            <p className="text-xs text-muted-foreground">照這四步走，就能從空公司變成可協作的個人 AI 團隊。</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              {completedStepCount} / {starterSteps.length} 完成
            </span>
            <span className="text-xs text-muted-foreground">
              {reviewedStepCount} / {starterSteps.length} 已讀
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 px-2 text-xs"
              onClick={() => setChecklistExpanded((open) => !open)}
            >
              {checklistExpanded ? <ChevronUp className="mr-1 h-4 w-4" /> : <ChevronDown className="mr-1 h-4 w-4" />}
              {checklistExpanded ? "收起驗收" : "顯示驗收"}
            </Button>
          </div>
        </div>
        <div className="mb-3 h-2 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${completionPercent}%` }} />
        </div>
        <ol className="grid gap-2 lg:grid-cols-4">
          {starterSteps.map((step, index) => (
            <li key={step.label} className="flex min-h-28 flex-col justify-between rounded-md border border-border/70 bg-background p-3">
              <div className="space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className={cn(
                        "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium",
                        step.done
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-muted text-muted-foreground",
                      )}
                    >
                      {step.done ? <CheckCircle2 className="h-3.5 w-3.5" /> : index + 1}
                    </span>
                    <span className="truncate text-sm font-medium">{step.label}</span>
                  </div>
                  <span
                    className={cn(
                      "shrink-0 rounded-full border px-2 py-0.5 text-[11px]",
                      step.done
                        ? "border-primary/40 bg-primary/10 text-primary"
                        : "border-amber-500/40 bg-amber-500/10 text-amber-600",
                    )}
                  >
                    {step.done ? step.statusLabel : (
                      <span className="inline-flex items-center gap-1">
                        <TriangleAlert className="h-3 w-3" />
                        {step.statusLabel}
                      </span>
                    )}
                  </span>
                </div>
                <p className="text-xs leading-5 text-muted-foreground">{step.description}</p>
                {checklistExpanded && (
                  <ul className="space-y-1 border-t border-border/70 pt-2 text-xs text-muted-foreground">
                    {step.checkItems.map((item) => (
                      <li key={item} className="flex gap-2">
                        <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/70" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-1 2xl:grid-cols-2">
                <Button type="button" size="sm" variant={step.done ? "outline" : "default"} className="h-8" onClick={step.onClick}>
                  {step.actionLabel}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={reviewedStepIds.includes(step.id) ? "secondary" : "ghost"}
                  className="h-8"
                  onClick={() => toggleReviewedStep(step.id)}
                >
                  {reviewedStepIds.includes(step.id) ? "已讀" : "標記已讀"}
                </Button>
              </div>
            </li>
          ))}
        </ol>
      </div>

      <Dialog
        open={cleanWorkflowOpen}
        onOpenChange={(open) => {
          setCleanWorkflowOpen(open);
          if (!open) {
            setCleanWorkflowPauseConfirm(false);
            setCleanWorkflowCancelRunIds([]);
          }
        }}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>處理工作流乾淨驗收</DialogTitle>
            <DialogDescription>
              暫停執行中或錯誤中的員工後，再建立沙盒工作流，比較不會產生 recovery 任務干擾驗收。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800">
              <div className="flex items-start gap-2">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <p className="leading-5">
                  這裡會修改員工狀態。若你正在等某位員工完成工作，先不要暫停；可以只複製狀態、留下紀錄，再回來處理。
                </p>
              </div>
            </div>

            {workflowWakeRiskAgents.length > 0 ? (
              <div className="space-y-2">
                <div className="text-sm font-medium">目前需要處理的員工</div>
                {workflowWakeRiskAgents.map((agent) => (
                  <label
                    key={agent.id}
                    className="flex items-start gap-3 rounded-md border border-border/70 bg-background p-3 text-sm"
                  >
                    <Checkbox
                      checked={cleanWorkflowPauseAgentIds.includes(agent.id)}
                      onCheckedChange={(checked) =>
                        setCleanWorkflowPauseAgentIds((current) =>
                          checked
                            ? Array.from(new Set([...current, agent.id]))
                            : current.filter((id) => id !== agent.id),
                        )
                      }
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{agent.name}</span>
                        <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                          {agent.status}
                        </span>
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                        {agent.title ?? "未設定職稱"} · {getAdapterLabel(agent.adapterType)}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-700">
                目前沒有 running/error 員工，可以回到工作流建立流程做乾淨驗收。
              </div>
            )}

            {workflowWakeRiskRuns.length > 0 && (
              <div className="space-y-2">
                <div className="text-sm font-medium">仍在排隊或執行的舊工作</div>
                {workflowWakeRiskRuns.map((run) => (
                  <label
                    key={run.id}
                    className="flex items-start gap-3 rounded-md border border-border/70 bg-background p-3 text-sm"
                  >
                    <Checkbox
                      checked={cleanWorkflowCancelRunIds.includes(run.id)}
                      onCheckedChange={(checked) =>
                        setCleanWorkflowCancelRunIds((current) =>
                          checked
                            ? Array.from(new Set([...current, run.id]))
                            : current.filter((id) => id !== run.id),
                        )
                      }
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{run.agentName || "未指定員工"}</span>
                        <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                          {run.status}
                        </span>
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                        {run.triggerDetail ?? run.invocationSource} · {run.issueId ? `issue ${run.issueId.slice(0, 8)}` : "沒有綁定任務"}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            )}

            <label className="flex items-start gap-2 rounded-md border border-border/70 bg-muted/30 p-3 text-xs leading-5">
              <Checkbox
                checked={cleanWorkflowPauseConfirm}
                onCheckedChange={(checked) => setCleanWorkflowPauseConfirm(Boolean(checked))}
                disabled={!workflowRequiresWakeRiskConfirmation}
              />
              <span>
                我知道這會改變選取員工或舊工作的狀態；這次是為了讓沙盒工作流驗收先避開自動喚醒與 recovery 干擾。
              </span>
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setCleanWorkflowOpen(false)}>
              先不處理
            </Button>
            <Button
              type="button"
              disabled={
                pauseCleanWorkflowAgents.isPending
                || !workflowRequiresWakeRiskConfirmation
                || (cleanWorkflowPauseAgentIds.length === 0 && cleanWorkflowCancelRunIds.length === 0)
                || !cleanWorkflowPauseConfirm
              }
              onClick={() => pauseCleanWorkflowAgents.mutate()}
            >
              {pauseCleanWorkflowAgents.isPending ? "處理中..." : "處理選取項目"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={workflowOpen}
        onOpenChange={(open) => {
          setWorkflowOpen(open);
          if (!open) setWorkflowWakeRiskConfirmed(false);
        }}
      >
        <DialogContent className="flex max-h-[88vh] flex-col overflow-hidden sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>建立專案工作流</DialogTitle>
            <DialogDescription>
              這會建立一個專案，並自動加入需求、設計、實作、測試、覆盤五個任務。
            </DialogDescription>
          </DialogHeader>
          <form className="flex min-h-0 flex-1 flex-col" onSubmit={handleSubmit}>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
            {workflowRequiresWakeRiskConfirmation && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800">
                <div className="flex items-start gap-2">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  <div className="space-y-2">
                    <div className="font-medium">建立前先確認自動喚醒風險</div>
                    <p className="leading-5">
                      目前仍有自動喚醒風險：
                      {workflowWakeRiskAgents.length > 0
                        ? `員工 ${workflowWakeRiskAgents.map((agent) => agent.name).join("、")} 處於執行中或錯誤狀態`
                        : null}
                      {workflowWakeRiskAgents.length > 0 && workflowWakeRiskRuns.length > 0 ? "，且" : null}
                      {workflowWakeRiskRuns.length > 0
                        ? `還有 ${workflowWakeRiskRunSummary || `${workflowWakeRiskRuns.length} 個舊工作`} 排隊或執行中`
                        : null}
                      。如果這時建立工作流，系統可能會產生 recovery 任務，影響驗收判讀。
                    </p>
                    <label className="flex items-start gap-2 text-xs leading-5">
                      <Checkbox
                        checked={workflowWakeRiskConfirmed}
                        onCheckedChange={(checked) => setWorkflowWakeRiskConfirmed(Boolean(checked))}
                      />
                      <span>我知道這次是沙盒測試，並已準備好記錄可能出現的 recovery 任務。</span>
                    </label>
                  </div>
                </div>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="starter-project-name">專案名稱</Label>
              <Input
                id="starter-project-name"
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
                placeholder="例如：個人品牌網站"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="starter-project-description">給團隊的說明</Label>
              <Textarea
                id="starter-project-description"
                value={projectDescription}
                onChange={(event) => setProjectDescription(event.target.value)}
                className="min-h-24"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>專案主管</Label>
                <Select value={leadAgentId} onValueChange={setLeadAgentId}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">自動選擇</SelectItem>
                    {activeAgents.map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        {agent.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>工作流型態</Label>
                <div className="grid gap-2 sm:grid-cols-2">
                  {[
                    {
                      value: "serial" as const,
                      label: "上下游順序",
                      description: "每一階段等待上一階段完成，適合線性流程。",
                    },
                    {
                      value: "parallel" as const,
                      label: "平行單位協作",
                      description: "需求後讓多個單位並行，最後由覆盤統整。",
                    },
                  ].map((option) => (
                    <div
                      key={option.value}
                      className={cn(
                        "rounded-md border p-3 text-left",
                        workflowShape === option.value
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border/70 bg-background",
                      )}
                    >
                      <span className="flex items-start gap-2">
                        <span
                          className={cn(
                            "mt-1 flex size-3.5 shrink-0 items-center justify-center rounded-full border",
                            workflowShape === option.value ? "border-primary" : "border-muted-foreground/50",
                          )}
                          aria-hidden="true"
                        >
                          {workflowShape === option.value && <span className="size-1.5 rounded-full bg-primary" />}
                        </span>
                        <span className="min-w-0">
                          <span className="block text-sm font-medium">{option.label}</span>
                          <span className="mt-1 block text-xs leading-5 text-muted-foreground">{option.description}</span>
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
                <select
                  aria-label="工作流型態"
                  value={workflowShape}
                  onChange={(event) => setWorkflowShape(event.target.value as "serial" | "parallel")}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="serial">上下游順序 - 每一階段等待上一階段完成</option>
                  <option value="parallel">平行單位協作 - 需求後多單位並行，覆盤統整</option>
                </select>
              </div>
            </div>
            <div className="space-y-2">
              <div>
                <Label>各階段負責人</Label>
                <p className="mt-1 text-xs text-muted-foreground">可以交給系統自動挑人，也可以手動指定某位員工。</p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {STARTER_PHASES.map((phase) => (
                  <div key={phase.title} className="rounded-md border border-border/70 bg-background p-3">
                    <div className="mb-2 text-sm font-medium">{phase.title}</div>
                    <Select
                      value={phaseAssignees[phase.title] ?? "auto"}
                      onValueChange={(value) =>
                        setPhaseAssignees((current) => ({
                          ...current,
                          [phase.title]: value,
                        }))
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">自動選擇</SelectItem>
                        {activeAgents.map((agent) => (
                          <SelectItem key={agent.id} value={agent.id}>
                            {agent.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            </div>
            <WorkflowBuildPreview
              phases={STARTER_PHASES}
              workflowShape={workflowShape}
              lead={workflowLead}
              getAssignee={selectedPhaseAssignee}
            />
              {createWorkflow.isError && (
                <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  建立失敗，請先確認 Paperclip 服務仍在執行，再試一次。
                </p>
              )}
            </div>
            <DialogFooter className="mt-4 border-t border-border/70 bg-card pt-4">
              <Button type="button" variant="outline" onClick={() => setWorkflowOpen(false)}>
                取消
              </Button>
              <Button
                type="submit"
                data-testid="starter-workflow-submit"
                disabled={
                  !projectName.trim()
                  || createWorkflow.isPending
                  || (workflowRequiresWakeRiskConfirmation && !workflowWakeRiskConfirmed)
                }
              >
                {createWorkflow.isPending ? "建立中..." : "建立工作流"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={meetingOpen} onOpenChange={setMeetingOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>建立討論會議</DialogTitle>
            <DialogDescription>
              建立一個可覆盤的會議任務，讓員工在同一串整理觀點、問題、決策與下一步。
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={handleMeetingSubmit}>
            <div className="space-y-2">
              <Label htmlFor="starter-meeting-title">會議主題</Label>
              <Input
                id="starter-meeting-title"
                value={meetingTitle}
                onChange={(event) => setMeetingTitle(event.target.value)}
                placeholder="例如：MVP 開發卡點討論"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="starter-meeting-agenda">議程與希望產出的結論</Label>
              <Textarea
                id="starter-meeting-agenda"
                value={meetingAgenda}
                onChange={(event) => setMeetingAgenda(event.target.value)}
                className="min-h-24"
              />
            </div>
            <div className="rounded-md border border-border/70 bg-muted/30 p-3">
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={meetingNeedsUserDecision}
                  onCheckedChange={(checked) => setMeetingNeedsUserDecision(checked === true)}
                />
                <span className="min-w-0">
                  <span className="block font-medium">需要我介入決策</span>
                  <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                    勾選後，會議任務會要求員工把需要你拍板的問題集中整理，方便你之後進入討論串補充或決定。
                  </span>
                </span>
              </label>
              {meetingNeedsUserDecision && (
                <div className="mt-3 space-y-2">
                  <Label htmlFor="starter-meeting-user-decision">介入規則</Label>
                  <Textarea
                    id="starter-meeting-user-decision"
                    value={meetingUserDecisionNote}
                    onChange={(event) => setMeetingUserDecisionNote(event.target.value)}
                    className="min-h-20 bg-background"
                  />
                </div>
              )}
            </div>
            <div className="space-y-2">
              <Label>會議紀錄模板</Label>
              <Select value={meetingTemplateId} onValueChange={setMeetingTemplateId}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MEETING_TEMPLATES.map((template) => (
                    <SelectItem key={template.id} value={template.id}>
                      {template.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{selectedMeetingTemplate.hint}</p>
              <pre className="max-h-36 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs whitespace-pre-wrap">
                {selectedMeetingTemplate.body}
              </pre>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>關聯專案</Label>
                <Select value={meetingProjectId} onValueChange={setMeetingProjectId}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">不指定專案</SelectItem>
                    {activeProjects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>主持人</Label>
                <Select value={meetingFacilitatorId} onValueChange={setMeetingFacilitatorId}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">自動選擇</SelectItem>
                    {activeAgents.map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        {agent.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <div>
                <Label>參與員工</Label>
                <p className="mt-1 text-xs text-muted-foreground">不勾選時會先把所有目前員工列為參與者。</p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {activeAgents.map((agent) => (
                  <label
                    key={agent.id}
                    className="flex items-center gap-2 rounded-md border border-border/70 bg-background px-3 py-2 text-sm"
                  >
                    <Checkbox
                      checked={meetingParticipantIds.includes(agent.id)}
                      onCheckedChange={(checked) => toggleMeetingParticipant(agent.id, checked === true)}
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{agent.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {agent.title ?? getAdapterLabel(agent.adapterType)}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
            {createMeeting.isError && (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                建立失敗，請先確認 Paperclip 服務仍在執行，再試一次。
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setMeetingOpen(false)}>
                取消
              </Button>
              <Button type="submit" disabled={!meetingTitle.trim() || createMeeting.isPending}>
                {createMeeting.isPending ? "建立中..." : "建立會議任務"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={skillOpen} onOpenChange={setSkillOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>技能安裝精靈</DialogTitle>
            <DialogDescription>
              先選一位員工，再勾選要讓他使用的公司技能。內建 Paperclip 技能會自動保留。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-2 rounded-md border border-border/70 bg-muted/30 p-3 sm:grid-cols-4">
              {skillWizardSteps.map((step, index) => (
                <div key={step.label} className="rounded-md border border-border/70 bg-background p-2">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium",
                        step.done
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-muted text-muted-foreground",
                      )}
                    >
                      {step.done ? <CheckCircle2 className="h-3.5 w-3.5" /> : index + 1}
                    </span>
                    <span className="text-sm font-medium">{step.label}</span>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{step.hint}</p>
                </div>
              ))}
            </div>

            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <div className="space-y-2">
                <Label>要配置的員工</Label>
                <Select value={skillAgentId} onValueChange={setSkillAgentId}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="選擇員工" />
                  </SelectTrigger>
                  <SelectContent>
                    {activeAgents.map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        {agent.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button type="button" variant="outline" asChild>
                <Link to="/skills">管理技能庫</Link>
              </Button>
            </div>

            <div className="rounded-md border border-border/70 bg-muted/30 p-3">
              <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex gap-2">
                  <UserRoundCog className="mt-0.5 h-4 w-4 text-primary" />
                  <div>
                    <div className="text-sm font-medium">角色模板來源</div>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      已排程參考 agency-agents，把常見專家角色轉成新手可選的員工與 skills 模板。
                    </p>
                  </div>
                </div>
                <span className="w-fit rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
                  {AGENCY_ROLE_TEMPLATES.length} 個模板
                </span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {AGENCY_ROLE_TEMPLATES.map((template) => {
                  const profile = template.profile;
                  return (
                    <div key={template.id} className="rounded-md border border-border/70 bg-background p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="text-sm font-medium">{template.name}</div>
                          <div className="mt-0.5 text-[11px] text-muted-foreground">{template.division}</div>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7"
                          onClick={() => setPreviewRoleTemplate(template)}
                        >
                          查看角色
                        </Button>
                      </div>
                      <p className="mt-2 text-xs leading-5 text-muted-foreground">{template.useWhen}</p>
                      {profile && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="mt-2 h-7 px-2 text-xs"
                          onClick={() => applySkillProfile(profile)}
                        >
                          預選 skills
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="rounded-md border border-border/70 bg-muted/30 p-3">
              <div className="mb-2 flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                <div>
                  <div className="text-sm font-medium">新手推薦包</div>
                  <p className="text-xs text-muted-foreground">先依角色預選一組技能，再依你的需要微調。</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => applySkillProfile("pm")}>
                  PM / 會議
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => applySkillProfile("engineering")}>
                  工程 / 自動化
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => applySkillProfile("quality")}>
                  測試 / 覆盤
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setSelectedSkillKeys([])}>
                  清空選擇
                </Button>
              </div>
            </div>

            <div className="rounded-md border border-border/70 bg-background p-3">
              <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="text-sm font-medium">建立常用 starter skills</div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    技能庫還空或不夠用時，可以先建立這些常用能力，再配置給員工。
                  </p>
                </div>
                <div className="shrink-0 rounded-md border border-border/70 bg-muted/40 px-3 py-2 text-xs">
                  <div className="font-medium">
                    {readyStarterSkillTemplates.length} / {STARTER_SKILL_TEMPLATES.length} 已準備
                  </div>
                  <div className="mt-1 h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${Math.round((readyStarterSkillTemplates.length / STARTER_SKILL_TEMPLATES.length) * 100)}%` }}
                    />
                  </div>
                </div>
              </div>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <Button type="button" size="sm" variant="outline" onClick={selectReadyStarterSkills}>
                  勾選已存在 starter skills
                </Button>
                <span className="text-xs text-muted-foreground">
                  {missingStarterSkillTemplates.length > 0
                    ? `還缺 ${missingStarterSkillTemplates.length} 個，請先預覽再建立。`
                    : "三個 starter skills 都已在技能庫中。"}
                </span>
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                {STARTER_SKILL_TEMPLATES.map((template) => {
                  const existingSkill = visibleCompanySkillsByName.get(template.name);
                  return (
                    <div
                      key={template.id}
                      data-testid={`starter-skill-card-${template.id}`}
                      className="rounded-md border border-border/70 bg-card p-3 text-sm"
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="font-medium">{template.name}</span>
                        {existingSkill && (
                          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
                            已有
                          </span>
                        )}
                      </span>
                      <span className="mt-1 block text-xs text-muted-foreground">{template.description}</span>
                      <span className="mt-2 block text-[11px] text-muted-foreground">
                        {existingSkill ? "可直接勾選並同步給員工。" : "建議先按預覽，確認後再建立。"}
                      </span>
                      <span className="mt-3 flex gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-8 flex-1"
                          data-testid={`starter-skill-preview-${template.id}`}
                          onClick={() => setPreviewSkillTemplate(template)}
                        >
                          <Eye className="mr-1.5 h-3.5 w-3.5" />
                          預覽
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          className="h-8 flex-1"
                          data-testid={`starter-skill-create-${template.id}`}
                          onClick={() => handleStarterSkillTemplate(template)}
                          disabled={createStarterSkill.isPending}
                        >
                          {existingSkill ? "勾選" : "建立"}
                        </Button>
                      </span>
                    </div>
                  );
                })}
              </div>
              {starterSkillNotice && (
                <p className="mt-3 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-primary">
                  {starterSkillNotice}
                </p>
              )}
            </div>

            <div className="max-h-[360px] space-y-2 overflow-auto pr-1">
              <div className="sticky top-0 z-10 rounded-md border border-border/70 bg-card px-3 py-2 text-xs text-muted-foreground shadow-sm">
                目前選取 {selectedSkillKeys.length} 個技能。只按「同步技能」才會真正寫入員工設定。
              </div>
              {visibleCompanySkills.length > 0 ? (
                visibleCompanySkills.map((skill) => (
                  <label
                    key={skill.id}
                    className="flex gap-3 rounded-md border border-border/70 bg-background p-3 text-sm"
                  >
                    <Checkbox
                      checked={selectedSkillKeys.includes(skill.key)}
                      onCheckedChange={(checked) => toggleSelectedSkill(skill.key, checked === true)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{skill.name}</span>
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                          {skill.sourceBadge}
                        </span>
                      </span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {skill.description ?? "尚無描述，建議先到技能庫補上用途說明。"}
                      </span>
                      <span className="mt-2 block text-xs text-primary">
                        {suggestedSkillAudience(skill)}
                      </span>
                    </span>
                  </label>
                ))
              ) : (
                <div className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">
                  目前還沒有可手動配置的公司技能。可以先到技能庫建立或匯入 skill。
                </div>
              )}
            </div>

            {syncSelectedAgentSkills.isError && (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                技能同步失敗，請確認 Paperclip 服務仍在執行，再試一次。
              </p>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setSkillOpen(false)}>
                取消
              </Button>
              <Button
                type="button"
                disabled={!skillAgentId || syncSelectedAgentSkills.isPending}
                onClick={() => syncSelectedAgentSkills.mutate()}
              >
                {syncSelectedAgentSkills.isPending ? "同步中..." : "同步技能"}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={guideOpen} onOpenChange={setGuideOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Virtual Office 新手教學</DialogTitle>
            <DialogDescription>
              這個頁面把 Paperclip 的員工、技能、專案與任務包成比較像辦公室的操作流程。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <section className="rounded-md border border-border/70 bg-background p-3">
              <h3 className="font-medium">建議起手式</h3>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
                <li>先建立幾位員工，例如 PM、工程、測試或設計角色。</li>
                <li>到技能精靈建立 starter skills，並同步給適合的員工。</li>
                <li>用建立工作流產生專案與五個階段任務。</li>
                <li>需要討論時開會議任務，讓員工在同一串留下過程與結論。</li>
                <li>回到 Office 觀察專案進度、會議紀錄與近期活動。</li>
              </ol>
            </section>
            <section className="rounded-md border border-border/70 bg-background p-3">
              <h3 className="font-medium">這不是商業 SaaS 模板</h3>
              <p className="mt-2 text-muted-foreground">
                目前目標是讓本地模型與 Paperclip 新手更容易上手。它偏向個人團隊、個人公司、實驗室式工作台，
                之後可以開源給同樣需要低門檻介面的使用者。
              </p>
            </section>
            <section className="rounded-md border border-border/70 bg-background p-3">
              <h3 className="font-medium">新手名詞翻譯</h3>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {[
                  ["Agent", "AI 員工", "可以被指派任務、安裝技能、參與會議的角色。"],
                  ["Skill", "員工技能", "像工作手冊或 SOP，讓員工知道某類任務該怎麼做。"],
                  ["Project", "專案", "把一組相關任務、負責人與進度集中管理。"],
                  ["Issue", "任務或討論串", "真正留下工作內容、會議紀錄、決策與下一步的地方。"],
                  ["Workflow", "工作流", "把需求、設計、開發、測試、覆盤排成上下游或平行協作。"],
                  ["Heartbeat", "自動喚醒", "讓本地 agent 自動接手任務；新手預覽時建議先關閉。"],
                ].map(([term, officeName, meaning]) => (
                  <div key={term} className="rounded-md border border-border/70 bg-card p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-semibold">{term}</span>
                      <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
                        {officeName}
                      </span>
                    </div>
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">{meaning}</p>
                  </div>
                ))}
              </div>
            </section>
            <section className="rounded-md border border-border/70 bg-background p-3">
              <h3 className="font-medium">第一次使用建議路線</h3>
              <div className="mt-2 grid gap-2 lg:grid-cols-3">
                {[
                  {
                    title: "只看介面",
                    badge: "最安全",
                    steps: ["打開使用教學", "查看名詞翻譯", "打開檢查清單", "不要按建立、同步、保存或停用"],
                  },
                  {
                    title: "沙盒測試",
                    badge: "適合練習",
                    steps: ["建立測試員工", "建立測試專案", "一次只測一種資料變更", "把結果貼回驗收紀錄"],
                  },
                  {
                    title: "正式使用",
                    badge: "完成確認後",
                    steps: ["先記錄正式驗收快照", "確認本地模型與 heartbeat 狀態", "指定專案主管", "再建立正式工作流"],
                  },
                ].map((route) => (
                  <div key={route.title} className="rounded-md border border-border/70 bg-card p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{route.title}</span>
                      <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                        {route.badge}
                      </span>
                    </div>
                    <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs leading-5 text-muted-foreground">
                      {route.steps.map((step) => (
                        <li key={step}>{step}</li>
                      ))}
                    </ol>
                  </div>
                ))}
              </div>
            </section>
            <section className="rounded-md border border-border/70 bg-background p-3">
              <h3 className="font-medium">繼續前看三個訊號</h3>
              <div className="mt-2 grid gap-2 lg:grid-cols-3">
                {[
                  {
                    label: "綠燈",
                    tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700",
                    title: "可以繼續",
                    detail: "只在看教學、預覽、複製檢查清單，或測試資料名稱清楚標成 Test / Sandbox 時繼續。",
                  },
                  {
                    label: "黃燈",
                    tone: "border-amber-500/30 bg-amber-500/10 text-amber-700",
                    title: "先記錄",
                    detail: "畫面看起來成功但還沒重新整理確認，或要按同步、建立、保存前，先截圖與貼回驗收紀錄。",
                  },
                  {
                    label: "紅燈",
                    tone: "border-destructive/30 bg-destructive/10 text-destructive",
                    title: "停下確認",
                    detail: "牽涉正式資料、停用員工、開啟 heartbeat、自動喚醒模型，或不知道會改哪裡時先不要按。",
                  },
                ].map((signal) => (
                  <div key={signal.label} className="rounded-md border border-border/70 bg-card p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${signal.tone}`}>
                        {signal.label}
                      </span>
                      <span className="text-sm font-medium">{signal.title}</span>
                    </div>
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">{signal.detail}</p>
                  </div>
                ))}
              </div>
            </section>
            <section className="rounded-md border border-border/70 bg-background p-3">
              <h3 className="font-medium">開源安裝前先確認</h3>
              <div className="mt-2 grid gap-2 lg:grid-cols-3">
                {[
                  {
                    title: "必要條件",
                    items: ["Node.js 與 pnpm 可用", "Paperclip 專案已下載", "前後端預覽能打開", "先關閉 heartbeat"],
                  },
                  {
                    title: "可以先跳過",
                    items: ["真正喚醒 Hermes", "正式建立工作流", "同步 skills 到正式員工", "停用或清理正式資料"],
                  },
                  {
                    title: "卡住時",
                    items: ["先跑開機預覽 SOP", "看 health 是否 OK", "確認沒有舊後端殘留", "錯誤分頁先刷新或新開", "把畫面與錯誤貼回驗收紀錄"],
                  },
                ].map((group) => (
                  <div key={group.title} className="rounded-md border border-border/70 bg-card p-3">
                    <div className="text-sm font-medium">{group.title}</div>
                    <ul className="mt-2 space-y-1 text-xs leading-5 text-muted-foreground">
                      {group.items.map((item) => (
                        <li key={item}>- {item}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </section>
            <section className="rounded-md border border-border/70 bg-background p-3">
              <h3 className="font-medium">預覽服務故障判斷</h3>
              <p className="mt-2 text-muted-foreground">
                如果 Office 畫面能開，但員工、專案或會議資料讀不到，通常是後端或 embedded Postgres 還沒恢復。這時先不要測會改資料的功能。
              </p>
              <div className="mt-2 grid gap-2 lg:grid-cols-3">
                {PREVIEW_SERVICE_CHECKS.map((check) => (
                  <div key={check.label} className="rounded-md border border-border/70 bg-card p-3">
                    <div className="text-sm font-medium">{check.label}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{check.value}</div>
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">{check.note}</p>
                  </div>
                ))}
              </div>
            </section>
            <section className="rounded-md border border-border/70 bg-background p-3">
              <h3 className="font-medium">本地模型準備檢查</h3>
              <p className="mt-2 text-muted-foreground">
                Hermes 或其它本地模型要能真正接手任務前，建議先確認這四件事；現在的 Office 先協助看懂流程，不會自動啟動模型。
              </p>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
                <li>本地模型服務已啟動，例如 Ollama、vLLM、LM Studio 或 Hermes 相容服務。</li>
                <li>Paperclip 的員工 adapter 已指向正確模型與網址。</li>
                <li>先用小型測試任務確認 agent 能讀任務、回覆紀錄，且不會產生大量 recovery issues。</li>
                <li>確認穩定後再開啟自動喚醒；預覽期間可以先關閉 heartbeat，避免未設定完成時反覆重試。</li>
              </ol>
            </section>
            <section className="rounded-md border border-border/70 bg-background p-3">
              <h3 className="font-medium">教學文件地圖</h3>
              <ul className="mt-2 space-y-1 text-muted-foreground">
                <li>
                  <code>docs/virtual-office-getting-started.zh-TW.md</code>：中文新手入門。
                </li>
                <li>
                  <code>docs/virtual-office-getting-started.en.md</code>：英文新手入門。
                </li>
                <li>
                  <code>docs/virtual-office-open-source-readme.zh-TW.md</code>：中文開源導覽草稿。
                </li>
                <li>
                  <code>docs/virtual-office-open-source-readme.en.md</code>：英文開源導覽草稿。
                </li>
                <li>
                  <code>docs/virtual-office-acceptance-checklist.zh-TW.md</code>：功能驗收與設計符合度。
                </li>
                <li>
                  <code>docs/virtual-office-startup-sop.zh-TW.md</code>：開機後預覽復原流程。
                </li>
                <li>
                  <code>docs/virtual-office-hermes-sop.zh-TW.md</code>：Hermes 本地模型安裝、環境測試與沙盒喚醒流程。
                </li>
                <li>
                  <code>docs/virtual-office-routine-safety.zh-TW.md</code>：Routine / schedule 排程安全說明。
                </li>
                <li>
                  <code>docs/virtual-office-routine-safety.en.md</code>：Routine / schedule safety notes in English.
                </li>
              </ul>
            </section>
            <section className="rounded-md border border-blue-500/25 bg-blue-500/5 p-3" data-testid="beginner-codex-help-prompt">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="font-medium">貼給 Codex 的求助文字</h3>
                  <p className="mt-2 text-muted-foreground">
                    卡住時可以先複製這段文字貼回對話，讓 Codex 只做健康檢查與安全說明，不刪資料庫、不建立或修改資料、不新增 trigger、不 Run now，也不喚醒 Hermes。
                  </p>
                </div>
                <Button type="button" size="sm" variant="outline" className="h-8 shrink-0" onClick={copyBeginnerCodexHelpPrompt}>
                  <Copy className="mr-1.5 h-4 w-4" />
                  複製求助文字
                </Button>
              </div>
              <pre className="mt-3 max-h-32 overflow-auto whitespace-pre-wrap rounded-md border border-border/70 bg-background p-3 text-xs leading-5 text-muted-foreground">
                {BEGINNER_CODEX_HELP_PROMPT}
              </pre>
            </section>
            <section className="rounded-md border border-emerald-500/25 bg-emerald-500/5 p-3" data-testid="daily-start-check">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="font-medium">每日開工前安全檢查</h3>
                  <p className="mt-2 text-muted-foreground">
                    每次重開機或重新開啟預覽後，先照這四步確認環境健康。只有 Backend OK / Frontend OK 都出現後，再進入建立、同步、停用、Routine 或 Hermes 相關操作。
                  </p>
                </div>
                <Button type="button" size="sm" variant="outline" className="h-8 shrink-0" onClick={copyDailyStartCheckPrompt}>
                  <Copy className="mr-1.5 h-4 w-4" />
                  複製開工檢查
                </Button>
              </div>
              <ol className="mt-3 list-decimal space-y-1 pl-5 text-muted-foreground">
                {DAILY_START_CHECK_STEPS.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </section>
            <section className="rounded-md border border-border/70 bg-background p-3">
              <h3 className="font-medium">端到端驗收沙盒</h3>
              <p className="mt-2 text-muted-foreground">
                真正按下建立、同步、保存或停用前，建議先把驗收限制在測試資料裡，確定流程符合預期再拿來處理正式專案。
              </p>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
                <li>建立一位測試員工，例如 `Test PM` 或 `Sandbox Engineer`。</li>
                <li>建立一個測試專案，例如 `Virtual Office Sandbox`，不要選正式專案。</li>
                <li>先複製 Markdown 檢查清單，記下要驗收的項目、預期結果與實際結果。</li>
                <li>一次只驗收一種會改資料的動作，例如先同步技能，再測建立工作流。</li>
                <li>驗收後回到檢查清單，把結果補進開發紀錄，避免同一件事重複猜測。</li>
              </ol>
            </section>
            <section className="rounded-md border border-border/70 bg-background p-3">
              <h3 className="font-medium">安全提醒</h3>
              <p className="mt-2 text-muted-foreground">
                如果只是試看介面，可以先開表單與預覽；真正修改本地 Paperclip 資料的是最後的建立、同步、保存或停用。
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3">
                  <div className="text-xs font-medium text-emerald-700">可安全預覽</div>
                  <ul className="mt-2 space-y-1 text-xs leading-5 text-muted-foreground">
                    <li>打開建立員工、技能、工作流或會議表單。</li>
                    <li>查看 starter skill 預覽、角色模板、工作流預覽與檢查清單。</li>
                    <li>複製 Markdown 檢查清單到本機剪貼簿。</li>
                  </ul>
                </div>
                <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
                  <div className="text-xs font-medium text-amber-700">會修改本地資料</div>
                  <ul className="mt-2 space-y-1 text-xs leading-5 text-muted-foreground">
                    <li>按下建立工作流、建立會議任務或建立 starter skill。</li>
                    <li>按下同步技能或保存員工變更。</li>
                    <li>停用員工會把員工移出目前辦公室，但歷史紀錄仍保留。</li>
                  </ul>
                </div>
              </div>
            </section>
          </div>
          <DialogFooter>
            <Button type="button" onClick={() => setGuideOpen(false)}>
              我知道了
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={acceptanceOpen} onOpenChange={setAcceptanceOpen}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Virtual Office 檢查清單</DialogTitle>
            <DialogDescription>
              這裡整理目前功能驗收狀態，完整紀錄同步保存在專案文件中。
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end">
            <Button type="button" size="sm" variant="outline" onClick={copyAcceptanceMarkdown}>
              <Copy className="mr-1.5 h-4 w-4" />
              複製 Markdown
            </Button>
          </div>
          <div className="max-h-[640px] space-y-3 overflow-auto pr-1">
            <section className="rounded-md border border-border/70 bg-background p-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="text-sm font-medium">目前可驗收程度</div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {verifiedAcceptanceCount} / {acceptanceItems.length} 項已驗證，其餘保留在開發或人工驗收清單。
                  </p>
                </div>
                <div className="text-2xl font-semibold">{verifiedAcceptancePercent}%</div>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${verifiedAcceptancePercent}%` }} />
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-4">
                {[
                  ["已驗證", verifiedAcceptanceCount],
                  ["部分完成", partialAcceptanceCount],
                  ["待開發", pendingAcceptanceCount],
                  ["需人工驗收", manualAcceptanceCount],
                ].map(([label, count]) => (
                  <div key={label} className="rounded-md border border-border/70 bg-card p-2">
                    <div className="text-lg font-semibold">{count}</div>
                    <div className="text-[11px] text-muted-foreground">{label}</div>
                  </div>
                ))}
              </div>
              <div className="mt-3 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3" data-testid="acceptance-near-complete-summary">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h3 className="text-sm font-medium">接近完成總結</h3>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      skills runtime 載入、Hermes 沙盒喚醒、中文文件試讀、60 分鐘長時間穩定性與 3/3 重開機驗收已取得證據；目前主要剩英文文件試讀與正式 Hermes 授權線。
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8 shrink-0"
                    onClick={copyNearCompleteSummaryMarkdown}
                    data-testid="acceptance-action-copy-near-complete-summary"
                  >
                    <Copy className="mr-1.5 h-4 w-4" />
                    複製完成總結
                  </Button>
                </div>
                <div className="mt-3 grid gap-2 md:grid-cols-3">
                  {[
                    ["可交接", "預覽健康、驗收同步、文件連結、英文可讀性與安全模板都已有固定檢查。"],
                    ["仍需真人", "文件能否讓非工程新手看懂，仍需試讀者用自評表回報。"],
                    ["仍需授權", "下一次 Hermes 喚醒仍需新的 Sandbox/Test issue 與逐字一次性授權，不能延伸成正式任務。"],
                  ].map(([title, detail]) => (
                    <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                      <div className="text-xs font-medium">{title}</div>
                      <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                    </div>
                  ))}
                </div>
              </div>
            </section>
            <section className="rounded-md border border-border/70 bg-background p-3" data-testid="acceptance-ideal-delivery-decision">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="text-sm font-medium">理想版交付判斷卡</h3>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    開源或交付前，用這張卡把目前狀態分成可交付、仍需證據與不可越線，避免把 98% 誤當成已可喚醒正式任務。
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8 shrink-0"
                  onClick={copyIdealDeliveryDecisionMarkdown}
                  data-testid="acceptance-action-copy-ideal-delivery-decision"
                >
                  <Copy className="mr-1.5 h-4 w-4" />
                  複製交付判斷
                </Button>
              </div>
              <div className="mt-3 grid gap-2 lg:grid-cols-3">
                {ACCEPTANCE_DELIVERY_DECISIONS.map((decision) => (
                  <div key={decision.title} className="rounded-md border border-border/70 bg-card p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-xs font-medium">{decision.title}</div>
                      <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                        {decision.status}
                      </span>
                    </div>
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">{decision.detail}</p>
                  </div>
                ))}
              </div>
            </section>
            <section className="rounded-md border border-border/70 bg-background p-3" data-testid="acceptance-open-source-release-safety">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="text-sm font-medium">開源發布前安全包</h3>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    發布或交付試用前，先確認本機設定與 log 不提交、文件入口齊全、驗證指令一致，並保留 Hermes 停手線。
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8 shrink-0"
                  onClick={copyOpenSourceReleaseSafetyMarkdown}
                  data-testid="acceptance-action-copy-open-source-release-safety"
                >
                  <Copy className="mr-1.5 h-4 w-4" />
                  複製開源安全包
                </Button>
              </div>
              <div className="mt-3 grid gap-2 lg:grid-cols-4">
                {OPEN_SOURCE_RELEASE_SAFETY_ITEMS.map((item) => (
                  <div key={item.title} className="rounded-md border border-border/70 bg-card p-3">
                    <div className="text-xs font-medium">{item.title}</div>
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">{item.detail}</p>
                  </div>
                ))}
              </div>
            </section>
            <section className="rounded-md border border-border/70 bg-background p-3" data-testid="acceptance-remaining-gaps-handoff">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="text-sm font-medium">98% 剩餘缺口交接</h3>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    這裡列出目前仍不是已驗證的項目，讓下一輪知道卡在哪裡、要找誰確認、哪些線不能越過。
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8 shrink-0"
                  onClick={copyRemainingAcceptanceGapsMarkdown}
                  data-testid="acceptance-action-copy-remaining-gaps-handoff"
                >
                  <Copy className="mr-1.5 h-4 w-4" />
                  複製缺口交接
                </Button>
              </div>
              <div className="mt-3 grid gap-2 lg:grid-cols-3">
                {remainingAcceptanceItems.map((item) => (
                  <div key={`${item.sectionTitle}-${item.label}`} className="rounded-md border border-border/70 bg-card p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-xs font-medium">{item.label}</div>
                      <span className={cn("rounded-full border px-2 py-0.5 text-[11px]", acceptanceStatusClassName(item.status))}>
                        {item.status}
                      </span>
                    </div>
                    <div className="mt-2 text-[11px] text-muted-foreground">{item.sectionTitle}</div>
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">{acceptanceNextCheck(item.label)}</p>
                  </div>
                ))}
              </div>
            </section>
            <section className="rounded-md border border-border/70 bg-background p-3" data-testid="acceptance-remaining-roadmap">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="text-sm font-medium">完成前剩餘路線</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    runtime skill、Hermes 沙盒、中文文件試讀、長時間穩定性與重開機驗收已完成真測；剩下的 gate 主要是英文讀者與正式 Hermes 授權線收尾。
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="w-fit rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                    {ACCEPTANCE_REMAINING_ROADMAP.length} 個 gate
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8"
                    onClick={copyRemainingRoadmapMarkdown}
                    data-testid="acceptance-action-copy-remaining-roadmap"
                  >
                    <Copy className="mr-1.5 h-4 w-4" />
                    複製剩餘路線
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8"
                    onClick={copyFinalGateHandoffMarkdown}
                    data-testid="acceptance-action-copy-final-gate-handoff"
                  >
                    <Copy className="mr-1.5 h-4 w-4" />
                    複製 Gate 交接
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8"
                    onClick={copyGateDecisionBoardMarkdown}
                    data-testid="acceptance-action-copy-gate-decision-board"
                  >
                    <Copy className="mr-1.5 h-4 w-4" />
                    複製 Gate 決策
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8"
                    onClick={copyRuntimeSkillLoadingCheckTemplate}
                    data-testid="acceptance-action-copy-runtime-skill-loading"
                  >
                    <Copy className="mr-1.5 h-4 w-4" />
                    複製技能載入驗收
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8"
                    onClick={copySkillSyncE2eTaskCardMarkdown}
                    data-testid="acceptance-action-copy-skill-sync-e2e-task-card"
                  >
                    <Copy className="mr-1.5 h-4 w-4" />
                    複製技能同步 E2E
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8"
                    onClick={copySkillWizardCompletionDecisionMarkdown}
                    data-testid="acceptance-action-copy-skill-wizard-completion-decision"
                  >
                    <Copy className="mr-1.5 h-4 w-4" />
                    複製技能完成判斷
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8"
                    onClick={copySkillSyncReadOnlyRecheckMarkdown}
                    data-testid="acceptance-action-copy-skill-sync-read-only-recheck"
                  >
                    <Copy className="mr-1.5 h-4 w-4" />
                    複製技能同步復查
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8"
                    onClick={copyDocumentReviewFeedbackTemplate}
                    data-testid="acceptance-action-copy-document-review-feedback"
                  >
                    <Copy className="mr-1.5 h-4 w-4" />
                    複製文件回饋
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8"
                    onClick={copyDocumentReviewReadinessMarkdown}
                    data-testid="acceptance-action-copy-document-review-readiness"
                  >
                    <Copy className="mr-1.5 h-4 w-4" />
                    複製閱讀準備
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8"
                    onClick={copyBeginnerDocumentSelfCheckMarkdown}
                    data-testid="acceptance-action-copy-beginner-document-self-check"
                  >
                    <Copy className="mr-1.5 h-4 w-4" />
                    複製新手自評
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8"
                    onClick={copyChineseDocumentCompletionDecisionMarkdown}
                    data-testid="acceptance-action-copy-chinese-document-completion-decision"
                  >
                    <Copy className="mr-1.5 h-4 w-4" />
                    複製中文完成判斷
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8"
                    onClick={copyHumanDocumentReviewTaskCardMarkdown}
                    data-testid="acceptance-action-copy-human-document-review-task-card"
                  >
                    <Copy className="mr-1.5 h-4 w-4" />
                    複製真人試讀任務
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8"
                    onClick={copyOpenSourceReviewInviteMarkdown}
                    data-testid="acceptance-action-copy-open-source-review-invite"
                  >
                    <Copy className="mr-1.5 h-4 w-4" />
                    複製開源試讀邀請
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8"
                    onClick={copyOpenSourceTrialReportMarkdown}
                    data-testid="acceptance-action-copy-open-source-trial-report"
                  >
                    <Copy className="mr-1.5 h-4 w-4" />
                    複製試用回報
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8"
                    onClick={copyOpenSourceIssueReportMarkdown}
                    data-testid="acceptance-action-copy-open-source-issue-report"
                  >
                    <Copy className="mr-1.5 h-4 w-4" />
                    複製 issue 回報
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8"
                    onClick={copyDocumentReviewSynthesisMarkdown}
                    data-testid="acceptance-action-copy-document-review-synthesis"
                  >
                    <Copy className="mr-1.5 h-4 w-4" />
                    複製回饋彙整
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8"
                    onClick={copyDocumentReviewBackfillMarkdown}
                    data-testid="acceptance-action-copy-document-review-backfill"
                  >
                    <Copy className="mr-1.5 h-4 w-4" />
                    複製回填卡
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8"
                    onClick={copyDocumentReviewEvidenceLogMarkdown}
                    data-testid="acceptance-action-copy-document-review-evidence-log"
                  >
                    <Copy className="mr-1.5 h-4 w-4" />
                    複製證據紀錄
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8"
                    onClick={copyOpenSourceFinalManualEvidenceMarkdown}
                    data-testid="acceptance-action-copy-open-source-final-manual-evidence"
                  >
                    <Copy className="mr-1.5 h-4 w-4" />
                    複製人工驗收總表
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8"
                    onClick={copyEnglishDocumentReviewPacketMarkdown}
                    data-testid="acceptance-action-copy-english-document-review-packet"
                  >
                    <Copy className="mr-1.5 h-4 w-4" />
                    複製英文試讀包
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8"
                    onClick={copyEnglishDocumentCompletionDecisionMarkdown}
                    data-testid="acceptance-action-copy-english-document-completion-decision"
                  >
                    <Copy className="mr-1.5 h-4 w-4" />
                    複製英文完成判斷
                  </Button>
                </div>
              </div>
              <div className="mt-3 grid gap-2 md:grid-cols-3">
                {ACCEPTANCE_REMAINING_ROADMAP.map((item) => (
                  <div key={item.title} className="rounded-md border border-border/70 bg-card p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{item.title}</span>
                      <span className={cn("rounded-full border px-2 py-0.5 text-[11px]", acceptanceStatusClassName(item.status as AcceptanceStatus))}>
                        {item.status}
                      </span>
                    </div>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{item.next}</p>
                    <ul className="mt-2 space-y-1 text-xs leading-5 text-muted-foreground">
                      {item.checks.map((check) => (
                        <li key={check} className="flex gap-2">
                          <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/70" />
                          <span>{check}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
              <div className="mt-3 rounded-md border border-border/70 bg-card p-3" data-testid="acceptance-gate-decision-board">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h4 className="text-xs font-medium">剩餘 Gate 決策板</h4>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      把最後 gate 轉成每日判斷：哪些今天可以安全做，哪些要等真人或重開機證據，哪些一定要等你明確授權。
                    </p>
                  </div>
                  <span className="w-fit rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                    Hermes 前停手線
                  </span>
                </div>
                <div className="mt-3 grid gap-2 md:grid-cols-3">
                  {ACCEPTANCE_GATE_DECISIONS.map((decision) => (
                    <div key={decision.title} className="rounded-md border border-border/70 bg-background p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                          {decision.tone}
                        </span>
                        <span className="text-xs font-medium">{decision.title}</span>
                      </div>
                      <p className="mt-2 text-xs leading-5 text-muted-foreground">{decision.summary}</p>
                      <ul className="mt-2 space-y-1 text-xs leading-5 text-muted-foreground">
                        {decision.actions.map((action) => (
                          <li key={action} className="flex gap-2">
                            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/70" />
                            <span>{action.replaceAll("`", "")}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
              <div className="mt-3 rounded-md border border-border/70 bg-card p-3" data-testid="acceptance-skill-sync-e2e-task-card">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs font-medium">技能同步 E2E 任務卡</div>
                  <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                    Sandbox only
                  </span>
                </div>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  用 Sandbox/Test 員工驗收技能精靈的 UI 與資料同步：選員工、勾 skills、同步、重新整理後確認 desired skills 保留；不驗證模型 runtime loading。
                </p>
              </div>
              <div className="mt-3 rounded-md border border-border/70 bg-card p-3" data-testid="acceptance-skill-wizard-completion-decision">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs font-medium">技能精靈完成判斷卡</div>
                  <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-700">
                    AI-98530 proof
                  </span>
                </div>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  技能精靈的 UI/資料同步已通過；AI-98530 已證明 Hermes Sandbox/Test 回覆能看見 7 個 Paperclip runtime capability keys。正式員工仍需另行驗收。
                </p>
              </div>
              <div className="mt-3 rounded-md border border-border/70 bg-card p-3" data-testid="acceptance-skill-sync-read-only-recheck">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs font-medium">技能同步只讀復查</div>
                  <span
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[11px]",
                      sandboxSkillSyncReadOnlyMatchedCount === STARTER_SKILL_TEMPLATES.length
                        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700"
                        : "border-amber-500/40 bg-amber-500/10 text-amber-700",
                    )}
                  >
                    {sandboxSkillSyncReadOnlyMatchedCount} / {STARTER_SKILL_TEMPLATES.length}
                  </span>
                </div>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  只讀讀取 Sandbox Skills Sync Test 的 desired skills，確認 starter skills 是否仍保存；這不會同步資料，也不會喚醒模型。
                </p>
                <div className="mt-3 grid gap-2 md:grid-cols-3">
                  {sandboxSkillSyncReadOnlyCards.map((card) => (
                    <div key={card.name} className="rounded-md border border-border/70 bg-muted/30 p-2 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium">{card.name}</span>
                        <span className={card.synced ? "text-emerald-700" : "text-amber-700"}>{card.status}</span>
                      </div>
                      <div className="mt-1 truncate text-[11px] text-muted-foreground">{card.key}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="mt-3 rounded-md border border-border/70 bg-muted/20 p-3" data-testid="acceptance-document-review-readiness">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h4 className="text-xs font-medium">文件人工閱讀準備</h4>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      讓第一次試用者照閱讀範圍與檢查問題回報，不需要懂程式也能指出卡住位置。
                    </p>
                  </div>
                  <span className="w-fit rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
                    {DOCUMENT_REVIEW_READINESS_ITEMS.length} 組閱讀任務
                  </span>
                </div>
                <div className="mt-3 grid gap-2 lg:grid-cols-3">
                  {DOCUMENT_REVIEW_READINESS_ITEMS.map((item) => (
                    <div key={item.title} className="rounded-md border border-border/70 bg-card p-3 text-xs">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{item.title}</span>
                        <span
                          className={cn(
                            "rounded-full border px-2 py-0.5 text-[11px]",
                            item.status === "已準備"
                              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700"
                              : "border-amber-500/40 bg-amber-500/10 text-amber-700",
                          )}
                        >
                          {item.status}
                        </span>
                      </div>
                      <div className="mt-2 font-medium text-muted-foreground">閱讀文件</div>
                      <ul className="mt-1 space-y-1 text-muted-foreground">
                        {item.docs.map((doc) => (
                          <li key={doc} className="truncate">{doc}</li>
                        ))}
                      </ul>
                      <div className="mt-2 font-medium text-muted-foreground">檢查問題</div>
                      <ul className="mt-1 space-y-1 leading-5 text-muted-foreground">
                        {item.checks.map((check) => (
                          <li key={check} className="flex gap-2">
                            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/70" />
                            <span>{check}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
              <div className="mt-3 rounded-md border border-border/70 bg-muted/20 p-3" data-testid="acceptance-beginner-document-self-check">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h4 className="text-xs font-medium">新手文件自評表</h4>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      給不會程式的試讀者使用；只回報能不能照做、哪裡卡住、安全停手線是否清楚，不需要貼密鑰或執行任何模型。
                    </p>
                  </div>
                  <span className="w-fit rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
                    人工回饋
                  </span>
                </div>
              <div className="mt-3 grid gap-2 md:grid-cols-3">
                {[
                  ["能不能照做", "確認是否知道先做健康檢查、Backend OK / Frontend OK 後才繼續。"],
                  ["卡住位置", "回報看不懂的原句、希望怎麼改、是否需要圖片或範例。"],
                  ["安全感", "確認知道不要刪資料庫、不要貼 API key、不要喚醒 Hermes。"],
                  ].map(([title, detail]) => (
                    <div key={title} className="rounded-md border border-border/70 bg-card p-3">
                      <div className="text-xs font-medium">{title}</div>
                      <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
                    </div>
                  ))}
                </div>
                <div className="mt-3 rounded-md border border-border/70 bg-card p-3" data-testid="acceptance-chinese-document-completion-decision">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs font-medium">中文文件完成判斷卡</div>
                    <span className="rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[11px] text-sky-700">
                      Beginner check
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    確認新手是否知道第一步、安全停手線、只讀與資料變更差異；若尚未試讀，仍維持部分完成。
                  </p>
                </div>
                <div className="mt-3 rounded-md border border-border/70 bg-card p-3" data-testid="acceptance-human-document-review-task-card">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs font-medium">真人試讀任務卡</div>
                    <span className="rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[11px] text-sky-700">
                      30-45 分鐘
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    可直接交給朋友或開源試用者：只讀文件、找卡點、回報看不懂的句子；不建立任務、不貼密鑰、不喚醒 Hermes。
                  </p>
                </div>
                <div className="mt-3 rounded-md border border-border/70 bg-card p-3" data-testid="acceptance-open-source-review-invite">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs font-medium">開源試讀邀請包</div>
                    <span className="rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[11px] text-sky-700">
                      Reader invite
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    可直接貼給朋友或 GitHub 讀者，請他們只讀文件與畫面文字，回報是否看懂第一步、安全界線與卡住位置。
                  </p>
                </div>
                <div className="mt-3 rounded-md border border-border/70 bg-card p-3" data-testid="acceptance-open-source-trial-report">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs font-medium">開源試用回報包</div>
                    <span className="rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[11px] text-sky-700">
                      Trial feedback
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    給真的打開預覽的試用者使用：回報作業系統、預覽狀態、卡住位置與錯誤摘要；不要貼密鑰、完整 log 或私密路徑。
                  </p>
                </div>
                <div className="mt-3 rounded-md border border-border/70 bg-card p-3" data-testid="acceptance-open-source-issue-report">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs font-medium">開源 issue 回報模板</div>
                    <span className="rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[11px] text-sky-700">
                      GitHub ready
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    給未來 GitHub issue 使用：分流預覽啟動、畫面文字、文件、Hermes 前置與安全疑慮；只貼短錯誤摘要，不貼密鑰、完整 log 或私密路徑。
                  </p>
                </div>
                <div className="mt-3 rounded-md border border-border/70 bg-card p-3" data-testid="acceptance-document-review-synthesis">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs font-medium">試讀回饋彙整表</div>
                    <span className="rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[11px] text-sky-700">
                      Feedback triage
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    收到試讀回覆後，用同一張表整理必修、建議修、可延後與安全風險，方便轉成文件或 UI 待辦。
                  </p>
                </div>
                <div className="mt-3 rounded-md border border-border/70 bg-card p-3" data-testid="acceptance-document-review-backfill">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs font-medium">試讀回饋回填卡</div>
                    <span className="rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[11px] text-sky-700">
                      Backfill
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    把讀者回饋回填成文件修改、UI 文字、安全提醒與驗收狀態建議；它不會把試讀邀請誤當成文件已通過。
                  </p>
                </div>
                <div className="mt-3 rounded-md border border-border/70 bg-card p-3" data-testid="acceptance-open-source-final-manual-evidence">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs font-medium">開源前人工驗收總表</div>
                    <span className="rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[11px] text-sky-700">
                      Final manual gates
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    用一張表收攏中文試讀、英文試讀、多次重開機與長時間穩定性；長測已完成 60 分鐘，重開機已完成 3/3，剩餘人工 gate 不新增無限流程卡。
                  </p>
                </div>
                <div className="mt-3 rounded-md border border-border/70 bg-card p-3" data-testid="acceptance-document-review-evidence-log">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs font-medium">試讀證據紀錄表</div>
                    <span className="rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[11px] text-sky-700">
                      Evidence log
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    逐位記錄試讀者背景、閱讀範圍、是否知道第一步與安全停手線；只有有證據時，才把文件 gate 往完成推進。
                  </p>
                </div>
                <div className="mt-3 rounded-md border border-border/70 bg-card p-3" data-testid="acceptance-english-document-review-packet">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs font-medium">英文文件試讀包</div>
                    <span className="rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[11px] text-sky-700">
                      English review
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    給英文讀者檢查 getting started、open-source README 與 routine safety，確認英文語氣、中文 UI 對照與安全提醒是否清楚。
                  </p>
                </div>
                <div className="mt-3 rounded-md border border-border/70 bg-card p-3" data-testid="acceptance-english-document-completion-decision">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs font-medium">英文文件完成判斷卡</div>
                    <span className="rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[11px] text-sky-700">
                      Human check
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    區分英文文件已通過的自動檢查與仍需英文讀者人工確認的項目；沒有真人回饋前，不把英文文件 gate 視為完成。
                  </p>
                </div>
              </div>
            </section>
            <section className="rounded-md border border-border/70 bg-background p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="text-sm font-medium">今日驗收紀錄摘要</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    這裡只記錄本日已確認的安全檢查，方便之後回來覆盤。
                  </p>
                </div>
                <span className="w-fit rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  {ACCEPTANCE_SESSION_LOG.length} 筆
                </span>
              </div>
              <div className="mt-3 grid gap-2 md:grid-cols-2">
                {ACCEPTANCE_SESSION_LOG.map((entry) => (
                  <div key={entry.title} className="rounded-md border border-border/70 bg-card p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{entry.title}</span>
                      <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-700">
                        {entry.result}
                      </span>
                    </div>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{entry.detail}</p>
                  </div>
                ))}
              </div>
            </section>
            <section className="rounded-md border border-border/70 bg-background p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="text-sm font-medium">驗收紀錄模板</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    做端到端測試時，用同一個格式記錄預期與實際結果，之後比較不會漏掉關鍵細節。
                  </p>
                </div>
                <span className="w-fit rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  會一起複製
                </span>
              </div>
              <div className="mt-3 rounded-md border border-border/70 bg-muted/30 p-3 font-mono text-xs leading-5 text-muted-foreground">
                {ACCEPTANCE_RECORD_TEMPLATE.slice(2).map((line) => (
                  <div key={line}>{line}</div>
                ))}
              </div>
            </section>
            <section className="rounded-md border border-border/70 bg-background p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="text-sm font-medium">端到端驗收批次計畫</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    先照批次逐項測，避免同時建立太多資料後，不知道是哪個流程出問題。
                  </p>
                </div>
                <span className="w-fit rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  {ACCEPTANCE_TEST_BATCHES.length} 批
                </span>
              </div>
              <div className="mt-3 grid gap-2">
                {ACCEPTANCE_TEST_BATCHES.map((batch) => (
                  <div key={batch.title} className="rounded-md border border-border/70 bg-card p-3 text-sm">
                    <div className="font-medium">{batch.title}</div>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">重點：{batch.focus}</p>
                    <p className="mt-1 text-xs leading-5 text-amber-700">注意：{batch.caution}</p>
                    <p className="mt-1 text-xs leading-5 text-emerald-700">通過標準：{batch.pass}</p>
                    <p className="mt-1 text-xs leading-5 text-destructive">未通過時：{batch.fail}</p>
                  </div>
                ))}
              </div>
            </section>
            <section className="rounded-md border border-border/70 bg-background p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="text-sm font-medium">測試資料清理前檢查</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    清理前先確認這些資料確實是測試用，並已經把驗收結果記錄好。
                  </p>
                </div>
                <span className="w-fit rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  不自動清理
                </span>
              </div>
              <ul className="mt-3 space-y-1 text-xs leading-5 text-muted-foreground">
                {ACCEPTANCE_CLEANUP_CHECKS.map((item) => (
                  <li key={item}>- {item}</li>
                ))}
              </ul>
            </section>
            <section className="rounded-md border border-border/70 bg-background p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="text-sm font-medium">正式驗收前快照</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    按任何會改資料的按鈕前，先記錄目前狀態，之後才知道變更是否符合預期。
                  </p>
                </div>
                <span className="w-fit rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  先記錄再操作
                </span>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-border/70 bg-muted/30 p-3">
                <Button type="button" size="sm" variant="outline" className="h-8" onClick={copySnapshotMarkdown}>
                  <Copy className="mr-1.5 h-4 w-4" />
                  複製快照模板
                </Button>
                <span className="text-xs text-muted-foreground">
                  只複製正式驗收前需要填的欄位，不會修改 Paperclip 資料。
                </span>
              </div>
              <ul className="mt-3 space-y-1 text-xs leading-5 text-muted-foreground">
                {ACCEPTANCE_SNAPSHOT_CHECKS.map((item) => (
                  <li key={item}>- {item}</li>
                ))}
              </ul>
            </section>
            <section className="rounded-md border border-border/70 bg-background p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="text-sm font-medium">資料變更按鈕索引</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    這些按鈕會寫入本地 Paperclip 資料；先看安全預覽，再決定是否進入端到端驗收。
                  </p>
                </div>
                <span className="w-fit rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  {ACCEPTANCE_DATA_CHANGE_ACTIONS.length} 個動作
                </span>
              </div>
              <div className="mt-3 grid gap-2">
                {ACCEPTANCE_DATA_CHANGE_ACTIONS.map((action) => (
                  <div key={action.button} className="rounded-md border border-border/70 bg-card p-3 text-sm">
                    <div className="font-medium">{action.button}</div>
                    <p className="mt-1 text-xs leading-5 text-destructive">會修改：{action.changes}</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">先看：{action.preview}</p>
                  </div>
                ))}
              </div>
            </section>
            <section className="rounded-md border border-border/70 bg-background p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="text-sm font-medium">資料變更風險分流</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    先用風險分流判斷下一步，避免把可預覽、可測試與需人工確認的動作混在一起。
                  </p>
                </div>
                <span className="w-fit rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  {ACCEPTANCE_DATA_CHANGE_RISK_LANES.length} 條路線
                </span>
              </div>
              <div className="mt-3 grid gap-2 lg:grid-cols-3">
                {ACCEPTANCE_DATA_CHANGE_RISK_LANES.map((lane) => (
                  <div key={lane.label} className="rounded-md border border-border/70 bg-card p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{lane.label}</span>
                      <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                        {lane.badge}
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {lane.actions.map((action) => (
                        <span key={action} className="rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
                          {action}
                        </span>
                      ))}
                    </div>
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">{lane.rule}</p>
                  </div>
                ))}
              </div>
            </section>
            <section className="rounded-md border border-border/70 bg-background p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="text-sm font-medium">資料變更操作確認表</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    真正按下會改資料的按鈕前，先照這張表確認操作前、操作中與操作後的檢查點。
                  </p>
                </div>
                <span className="w-fit rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  {ACCEPTANCE_DATA_CHANGE_CONFIRMATION_CARDS.length} 個動作
                </span>
              </div>
              <div className="mt-3 grid gap-2 lg:grid-cols-2">
                {ACCEPTANCE_DATA_CHANGE_CONFIRMATION_CARDS.map((card) => (
                  <div key={card.action} className="rounded-md border border-border/70 bg-card p-3 text-sm">
                    <div className="font-medium">{card.action}</div>
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">操作前：{card.before}</p>
                    <p className="mt-1 text-xs leading-5 text-amber-700">操作中：{card.during}</p>
                    <p className="mt-1 text-xs leading-5 text-emerald-700">操作後：{card.after}</p>
                  </div>
                ))}
              </div>
            </section>
            <section className="rounded-md border border-border/70 bg-background p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="text-sm font-medium">驗收批次執行紀錄</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    每批驗收完成後，照這裡留下結果、證據與該暫停的條件，方便之後覆盤。
                  </p>
                </div>
                <span className="w-fit rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  {ACCEPTANCE_EXECUTION_RECORDS.length} 批紀錄
                </span>
              </div>
              <div className="mt-3 grid gap-2">
                {ACCEPTANCE_EXECUTION_RECORDS.map((record) => (
                  <div key={record.batch} className="rounded-md border border-border/70 bg-card p-3 text-sm">
                    <div className="font-medium">{record.batch}</div>
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">結果欄：{record.result}</p>
                    <p className="mt-1 text-xs leading-5 text-emerald-700">證據欄：{record.evidence}</p>
                    <p className="mt-1 text-xs leading-5 text-destructive">暫停條件：{record.pause}</p>
                  </div>
                ))}
              </div>
            </section>
            <section className="rounded-md border border-border/70 bg-background p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="text-sm font-medium">端到端驗收準備度</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    這五個門檻都確認後，再開始按會改資料的按鈕做端到端驗收。
                  </p>
                </div>
                <span className="w-fit rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-700">
                  {ACCEPTANCE_READINESS_GATES.length} / {ACCEPTANCE_READINESS_GATES.length} 已準備
                </span>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {ACCEPTANCE_READINESS_GATES.map((gate) => (
                  <div key={gate.label} className="rounded-md border border-border/70 bg-card p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{gate.label}</span>
                      <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-700">
                        {gate.status}
                      </span>
                    </div>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{gate.note}</p>
                  </div>
                ))}
              </div>
            </section>
            <section className="rounded-md border border-border/70 bg-background p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="text-sm font-medium">端到端驗收決策規則</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    每個批次測完後，用這裡判斷要繼續、暫停、回復或請你介入。
                  </p>
                </div>
                <span className="w-fit rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  {ACCEPTANCE_DECISION_RULES.length} 條規則
                </span>
              </div>
              <div className="mt-3 grid gap-2">
                {ACCEPTANCE_DECISION_RULES.map((rule) => (
                  <div key={rule.label} className="rounded-md border border-border/70 bg-card p-3 text-sm">
                    <div className="font-medium">{rule.label}</div>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">何時使用：{rule.when}</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">下一步：{rule.next}</p>
                  </div>
                ))}
              </div>
            </section>
            <section className="rounded-md border border-border/70 bg-background p-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-medium">下一步優先檢查</h3>
                  <p className="mt-1 text-xs text-muted-foreground">先處理這些項目，最能推進整體完成度。</p>
                </div>
                <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  {nextAcceptanceItems.length} 項
                </span>
              </div>
              <div className="mt-3 space-y-2">
                {nextAcceptanceItems.map((item, index) => (
                  <div key={`${item.sectionTitle}-${item.label}`} className="grid gap-3 rounded-md border border-border/70 bg-card p-3 text-sm sm:grid-cols-[auto_minmax(0,1fr)_auto]">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground">
                      {index + 1}
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{item.label}</span>
                        <span className="text-[11px] text-muted-foreground">{item.sectionTitle}</span>
                      </div>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">{item.note}</p>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        建議驗收：{acceptanceNextCheck(item.label)}
                      </p>
                    </div>
                    <span className={cn("h-fit rounded-full border px-2 py-0.5 text-[11px]", acceptanceStatusClassName(item.status))}>
                      {item.status}
                    </span>
                  </div>
                ))}
              </div>
            </section>
            {ACCEPTANCE_SECTIONS.map((section) => (
              <section key={section.title} className="rounded-md border border-border/70 bg-background p-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <h3 className="text-sm font-medium">{section.title}</h3>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted sm:w-28">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{
                        width: `${Math.round(
                          (section.items.filter((item) => item.status === "已驗證").length / section.items.length) * 100,
                        )}%`,
                      }}
                    />
                  </div>
                </div>
                <div className="mt-3 space-y-2">
                  {section.items.map((item) => (
                    <div
                      key={`${section.title}-${item.label}`}
                      className="grid gap-3 rounded-md border border-border/70 bg-card p-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto]"
                    >
                      <div className="min-w-0">
                        <div className="font-medium">{item.label}</div>
                        <div className="mt-1 text-xs leading-5 text-muted-foreground">{item.note}</div>
                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                          <div className="h-full rounded-full bg-primary/80" style={{ width: acceptanceProgressWidth(item.status) }} />
                        </div>
                      </div>
                      <span className={cn("h-fit rounded-full border px-2 py-0.5 text-[11px]", acceptanceStatusClassName(item.status))}>
                        {item.status}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
          <DialogFooter>
            <Button type="button" onClick={() => setAcceptanceOpen(false)}>
              關閉
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(previewSkillTemplate)} onOpenChange={(open) => !open && setPreviewSkillTemplate(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{previewSkillTemplate?.name ?? "預覽 starter skill"}</DialogTitle>
            <DialogDescription>
              建立前先確認這個 skill 會放進員工指令中的內容。
            </DialogDescription>
          </DialogHeader>
          {previewSkillTemplate && (
            <div className="space-y-4">
              <div className="rounded-md border border-border/70 bg-background p-3">
                <div className="text-sm font-medium">用途</div>
                <p className="mt-1 text-sm text-muted-foreground">{previewSkillTemplate.description}</p>
              </div>
              <pre className="max-h-[360px] overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs whitespace-pre-wrap">
                {previewSkillTemplate.markdown}
              </pre>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setPreviewSkillTemplate(null)}>
                  返回
                </Button>
                <Button
                  type="button"
                  disabled={createStarterSkill.isPending}
                  onClick={() => {
                    handleStarterSkillTemplate(previewSkillTemplate);
                    setPreviewSkillTemplate(null);
                  }}
                >
                  {visibleCompanySkillsByName.has(previewSkillTemplate.name) ? "勾選這個 skill" : "建立並勾選"}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(previewRoleTemplate)} onOpenChange={(open) => !open && setPreviewRoleTemplate(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{previewRoleTemplate?.name ?? "角色模板"}</DialogTitle>
            <DialogDescription>
              目前先作為建立員工與挑選 skills 的參考，未來可接 agency-agents 匯入流程。
            </DialogDescription>
          </DialogHeader>
          {previewRoleTemplate && (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-md border border-border/70 bg-background p-3">
                  <div className="text-xs text-muted-foreground">建議姓名</div>
                  <div className="mt-1 text-sm font-medium">{previewRoleTemplate.suggestedName}</div>
                </div>
                <div className="rounded-md border border-border/70 bg-background p-3">
                  <div className="text-xs text-muted-foreground">建議職稱</div>
                  <div className="mt-1 text-sm font-medium">{previewRoleTemplate.suggestedTitle}</div>
                </div>
                <div className="rounded-md border border-border/70 bg-background p-3">
                  <div className="text-xs text-muted-foreground">來源分組</div>
                  <div className="mt-1 text-sm font-medium">{previewRoleTemplate.division}</div>
                </div>
              </div>
              <div className="rounded-md border border-border/70 bg-background p-3">
                <div className="text-sm font-medium">能力描述</div>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">{previewRoleTemplate.capabilities}</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-md border border-border/70 bg-muted/30 p-3">
                  <div className="text-sm font-medium">建議 starter skills</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {previewRoleTemplate.starterSkills.map((skill) => (
                      <span key={skill} className="rounded-full border border-border bg-background px-2 py-0.5 text-xs">
                        {skill}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="rounded-md border border-border/70 bg-muted/30 p-3">
                  <div className="text-sm font-medium">適合先交辦</div>
                  <ul className="mt-2 space-y-1 text-xs leading-5 text-muted-foreground">
                    {previewRoleTemplate.firstTasks.map((task) => (
                      <li key={task}>{task}</li>
                    ))}
                  </ul>
                </div>
              </div>
              <div className="rounded-md border border-primary/30 bg-primary/10 p-3 text-xs leading-5 text-primary">
                按「用此角色建立草稿」只會開啟建立員工表單，預填姓名、職稱、角色與 prompt 草稿；不會自動建立員工，也不會同步 skills。
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setPreviewRoleTemplate(null)}>
                  返回
                </Button>
                <Button type="button" variant="outline" onClick={() => openRoleDraft(previewRoleTemplate)}>
                  用此角色建立草稿
                </Button>
                {previewRoleTemplate.profile && (
                  <Button
                    type="button"
                    onClick={() => {
                      const profile = previewRoleTemplate.profile;
                      if (profile) applySkillProfile(profile);
                      setPreviewRoleTemplate(null);
                    }}
                  >
                    預選相關 skills
                  </Button>
                )}
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

export function VirtualOffice() {
  const { selectedCompanyId, companies } = useCompany();
  const { openNewAgent, openNewIssue, openOnboarding } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const [managedAgent, setManagedAgent] = useState<Agent | null>(null);
  const [managedName, setManagedName] = useState("");
  const [managedTitle, setManagedTitle] = useState("");
  const [managedCapabilities, setManagedCapabilities] = useState("");
  const [terminateConfirm, setTerminateConfirm] = useState(false);
  const [handoffConfirm, setHandoffConfirm] = useState(false);
  const [handoffDraftOpen, setHandoffDraftOpen] = useState(false);

  useEffect(() => {
    setBreadcrumbs([{ label: "Virtual Office" }]);
  }, [setBreadcrumbs]);

  const { data: agents, isLoading: agentsLoading } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: projects, isLoading: projectsLoading } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: activity } = useQuery({
    queryKey: [...queryKeys.activity(selectedCompanyId!), { limit: 8, surface: "virtual-office" }],
    queryFn: () => activityApi.list(selectedCompanyId!, { limit: 8 }),
    enabled: !!selectedCompanyId,
  });

  useEffect(() => {
    if (!managedAgent) {
      setManagedName("");
      setManagedTitle("");
      setManagedCapabilities("");
      setTerminateConfirm(false);
      setHandoffConfirm(false);
      return;
    }
    setManagedName(managedAgent.name);
    setManagedTitle(managedAgent.title ?? "");
    setManagedCapabilities(managedAgent.capabilities ?? "");
    setTerminateConfirm(false);
    setHandoffConfirm(false);
    setHandoffDraftOpen(false);
  }, [managedAgent]);

  const updateManagedAgent = useMutation({
    mutationFn: async () => {
      if (!selectedCompanyId || !managedAgent) throw new Error("No agent selected");
      return agentsApi.update(
        managedAgent.id,
        {
          name: managedName.trim(),
          title: managedTitle.trim() || null,
          capabilities: managedCapabilities.trim() || null,
        },
        selectedCompanyId,
      );
    },
    onSuccess: (agent) => {
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId) });
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) });
      setManagedAgent(agent);
      pushToast({ title: "員工資料已更新", body: `${agent.name} 的名稱與職責已保存。`, tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "員工資料更新失敗",
        body: error instanceof Error ? error.message : "請稍後再試。",
        tone: "error",
      });
    },
  });

  const terminateManagedAgent = useMutation({
    mutationFn: async () => {
      if (!selectedCompanyId || !managedAgent) throw new Error("No agent selected");
      return agentsApi.terminate(managedAgent.id, selectedCompanyId);
    },
    onSuccess: (agent) => {
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId) });
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
      setManagedAgent(null);
      pushToast({ title: "員工已停用", body: `${agent.name} 已從目前辦公室移出，歷史紀錄仍會保留。`, tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "停用員工失敗",
        body: error instanceof Error ? error.message : "請稍後再試。",
        tone: "error",
      });
    },
  });

  const agentsById = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agents ?? []) map.set(agent.id, agent);
    return map;
  }, [agents]);

  const activeOfficeAgents = useMemo(
    () => (agents ?? []).filter((agent) => agent.status !== "terminated"),
    [agents],
  );

  const agentsByRoom = useMemo(() => {
    const grouped = new Map<string, Agent[]>();
    for (const room of OFFICE_ROOMS) grouped.set(room.id, []);
    for (const agent of activeOfficeAgents) {
      grouped.get(roomForAgent(agent))?.push(agent);
    }
    return grouped;
  }, [activeOfficeAgents]);

  const visibleProjects = useMemo(
    () => (projects ?? []).filter((project) => !project.archivedAt).slice(0, 3),
    [projects],
  );

  const { data: projectScopedIssues, isLoading: projectIssuesLoading } = useQuery({
    queryKey: [
      ...queryKeys.issues.list(selectedCompanyId!),
      "virtual-office-projects",
      visibleProjects.map((project) => project.id).join(","),
    ],
    queryFn: async () => {
      const issueGroups = await Promise.all(
        visibleProjects.map((project) =>
          issuesApi.list(selectedCompanyId!, {
            projectId: project.id,
            includeBlockedBy: true,
            limit: 40,
          }),
        ),
      );
      return issueGroups.flat();
    },
    enabled: !!selectedCompanyId && visibleProjects.length > 0,
  });

  const userIssues = (projectScopedIssues ?? []).filter((issue) => !isSystemRecoveryIssue(issue));
  const active = activeIssues(userIssues);
  const meetingIssues = userIssues
    .filter(isMeetingLike)
    .sort((a, b) => {
      const interventionDelta = Number(needsUserIntervention(b)) - Number(needsUserIntervention(a));
      if (interventionDelta !== 0) return interventionDelta;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    })
    .slice(0, 4);
  const interventionMeetingCount = meetingIssues.filter(needsUserIntervention).length;
  const managedAgentActiveIssues = useMemo(
    () =>
      managedAgent
        ? userIssues
            .filter((issue) => issue.assigneeAgentId === managedAgent.id && !["done", "cancelled"].includes(issue.status))
            .slice(0, 4)
        : [],
    [managedAgent, userIssues],
  );
  const managedAgentLedProjects = useMemo(
    () =>
      managedAgent
        ? (projects ?? []).filter((project) => project.leadAgentId === managedAgent.id && !project.archivedAt).slice(0, 3)
        : [],
    [managedAgent, projects],
  );
  const handoffRecommendations = useMemo(() => {
    if (!managedAgent) return [];
    const managedRoom = roomForAgent(managedAgent);
    const managedProfile = `${managedAgent.title ?? ""} ${managedAgent.capabilities ?? ""} ${managedAgent.adapterType}`.toLowerCase();
    const activeIssueCountByAgent = new Map<string, number>();
    for (const issue of active) {
      if (!issue.assigneeAgentId) continue;
      activeIssueCountByAgent.set(issue.assigneeAgentId, (activeIssueCountByAgent.get(issue.assigneeAgentId) ?? 0) + 1);
    }

    return activeOfficeAgents
      .filter((agent) => agent.id !== managedAgent.id)
      .map((agent) => {
        const agentProfile = `${agent.title ?? ""} ${agent.capabilities ?? ""} ${agent.adapterType}`.toLowerCase();
        const sameRoom = roomForAgent(agent) === managedRoom;
        const sharedSignals = ["pm", "主管", "project", "engineer", "developer", "設計", "測試", "需求", "codex", "hermes"]
          .filter((signal) => managedProfile.includes(signal) && agentProfile.includes(signal));
        const workload = activeIssueCountByAgent.get(agent.id) ?? 0;
        const score = (sameRoom ? 3 : 0) + sharedSignals.length - workload * 0.25;
        const reason =
          sameRoom && sharedSignals.length > 0
            ? "同區域且能力相近"
            : sameRoom
              ? "同區域，較容易接手脈絡"
              : sharedSignals.length > 0
                ? "能力標籤相近"
                : "可作為備援人選";
        return { agent, reason, workload, score };
      })
      .sort((a, b) => b.score - a.score || a.workload - b.workload || a.agent.name.localeCompare(b.agent.name))
      .slice(0, 3);
  }, [active, activeOfficeAgents, managedAgent]);
  const managedAgentHasChanges =
    Boolean(managedAgent)
    && (
      managedName.trim() !== (managedAgent?.name ?? "")
      || managedTitle.trim() !== (managedAgent?.title ?? "")
      || managedCapabilities.trim() !== (managedAgent?.capabilities ?? "")
    );
  const managedAgentNeedsHandoff = managedAgentActiveIssues.length > 0 || managedAgentLedProjects.length > 0;
  const terminateBlockedByUnsavedChanges = managedAgentHasChanges;
  const handoffDraftText = managedAgent
    ? [
        `交接會議：${managedAgent.name}`,
        "",
        "建議先在停用前確認以下事項：",
        `1. ${managedAgent.name} 目前負責的進行中任務是否要改派。`,
        `2. 是否有主管專案需要指定新的專案管理主管。`,
        `3. 建議交接對象：${
          handoffRecommendations.length > 0
            ? handoffRecommendations.map(({ agent }) => agent.name).join("、")
            : "目前沒有其它啟用員工"
        }。`,
        "4. 需要保留哪些決策背景、討論紀錄與下一步。",
        "5. 交接完成後，再回到員工管理視窗執行停用。",
      ].join("\n")
    : "";

  if (!selectedCompanyId) {
    if (companies.length === 0) {
      return (
        <EmptyState
          icon={BriefcaseBusiness}
          message="Create a company first, then your office will appear here."
          action="Start Onboarding"
          onAction={openOnboarding}
        />
      );
    }
    return <EmptyState icon={BriefcaseBusiness} message="Select a company to open the virtual office." />;
  }

  if (agentsLoading || projectsLoading || (visibleProjects.length > 0 && projectIssuesLoading)) {
    return <PageSkeleton variant="dashboard" />;
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">Virtual Office</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            A visual control room for agents, projects, workflows, and reviewable discussions.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={openNewAgent}>
            <Plus className="mr-1.5 h-4 w-4" />
            New Agent
          </Button>
          <Button size="sm" onClick={() => openNewIssue()}>
            <CircleDot className="mr-1.5 h-4 w-4" />
            New Work
          </Button>
        </div>
      </div>

      <StarterConsole
        agents={agents ?? []}
        projects={projects ?? []}
        issues={userIssues}
        companyId={selectedCompanyId}
        openNewAgent={openNewAgent}
        openNewIssue={openNewIssue}
        openManageAgent={setManagedAgent}
      />

      <div className="grid gap-3 md:grid-cols-4">
        <div className="rounded-md border border-border bg-card p-3">
          <Bot className="mb-2 h-4 w-4 text-primary" />
          <div className="text-2xl font-semibold">{agents?.length ?? 0}</div>
          <div className="text-xs text-muted-foreground">employees</div>
        </div>
        <div className="rounded-md border border-border bg-card p-3">
          <BriefcaseBusiness className="mb-2 h-4 w-4 text-primary" />
          <div className="text-2xl font-semibold">{projects?.length ?? 0}</div>
          <div className="text-xs text-muted-foreground">projects</div>
        </div>
        <div className="rounded-md border border-border bg-card p-3">
          <CircleDot className="mb-2 h-4 w-4 text-primary" />
          <div className="text-2xl font-semibold">{active.length}</div>
          <div className="text-xs text-muted-foreground">open work items</div>
        </div>
        <div className="rounded-md border border-border bg-card p-3">
          <MessageSquare className="mb-2 h-4 w-4 text-primary" />
          <div className="flex items-end justify-between gap-2">
            <div className="text-2xl font-semibold">{meetingIssues.length}</div>
            {interventionMeetingCount > 0 && (
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                {interventionMeetingCount} 需介入
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground">review threads</div>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-5">
          <div className="relative min-h-[520px] overflow-hidden rounded-md border border-border bg-muted/30">
            <img
              src={OFFICE_REFERENCE_IMAGE}
              alt=""
              className="absolute inset-0 h-full w-full object-cover opacity-30 mix-blend-multiply dark:opacity-20"
            />
            <div className="absolute inset-0 bg-background/35" />
            <div className="absolute inset-0 bg-[linear-gradient(90deg,transparent_0,transparent_49%,hsl(var(--border))_50%,transparent_51%),linear-gradient(0deg,transparent_0,transparent_49%,hsl(var(--border))_50%,transparent_51%)] bg-[size:120px_120px] opacity-20" />
            <div className="absolute left-[35%] top-[8%] h-[80%] w-[2px] bg-border" />
            <div className="absolute left-[5%] top-[44%] h-[2px] w-[68%] bg-border" />
            <div className="absolute left-[75%] top-[8%] h-[80%] w-[18%] rounded-md border border-dashed border-border bg-background/40" />
            <div className="absolute left-[77%] top-[23%] h-[58%] w-[14%] rounded-full border border-border/60 bg-muted/30" />
            <div className="absolute left-[81%] top-[30%] h-[44%] w-1 rounded-full bg-primary/30" />
            <div className="absolute left-[79%] top-[31%] h-3 w-3 rounded-full border border-primary/40 bg-background" />
            <div className="absolute left-[79%] top-[48%] h-3 w-3 rounded-full border border-primary/40 bg-background" />
            <div className="absolute left-[79%] top-[66%] h-3 w-3 rounded-full border border-primary/40 bg-background" />
            <div className="absolute left-[84%] top-[36%] rounded-sm border border-border/70 bg-card/80 px-2 py-1 text-[10px] text-muted-foreground shadow-sm">
              plan
            </div>
            <div className="absolute left-[84%] top-[53%] rounded-sm border border-border/70 bg-card/80 px-2 py-1 text-[10px] text-muted-foreground shadow-sm">
              build
            </div>
            <div className="absolute left-[84%] top-[70%] rounded-sm border border-border/70 bg-card/80 px-2 py-1 text-[10px] text-muted-foreground shadow-sm">
              review
            </div>
            <div className="absolute left-[78%] top-[12%] flex items-center gap-2 text-xs text-muted-foreground">
              <Network className="h-4 w-4" />
              workflow hall
            </div>
            {OFFICE_ROOMS.map((room) => (
              <OfficeRoomPanel key={room.id} room={room} agents={agentsByRoom.get(room.id) ?? []} />
            ))}
          </div>

          <section className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h2 className="text-base font-semibold">Project Workflows</h2>
                <p className="text-xs text-muted-foreground">Parallel teams and upstream/downstream work as visible lanes.</p>
              </div>
              <Link to="/projects" className="text-xs text-primary hover:underline">View projects</Link>
            </div>
            <div className="grid gap-2 rounded-md border border-border/70 bg-muted/30 p-3 text-xs text-muted-foreground sm:grid-cols-3">
              <div>
                <div className="font-medium text-foreground">上下游方向</div>
                <p className="mt-1 leading-5">卡片由左到右排列，左邊通常是右邊任務的前置工作。</p>
              </div>
              <div>
                <div className="font-medium text-foreground">平行處理</div>
                <p className="mt-1 leading-5">同一階段或同一區有多張卡時，代表可由不同員工同步處理。</p>
              </div>
              <div>
                <div className="font-medium text-foreground">等待上游</div>
                <p className="mt-1 leading-5">看到 blocked 或等待上游時，先回到前一階段確認輸入是否完成。</p>
              </div>
            </div>
            {visibleProjects.length > 0 ? (
              <div className="space-y-3">
                {visibleProjects.map((project) => (
                  <ProjectFlow
                    key={project.id}
                    project={project}
                    issues={projectIssues(project, userIssues)}
                    agentsById={agentsById}
                  />
                ))}
              </div>
            ) : (
              <div className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">
                No projects yet. Create a project, then this area becomes the office workflow board.
              </div>
            )}
          </section>
        </div>

        <aside className="space-y-4">
          <section className="rounded-md border border-border bg-card p-4">
            <div className="mb-3 flex items-center gap-2">
              <UserRoundCog className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold">Employee Setup</h2>
            </div>
            <div className="space-y-2 text-sm">
              {(agents ?? []).filter((agent) => agent.status !== "terminated").slice(0, 6).map((agent) => (
                <div key={agent.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
                  <Link to={`/agents/${agentRouteRef(agent)}`} className="min-w-0 flex-1">
                    <span className="block truncate">{agent.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{agent.title ?? getAdapterLabel(agent.adapterType)}</span>
                  </Link>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    title={`管理 ${agent.name}`}
                    data-testid={`office-manage-agent-${agent.id}`}
                    onClick={() => setManagedAgent(agent)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
              {(agents ?? []).filter((agent) => agent.status !== "terminated").length === 0 && (
                <p className="text-sm text-muted-foreground">No active employees yet.</p>
              )}
            </div>
            <Link to="/skills" className="mt-3 inline-flex items-center gap-1.5 text-xs text-primary hover:underline">
              <Boxes className="h-3.5 w-3.5" />
              Manage company skills
            </Link>
          </section>

          <section className="rounded-md border border-border bg-card p-4">
            <div className="mb-3 flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-primary" />
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-semibold">Meetings & Review</h2>
                {interventionMeetingCount > 0 && (
                  <p className="mt-0.5 text-xs text-amber-700">
                    {interventionMeetingCount} 串討論正在等待使用者介入。
                  </p>
                )}
              </div>
            </div>
            <div className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-5 text-muted-foreground">
              <div className="font-medium text-amber-700">介入判讀</div>
              <p className="mt-1">
                出現 <span className="font-medium text-amber-700">需介入</span> 時，代表討論串要求你補充、拍板或確認方向；沒有標籤的會議可先當成覆盤紀錄。
              </p>
            </div>
            <div className="space-y-2">
              {meetingIssues.length > 0 ? meetingIssues.map((issue) => {
                const needsIntervention = needsUserIntervention(issue);
                return (
                <Link
                  key={issue.id}
                  to={`/issues/${issue.id}`}
                  className={cn(
                    "block rounded-md border bg-background p-3 hover:bg-accent",
                    needsIntervention ? "border-amber-500/50" : "border-border/70",
                  )}
                >
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="truncate text-xs text-muted-foreground">{issue.identifier ?? "thread"}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {needsIntervention && (
                        <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
                          需介入
                        </span>
                      )}
                      <StatusBadge status={issue.status} />
                    </span>
                  </div>
                  <div className="line-clamp-2 text-sm font-medium">{issue.title}</div>
                </Link>
                );
              }) : (
                <p className="text-sm text-muted-foreground">No meeting-like threads yet. Create a work item with “meeting”, “discussion”, or “覆盤” in the title.</p>
              )}
            </div>
          </section>

          <section className="rounded-md border border-border bg-card p-4">
            <div className="mb-3 flex items-center gap-2">
              <Activity className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold">Recent Activity</h2>
            </div>
            <div className="space-y-2">
              {(activity ?? []).slice(0, 6).map((event) => (
                <div key={event.id} className="rounded-md bg-muted/50 px-2 py-1.5 text-xs">
                  <div className="truncate font-medium">{event.action.replace(/_/g, " ")}</div>
                  <div className="truncate text-muted-foreground">{event.entityType ?? "system"}</div>
                </div>
              ))}
              {(activity ?? []).length === 0 && (
                <p className="text-sm text-muted-foreground">Activity will appear as agents work.</p>
              )}
            </div>
          </section>
        </aside>
      </div>

      <Dialog open={Boolean(managedAgent)} onOpenChange={(open) => !open && setManagedAgent(null)}>
        <DialogContent className="flex max-h-[88vh] flex-col overflow-hidden sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>管理員工</DialogTitle>
            <DialogDescription>
              修改員工在辦公室中的名稱與職責。停用會保留歷史任務與討論紀錄。
            </DialogDescription>
          </DialogHeader>
          {managedAgent && (
            <form
              className="flex min-h-0 flex-1 flex-col"
              onSubmit={(event) => {
                event.preventDefault();
                if (!managedName.trim() || !managedAgentHasChanges || updateManagedAgent.isPending) return;
                updateManagedAgent.mutate();
              }}
            >
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
                <div className="space-y-2">
                  <Label htmlFor="office-agent-select">選擇員工</Label>
                  <Select
                    value={managedAgent.id}
                    onValueChange={(agentId) => {
                      const nextAgent = activeOfficeAgents.find((agent) => agent.id === agentId);
                      if (nextAgent) setManagedAgent(nextAgent);
                    }}
                  >
                    <SelectTrigger id="office-agent-select">
                      <SelectValue placeholder="選擇要管理的員工" />
                    </SelectTrigger>
                    <SelectContent>
                      {activeOfficeAgents.map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>
                          {agent.name} · {agent.title ?? getAdapterLabel(agent.adapterType)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="office-agent-name">員工名稱</Label>
                    <Input
                      id="office-agent-name"
                      value={managedName}
                      onChange={(event) => setManagedName(event.target.value)}
                      placeholder="例如 Eve"
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="office-agent-title">職稱</Label>
                    <Input
                      id="office-agent-title"
                      value={managedTitle}
                      onChange={(event) => setManagedTitle(event.target.value)}
                      placeholder="例如 專案管理主管"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>職責範本</Label>
                  <div className="grid gap-2 sm:grid-cols-4">
                    {EMPLOYEE_ROLE_PRESETS.map((preset) => (
                      <Button
                        key={preset.id}
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-auto min-h-9 justify-center whitespace-normal px-2 py-2 text-xs"
                        onClick={() => {
                          setManagedTitle(preset.title);
                          setManagedCapabilities(preset.capabilities);
                        }}
                      >
                        {preset.label}
                      </Button>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    範本只會先填入職稱與能力備註，確認後再按保存變更。
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="office-agent-capabilities">能力備註</Label>
                  <Textarea
                    id="office-agent-capabilities"
                    value={managedCapabilities}
                    onChange={(event) => setManagedCapabilities(event.target.value)}
                    rows={4}
                    placeholder="簡短寫下這位員工擅長什麼、適合負責哪些工作。"
                  />
                </div>
                <div className="rounded-md border border-border/70 bg-muted/30 p-3 text-xs text-muted-foreground">
                  <div className="font-medium text-foreground">目前模型</div>
                  <div className="mt-1">{getAdapterLabel(managedAgent.adapterType)}</div>
                </div>
                <div
                  className={cn(
                    "rounded-md border p-3 text-xs",
                    managedAgentHasChanges
                      ? "border-amber-500/40 bg-amber-500/10 text-amber-700"
                      : "border-border/70 bg-muted/30 text-muted-foreground",
                  )}
                >
                  {managedAgentHasChanges
                    ? "有未保存變更。確認名稱、職稱與能力備註後，再按保存變更。"
                    : "目前沒有未保存變更。"}
                </div>
                <div className="rounded-md border border-border/70 bg-background p-3">
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                    <div className="text-sm font-medium">停用前影響範圍</div>
                    <div className="text-xs text-muted-foreground">
                      {managedAgentActiveIssues.length} 個進行中任務 · {managedAgentLedProjects.length} 個主管專案
                    </div>
                  </div>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <div>
                      <div className="text-xs font-medium text-muted-foreground">目前負責任務</div>
                      <div className="mt-2 space-y-1.5">
                        {managedAgentActiveIssues.length > 0 ? managedAgentActiveIssues.map((issue) => (
                          <Link
                            key={issue.id}
                            to={`/issues/${issue.id}`}
                            className="block truncate rounded-sm border border-border/70 bg-muted/30 px-2 py-1 text-xs hover:bg-accent"
                          >
                            {issue.identifier ? `${issue.identifier} · ` : ""}{issue.title}
                          </Link>
                        )) : (
                          <p className="text-xs text-muted-foreground">沒有進行中的指派任務。</p>
                        )}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs font-medium text-muted-foreground">主管專案</div>
                      <div className="mt-2 space-y-1.5">
                        {managedAgentLedProjects.length > 0 ? managedAgentLedProjects.map((project) => (
                          <Link
                            key={project.id}
                            to={`/projects/${projectRouteRef(project)}`}
                            className="block truncate rounded-sm border border-border/70 bg-muted/30 px-2 py-1 text-xs hover:bg-accent"
                          >
                            {project.name}
                          </Link>
                        )) : (
                          <p className="text-xs text-muted-foreground">沒有主管中的專案。</p>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 rounded-md border border-dashed border-border/80 bg-muted/20 p-3">
                    <div className="flex items-center gap-2 text-xs font-medium text-foreground">
                      <Network className="h-3.5 w-3.5 text-primary" />
                      交接建議
                    </div>
                    {handoffRecommendations.length > 0 ? (
                      <div className="mt-2 space-y-1.5">
                        {handoffRecommendations.map(({ agent, reason, workload }) => (
                          <Link
                            key={agent.id}
                            to={`/agents/${agentRouteRef(agent)}`}
                            className="flex items-center justify-between gap-2 rounded-sm border border-border/70 bg-background px-2 py-1.5 text-xs hover:bg-accent"
                          >
                            <span className="min-w-0">
                              <span className="block truncate font-medium text-foreground">{agent.name}</span>
                              <span className="block truncate text-muted-foreground">{reason}</span>
                            </span>
                            <span className="shrink-0 text-muted-foreground">{workload} 件進行中</span>
                          </Link>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-2 text-xs text-muted-foreground">目前沒有其它啟用員工可交接。</p>
                    )}
                    <p className="mt-2 text-xs text-muted-foreground">
                      這裡只提供交接參考，不會自動改派任務或更動專案主管。
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-3"
                      onClick={() => setHandoffDraftOpen((open) => !open)}
                    >
                      <CalendarClock className="mr-1.5 h-4 w-4" />
                      {handoffDraftOpen ? "收起交接草稿" : "產生交接會議草稿"}
                    </Button>
                    {handoffDraftOpen && (
                      <div className="mt-3 rounded-md border border-border/70 bg-background p-3">
                        <div className="mb-2 text-xs font-medium text-foreground">交接會議議程草稿</div>
                        <pre className="whitespace-pre-wrap text-xs leading-5 text-muted-foreground">{handoffDraftText}</pre>
                      </div>
                    )}
                  </div>
                </div>
                <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
                  <div className="flex items-start gap-2">
                    <Checkbox
                      id="office-agent-terminate-confirm"
                      data-testid="office-agent-terminate-confirm"
                      checked={terminateConfirm}
                      onCheckedChange={(checked) => setTerminateConfirm(Boolean(checked))}
                    />
                    <Label htmlFor="office-agent-terminate-confirm" className="text-xs leading-5 text-muted-foreground">
                      我了解停用後，這位員工會從目前辦公室與指派選單移出，但過去任務與討論紀錄仍保留。
                    </Label>
                  </div>
                  {managedAgentNeedsHandoff && (
                    <div className="mt-3 rounded-md border border-destructive/20 bg-background/70 p-3">
                      <div className="flex items-start gap-2">
                        <Checkbox
                          id="office-agent-handoff-confirm"
                          data-testid="office-agent-handoff-confirm"
                          checked={handoffConfirm}
                          onCheckedChange={(checked) => setHandoffConfirm(Boolean(checked))}
                        />
                        <Label htmlFor="office-agent-handoff-confirm" className="text-xs leading-5 text-muted-foreground">
                          我已確認交接安排，知道還有進行中任務或主管專案需要先處理。
                        </Label>
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        若尚未安排，請先使用上方交接建議與交接會議草稿確認接手人選。
                      </p>
                    </div>
                  )}
                  {terminateBlockedByUnsavedChanges && (
                    <p className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
                      目前有未保存變更。請先保存或取消這些修改，再停用員工。
                    </p>
                  )}
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    className="mt-3"
                    data-testid="office-agent-terminate-button"
                    disabled={
                      terminateBlockedByUnsavedChanges
                      || !terminateConfirm
                      || (managedAgentNeedsHandoff && !handoffConfirm)
                      || terminateManagedAgent.isPending
                    }
                    onClick={() => terminateManagedAgent.mutate()}
                  >
                    <Trash2 className="mr-1.5 h-4 w-4" />
                    {terminateManagedAgent.isPending ? "停用中..." : "停用員工"}
                  </Button>
                </div>
              </div>
              <DialogFooter className="mt-4 border-t border-border/70 bg-card pt-4">
                <Button type="button" variant="outline" onClick={() => setManagedAgent(null)}>
                  取消
                </Button>
                <Button type="submit" disabled={!managedName.trim() || !managedAgentHasChanges || updateManagedAgent.isPending}>
                  {updateManagedAgent.isPending ? "保存中..." : "保存變更"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
