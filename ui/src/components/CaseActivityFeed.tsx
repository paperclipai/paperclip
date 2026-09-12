import { i18n, t, useTranslation } from "@/i18n";
import { useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { Bot, User, Cog, ChevronDown, ListFilter } from "lucide-react";
import type { CaseEvent, CaseEventKind } from "@/api/cases";
import { Button } from "@/components/ui/button";
import { StatusIcon } from "@/components/StatusIcon";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn, relativeTime } from "@/lib/utils";

const EVENT_LABEL: Record<CaseEventKind, string> = {
  get created() { return t("localizationActivityTail.caseEvent_created"); },
  get updated() { return t("localizationActivityTail.caseEvent_updated"); },
  get fields_changed() { return t("localizationActivityTail.caseEvent_fields_changed"); },
  get status_changed() { return t("localizationActivityTail.caseEvent_status_changed"); },
  get issue_linked() { return t("localizationActivityTail.caseEvent_issue_linked"); },
  get issue_unlinked() { return t("localizationActivityTail.caseEvent_issue_unlinked"); },
  get document_revised() { return t("localizationActivityTail.caseEvent_document_revised"); },
  get child_linked() { return t("localizationActivityTail.caseEvent_child_linked"); },
  get attachment_added() { return t("localizationActivityTail.caseEvent_attachment_added"); },
  get label_added() { return t("localizationActivityTail.caseEvent_label_added"); },
  get label_removed() { return t("localizationActivityTail.caseEvent_label_removed"); },
};

/** Human label for the actor, preferring the resolved agent name. */
function actorLabel(event: CaseEvent): string {
  if (event.actorType === "agent") return event.actorAgentName ?? t("localizationActivityTail.agent");
  if (event.actorType === "user") return t("localizationActivityTail.user");
  return t("localizationActivityTail.system");
}

function ActorIcon({ event }: { event: CaseEvent }) {
  const Icon = event.actorType === "agent" ? Bot : event.actorType === "user" ? User : Cog;
  return <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />;
}

function issueRelationLabel(event: CaseEvent): string {
  return event.kind === "issue_linked" || event.kind === "issue_unlinked" ? t("localizationActivityTail.issue") : t("localizationActivityTail.via");
}

/** One event with actor + run→issue attribution (P4 §1). */
export function CaseEventRow({ event, compact = false }: { event: CaseEvent; compact?: boolean }) {
  const { t } = useTranslation();
  const statusLabel = (status: unknown) => typeof status === "string" ? t(`status.${status}`, { defaultValue: status }) : "?";
  const detail =
    event.kind === "status_changed" && event.payload
      ? `${statusLabel(event.payload.previousStatus)} → ${statusLabel(event.payload.status)}`
      : "";
  return (
    <div className={cn("flex items-start gap-2 text-xs", compact ? "py-1.5" : "py-2")}>
      <span className="mt-1"><ActorIcon event={event} /></span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-1.5">
          <span className="font-medium">{EVENT_LABEL[event.kind] ?? event.kind}</span>
          {detail && <span className="text-muted-foreground">· {detail}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-x-1.5 text-muted-foreground">
          <span>{actorLabel(event)}</span>
          {event.issue && (
            <>
              <span aria-hidden>·</span>
              <span>{issueRelationLabel(event)}</span>
              <Link
                to={`/issues/${event.issue.identifier}`}
                className="inline-flex min-w-0 items-center gap-1 text-foreground/80 hover:underline"
                title={event.issue.title}
              >
                <StatusIcon status={event.issue.status} size="sm" />
                <span className="shrink-0 font-mono">{event.issue.identifier}</span>
                <span className="min-w-0 truncate">{event.issue.title}</span>
              </Link>
            </>
          )}
          <span aria-hidden>·</span>
          <span>{relativeTime(event.createdAt)}</span>
        </div>
      </div>
    </div>
  );
}

/** The full activity feed with kind filters (detail-page Activity tab). */
export function CaseActivityFeed({ events }: { events: CaseEvent[] }) {
  const { t } = useTranslation();
  const [active, setActive] = useState<Set<CaseEventKind>>(new Set());

  // Only offer filters for kinds actually present, in first-seen order.
  const presentKinds = useMemo(() => {
    const seen: CaseEventKind[] = [];
    for (const e of events) if (!seen.includes(e.kind)) seen.push(e.kind);
    return seen;
  }, [events]);

  const filtered = useMemo(
    () => (active.size === 0 ? events : events.filter((e) => active.has(e.kind))),
    [events, active],
  );

  function toggle(kind: CaseEventKind) {
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  const filterLabel = active.size === 0
    ? t("localizationActivityTail.allActivity")
    : active.size === 1
      ? EVENT_LABEL[[...active][0]!] ?? [...active][0]!
      : t("localizationActivityTail.filters", { count: active.size, value: new Intl.NumberFormat(i18n.resolvedLanguage).format(active.size) });

  if (events.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">{t("localizationActivityTail.noActivity")}</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {t("localizationActivityTail.eventCount", { visible: filtered.length, count: events.length })}
        </p>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 gap-1.5">
              <ListFilter className="h-3.5 w-3.5" />
              {filterLabel}
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>{t("localizationActivityTail.activityFilter")}</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => setActive(new Set())}>
              {t("localizationActivityTail.allActivity")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {presentKinds.map((kind) => (
              <DropdownMenuCheckboxItem
                key={kind}
                checked={active.has(kind)}
                onCheckedChange={() => toggle(kind)}
              >
                {EVENT_LABEL[kind] ?? kind}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {filtered.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{t("localizationActivityTail.noMatchingEvents")}</p>
      ) : (
        <div className="divide-y divide-border">
          {filtered.map((event) => (
            <CaseEventRow key={event.id} event={event} />
          ))}
        </div>
      )}
    </div>
  );
}
