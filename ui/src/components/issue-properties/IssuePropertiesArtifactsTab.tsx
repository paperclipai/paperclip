import { TextAttachmentContext } from "@/context/TextAttachmentContext";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
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
import { Download, ExternalLink, FileText } from "lucide-react";
import { ApiError } from "@/api/client";
import { issuesApi } from "@/api/issues";
import { activityApi } from "@/api/activity";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import { useIssueDocuments } from "@/hooks/useIssueDocuments";
import {
  documentDisplayTitle,
  selectAgentArtifactAttachments,
} from "@/lib/issue-artifacts";
import { DocumentCard } from "@/components/artifacts/RichArtifactCards";
import {
  IssueArtifactFile,
  IssueWorkProductArtifactCard,
} from "@/components/artifacts/IssueArtifactCard";
import {
  attachmentDownloadPath,
  attachmentOpenPath,
} from "@/lib/issue-attachments";
import { MarkdownBody } from "@/components/MarkdownBody";
import {
  DocumentAnnotationsCountChip,
  IssueDocumentAnnotations,
} from "@/components/IssueDocumentAnnotations";
import { formatDateTime } from "@/lib/utils";
import { useLocation } from "@/lib/router";

interface IssuePropertiesArtifactsTabProps {
  issue: Issue;
  onOpenDocument?: (document: IssueDocument) => void;
  documentDeepLink?: {
    requestId: number;
    documentKey: string;
  } | null;
}

/** Work-product status → label + `--status-task-*` base-hue var for `.status-chip`. */
function workProductStatusBadge(
  status: string,
): { label: string; cssVar: string } | null {
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
  author,
  openRequestId,
}: {
  issueId: string;
  workProduct: IssueWorkProduct;
  metadata: AttachmentArtifactWorkProductMetadata;
  reviewDoc: IssueDocument | undefined;
  author: string;
  openRequestId?: number;
}) {
  const openTextAttachment = useContext(TextAttachmentContext);
  const [expanded, setExpanded] = useState(false);
  const [annotationPanelOpen, setAnnotationPanelOpen] = useState(false);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const location = useLocation();
  const queryClient = useQueryClient();
  const badge = workProductStatusBadge(workProduct.status);
  const tooLarge = metadata.byteSize > MARKDOWN_REVIEW_DOCUMENT_MAX_BYTES;

  const ensure = useMutation({
    mutationFn: () =>
      issuesApi.ensureWorkProductReviewDocument(issueId, workProduct.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.issues.documents(issueId),
      });
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
    ensure.error instanceof ApiError &&
    [413, 415, 422].includes(ensure.error.status);

  let expandedBody: React.ReactNode;
  if (tooLarge) {
    expandedBody = (
      <p className="text-sm text-muted-foreground">
        This Markdown file is too large to preview. Use Raw or Download instead.
      </p>
    );
  } else if (reviewDoc) {
    expandedBody =
      reviewDoc.body.trim().length > 0 ? (
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
    expandedBody = (
      <p className="text-sm text-muted-foreground">Preparing preview…</p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div ref={headerRef}>
        <DocumentCard
          title={workProduct.title}
          summary={workProduct.summary ?? ""}
          author={author}
          updatedAt={formatDateTime(workProduct.updatedAt)}
          filename={metadata.originalFilename ?? workProduct.title}
          revision={reviewDoc?.latestRevisionNumber}
          body={reviewDoc?.body ?? ""}
          onOpen={handleToggle}
          expanded={expanded}
          statusBadge={
            badge ? (
              <span className="text-xs text-muted-foreground">
                {badge.label}
              </span>
            ) : undefined
          }
          actions={
            <>
              {reviewDoc ? (
                <DocumentAnnotationsCountChip
                  issueId={issueId}
                  docKey={reviewDoc.key}
                  panelOpen={annotationPanelOpen}
                  onToggle={() => {
                    setExpanded(true);
                    setAnnotationPanelOpen((open) => !open);
                  }}
                />
              ) : null}
              {openTextAttachment ? (
                <button
                  type="button"
                  onClick={() => openTextAttachment(metadata.attachmentId, metadata.originalFilename ?? workProduct.title)}
                  aria-label={`Open in tab: ${workProduct.title}`}
                  title="Open in tab"
                  className="shrink-0 px-1.5 py-1.5 text-muted-foreground hover:text-foreground"
                >
                  <FileText className="h-3 w-3" />
                </button>
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
            </>
          }
        />
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
  author,
  openRequestId,
  onOpen,
}: {
  issueId: string;
  doc: IssueDocument;
  author: string;
  openRequestId?: number;
  onOpen?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [annotationPanelOpen, setAnnotationPanelOpen] = useState(false);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const location = useLocation();
  useEffect(() => {
    if (onOpen || openRequestId === undefined) return;
    setExpanded(true);
  }, [onOpen, openRequestId]);
  useEffect(() => {
    if (onOpen || openRequestId === undefined || !expanded) return;
    headerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [expanded, onOpen, openRequestId]);
  return (
    <div ref={headerRef}>
      <DocumentCard
        title={documentDisplayTitle(doc)}
        summary=""
        author={author}
        updatedAt={formatDateTime(doc.updatedAt)}
        filename={`${doc.key}.md`}
        revision={doc.latestRevisionNumber}
        body={doc.body}
        onOpen={onOpen ?? (() => setExpanded((open) => !open))}
        expanded={onOpen ? undefined : expanded}
        actions={
          !onOpen ? (
            <DocumentAnnotationsCountChip
              issueId={issueId}
              docKey={doc.key}
              panelOpen={annotationPanelOpen}
              onToggle={() => {
                setExpanded(true);
                setAnnotationPanelOpen((open) => !open);
              }}
            />
          ) : undefined
        }
      />
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
export function IssuePropertiesArtifactsTab({
  issue,
  documentDeepLink,
  onOpenDocument,
}: IssuePropertiesArtifactsTabProps) {
  const {
    data: attachments,
    isPending: attachmentsPending,
    isError: attachmentsError,
    refetch: refetchAttachments,
  } = useQuery({
    queryKey: queryKeys.issues.attachments(issue.id),
    queryFn: () => issuesApi.listAttachments(issue.id),
  });
  const {
    data: workProducts,
    isPending: productsPending,
    isError: productsError,
    refetch: refetchProducts,
  } = useQuery({
    queryKey: queryKeys.issues.workProducts(issue.id),
    queryFn: () => issuesApi.listWorkProducts(issue.id, {
      refreshPullRequests: true,
    }),
  });
  const {
    data: documents,
    isPending: documentsPending,
    isError: documentsError,
    refetch: refetchDocuments,
  } = useIssueDocuments(issue.id);
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
  const documentRows = (documents ?? []).filter(
    (doc) => !isArtifactReviewDocumentKey(doc.key),
  );
  const reviewDocsByKey = new Map(
    (documents ?? []).map((doc) => [doc.key, doc]),
  );
  const fileRows = selectAgentArtifactAttachments(attachments, workProducts);
  const runsById = useMemo(
    () => new Map((runs ?? []).map((run) => [run.runId, run])),
    [runs],
  );
  const agentsById = useMemo(
    () => new Map((agents ?? []).map((agent) => [agent.id, agent])),
    [agents],
  );

  type ArtifactRow =
    | {
        kind: "work_product";
        id: string;
        runId: string | null;
        date: Date;
        value: IssueWorkProduct;
      }
    | {
        kind: "document";
        id: string;
        runId: null;
        date: Date;
        value: IssueDocument;
      }
    | {
        kind: "attachment";
        id: string;
        runId: null;
        date: Date;
        value: NonNullable<typeof fileRows>[number];
      };

  const allRows = useMemo<ArtifactRow[]>(
    () => [
      ...workProductRows.map(
        (value): ArtifactRow => ({
          kind: "work_product",
          id: value.id,
          runId: value.createdByRunId,
          date: new Date(value.createdAt),
          value,
        }),
      ),
      ...documentRows.map(
        (value): ArtifactRow => ({
          kind: "document",
          id: value.id,
          runId: null,
          date: new Date(value.createdAt),
          value,
        }),
      ),
      ...fileRows.map(
        (value): ArtifactRow => ({
          kind: "attachment",
          id: value.id,
          runId: null,
          date: new Date(value.createdAt),
          value,
        }),
      ),
    ],
    [documentRows, fileRows, workProductRows],
  );

  const groupedRows = [
    ...allRows.reduce((groups, row) => {
      const key = row.runId ?? "other";
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
      return groups;
    }, new Map<string, ArtifactRow[]>()),
  ]
    .map(([runId, rows]) => ({
      runId,
      rows: rows.sort((a, b) => b.date.getTime() - a.date.getTime()),
      date:
        runId === "other"
          ? (rows[0]?.date ?? new Date(0))
          : new Date(runsById.get(runId)?.startedAt ?? rows[0]?.date ?? 0),
    }))
    .sort((a, b) => b.date.getTime() - a.date.getTime());

  const loadError = attachmentsError || productsError || documentsError;
  const loading = attachmentsPending || productsPending || documentsPending;
  const feedback = loadError ? (
    <div role="alert" className="px-1 py-3 text-sm text-muted-foreground">
      Some artifacts could not be loaded.
      <button
        className="ml-2 underline"
        onClick={() => {
          void refetchAttachments();
          void refetchProducts();
          void refetchDocuments();
        }}
      >
        Retry
      </button>
    </div>
  ) : loading ? (
    <p role="status" className="px-1 py-3 text-sm text-muted-foreground">
      Loading artifacts…
    </p>
  ) : null;

  if (
    workProductRows.length === 0 &&
    documentRows.length === 0 &&
    fileRows.length === 0
  ) {
    if (feedback) return feedback;
    return (
      <div className="px-1 py-6 text-sm text-muted-foreground">
        No artifacts yet. Work products, documents, and agent-produced files
        will appear here.
      </div>
    );
  }

  return (
    <div className="@container flex flex-col gap-3 py-2">
      {feedback}
      {groupedRows.map((group) => {
        const run = group.runId === "other" ? null : runsById.get(group.runId);
        const agent = run ? agentsById.get(run.agentId) : null;
        return (
          <section key={group.runId} className="flex flex-col gap-1.5">
            {group.runId !== "other" ? (
              <header className="flex items-baseline justify-between gap-2 px-1">
                <h3 className="truncate text-xs font-medium text-foreground">
                  {agent?.name ?? `Run ${group.runId.slice(0, 8)}`}
                </h3>
                <time
                  className="shrink-0 text-(length:--text-micro) text-muted-foreground"
                  dateTime={group.date.toISOString()}
                >
                  {formatDateTime(group.date)}
                </time>
              </header>
            ) : null}
            <ul className="grid grid-cols-1 gap-3">
              {group.rows.map((row) => {
                if (row.kind === "work_product") {
                  const wp = row.value;
                  const markdownMetadata =
                    getMarkdownWorkProductAttachmentMetadata(wp);
                  if (markdownMetadata) {
                    const reviewKey = artifactReviewDocumentKey(wp.id);
                    return (
                      <li key={row.id} className="col-span-full min-w-0">
                        <MarkdownWorkProductRow
                          issueId={issue.id}
                          workProduct={wp}
                          author={agent?.name ?? ""}
                          metadata={markdownMetadata}
                          reviewDoc={reviewDocsByKey.get(reviewKey)}
                          openRequestId={
                            documentDeepLink?.documentKey === reviewKey
                              ? documentDeepLink.requestId
                              : undefined
                          }
                        />
                      </li>
                    );
                  }
                  return (
                    <li key={row.id} className="col-span-full min-w-0">
                      <IssueWorkProductArtifactCard
                        workProduct={wp}
                        author={agent?.name ?? ""}
                      />
                    </li>
                  );
                }
                if (row.kind === "document") {
                  const doc = row.value;
                  return (
                    <li key={row.id} className="col-span-full min-w-0">
                      <DocumentRow
                        issueId={issue.id}
                        doc={doc}
                        author={
                          agentsById.get(
                            doc.updatedByAgentId ?? doc.createdByAgentId ?? "",
                          )?.name ?? ""
                        }
                        onOpen={
                          onOpenDocument ? () => onOpenDocument(doc) : undefined
                        }
                        openRequestId={
                          documentDeepLink?.documentKey === doc.key
                            ? documentDeepLink.requestId
                            : undefined
                        }
                      />
                    </li>
                  );
                }
                const attachment = row.value;
                const filename =
                  attachment.originalFilename ?? attachment.objectKey;
                return (
                  <li key={row.id} className="col-span-full min-w-0">
                    <IssueArtifactFile
                      id={attachment.id}
                      attachmentId={attachment.id}
                      title={filename}
                      summary=""
                      author={
                        agentsById.get(attachment.createdByAgentId ?? "")
                          ?.name ?? ""
                      }
                      updatedAt={formatDateTime(attachment.updatedAt)}
                      filename={filename}
                      contentType={attachment.contentType}
                      contentPath={attachment.contentPath}
                      openPath={attachmentOpenPath(attachment)}
                      downloadPath={attachmentDownloadPath(attachment)}
                      byteSize={attachment.byteSize}
                    />
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
