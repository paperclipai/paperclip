import type { CSSProperties, ReactNode } from "react";
import { ArrowUpRight, MoreHorizontal, UserRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { LabAttentionRecord } from "../../kit";

const GO_ELSEWHERE_PRIMARY: Partial<Record<LabAttentionRecord["kind"], string>> = {
  review: "Review",
  blocker: "Review",
  recovery: "Open recovery",
  agent_error: "Inspect",
};

function ContextLine({ record }: { record: LabAttentionRecord }) {
  if (record.forUser) {
    return (
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="outline" className="shrink-0">
          <UserRound className="h-3 w-3" />
          For @{record.forUser}
        </Badge>
        <span className="truncate">
          {record.task} · {record.taskTitle} · {record.agent} · {record.ageLabel}
        </span>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span className="shrink-0 font-mono">{record.task}</span>
      <span className="min-w-0 truncate">· {record.taskTitle}</span>
      <span className="shrink-0">· {record.agent}</span>
      <span className="shrink-0">· {record.ageLabel}</span>
      {record.stale ? null : <span className="shrink-0 opacity-70">· {record.reason}</span>}
    </div>
  );
}

function Accent({ record }: { record: LabAttentionRecord }) {
  if (record.spend) {
    return (
      <div className="flex items-center gap-2 text-xs">
        <Badge variant="destructive">{record.spend.percent}%</Badge>
        <span className="font-medium text-foreground">
          {record.spend.spent} / {record.spend.limit}
        </span>
        <span className="text-muted-foreground">· work is paused</span>
      </div>
    );
  }
  if (record.kind === "question" && record.questions) {
    const recommended = record.questions.find((question) => question.recommended)?.recommended;
    return (
      <p className="text-xs text-muted-foreground">
        {record.questions.length} questions{recommended ? ` · recommends ${recommended}` : ""}
      </p>
    );
  }
  if (record.kind === "suggested_tasks" && record.suggested) {
    return <p className="truncate text-xs text-muted-foreground">{record.suggested.length} tasks · {record.suggested.map((task) => task.split(" (")[0]).join(", ")}</p>;
  }
  if (record.kind === "decision" && record.options) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {record.options.map((option) => (
          <span key={option} className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground">
            {option}
          </span>
        ))}
      </div>
    );
  }
  if (record.error) {
    return <p className="truncate rounded-md bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">{record.error}</p>;
  }
  if (record.blockingTask) {
    return (
      <p className="text-xs text-muted-foreground">
        Blocked by <span className="font-mono">{record.blockingTask.identifier}</span> · {record.blockingTask.title}
      </p>
    );
  }
  return null;
}

function ExpandedForm({ record }: { record: LabAttentionRecord }) {
  if (record.kind === "question" && record.questions) {
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3">
        {record.questions.map((question) => (
          <div key={question.prompt} className="flex flex-col gap-1.5">
            <p className="text-sm font-medium text-foreground">{question.prompt}</p>
            {question.mode === "text" ? (
              <div className="h-9 rounded-md border border-border bg-background" />
            ) : (
              <div className="flex flex-col gap-1">
                {(question.options ?? []).map((option) => (
                  <label key={option} className="flex items-center gap-2 text-sm text-muted-foreground">
                    <span className={cn("inline-block h-3.5 w-3.5 rounded-full border border-border", option === question.recommended && "bg-primary")} />
                    {option}
                    {option === question.recommended ? <Badge variant="secondary">Recommended</Badge> : null}
                  </label>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    );
  }
  if (record.kind === "suggested_tasks" && record.suggested) {
    return (
      <ul className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/30 p-3">
        {record.suggested.map((task) => (
          <li key={task} className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="inline-block h-3.5 w-3.5 rounded-sm border border-border bg-primary" />
            {task}
          </li>
        ))}
      </ul>
    );
  }
  if (record.spend) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 p-3">
        <span className="text-sm text-muted-foreground">New limit</span>
        <div className="h-9 w-32 rounded-md border border-border bg-background" />
      </div>
    );
  }
  return <p className="rounded-lg border border-border bg-muted/30 p-3 text-sm leading-relaxed text-muted-foreground">{record.context}</p>;
}

function Actions({ record }: { record: LabAttentionRecord }) {
  const inline = record.kind === "approval" || record.kind === "join_request";
  if (record.decideHere) {
    return (
      <div className="flex items-center justify-end gap-2">
        {(record.secondary ?? []).map((label) => (
          <Button key={label} type="button" variant="ghost" size="sm">
            {label}
          </Button>
        ))}
        <Button type="button" size="sm">
          {record.primary}
        </Button>
      </div>
    );
  }
  if (inline) {
    return (
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm">
          Reject
        </Button>
        <Button type="button" size="sm">
          Approve
        </Button>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-end">
      <Button type="button" size="sm">
        {GO_ELSEWHERE_PRIMARY[record.kind] ?? "Review"}
        <ArrowUpRight className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function Shell({ featured, children }: { featured?: boolean; children: ReactNode }) {
  if (!featured) {
    return <div className="rounded-xl border border-border bg-card p-4">{children}</div>;
  }
  return (
    <div className="focus-tile relative">
      <div aria-hidden data-rotate data-spread="left" className="absolute inset-0 -z-10 rounded-xl bg-(--focus-paper)" style={{ "--focus-base": "-2deg", boxShadow: "var(--focus-shadow-sheet)" } as CSSProperties} />
      <div aria-hidden data-rotate data-spread="right" className="absolute inset-0 -z-10 rounded-xl bg-(--focus-paper)" style={{ "--focus-base": "2deg", boxShadow: "var(--focus-shadow-sheet)" } as CSSProperties} />
      <div data-front className="relative rounded-xl border border-border bg-card p-4" style={{ boxShadow: "var(--focus-shadow-sheet)" }}>
        {children}
      </div>
    </div>
  );
}

export function FocusCard({ record, featured, expanded, className }: { record: LabAttentionRecord; featured?: boolean; expanded?: boolean; className?: string }) {
  const chip = record.target ? `Review ${record.target.kind} ▸` : null;
  return (
    <div className={cn("w-full", className)}>
      <Shell featured={featured}>
        <div className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-2">
            <ContextLine record={record} />
            <div className="flex shrink-0 items-center gap-1">
              {record.stale ? <Badge variant="secondary">Stale</Badge> : null}
              <Button type="button" variant="ghost" size="icon-xs" aria-label="Card menu">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <p className="text-base font-semibold leading-snug text-foreground">{record.ask}</p>
          <p className="text-sm leading-relaxed text-muted-foreground">{record.context}</p>
          <Accent record={record} />
          {expanded ? <ExpandedForm record={record} /> : null}
          <div className="flex items-center justify-between gap-3 pt-1">
            {chip ? (
              <Button type="button" variant="outline" size="sm">
                {chip}
              </Button>
            ) : (
              <span />
            )}
            <Actions record={record} />
          </div>
        </div>
      </Shell>
    </div>
  );
}
