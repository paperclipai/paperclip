import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
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
  caseDocumentToIssueDocument,
  caseRevisionToDocumentRevision,
  type CaseDocument,
  type CaseDetail as CaseDetailData,
  type CaseParentRef,
  type CaseStatus,
  type CaseSummary,
} from "@/api/cases";
import { issuesApi } from "@/api/issues";
import type { IssueDocument } from "@paperclipai/shared";
import { PROJECT_COLORS, type IssueLabel } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatusBadge } from "@/components/StatusBadge";
import { PageSkeleton } from "@/components/PageSkeleton";
import { CaseFieldValue } from "@/components/CaseFieldsPanel";
import { CaseActivityFeed } from "@/components/CaseActivityFeed";
import { CaseChildrenTree } from "@/components/CaseChildrenTree";
import { CaseAttachmentsGallery } from "@/components/CaseAttachmentsGallery";
import { IssueReferencePill } from "@/components/IssueReferencePill";
import { PropertyChip, PropertyRow, PropertySection } from "@/components/issue-properties";
import { IssueDocumentsSection } from "@/components/IssueDocumentsSection";
import { CaseCopyableToken, CaseIdentifierKey } from "@/components/CaseIdentifierKey";
import { copyTextToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<CaseStatus, string> = {
  draft: "Draft",
  in_progress: "In progress",
  in_review: "In review",
  approved: "Approved",
  done: "Done",
  cancelled: "Cancelled",
};

const PRIMARY_FIELD_KEYS = ["name", "title", "body", "description"] as const;
const ISSUE_REFERENCE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"] as const;

type CasePropertyDisplayMode = "compact" | "full";
type IssueReferenceStatus = (typeof ISSUE_REFERENCE_STATUSES)[number];

function issueReferenceStatus(status: string): IssueReferenceStatus | undefined {
  return ISSUE_REFERENCE_STATUSES.includes(status as IssueReferenceStatus)
    ? status as IssueReferenceStatus
    : undefined;
}

function fieldValueByName(fields: Record<string, unknown>, name: string): unknown {
  return fields[name] ?? fields[name.charAt(0).toUpperCase() + name.slice(1)];
}

function caseFieldKeyVariants(key: string): string[] {
  if (!key) return [key];
  return [key, key.charAt(0).toUpperCase() + key.slice(1), key.charAt(0).toLowerCase() + key.slice(1)];
}

function hasFieldValue(value: unknown): boolean {
  return value !== null && value !== undefined && !(typeof value === "string" && value.trim() === "");
}

function casePropertyRows(caseData: CaseDetailData) {
  const reservedKeys = new Set(PRIMARY_FIELD_KEYS.flatMap((key) => caseFieldKeyVariants(key)));
  const documentKeys = new Set(caseData.documents.flatMap((documentRef) => caseFieldKeyVariants(documentRef.key)));
  const primary = PRIMARY_FIELD_KEYS.map((key) => {
    if (caseFieldKeyVariants(key).some((variant) => documentKeys.has(variant))) return null;
    let value: unknown;
    if (key === "title") value = fieldValueByName(caseData.fields, key) ?? caseData.title;
    else if (key === "body") value = fieldValueByName(caseData.fields, key);
    else value = fieldValueByName(caseData.fields, key);
    return { key, label: key, value };
  }).filter((row): row is { key: typeof PRIMARY_FIELD_KEYS[number]; label: typeof PRIMARY_FIELD_KEYS[number]; value: unknown } =>
    row !== null && hasFieldValue(row.value)
  );

  const generic = Object.entries(caseData.fields)
    .filter(([key]) => !reservedKeys.has(key) && !documentKeys.has(key))
    .map(([key, value]) => ({ key, label: key, value }));

  return [...primary, ...generic];
}

function issueDocumentToCaseDocument(document: IssueDocument): CaseDocument {
  return {
    id: document.id,
    companyId: document.companyId,
    title: document.title,
    format: document.format,
    latestBody: document.body,
    latestRevisionId: document.latestRevisionId,
    latestRevisionNumber: document.latestRevisionNumber,
    createdByAgentId: document.createdByAgentId,
    createdByUserId: document.createdByUserId,
    updatedByAgentId: document.updatedByAgentId,
    updatedByUserId: document.updatedByUserId,
    lockedAt: document.lockedAt ? new Date(document.lockedAt).toISOString() : null,
    lockedByAgentId: document.lockedByAgentId,
    lockedByUserId: document.lockedByUserId,
    sourceTrust: document.sourceTrust,
    createdAt: new Date(document.createdAt).toISOString(),
    updatedAt: new Date(document.updatedAt).toISOString(),
  };
}

function CaseRelationshipsSection({
  parent,
  children,
}: {
  parent: CaseParentRef | null;
  children: CaseSummary[];
}) {
  if (!parent && children.length === 0) return null;

  return (
    <section className="space-y-3" aria-label="Case relationships">
      {parent ? (
        <div className="space-y-1">
          <h2 className="text-xs font-medium text-muted-foreground">Parent</h2>
          <CaseChildrenTree children={[parent]} />
        </div>
      ) : null}
      {children.length > 0 ? (
        <div className="space-y-1">
          <h2 className="text-xs font-medium text-muted-foreground">Children {children.length}</h2>
          <CaseChildrenTree children={children} maxVisible={5} />
        </div>
      ) : null}
    </section>
  );
}

function CasePropertyRow({
  label,
  children,
  wrap,
  mode,
}: {
  label: string;
  children: ReactNode;
  wrap?: boolean;
  mode: CasePropertyDisplayMode;
}) {
  if (mode === "compact") {
    return (
      <PropertyRow label={label} wrap={wrap}>
        {children}
      </PropertyRow>
    );
  }

  return (
    <div
      className={cn(
        "flex w-full min-w-0 gap-3 py-1",
        wrap ? "items-start" : "items-center",
      )}
      data-property-row="true"
    >
      <span
        className={cn(
          "w-40 shrink-0 break-words text-xs text-muted-foreground",
          wrap && "mt-0.5",
        )}
        data-property-label={label}
      >
        {label}
      </span>
      <div className={cn("flex min-w-0 flex-1 items-center gap-1.5", wrap && "flex-wrap")}>{children}</div>
    </div>
  );
}

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
function CasePropertiesContent({
  caseData,
  childCases,
  companyId,
  labelsPending,
  onLabelIdsChange,
  mode,
}: {
  caseData: CaseDetailData;
  childCases: CaseSummary[];
  companyId: string | null | undefined;
  labelsPending?: boolean;
  onLabelIdsChange: (labelIds: string[]) => void;
  mode: CasePropertyDisplayMode;
}) {
  const propertyRows = casePropertyRows(caseData);
  const isFull = mode === "full";

  return (
    <div className={cn("space-y-4", isFull && "space-y-6")}>
      <PropertySection title="Case" first>
        <CasePropertyRow label="Type" mode={mode}>
          <PropertyChip>{caseData.caseType}</PropertyChip>
        </CasePropertyRow>
        {caseData.key ? (
          <CasePropertyRow label="Key" mode={mode}>
            <CaseCopyableToken
              value={caseData.key}
              label="case key"
              className="font-mono text-xs text-muted-foreground"
              truncate={!isFull}
            />
          </CasePropertyRow>
        ) : null}
        <CasePropertyRow label="Labels" wrap mode={mode}>
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
        </CasePropertyRow>
      </PropertySection>

      {propertyRows.length > 0 ? (
        <PropertySection title="Fields">
          {propertyRows.map(({ key, label, value }) => (
            <CasePropertyRow
              key={key}
              label={label}
              wrap={isFull || Array.isArray(value) || (typeof value === "object" && value !== null)}
              mode={mode}
            >
              <span className={cn("min-w-0 text-sm", !isFull && "truncate")}>
                <CaseFieldValue value={value} fieldKey={key} variant={mode} />
              </span>
            </CasePropertyRow>
          ))}
        </PropertySection>
      ) : null}

      <PropertySection title="Linked tasks">
        {caseData.issueLinks.length === 0 ? (
          <CasePropertyRow label="Tasks" mode={mode}>
            <span className="text-xs text-muted-foreground">None yet</span>
          </CasePropertyRow>
        ) : (
          <CasePropertyRow label="Tasks" wrap mode={mode}>
            <div className="flex flex-wrap items-center gap-1.5">
              {caseData.issueLinks.map((link) => (
                <IssueReferencePill
                  key={link.id}
                  issue={{
                    id: link.issue.id,
                    identifier: link.issue.identifier,
                    title: link.issue.title,
                    status: issueReferenceStatus(link.issue.status),
                  }}
                />
              ))}
            </div>
          </CasePropertyRow>
        )}
      </PropertySection>

      <PropertySection title={`Children${childCases.length > 0 ? ` ${childCases.length}` : ""}`}>
        <CaseChildrenTree children={childCases} />
      </PropertySection>

      {caseData.attachments.length > 0 ? (
        <PropertySection title="Attachments">
          <CasePropertyRow label="Files" mode={mode}>
            <span className="text-xs text-muted-foreground">
              {caseData.attachments.length} {caseData.attachments.length === 1 ? "file" : "files"}
            </span>
          </CasePropertyRow>
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
  const caseDetailQueryKey = queryKeys.cases.detail(caseIdentifier ?? "");

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
  const caseDocumentSubject = useMemo(() => {
    if (!caseData || !caseIdentifier) return null;
    return {
      id: caseData.id,
      detailQueryKey: caseDetailQueryKey,
      documentsQueryKey: queryKeys.cases.documents(caseData.id),
      idleDocumentRevisionsQueryKey: ["cases", "revisions", caseData.id, "__idle__"] as const,
      documentRevisionsQueryKey: (key: string) => queryKeys.cases.revisions(caseData.id, key),
      listDocuments: async () => {
        const cached = queryClient.getQueryData<CaseDetailData>(caseDetailQueryKey);
        const detail = cached ?? await casesApi.get(caseIdentifier);
        return detail.documents.map((documentRef) =>
          caseDocumentToIssueDocument(detail.id, documentRef.key, documentRef.document)
        );
      },
      listDocumentRevisions: async (key: string) => {
        const revisions = await casesApi.listRevisions(caseIdentifier, key);
        return revisions.revisions.map((revision) => caseRevisionToDocumentRevision(caseData.id, key, revision));
      },
      getDocument: async (key: string) => {
        const document = await casesApi.getDocument(caseIdentifier, key);
        return caseDocumentToIssueDocument(caseData.id, document.key, document);
      },
      upsertDocument: async (key: string, data: { title: string | null; format: "markdown"; body: string; baseRevisionId: string | null }) => {
        const result = await casesApi.upsertDocument(caseIdentifier, key, data);
        return caseDocumentToIssueDocument(caseData.id, result.document.key, result.document);
      },
      deleteDocument: (key: string) => casesApi.deleteDocument(caseIdentifier, key),
      restoreDocumentRevision: async (key: string, revisionId: string) => {
        const result = await casesApi.restoreDocumentRevision(caseIdentifier, key, revisionId);
        return caseDocumentToIssueDocument(caseData.id, result.document.key, result.document);
      },
      setDocumentLock: async (key: string, locked: boolean) => {
        const document = locked
          ? await casesApi.lockDocument(caseIdentifier, key)
          : await casesApi.unlockDocument(caseIdentifier, key);
        return caseDocumentToIssueDocument(caseData.id, document.key, document);
      },
      syncDetailCache: (cache: typeof queryClient, document: IssueDocument) => {
        cache.setQueryData<CaseDetailData | undefined>(caseDetailQueryKey, (current) => {
          if (!current) return current;
          const nextDocumentRef = {
            key: document.key,
            document: issueDocumentToCaseDocument(document),
          };
          const existingIndex = current.documents.findIndex((entry) => entry.key === document.key);
          const documents = existingIndex === -1
            ? [...current.documents, nextDocumentRef]
            : current.documents.map((entry, index) => index === existingIndex ? nextDocumentRef : entry);
          return {
            ...current,
            documents,
            updatedAt: new Date(document.updatedAt).toISOString(),
          };
        });
      },
      hideSystemDocuments: false,
      legacyPlanDocument: null,
      annotations: {
        issueId: caseData.id,
        target: (documentKey: string) => ({ kind: "case" as const, caseId: caseData.id, documentKey }),
      },
    };
  }, [caseData, caseDetailQueryKey, caseIdentifier, queryClient]);
  const panelContent = useMemo(() => {
    if (!caseData) return null;
    return (
      <CasePropertiesContent
        caseData={caseData}
        childCases={children}
        companyId={selectedCompanyId}
        labelsPending={patchMutation.isPending}
        onLabelIdsChange={handleLabelIdsChange}
        mode="compact"
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
    void copyTextToClipboard(markdown).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <CaseIdentifierKey identifier={caseData.identifier} caseKey={caseData.key} />
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
          <Badge variant="secondary">{caseData.caseType}</Badge>
        </div>

        <CaseRelationshipsSection parent={caseData.parent} children={children} />
      </header>

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList variant="line" className="w-full justify-start gap-1">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="properties">Properties</TabsTrigger>
          <TabsTrigger value="activity">
            Activity{events.length > 0 && <span className="ml-1 text-muted-foreground">{events.length}</span>}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          {caseDocumentSubject ? (
            <IssueDocumentsSection
              subject={caseDocumentSubject}
              canDeleteDocuments
              canManageDocumentLocks
            />
          ) : null}

          {description ? (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold">Description</h2>
              <Card className="px-4 py-3">
                <CaseFieldValue value={description} />
              </Card>
            </section>
          ) : null}

          {caseData.attachments.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold">Attachments ({caseData.attachments.length})</h2>
              <CaseAttachmentsGallery attachments={caseData.attachments} />
            </section>
          )}
        </TabsContent>

        <TabsContent value="properties">
          <CasePropertiesContent
            caseData={caseData}
            childCases={children}
            companyId={selectedCompanyId}
            labelsPending={patchMutation.isPending}
            onLabelIdsChange={handleLabelIdsChange}
            mode="full"
          />
        </TabsContent>

        <TabsContent value="activity">
          <CaseActivityFeed events={events} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
