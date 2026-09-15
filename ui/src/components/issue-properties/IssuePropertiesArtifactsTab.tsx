import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AttachmentArtifactWorkProductMetadata,
  Issue,
  IssueDocument,
  IssueWorkProduct,
} from "@paperclipai/shared";
import {
  MARKDOWN_REVIEW_DOCUMENT_MAX_BYTES,
  artifactReviewDocumentKey,
  getMarkdownWorkProductAttachmentMetadata,
  isArtifactReviewDocumentKey,
} from "@paperclipai/shared";
import {
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  Paperclip,
} from "lucide-react";
import { ApiError } from "@/api/client";
import { issuesApi } from "@/api/issues";
import { activityApi } from "@/api/activity";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import { useIssueDocuments } from "@/hooks/useIssueDocuments";
import {
  documentDisplayTitle,
  selectAgentArtifactAttachments,
  workProductHref,
} from "@/lib/issue-artifacts";
import { attachmentOpenPath } from "@/lib/issue-attachments";
import { MarkdownBody } from "@/components/MarkdownBody";
import { RichWorkProductCard } from "@/components/task-chat/RichWorkProductCard";
import { DocumentAnnotationsCountChip, IssueDocumentAnnotations } from "@/components/IssueDocumentAnnotations";
import { cn, formatDateTime } from "@/lib/utils";
import { Link, useLocation } from "@/lib/router";

interface IssuePropertiesArtifactsTabProps {
  issue: Issue;
  onOpenDocument?: (document: IssueDocument) => void;
  documentDeepLink?: {
    requestId: number;
    documentKey: string;
  } | null;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Work-product status → label + `--status-task-*` base-hue var for `.status-chip`. */
function workProductStatusBadge(status: string): { label: string; cssVar: string } | null {
  switch (status) {
    case "active":
    case "draft":
      return { label: "In progress", cssVar: "--status-task-in_progress" };
    case "ready_for_review":
      return { label: "For review", cssVar: "--status-task-in_review" };
    case "approved":
    case "merged":
      return { label: "Done", cssVar: "--status-task-done" };
    case "changes_requested":
      return { label: "Changes requested", cssVar: "--status-task-todo" };
    case "failed":
      return { label: "Failed", cssVar: "--status-task-blocked" };
    default:
      return null;
  }
}

const ROW_CLASS =
  "flex items-center gap-2 rounded-md border border-border bg-card/50 px-2.5 py-1.5 text-sm";

/**
 * Work-product row for an eligible Markdown artifact (LOOA-1533 gap): expands
 * in place into the shipped document review surface backed by the
 * server-materialized `artifact-review-<workProductId>` issue document instead
 * of opening the raw attachment. Raw open and download stay as explicit
 * secondary actions.
 */
function MarkdownWorkProductRow({
  issueId,
  workProduct,
  metadata,
  reviewDoc,
  openRequestId,
}: {
  issueId: string;
  workProduct: IssueWorkProduct;
  metadata: AttachmentArtifactWorkProductMetadata;
  reviewDoc: IssueDocument | undefined;
  openRequestId?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [annotationPanelOpen, setAnnotationPanelOpen] = useState(false);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const location = useLocation();
  const queryClient = useQueryClient();
  const badge = workProductStatusBadge(workProduct.status);
  const Chevron = expanded ? ChevronDown : ChevronRight;
  const tooLarge = metadata.byteSize > MARKDOWN_REVIEW_DOCUMENT_MAX_BYTES;

  const ensure = useMutation({
    mutationFn: () => issuesApi.ensureWorkProductReviewDocument(issueId, workProduct.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.issues.documents(issueId) });
    },
  });

  const requestPreview = () => {
    if (reviewDoc || tooLarge) return;
    if (ensure.isPending || ensure.isSuccess || ensure.isError) return;
    ensure.mutate();
  };

  const handleToggle = () => {
    setExpanded((open) => {
      if (!open) requestPreview();
      return !open;
    });
  };

  useEffect(() => {
    if (openRequestId === undefined) return;
    setExpanded(true);
  }, [openRequestId]);
  useEffect(() => {
    if (openRequestId === undefined || !expanded) return;
    headerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [expanded, openRequestId]);
  // Deep links land before the user clicks, so the deep-link expansion has to
  // request materialization the same way a manual expand does.
  useEffect(() => {
    if (openRequestId === undefined) return;
    requestPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequestId, reviewDoc]);

  const unsupportedError =
    ensure.error instanceof ApiError && [413, 415, 422].includes(ensure.error.status);

  let expandedBody: React.ReactNode;
  if (tooLarge) {
    expandedBody = (
      <p className="text-sm text-muted-foreground">
        This Markdown file is too large to preview. Use Raw or Download instead.
      </p>
    );
  } else if (reviewDoc) {
    expandedBody = reviewDoc.body.trim().length > 0 ? (
      <IssueDocumentAnnotations
        issueId={issueId}
        doc={reviewDoc}
        bodyMarkdown={reviewDoc.body}
        draftDirty={false}
        draftConflicted={false}
        historicalPreview={false}
        locationHash={location.hash}
        panelOpen={annotationPanelOpen}
        onPanelOpenChange={setAnnotationPanelOpen}
        panelPlacement="popover"
      >
        <MarkdownBody>{reviewDoc.body}</MarkdownBody>
      </IssueDocumentAnnotations>
    ) : (
      <p className="text-sm text-muted-foreground">Document is empty.</p>
    );
  } else if (ensure.isError) {
    expandedBody = (
      <div className="flex flex-col items-start gap-1.5">
        <p className="text-sm text-muted-foreground">
          {unsupportedError
            ? "This file can't be previewed as Markdown. Use Raw or Download instead."
            : "Preview failed to load."}
        </p>
        {!unsupportedError ? (
          <button
            type="button"
            className="rounded-md border border-border px-2 py-0.5 text-(length:--text-micro) text-muted-foreground hover:bg-accent/50"
            onClick={() => {
              ensure.reset();
              ensure.mutate();
            }}
          >
            Retry
          </button>
        ) : null}
      </div>
    );
  } else {
    expandedBody = <p className="text-sm text-muted-foreground">Preparing preview…</p>;
  }

  return (
    <div className="rounded-md border border-border bg-card/50">
      <div ref={headerRef} className="flex items-center hover:bg-accent/50">
        <button
          type="button"
          onClick={handleToggle}
          className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left text-sm"
          aria-expanded={expanded}
        >
          <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{workProduct.title}</span>
          {badge ? (
            <span
              className="status-chip inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-(length:--text-nano) leading-none whitespace-nowrap"
              style={{ "--sc": `var(${badge.cssVar})` } as CSSProperties}
            >
              {badge.label}
            </span>
          ) : null}
          {reviewDoc ? (
            <span className="shrink-0 text-(length:--text-micro) text-muted-foreground">
              {`Rev ${reviewDoc.latestRevisionNumber ?? 1}`}
            </span>
          ) : null}
          <Chevron className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
        {reviewDoc ? (
          <DocumentAnnotationsCountChip
            issueId={issueId}
            docKey={reviewDoc.key}
            panelOpen={annotationPanelOpen}
            onToggle={() => setAnnotationPanelOpen((open) => !open)}
          />
        ) : null}
        <a
          href={metadata.openPath}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open raw ${workProduct.title}`}
          title="Open raw"
          className="shrink-0 px-1.5 py-1.5 text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="h-3 w-3" />
        </a>
        <a
          href={metadata.downloadPath}
          aria-label={`Download ${workProduct.title}`}
          title="Download"
          className="shrink-0 py-1.5 pr-2 pl-0.5 text-muted-foreground hover:text-foreground"
        >
          <Download className="h-3 w-3" />
        </a>
      </div>
      {expanded ? (
        <div className="border-t border-border px-2.5 py-2">{expandedBody}</div>
      ) : null}
    </div>
  );
}

function DocumentRow({
  issueId,
  doc,
  openRequestId,
  onOpen,
}: {
  issueId: string;
  doc: IssueDocument;
  openRequestId?: number;
  onOpen?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [annotationPanelOpen, setAnnotationPanelOpen] = useState(false);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const location = useLocation();
  const Chevron = expanded ? ChevronDown : ChevronRight;
  useEffect(() => {
    if (onOpen || openRequestId === undefined) return;
    setExpanded(true);
  }, [onOpen, openRequestId]);
  useEffect(() => {
    if (onOpen || openRequestId === undefined || !expanded) return;
    headerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [expanded, onOpen, openRequestId]);
  if (onOpen) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className={cn(ROW_CLASS, "w-full text-left hover:bg-accent/50")}
      >
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{documentDisplayTitle(doc)}</span>
        <span className="shrink-0 text-(length:--text-micro) text-muted-foreground">
          {`Rev ${doc.latestRevisionNumber ?? 1}`}
        </span>
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>
    );
  }
  return (
    <div className="rounded-md border border-border bg-card/50">
      <div ref={headerRef} className="flex items-center hover:bg-accent/50">
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left text-sm"
          aria-expanded={expanded}
        >
          <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{documentDisplayTitle(doc)}</span>
          <span className="shrink-0 text-(length:--text-micro) text-muted-foreground">
            {`Rev ${doc.latestRevisionNumber ?? 1}`}
          </span>
          <Chevron className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
        <DocumentAnnotationsCountChip
          issueId={issueId}
          docKey={doc.key}
          panelOpen={annotationPanelOpen}
          onToggle={() => setAnnotationPanelOpen((open) => !open)}
        />
      </div>
      {expanded ? (
        <div className="border-t border-border px-2.5 py-2">
          {doc.body.trim().length > 0 ? (
            <IssueDocumentAnnotations
              issueId={issueId}
              doc={doc}
              bodyMarkdown={doc.body}
              draftDirty={false}
              draftConflicted={false}
              historicalPreview={false}
              locationHash={location.hash}
              panelOpen={annotationPanelOpen}
              onPanelOpenChange={setAnnotationPanelOpen}
              panelPlacement="popover"
            >
              <MarkdownBody>{doc.body}</MarkdownBody>
            </IssueDocumentAnnotations>
          ) : (
            <p className="text-sm text-muted-foreground">Document is empty.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Artifacts tab of the properties pane (PAP-491).
 *
 * A read-only "what did this task produce" view composed from three sources:
 * work products, issue documents (also readable in the Plan tab — the
 * redundancy is intentional), and agent-created attachments. Attachments
 * already promoted to attachment-backed work products are deduped out, and
 * user uploads are excluded — those stay first-class in the conversation
 * thread.
 */
export function IssuePropertiesArtifactsTab({ issue, documentDeepLink, onOpenDocument }: IssuePropertiesArtifactsTabProps) {
  const [typeFilter, setTypeFilter] = useState("all");
  const [runFilter, setRunFilter] = useState("all");
  const { data: attachments } = useQuery({
    queryKey: queryKeys.issues.attachments(issue.id),
    queryFn: () => issuesApi.listAttachments(issue.id),
  });
  const { data: workProducts } = useQuery({
    queryKey: queryKeys.issues.workProducts(issue.id),
    queryFn: () => issuesApi.listWorkProducts(issue.id),
  });
  const { data: documents } = useIssueDocuments(issue.id);
  const { data: runs } = useQuery({
    queryKey: queryKeys.issues.runs(issue.id),
    queryFn: () => activityApi.runsForIssue(issue.id),
  });
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(issue.companyId),
    queryFn: () => agentsApi.list(issue.companyId),
  });

  const workProductRows = workProducts ?? [];
  // Proxy review documents (`artifact-review-*`) present only through their
  // originating Work product row, never as standalone Documents rows.
  const documentRows = (documents ?? []).filter((doc) => !isArtifactReviewDocumentKey(doc.key));
  const reviewDocsByKey = new Map((documents ?? []).map((doc) => [doc.key, doc]));
  const fileRows = selectAgentArtifactAttachments(attachments, workProducts);
  const runsById = useMemo(() => new Map((runs ?? []).map((run) => [run.runId, run])), [runs]);
  const agentsById = useMemo(() => new Map((agents ?? []).map((agent) => [agent.id, agent])), [agents]);

  type ArtifactRow =
    | { kind: "work_product"; id: string; runId: string | null; date: Date; type: string; value: IssueWorkProduct }
    | { kind: "document"; id: string; runId: null; date: Date; type: "document"; value: IssueDocument }
    | { kind: "attachment"; id: string; runId: null; date: Date; type: "file" | "image"; value: NonNullable<typeof fileRows>[number] };

  const allRows = useMemo<ArtifactRow[]>(() => [
    ...workProductRows.map((value): ArtifactRow => ({
      kind: "work_product",
      id: value.id,
      runId: value.createdByRunId,
      date: new Date(value.createdAt),
      type: value.type === "artifact" && typeof value.metadata?.contentType === "string" && value.metadata.contentType.startsWith("image/")
        ? "image"
        : value.type === "artifact" ? "file" : value.type,
      value,
    })),
    ...documentRows.map((value): ArtifactRow => ({
      kind: "document",
      id: value.id,
      runId: null,
      date: new Date(value.createdAt),
      type: "document",
      value,
    })),
    ...fileRows.map((value): ArtifactRow => ({
      kind: "attachment",
      id: value.id,
      runId: null,
      date: new Date(value.createdAt),
      type: value.contentType.startsWith("image/") ? "image" : "file",
      value,
    })),
  ], [documentRows, fileRows, workProductRows]);

  const filteredRows = allRows.filter((row) =>
    (typeFilter === "all" || row.type === typeFilter) &&
    (runFilter === "all" || (runFilter === "other" ? row.runId === null : row.runId === runFilter)),
  );
  const groupedRows = [...filteredRows.reduce((groups, row) => {
    const key = row.runId ?? "other";
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
    return groups;
  }, new Map<string, ArtifactRow[]>())]
    .map(([runId, rows]) => ({
      runId,
      rows: rows.sort((a, b) => b.date.getTime() - a.date.getTime()),
      date: runId === "other"
        ? rows[0]?.date ?? new Date(0)
        : new Date(runsById.get(runId)?.startedAt ?? rows[0]?.date ?? 0),
    }))
    .sort((a, b) => b.date.getTime() - a.date.getTime());
  const runOptions = [...new Set(allRows.flatMap((row) => row.runId ? [row.runId] : []))];

  if (workProductRows.length === 0 && documentRows.length === 0 && fileRows.length === 0) {
    return (
      <div className="px-1 py-6 text-sm text-muted-foreground">
        No artifacts yet. Work products, documents, and agent-produced files will appear here.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 py-2">
      <div className="flex items-center gap-2 px-1">
        <label className="min-w-0 flex-1 text-(length:--text-micro) text-muted-foreground">
          <span className="sr-only">Filter artifacts by type</span>
          <select
            aria-label="Filter artifacts by type"
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value)}
            className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
          >
            <option value="all">All types</option>
            <option value="image">Images</option>
            <option value="file">Files</option>
            <option value="pull_request">Pull requests</option>
            <option value="commit">Commits</option>
            <option value="branch">Branches</option>
            <option value="document">Documents</option>
            <option value="preview_url">Previews</option>
            <option value="runtime_service">Runtime services</option>
          </select>
        </label>
        <label className="min-w-0 flex-1 text-(length:--text-micro) text-muted-foreground">
          <span className="sr-only">Filter artifacts by run</span>
          <select
            aria-label="Filter artifacts by run"
            value={runFilter}
            onChange={(event) => setRunFilter(event.target.value)}
            className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
          >
            <option value="all">All runs</option>
            {runOptions.map((runId) => {
              const run = runsById.get(runId);
              const agent = run ? agentsById.get(run.agentId) : null;
              const runDate = run?.startedAt ?? allRows.find((row) => row.runId === runId)?.date;
              return (
                <option key={runId} value={runId}>
                  {`${agent?.name ?? `Run ${runId.slice(0, 8)}`}${runDate ? ` · ${formatDateTime(runDate)}` : ""}`}
                </option>
              );
            })}
            {allRows.some((row) => row.runId === null) ? <option value="other">Other artifacts</option> : null}
          </select>
        </label>
      </div>

      {groupedRows.length === 0 ? (
        <p className="px-1 py-6 text-sm text-muted-foreground">No artifacts match these filters.</p>
      ) : groupedRows.map((group) => {
        const run = group.runId === "other" ? null : runsById.get(group.runId);
        const agent = run ? agentsById.get(run.agentId) : null;
        return (
          <section key={group.runId} className="flex flex-col gap-1.5">
            <header className="flex items-baseline justify-between gap-2 px-1">
              <h3 className="truncate text-xs font-medium text-foreground">
                {group.runId === "other" ? "Other artifacts" : agent?.name ?? `Run ${group.runId.slice(0, 8)}`}
              </h3>
              <time className="shrink-0 text-(length:--text-micro) text-muted-foreground" dateTime={group.date.toISOString()}>
                {formatDateTime(group.date)}
              </time>
            </header>
            <ul className="flex flex-col gap-1">
              {group.rows.map((row) => {
                if (row.kind === "work_product") {
                  const wp = row.value;
                  const markdownMetadata = getMarkdownWorkProductAttachmentMetadata(wp);
                  if (markdownMetadata) {
                    const reviewKey = artifactReviewDocumentKey(wp.id);
                    return (
                      <li key={row.id}>
                        <MarkdownWorkProductRow
                          issueId={issue.id}
                          workProduct={wp}
                          metadata={markdownMetadata}
                          reviewDoc={reviewDocsByKey.get(reviewKey)}
                          openRequestId={documentDeepLink?.documentKey === reviewKey ? documentDeepLink.requestId : undefined}
                        />
                      </li>
                    );
                  }
                  return (
                    <li key={row.id}>
                      <RichWorkProductCard workProduct={wp} href={workProductHref(wp)} variant="compact" />
                    </li>
                  );
                }
                if (row.kind === "document") {
                  const doc = row.value;
                  return (
                    <li key={row.id}>
                      <DocumentRow
                        issueId={issue.id}
                        doc={doc}
                        onOpen={onOpenDocument ? () => onOpenDocument(doc) : undefined}
                        openRequestId={documentDeepLink?.documentKey === doc.key ? documentDeepLink.requestId : undefined}
                      />
                    </li>
                  );
                }
                const attachment = row.value;
                return (
                  <li key={row.id}>
                    <a href={attachmentOpenPath(attachment)} target="_blank" rel="noreferrer" className={cn(ROW_CLASS, "hover:bg-accent/50")}>
                      <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{attachment.originalFilename ?? attachment.objectKey}</span>
                      <span className="shrink-0 text-(length:--text-micro) text-muted-foreground">{formatBytes(attachment.byteSize)}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}

      <Link to="/artifacts" className="mx-1 border-t border-border pt-2 text-xs font-medium text-foreground hover:underline">
        View all in company Artifacts →
      </Link>
    </div>
  );
}
