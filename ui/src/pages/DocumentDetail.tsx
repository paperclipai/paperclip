import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@/lib/router";
import { Check, Copy, Download, FileText } from "lucide-react";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { issueUrl, relativeTime } from "../lib/utils";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusBadge } from "../components/StatusBadge";
import { MarkdownBody } from "../components/MarkdownBody";
import { Button } from "@/components/ui/button";

const COPIED_RESET_MS = 1400;

export function DocumentDetail() {
  const { issueId, key: rawKey } = useParams<{ issueId: string; key: string }>();
  const key = rawKey ? decodeURIComponent(rawKey) : "";
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const {
    data: doc,
    isLoading,
    error,
  } = useQuery({
    queryKey: [...queryKeys.issues.documents(issueId!), key],
    queryFn: () => issuesApi.getDocument(issueId!, key),
    enabled: !!issueId && !!key,
  });

  const { data: issue } = useQuery({
    queryKey: queryKeys.issues.detail(issueId!),
    queryFn: () => issuesApi.get(issueId!),
    enabled: !!issueId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const issuePrefix = selectedCompany?.issuePrefix ?? null;
  const docsListHref = issuePrefix ? `/${issuePrefix}/documents` : "/documents";
  const issueHref = issue
    ? issuePrefix
      ? `/${issuePrefix}/issues/${issue.identifier ?? issue.id}`
      : issueUrl({ id: issue.id, identifier: issue.identifier })
    : null;

  useEffect(() => {
    const docName = doc?.title?.trim() || doc?.key || key || "Document";
    const issueIdentifier = issue?.identifier ?? null;
    const label = issueIdentifier ? `${issueIdentifier} - ${docName}` : docName;
    setBreadcrumbs([
      { label: "Documents", href: docsListHref },
      { label },
    ]);
  }, [setBreadcrumbs, docsListHref, doc, key, issue]);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  const handleCopy = useCallback(async () => {
    if (!doc) return;
    try {
      await navigator.clipboard.writeText(doc.body);
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    } catch {
      // ignore — surfacing a toast here is overkill for a read view
    }
  }, [doc]);

  if (!issueId || !key) {
    return <EmptyState icon={FileText} message="Document not found." />;
  }

  if (isLoading) return <PageSkeleton variant="detail" />;

  if (error) {
    return <p className="text-sm text-destructive">{error.message}</p>;
  }

  if (!doc) {
    return <EmptyState icon={FileText} message="Document not found." />;
  }

  const author =
    (doc.updatedByAgentId && agents?.find((a) => a.id === doc.updatedByAgentId)?.name) ||
    (doc.createdByAgentId && agents?.find((a) => a.id === doc.createdByAgentId)?.name) ||
    (doc.updatedByUserId ? "user" : null);

  const showTitle = !!doc.title?.trim() && doc.title.trim().toLowerCase() !== doc.key.toLowerCase();

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            {doc.key}
          </span>
          {issue && <StatusBadge status={issue.status} />}
          <span className="text-[11px] text-muted-foreground">rev {doc.latestRevisionNumber}</span>
          <span
            className="text-[11px] text-muted-foreground"
            title={new Date(doc.updatedAt).toLocaleString()}
          >
            updated {relativeTime(doc.updatedAt)}
          </span>
          {author && <span className="text-[11px] text-muted-foreground">by {author}</span>}
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void handleCopy()}
              title={copied ? "Copied" : "Copy markdown"}
            >
              {copied ? (
                <Check className="mr-1.5 h-3.5 w-3.5" />
              ) : (
                <Copy className="mr-1.5 h-3.5 w-3.5" />
              )}
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button variant="ghost" size="sm" asChild>
              <a
                href={`/api/issues/${doc.issueId}/documents/${encodeURIComponent(doc.key)}/download`}
                download={`${doc.key}.md`}
                title="Download as .md"
              >
                <Download className="mr-1.5 h-3.5 w-3.5" />
                Download
              </a>
            </Button>
            {issueHref && (
              <Button variant="outline" size="sm" asChild>
                <Link to={issueHref}>Open issue</Link>
              </Button>
            )}
          </div>
        </div>

        {showTitle && <h2 className="text-xl font-bold">{doc.title}</h2>}

        {issue && issueHref && (
          <p className="text-sm text-muted-foreground">
            <Link to={issueHref} className="hover:text-foreground hover:underline">
              {issue.identifier ?? issue.id}
              {" "}
              <span>{issue.title}</span>
            </Link>
          </p>
        )}
      </div>

      <div className="rounded-md border border-border/60 bg-background/40 p-4">
        <MarkdownBody
          className="paperclip-edit-in-place-content min-h-[220px] text-[15px] leading-7"
          softBreaks={false}
        >
          {doc.body}
        </MarkdownBody>
      </div>
    </div>
  );
}
