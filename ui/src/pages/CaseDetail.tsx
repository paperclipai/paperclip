import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Copy, MoreVertical, Plus, SlidersHorizontal } from "lucide-react";
import { Link, Navigate, useCaseHref, useParams } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { usePanel } from "@/context/PanelContext";
import { queryKeys } from "@/lib/queryKeys";
import {
  casesApi,
  CASE_STATUSES,
  type CaseDetail as CaseDetailData,
  type CaseStatus,
  type CaseSummary,
} from "@/api/cases";
import { issuesApi } from "@/api/issues";
import { PROJECT_COLORS, type IssueLabel } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatusBadge } from "@/components/StatusBadge";
import { StatusIcon } from "@/components/StatusIcon";
import { MarkdownBody } from "@/components/MarkdownBody";
import { PageSkeleton } from "@/components/PageSkeleton";
import { CaseFieldValue } from "@/components/CaseFieldsPanel";
import { CaseActivityFeed } from "@/components/CaseActivityFeed";
import { CaseChildrenTree } from "@/components/CaseChildrenTree";
import { CaseAttachmentsGallery } from "@/components/CaseAttachmentsGallery";
import { EntityRow } from "@/components/EntityRow";
import { PropertyChip, PropertyRow, PropertySection } from "@/components/issue-properties";

const STATUS_LABEL: Record<CaseStatus, string> = {
  draft: "Draft",
  in_progress: "In progress",
  in_review: "In review",
  approved: "Approved",
  done: "Done",
  cancelled: "Cancelled",
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
  const [newColor, setNewColor] = useState<string>(PROJECT_COLORS[0]);
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

/** Right-rail content pushed into the shared PropertiesPanel (§3). */
function CaseSidePanel({
  caseData,
  childCases,
  companyId,
  labelsPending,
  onLabelIdsChange,
}: {
  caseData: CaseDetailData;
  childCases: CaseSummary[];
  companyId: string | null | undefined;
  labelsPending?: boolean;
  onLabelIdsChange: (labelIds: string[]) => void;
}) {
  const reservedFieldKeys = new Set(["name", "Name", "title", "Title", "body", "Body", "description", "Description"]);
  const genericFields = Object.entries(caseData.fields).filter(([key]) => !reservedFieldKeys.has(key));

  return (
    <div className="space-y-4 p-4">
      <PropertySection title="Case" first>
        <PropertyRow label="Type">
          <PropertyChip>{caseData.caseType}</PropertyChip>
        </PropertyRow>
        {caseData.key ? (
          <PropertyRow label="Key">
            <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={caseData.key}>
              {caseData.key}
            </span>
          </PropertyRow>
        ) : null}
        <PropertyRow label="Labels" wrap>
          {caseData.labels.length > 0 ? (
            caseData.labels.map((label) => (
              <PropertyChip
                key={label.id}
                style={{ borderColor: label.color, color: label.color }}
                className="bg-transparent"
              >
                {label.name}
              </PropertyChip>
            ))
          ) : (
            <span className="text-xs text-muted-foreground">None</span>
          )}
          {companyId ? (
            <CaseLabelsPicker
              companyId={companyId}
              selected={caseData.labels}
              onChange={onLabelIdsChange}
            />
          ) : null}
          {labelsPending ? <span className="text-xs text-muted-foreground">Saving...</span> : null}
        </PropertyRow>
      </PropertySection>

      {genericFields.length > 0 ? (
        <PropertySection title="Fields">
          {genericFields.map(([key, value]) => (
            <PropertyRow key={key} label={key} wrap={Array.isArray(value)}>
              <span className="min-w-0 truncate text-sm">
                <CaseFieldValue value={value} />
              </span>
            </PropertyRow>
          ))}
        </PropertySection>
      ) : null}

      <PropertySection title="Linked tasks">
        {caseData.issueLinks.length === 0 ? (
          <PropertyRow label="Tasks">
            <span className="text-xs text-muted-foreground">None yet</span>
          </PropertyRow>
        ) : (
          <div className="space-y-1">
            {caseData.issueLinks.map((link) => (
              <EntityRow
                key={link.id}
                to={`/issues/${link.issue.identifier}`}
                leading={<StatusIcon status={link.issue.status} />}
                identifier={link.issue.identifier}
                title={link.issue.title}
                trailing={<Badge variant="secondary">{ROLE_LABEL[link.role] ?? link.role}</Badge>}
              />
            ))}
          </div>
        )}
      </PropertySection>

      <PropertySection title={`Children${childCases.length > 0 ? ` ${childCases.length}` : ""}`}>
        <CaseChildrenTree children={childCases} />
      </PropertySection>

      {caseData.documents.length > 0 ? (
        <PropertySection title="Documents">
          <div className="space-y-1">
            {caseData.documents.map((documentRef) => (
              <PropertyRow key={documentRef.key} label={documentRef.key}>
                <span className="text-xs text-muted-foreground">
                  rev {documentRef.document.latestRevisionNumber ?? 1}
                </span>
              </PropertyRow>
            ))}
          </div>
        </PropertySection>
      ) : null}

      {caseData.attachments.length > 0 ? (
        <PropertySection title="Attachments">
          <PropertyRow label="Files">
            <span className="text-xs text-muted-foreground">
              {caseData.attachments.length} {caseData.attachments.length === 1 ? "file" : "files"}
            </span>
          </PropertyRow>
        </PropertySection>
      ) : null}
    </div>
  );
}

export function CaseDetail() {
  const { caseIdentifier } = useParams<{ caseIdentifier: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { openPanel, closePanel } = usePanel();
  const queryClient = useQueryClient();
  const caseHref = useCaseHref();
  const [copied, setCopied] = useState(false);

  const caseQuery = useQuery({
    queryKey: queryKeys.cases.detail(caseIdentifier ?? ""),
    queryFn: () => casesApi.get(caseIdentifier!),
    enabled: !!caseIdentifier,
  });
  const caseData = caseQuery.data;

  const eventsQuery = useQuery({
    queryKey: queryKeys.cases.events(caseIdentifier ?? ""),
    queryFn: () => casesApi.listEvents(caseIdentifier!, 100),
    enabled: !!caseIdentifier,
  });

  // Children come from the server-side parent filter (P4). All statuses, so the
  // tree shows completed/cancelled children too — it's a structural view, not a
  // work queue.
  const childrenQuery = useQuery({
    queryKey: queryKeys.cases.children(caseData?.id ?? ""),
    queryFn: () => casesApi.listChildren(selectedCompanyId!, caseData!.id),
    enabled: !!selectedCompanyId && !!caseData?.id,
  });
  const children = useMemo(() => childrenQuery.data ?? [], [childrenQuery.data]);

  const patchMutation = useMutation({
    mutationFn: (input: { status?: CaseStatus; labelIds?: string[] }) =>
      casesApi.patch(caseIdentifier!, input),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.cases.detail(caseIdentifier ?? ""), updated);
      queryClient.invalidateQueries({ queryKey: queryKeys.cases.events(caseIdentifier ?? "") });
    },
  });

  const handleLabelIdsChange = useCallback((labelIds: string[]) => {
    patchMutation.mutate({ labelIds });
  }, [patchMutation.mutate]);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Cases", href: caseHref() },
      { label: caseData ? `${caseData.identifier} — ${caseData.title}` : (caseIdentifier ?? "Case") },
    ]);
  }, [setBreadcrumbs, caseData, caseIdentifier, caseHref]);

  const events = useMemo(() => eventsQuery.data ?? [], [eventsQuery.data]);
  const panelContent = useMemo(() => {
    if (!caseData) return null;
    return (
      <CaseSidePanel
        caseData={caseData}
        childCases={children}
        companyId={selectedCompanyId}
        labelsPending={patchMutation.isPending}
        onLabelIdsChange={handleLabelIdsChange}
      />
    );
  }, [caseData, children, selectedCompanyId, patchMutation.isPending, handleLabelIdsChange]);

  useEffect(() => {
    if (!panelContent) return;
    openPanel(panelContent);
    return () => closePanel();
  }, [panelContent, openPanel, closePanel]);

  if (!caseIdentifier) return <Navigate to={caseHref()} replace />;
  if (caseQuery.isLoading) return <PageSkeleton variant="detail" />;
  if (caseQuery.isError || !caseData) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <p className="text-sm text-muted-foreground">Case not found.</p>
        <Link to={caseHref()} className="mt-2 inline-block text-sm text-primary hover:underline">
          ← Back to cases
        </Link>
      </div>
    );
  }

  const bodyDoc = caseData.documents.find((d) => d.key === "body");
  const description = caseData.fields.description ?? caseData.fields.Description ?? null;

  function copyCaseToClipboard(currentCase: CaseDetailData) {
    const markdown = [
      `# ${currentCase.identifier} ${currentCase.title}`,
      "",
      `- Key: ${currentCase.key ?? "none"}`,
      `- Type: ${currentCase.caseType}`,
      `- Status: ${STATUS_LABEL[currentCase.status]}`,
      currentCase.labels.length > 0 ? `- Labels: ${currentCase.labels.map((label) => label.name).join(", ")}` : "- Labels: none",
    ].join("\n");
    void navigator.clipboard?.writeText(markdown).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            {caseData.key ? (
              <div className="truncate font-mono text-xs text-muted-foreground" title={caseData.key}>
                {caseData.key}
              </div>
            ) : null}
            <h1 className="text-xl font-bold">{caseData.title}</h1>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <CaseStatusPicker
              status={caseData.status}
              disabled={patchMutation.isPending}
              onChange={(status) => patchMutation.mutate({ status })}
            />
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label="More case actions" title="More case actions">
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-48 p-1">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent/50"
                  onClick={() => copyCaseToClipboard(caseData)}
                >
                  {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  Copy as markdown
                </button>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent/50"
                  onClick={() => {
                    if (panelContent) openPanel(panelContent);
                  }}
                >
                  <SlidersHorizontal className="h-3 w-3" />
                  Properties
                </button>
              </PopoverContent>
            </Popover>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">{caseData.identifier}</span>
          <Badge variant="secondary">{caseData.caseType}</Badge>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          {caseData.parent ? (
            <Link to={caseHref(caseData.parent.identifier)} className="hover:underline">
              ↑ {caseData.parent.identifier} — {caseData.parent.title}
            </Link>
          ) : (
            <span />
          )}
        </div>
      </header>

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList variant="line" className="w-full justify-start gap-1">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="activity">
            Activity{events.length > 0 && <span className="ml-1 text-muted-foreground">{events.length}</span>}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
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
                <MarkdownBody linkIssueReferences linkCaseReferences>
                  {bodyDoc.document.latestBody}
                </MarkdownBody>
              ) : (
                <p className="text-sm text-muted-foreground">No body document yet</p>
              )}
            </Card>
          </section>

          {description ? (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold">Description</h2>
              <Card className="px-4 py-3">
                <CaseFieldValue value={description} />
              </Card>
            </section>
          ) : null}

          {children.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold">Children ({children.length})</h2>
              <CaseChildrenTree children={children} />
            </section>
          )}

          {caseData.attachments.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold">Attachments ({caseData.attachments.length})</h2>
              <CaseAttachmentsGallery attachments={caseData.attachments} />
            </section>
          )}
        </TabsContent>

        <TabsContent value="activity">
          <CaseActivityFeed events={events} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
