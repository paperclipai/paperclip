import type { CSSProperties } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  Ban,
  BadgeCheck,
  Bug,
  CircleDollarSign,
  Eye,
  FileText,
  GitFork,
  LifeBuoy,
  ListPlus,
  MessageCircleQuestion,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { LabAttentionRecord } from "../../kit";

const KIND_ICON: Record<LabAttentionRecord["kind"], LucideIcon> = {
  plan: FileText,
  confirmation: FileText,
  question: MessageCircleQuestion,
  suggested_tasks: ListPlus,
  decision: GitFork,
  budget: CircleDollarSign,
  failed_run: AlertTriangle,
  approval: BadgeCheck,
  review: Eye,
  blocker: Ban,
  recovery: LifeBuoy,
  join_request: UserPlus,
  agent_error: Bug,
};

const GO_ELSEWHERE_PRIMARY: Partial<Record<LabAttentionRecord["kind"], string>> = {
  review: "Review",
  blocker: "Open blocker",
  recovery: "Open recovery",
  agent_error: "Inspect",
};

export function RailRow({ record, selected, onSelect }: { record: LabAttentionRecord; selected: boolean; onSelect: () => void }) {
  const Icon = KIND_ICON[record.kind];
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
        selected ? "bg-(--workspace-rail-selected)" : "hover:bg-muted/60",
        record.stale && "opacity-70",
      )}
    >
      <Icon className={cn("h-4 w-4 shrink-0", record.severity === "critical" ? "text-destructive" : "text-muted-foreground")} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{record.ask}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {record.task} · {record.agent}
        </span>
      </span>
      {record.forUser ? (
        <Badge variant="outline" className="shrink-0">
          @{record.forUser}
        </Badge>
      ) : record.stale ? (
        <Badge variant="secondary" className="shrink-0">
          Stale
        </Badge>
      ) : (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{record.ageLabel}</span>
      )}
    </button>
  );
}

function PlanArtifact({ record }: { record: LabAttentionRecord }) {
  return (
    <div className="space-y-3">
      <p className="text-xs uppercase tracking-wider text-muted-foreground">{record.target?.label ?? "Document"}</p>
      <p className="text-sm leading-relaxed text-foreground">{record.context}</p>
      <ul className="flex flex-col gap-1.5 text-sm text-foreground">
        <li className="flex items-center gap-2"><span className="inline-block h-1.5 w-1.5 rounded-full bg-foreground/60" />Pillar 1 — Heritage craft</li>
        <li className="flex items-center gap-2"><span className="inline-block h-1.5 w-1.5 rounded-full bg-foreground/60" />Pillar 2 — Everyday wear</li>
        <li className="flex items-center gap-2"><span className="inline-block h-1.5 w-1.5 rounded-full bg-foreground/60" />Pillar 3 — Playful retail voice</li>
      </ul>
    </div>
  );
}

function QuestionArtifact({ record }: { record: LabAttentionRecord }) {
  return (
    <div className="flex flex-col gap-3">
      {(record.questions ?? []).map((question) => (
        <div key={question.prompt} className="flex flex-col gap-1.5">
          <p className="text-sm font-medium text-foreground">{question.prompt}</p>
          {question.mode === "text" ? (
            <div className="h-9 rounded-md border border-border bg-background" />
          ) : (
            <div className="flex flex-col gap-1">
              {(question.options ?? []).map((option) => (
                <span key={option} className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span className={cn("inline-block h-3.5 w-3.5 rounded-full border border-border", option === question.recommended && "bg-primary")} />
                  {option}
                  {option === question.recommended ? <Badge variant="secondary">Recommended</Badge> : null}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function PointerArtifact({ record }: { record: LabAttentionRecord }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-border bg-muted/30 p-4">
      <p className="text-sm text-muted-foreground">{record.context}</p>
      <Button type="button" variant="outline" size="sm">
        {GO_ELSEWHERE_PRIMARY[record.kind] ?? "Open"} in {record.task}
        <ArrowUpRight className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

export function Artifact({ record }: { record: LabAttentionRecord }) {
  if (record.kind === "question") return <QuestionArtifact record={record} />;
  if (record.kind === "suggested_tasks" && record.suggested) {
    return (
      <ul className="flex flex-col gap-1.5">
        {record.suggested.map((task) => (
          <li key={task} className="flex items-center gap-2 text-sm text-foreground">
            <span className="inline-block h-3.5 w-3.5 rounded-sm border border-border bg-primary" />
            {task}
          </li>
        ))}
      </ul>
    );
  }
  if (record.spend) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm">
          <Badge variant="destructive">{record.spend.percent}%</Badge>
          <span className="font-medium text-foreground">{record.spend.spent} / {record.spend.limit}</span>
          <span className="text-muted-foreground">· work is paused</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">New limit</span>
          <div className="h-9 w-32 rounded-md border border-border bg-background" />
        </div>
      </div>
    );
  }
  if (record.error) {
    return (
      <div className="space-y-2">
        <p className="rounded-md bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">{record.error}</p>
        <Button type="button" variant="outline" size="sm">
          Open run<ArrowUpRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }
  if (record.kind === "decision" && record.options) {
    return (
      <div className="flex flex-col gap-2">
        {record.options.map((option) => (
          <span key={option} className="rounded-md border border-border px-3 py-2 text-sm text-foreground">
            {option}
          </span>
        ))}
      </div>
    );
  }
  if (record.target?.kind === "plan" || record.kind === "plan" || record.kind === "approval") return <PlanArtifact record={record} />;
  return <PointerArtifact record={record} />;
}

function WorkspaceActions({ record }: { record: LabAttentionRecord }) {
  const inline = record.kind === "approval" || record.kind === "join_request";
  if (record.decideHere) {
    return (
      <>
        {(record.secondary ?? []).map((label) => (
          <Button key={label} type="button" variant="ghost" size="sm">
            {label}
          </Button>
        ))}
        <Button type="button" size="sm">
          {record.primary}
        </Button>
      </>
    );
  }
  if (inline) {
    return (
      <>
        <Button type="button" variant="ghost" size="sm">
          Reject
        </Button>
        <Button type="button" size="sm">
          Approve
        </Button>
      </>
    );
  }
  return (
    <Button type="button" size="sm">
      {GO_ELSEWHERE_PRIMARY[record.kind] ?? "Review"}
      <ArrowUpRight className="h-3.5 w-3.5" />
    </Button>
  );
}

export function WorkspaceDetail({ record, featured, className }: { record: LabAttentionRecord; featured?: boolean; className?: string }) {
  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <p className="truncate text-xs text-muted-foreground">
            {record.task} · {record.taskTitle} · {record.agent} · {record.ageLabel}
          </p>
          <h2 className="mt-1 text-lg font-semibold leading-snug text-foreground">{record.ask}</h2>
          {record.forUser ? (
            <Badge variant="outline" className="mt-1.5">
              For @{record.forUser}
            </Badge>
          ) : null}
        </div>
        <Button type="button" variant="ghost" size="xs" className="shrink-0">
          Open in {record.task}
          <ArrowUpRight className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="flex-1 px-5 py-4">
        <div className={cn("workspace-tile relative", !featured && "")}>
          {featured ? (
            <>
              <div aria-hidden data-rotate data-spread="left" className="absolute inset-0 -z-10 rounded-xl bg-(--workspace-paper)" style={{ "--workspace-base": "-2deg", boxShadow: "var(--workspace-shadow-sheet)" } as CSSProperties} />
              <div aria-hidden data-rotate data-spread="right" className="absolute inset-0 -z-10 rounded-xl bg-(--workspace-paper)" style={{ "--workspace-base": "2deg", boxShadow: "var(--workspace-shadow-sheet)" } as CSSProperties} />
            </>
          ) : null}
          <div data-front className="relative rounded-xl border border-border bg-card p-4" style={{ boxShadow: "var(--workspace-shadow-sheet)" }}>
            <Artifact record={record} />
          </div>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border bg-background px-5 py-3">
        <WorkspaceActions record={record} />
      </div>
    </div>
  );
}
