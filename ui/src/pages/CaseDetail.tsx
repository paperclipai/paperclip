import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Plus } from "lucide-react";
import { Link, Navigate, useParams } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { usePanel } from "@/context/PanelContext";
import { queryKeys } from "@/lib/queryKeys";
import {
  casesApi,
  CASE_STATUSES,
  type CaseDetail as CaseDetailData,
  type CaseEvent,
  type CaseStatus,
  type CaseSummary,
} from "@/api/cases";
import { issuesApi } from "@/api/issues";
import type { IssueLabel } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { StatusBadge } from "@/components/StatusBadge";
import { MarkdownBody } from "@/components/MarkdownBody";
import { PageSkeleton } from "@/components/PageSkeleton";
import { CaseFieldsPanel } from "@/components/CaseFieldsPanel";
import { EntityRow } from "@/components/EntityRow";
import { relativeTime } from "@/lib/utils";

const STATUS_LABEL: Record<CaseStatus, string> = {
  draft: "Draft",
  in_progress: "In progress",
  in_review: "In review",
  approved: "Approved",
  done: "Done",
  cancelled: "Cancelled",
};

const EVENT_LABEL: Record<string, string> = {
  created: "created",
  updated: "updated",
  fields_changed: "fields changed",
  status_changed: "status changed",
  issue_linked: "issue linked",
  issue_unlinked: "issue unlinked",
  document_revised: "document revised",
  child_linked: "child linked",
  attachment_added: "attachment added",
  label_added: "label added",
  label_removed: "label removed",
};

const ROLE_LABEL: Record<string, string> = { origin: "origin", work: "work", reference: "reference" };

/** Status dropdown — the primary human write in v1 (§3). */
function CaseStatusPicker({
  status,
  onChange,
  disabled,
}: {
  status: CaseStatus;
  onChange: (next: CaseStatus) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="inline-flex items-center gap-1 rounded-md hover:bg-accent/50 disabled:opacity-50"
          aria-label="Change case status"
        >
          <StatusBadge status={status} />
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-44 p-1">
        {CASE_STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              setOpen(false);
              if (s !== status) onChange(s);
            }}
            className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left hover:bg-accent"
          >
            <StatusBadge status={s} />
            {s === status && <Check className="h-4 w-4 text-muted-foreground" />}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/** Label editor — the second human write in v1 (§3). Reuses company labels. */
function CaseLabelsPicker({
  companyId,
  selected,
  onChange,
}: {
  companyId: string;
  selected: IssueLabel[];
  onChange: (labelIds: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [newColor, setNewColor] = useState("#6366f1");
  const queryClient = useQueryClient();
  const labelsQuery = useQuery({
    queryKey: queryKeys.issues.labels(companyId),
    queryFn: () => issuesApi.listLabels(companyId),
    enabled: open,
  });
  const selectedIds = new Set(selected.map((l) => l.id));
  const createLabel = useMutation({
    mutationFn: (data: { name: string; color: string }) => issuesApi.createLabel(companyId, data),
    onSuccess: (label) => {
      queryClient.setQueryData<IssueLabel[]>(queryKeys.issues.labels(companyId), (prev) =>
        prev ? [...prev, label] : [label],
      );
      onChange([...selectedIds, label.id]);
      setSearch("");
    },
  });

  const all = labelsQuery.data ?? [];
  const filtered = search.trim()
    ? all.filter((l) => l.name.toLowerCase().includes(search.trim().toLowerCase()))
    : all;

  function toggle(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange([...next]);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-xs text-muted-foreground">
          <Plus className="h-3.5 w-3.5" /> Labels
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search labels…"
          className="mb-2 h-7 text-xs"
        />
        <div className="max-h-52 space-y-0.5 overflow-y-auto">
          {filtered.map((l) => (
            <button
              key={l.id}
              type="button"
              onClick={() => toggle(l.id)}
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent"
            >
              <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: l.color }} />
              <span className="flex-1 truncate">{l.name}</span>
              {selectedIds.has(l.id) && <Check className="h-4 w-4 text-muted-foreground" />}
            </button>
          ))}
          {filtered.length === 0 && !search.trim() && (
            <p className="px-2 py-1 text-xs text-muted-foreground">No labels yet.</p>
          )}
        </div>
        {search.trim() && !all.some((l) => l.name.toLowerCase() === search.trim().toLowerCase()) && (
          <div className="mt-2 flex items-center gap-2 border-t border-border pt-2">
            <input
              type="color"
              value={newColor}
              onChange={(e) => setNewColor(e.target.value)}
              className="h-6 w-6 shrink-0 cursor-pointer rounded border border-border bg-transparent"
              aria-label="New label color"
            />
            <Button
              size="sm"
              variant="secondary"
              className="h-7 flex-1 text-xs"
              disabled={createLabel.isPending}
              onClick={() => createLabel.mutate({ name: search.trim(), color: newColor })}
            >
              Create “{search.trim()}”
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function CaseEventRow({ event }: { event: CaseEvent }) {
  const detail =
    event.kind === "status_changed" && event.payload
      ? `${(event.payload.previousStatus as string) ?? "?"} → ${(event.payload.status as string) ?? "?"}`
      : "";
  const actor =
    event.actorType === "system"
      ? "system"
      : event.actorType === "agent"
        ? "agent"
        : "user";
  return (
    <div className="flex items-start gap-2 py-1.5 text-xs">
      <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/60" />
      <div className="min-w-0 flex-1">
        <span className="font-medium">{EVENT_LABEL[event.kind] ?? event.kind}</span>
        {detail && <span className="text-muted-foreground"> · {detail}</span>}
        <div className="text-muted-foreground">
          {actor} · {relativeTime(event.createdAt)}
        </div>
      </div>
    </div>
  );
}

/** Right-rail content pushed into the shared PropertiesPanel (§3). */
function CaseSidePanel({
  caseData,
  childCases,
  events,
}: {
  caseData: CaseDetailData;
  childCases: CaseSummary[];
  events: CaseEvent[];
}) {
  return (
    <div className="space-y-6 p-4">
      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Linked issues
        </h3>
        {caseData.issueLinks.length === 0 ? (
          <p className="text-xs text-muted-foreground">None yet</p>
        ) : (
          <div className="space-y-1">
            {caseData.issueLinks.map((link) => (
              <EntityRow
                key={link.id}
                to={`/issues/${link.issue.identifier}`}
                identifier={link.issue.identifier}
                title={link.issue.title}
                trailing={<Badge variant="secondary">{ROLE_LABEL[link.role] ?? link.role}</Badge>}
              />
            ))}
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">
          auto-linked: any agent write from a run links its issue
        </p>
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Children</h3>
        {childCases.length === 0 ? (
          <p className="text-xs text-muted-foreground">None yet</p>
        ) : (
          <div className="space-y-1">
            {childCases.map((child) => (
              <EntityRow
                key={child.id}
                to={`/cases/${child.identifier}`}
                identifier={child.identifier}
                title={child.title}
                trailing={<StatusBadge status={child.status} />}
              />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Activity</h3>
        {events.length === 0 ? (
          <p className="text-xs text-muted-foreground">No activity yet</p>
        ) : (
          <div className="divide-y divide-border">
            {events.slice(0, 3).map((event) => (
              <CaseEventRow key={event.id} event={event} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export function CaseDetail() {
  const { caseIdentifier } = useParams<{ caseIdentifier: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { openPanel, closePanel } = usePanel();
  const queryClient = useQueryClient();

  const caseQuery = useQuery({
    queryKey: queryKeys.cases.detail(caseIdentifier ?? ""),
    queryFn: () => casesApi.get(caseIdentifier!),
    enabled: !!caseIdentifier,
  });
  const caseData = caseQuery.data;

  const eventsQuery = useQuery({
    queryKey: queryKeys.cases.events(caseIdentifier ?? ""),
    queryFn: () => casesApi.listEvents(caseIdentifier!, 20),
    enabled: !!caseIdentifier,
  });

  // Children are derived client-side: the list endpoint returns every case row
  // (no status filter → all statuses), filtered by parentCaseId. P4 owns the
  // richer children tree.
  const childrenQuery = useQuery({
    queryKey: queryKeys.cases.children(caseData?.id ?? ""),
    queryFn: () => casesApi.list(selectedCompanyId!, { limit: 200 }),
    enabled: !!selectedCompanyId && !!caseData?.id,
  });
  const children = useMemo(
    () => (childrenQuery.data ?? []).filter((c) => c.parentCaseId === caseData?.id),
    [childrenQuery.data, caseData?.id],
  );

  const patchMutation = useMutation({
    mutationFn: (input: { status?: CaseStatus; labelIds?: string[] }) =>
      casesApi.patch(caseIdentifier!, input),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.cases.detail(caseIdentifier ?? ""), updated);
      queryClient.invalidateQueries({ queryKey: queryKeys.cases.events(caseIdentifier ?? "") });
    },
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Cases", href: "/cases" },
      { label: caseData ? `${caseData.identifier} — ${caseData.title}` : (caseIdentifier ?? "Case") },
    ]);
  }, [setBreadcrumbs, caseData, caseIdentifier]);

  const events = useMemo(() => eventsQuery.data ?? [], [eventsQuery.data]);
  useEffect(() => {
    if (!caseData) return;
    openPanel(<CaseSidePanel caseData={caseData} childCases={children} events={events} />);
    return () => closePanel();
  }, [caseData, children, events, openPanel, closePanel]);

  if (!caseIdentifier) return <Navigate to="/cases" replace />;
  if (caseQuery.isLoading) return <PageSkeleton variant="detail" />;
  if (caseQuery.isError || !caseData) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <p className="text-sm text-muted-foreground">Case not found.</p>
        <Link to="/cases" className="mt-2 inline-block text-sm text-primary hover:underline">
          ← Back to cases
        </Link>
      </div>
    );
  }

  const bodyDoc = caseData.documents.find((d) => d.key === "body");

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground">{caseData.identifier}</span>
            <Badge variant="secondary">{caseData.caseType}</Badge>
          </div>
          <CaseStatusPicker
            status={caseData.status}
            disabled={patchMutation.isPending}
            onChange={(status) => patchMutation.mutate({ status })}
          />
        </div>

        <h1 className="text-xl font-bold">{caseData.title}</h1>

        <div className="flex flex-wrap items-center gap-1.5">
          {caseData.labels.map((label) => (
            <Badge
              key={label.id}
              variant="secondary"
              style={{ borderColor: label.color, color: label.color }}
              className="border bg-transparent"
            >
              {label.name}
            </Badge>
          ))}
          {selectedCompanyId && (
            <CaseLabelsPicker
              companyId={selectedCompanyId}
              selected={caseData.labels}
              onChange={(labelIds) => patchMutation.mutate({ labelIds })}
            />
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          {caseData.parentCaseId ? (
            <Link
              to={`/cases/${caseData.parentCaseId}`}
              className="hover:underline"
            >
              ↑ parent case
            </Link>
          ) : (
            <span />
          )}
          {caseData.key && <span className="font-mono">key: {caseData.key}</span>}
        </div>
      </header>

      <CaseFieldsPanel fields={caseData.fields} />

      <section className="space-y-2">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">Body</h2>
          {bodyDoc && (
            <span className="text-xs text-muted-foreground">
              document · rev {bodyDoc.document.latestRevisionNumber ?? 1}
            </span>
          )}
        </div>
        <Card className="px-4 py-3">
          {bodyDoc?.document.latestBody ? (
            <MarkdownBody linkIssueReferences>{bodyDoc.document.latestBody}</MarkdownBody>
          ) : (
            <p className="text-sm text-muted-foreground">No body document yet</p>
          )}
        </Card>
      </section>
    </div>
  );
}
