import type { Agent } from "@paperclipai/shared";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ClipboardList,
  GitBranch,
  Radio,
  ShieldCheck,
  Workflow,
} from "lucide-react";
import { Link } from "@/lib/router";
import {
  findYoonCompanyAgent,
  getYoonCompanyHermesStatus,
  HERMES_PHASE1_APPROVAL_PACKAGE,
  HERMES_PAPERCLIP_ADAPTER_VERSION,
  HERMES_PROFILE_ROSTER,
} from "../lib/yooncompany-hermes-status";
import { cn } from "../lib/utils";

function formatList(values: string[], fallback: string) {
  return values.length > 0 ? values.join(", ") : fallback;
}

function formatSession(value: boolean | null) {
  if (value === null) return "설정값 없음";
  return value ? "지속 세션" : "비지속 세션";
}

function formatMaxTurns(status: ReturnType<typeof getYoonCompanyHermesStatus>) {
  if (!status.maxTurns) return "설정값 없음";
  const suffix = status.maxTurns.source === "extraArgs" ? "extraArgs 이전 필요" : "구조화 설정";
  return `${status.maxTurns.value} · ${suffix}`;
}

function Signal({
  icon: Icon,
  label,
  value,
  tone = "neutral",
}: {
  icon: typeof Bot;
  label: string;
  value: string;
  tone?: "neutral" | "warn" | "ok";
}) {
  return (
    <div className={cn(
      "min-w-0 border border-border bg-background px-3 py-2",
      tone === "warn" && "border-amber-400/40 bg-amber-50/60 text-amber-950 dark:bg-amber-950/20 dark:text-amber-100",
      tone === "ok" && "border-emerald-500/30 bg-emerald-50/60 text-emerald-950 dark:bg-emerald-950/20 dark:text-emerald-100",
    )}>
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1 truncate text-sm font-medium">{value}</div>
    </div>
  );
}

export function YoonCompanyHermesStatusPanel({
  agents,
  className,
}: {
  agents: Agent[] | undefined;
  className?: string;
}) {
  const hermesAgent = findYoonCompanyAgent(agents, "hermes");
  const codexAgent = findYoonCompanyAgent(agents, "codex");
  const status = getYoonCompanyHermesStatus(hermesAgent);
  const toolsets = formatList(status.toolsets, "Paperclip 설정값 없음");
  const missing = formatList(status.missingToolsets, "누락 없음");
  const safety = [
    status.duplicateYoloRisk ? "--yolo 중복 위험" : status.yolo ? "--yolo 활성" : "--yolo 미표시",
    status.canCreateAgents ? "agent 생성권한 있음" : "agent 생성권한 없음",
  ].join(", ");

  return (
    <section className={cn("border border-border bg-muted/20 p-4", className)} aria-label="YoonCompany Hermes 운영 상태">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Workflow className="h-4 w-4 text-muted-foreground" />
            Hermes-first 운영 상태
          </div>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
            Hermes를 오케스트레이터로, Paperclip을 승인/감사 콘솔로, Codex를 개발 워커로 두기 위한 현재 정합성입니다.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 text-xs">
          <Link to="/agents" className="border border-border bg-background px-2.5 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground">
            직원 보기
          </Link>
          <Link to="/approvals" className="border border-border bg-background px-2.5 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground">
            승인 보기
          </Link>
        </div>
      </div>

      <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        <Signal
          icon={Bot}
          label="오케스트레이터"
          value={hermesAgent ? `${hermesAgent.name} · ${status.adapterType ?? "adapter 미확인"}` : "Hermes 직원 미확인"}
          tone={hermesAgent ? "neutral" : "warn"}
        />
        <Signal
          icon={GitBranch}
          label="개발 워커"
          value={codexAgent ? `${codexAgent.name} · ${codexAgent.adapterType}` : "Codex 직원 미확인"}
          tone={codexAgent ? "neutral" : "warn"}
        />
        <Signal icon={ClipboardList} label="Paperclip toolsets" value={toolsets} />
        <Signal
          icon={status.orchestrationReady ? CheckCircle2 : AlertTriangle}
          label="오케스트레이션 준비"
          value={status.orchestrationReady ? "준비됨" : `막힘: ${missing}`}
          tone={status.orchestrationReady ? "ok" : "warn"}
        />
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-5">
        <Signal icon={Workflow} label="Adapter" value={`hermes-paperclip-adapter ${HERMES_PAPERCLIP_ADAPTER_VERSION}`} />
        <Signal icon={Radio} label="세션" value={formatSession(status.persistSession)} tone={status.persistSession ? "ok" : "warn"} />
        <Signal icon={ShieldCheck} label="안전 신호" value={safety} tone={status.duplicateYoloRisk || status.yolo ? "warn" : "neutral"} />
        <Signal
          icon={ClipboardList}
          label="실행 제한"
          value={formatMaxTurns(status)}
          tone={status.maxTurns?.source === "extraArgs" ? "warn" : "neutral"}
        />
        <Signal
          icon={AlertTriangle}
          label="다음 승인 게이트"
          value="profile/toolset/Kanban 실제 활성화"
          tone="warn"
        />
      </div>

      {!status.orchestrationReady ? (
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          현재 Hermes는 설치된 런타임 능력보다 Paperclip agent 설정이 좁습니다. 이 패널은 상태만 드러내며, profile 생성이나 권한 개방은 승인 후 별도 변경으로 처리해야 합니다.
          {status.duplicateYoloRisk ? " adapter 0.3.0은 --yolo를 내부에서 추가하므로 현재 extraArgs의 --yolo는 승인 후 제거하거나 정책화해야 합니다." : ""}
        </p>
      ) : null}

      <div className="mt-3 grid gap-2 lg:grid-cols-[1.4fr_1fr]">
        <div className="border border-border bg-background px-3 py-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
            <ClipboardList className="h-3.5 w-3.5" />
            승인 패키지 초안
          </div>
          <div className="mt-1 text-sm font-medium">{HERMES_PHASE1_APPROVAL_PACKAGE.title}</div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{HERMES_PHASE1_APPROVAL_PACKAGE.action}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {HERMES_PHASE1_APPROVAL_PACKAGE.targets.map((target) => (
              <span key={target} className="border border-border bg-muted px-2 py-1 text-xs text-muted-foreground">
                {target}
              </span>
            ))}
          </div>
        </div>
        <div className="border border-amber-400/40 bg-amber-50/60 px-3 py-2 text-amber-950 dark:bg-amber-950/20 dark:text-amber-100">
          <div className="flex items-center gap-2 text-xs font-semibold">
            <ShieldCheck className="h-3.5 w-3.5" />
            승인 전 금지
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {HERMES_PHASE1_APPROVAL_PACKAGE.blocked.map((item) => (
              <span key={item} className="border border-amber-500/30 bg-background/70 px-2 py-1 text-xs">
                {item}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-3 border border-border bg-background px-3 py-2">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
            <Workflow className="h-3.5 w-3.5" />
            Hermes profile roster 미리보기
          </div>
          <div className="text-xs text-muted-foreground">읽기 전용 · profile 생성 안 됨</div>
        </div>
        <div className="mt-2 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {HERMES_PROFILE_ROSTER.map((profile) => (
            <div key={profile.name} className="min-w-0 border border-border bg-muted/20 px-2.5 py-2">
              <div className="flex min-w-0 items-center justify-between gap-2">
                <div className="truncate text-sm font-medium">{profile.name}</div>
                <span className="shrink-0 border border-border bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground">
                  {profile.phase}
                </span>
              </div>
              <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{profile.role}</p>
              <div className="mt-2 truncate text-xs text-muted-foreground">
                {profile.toolsets.join(", ")}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
