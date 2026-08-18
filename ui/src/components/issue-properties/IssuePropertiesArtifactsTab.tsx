import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Issue, IssueDocument, IssueWorkProduct } from "@paperclipai/shared";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  GitBranch,
  GitCommit,
  Globe,
  Package,
  Paperclip,
  Server,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { useIssueDocuments } from "@/hooks/useIssueDocuments";
import {
  documentDisplayTitle,
  selectAgentArtifactAttachments,
  workProductHref,
} from "@/lib/issue-artifacts";
import { attachmentOpenPath } from "@/lib/issue-attachments";
import { MarkdownBody } from "@/components/MarkdownBody";
import { DocumentAnnotationsCountChip, IssueDocumentAnnotations } from "@/components/IssueDocumentAnnotations";
import { cn } from "@/lib/utils";
import { useLocation } from "@/lib/router";

interface IssuePropertiesArtifactsTabProps {
  issue: Issue;
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

function workProductIcon(type: string): LucideIcon {
  switch (type) {
    case "document": return FileText;
    case "pull_request": return GitBranch;
    case "branch": return GitBranch;
    case "commit": return GitCommit;
    case "preview_url": return Globe;
    case "runtime_service": return Server;
    default: return Package;
  }
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

function SectionHeading({ children }: { children: string }) {
  return (
    <h3 className="px-1 pt-1 text-(length:--text-micro) font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </h3>
  );
}

const ROW_CLASS =
  "flex items-center gap-2 rounded-md border border-border bg-card/50 px-2.5 py-1.5 text-sm";

function WorkProductRow({ workProduct }: { workProduct: IssueWorkProduct }) {
  const Icon = workProductIcon(workProduct.type);
  const badge = workProductStatusBadge(workProduct.status);
  const href = workProductHref(workProduct);
  const body = (
    <>
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{workProduct.title}</span>
      {badge ? (
        <span
          className="status-chip inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-(length:--text-nano) leading-none whitespace-nowrap"
          style={{ "--sc": `var(${badge.cssVar})` } as CSSProperties}
        >
          {badge.label}
        </span>
      ) : null}
      {href ? (
        <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
      ) : null}
    </>
  );
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className={cn(ROW_CLASS, "hover:bg-accent/50")}
      >
        {body}
      </a>
    );
  }
  return <div className={ROW_CLASS}>{body}</div>;
}

function DocumentRow({
  issueId,
  doc,
  openRequestId,
}: {
  issueId: string;
  doc: IssueDocument;
  openRequestId?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [annotationPanelOpen, setAnnotationPanelOpen] = useState(false);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const location = useLocation();
  const Chevron = expanded ? ChevronDown : ChevronRight;
  useEffect(() => {
    if (openRequestId === undefined) return;
    setExpanded(true);
  }, [openRequestId]);
  useEffect(() => {
    if (openRequestId === undefined || !expanded) return;
    headerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [expanded, openRequestId]);
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
export function IssuePropertiesArtifactsTab({ issue, documentDeepLink }: IssuePropertiesArtifactsTabProps) {
  const { data: attachments } = useQuery({
    queryKey: queryKeys.issues.attachments(issue.id),
    queryFn: () => issuesApi.listAttachments(issue.id),
  });
  const { data: workProducts } = useQuery({
    queryKey: queryKeys.issues.workProducts(issue.id),
    queryFn: () => issuesApi.listWorkProducts(issue.id),
  });
  const { data: documents } = useIssueDocuments(issue.id);

  const workProductRows = workProducts ?? [];
  const documentRows = documents ?? [];
  const fileRows = selectAgentArtifactAttachments(attachments, workProducts);

  if (workProductRows.length === 0 && documentRows.length === 0 && fileRows.length === 0) {
    return (
      <div className="px-1 py-6 text-sm text-muted-foreground">
        No artifacts yet. Work products, documents, and agent-produced files will appear here.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 py-2">
      {workProductRows.length > 0 ? (
        <>
          <SectionHeading>Work products</SectionHeading>
          <ul className="flex flex-col gap-1">
            {workProductRows.map((wp) => (
              <li key={wp.id}>
                <WorkProductRow workProduct={wp} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {documentRows.length > 0 ? (
        <>
          <SectionHeading>Documents</SectionHeading>
          <ul className="flex flex-col gap-1">
            {documentRows.map((doc) => (
              <li key={doc.key}>
                <DocumentRow
                  issueId={issue.id}
                  doc={doc}
                  openRequestId={documentDeepLink?.documentKey === doc.key
                    ? documentDeepLink.requestId
                    : undefined}
                />
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {fileRows.length > 0 ? (
        <>
          <SectionHeading>Files</SectionHeading>
          <ul className="flex flex-col gap-1">
            {fileRows.map((a) => (
              <li key={a.id}>
                <a
                  href={attachmentOpenPath(a)}
                  target="_blank"
                  rel="noreferrer"
                  className={cn(ROW_CLASS, "hover:bg-accent/50")}
                >
                  <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{a.originalFilename ?? a.objectKey}</span>
                  <span className="shrink-0 text-(length:--text-micro) text-muted-foreground">{formatBytes(a.byteSize)}</span>
                </a>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
