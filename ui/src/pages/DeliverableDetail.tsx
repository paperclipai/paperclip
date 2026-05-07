import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Package } from "lucide-react";
import { Link, useParams } from "@/lib/router";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { deliverablesApi } from "../api/deliverables";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { agentUrl, formatDateTime, issueUrl, relativeTime, formatFileSize } from "../lib/utils";
import type { DeliverableDetail as DeliverableDetailType } from "@paperclipai/shared";

function isImage(contentType: string) {
  return contentType.toLowerCase().startsWith("image/");
}

function isPdf(contentType: string) {
  return contentType.toLowerCase() === "application/pdf";
}

export function DeliverableDetail() {
  const { deliverableId } = useParams<{ deliverableId: string }>();
  const { setBreadcrumbs } = useBreadcrumbs();

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.deliverables.detail(deliverableId ?? ""),
    queryFn: () => deliverablesApi.get(deliverableId!),
    enabled: !!deliverableId,
  });

  useEffect(() => {
    if (data) {
      setBreadcrumbs([
        { label: "Deliverables", href: "/deliverables" },
        { label: data.title },
      ]);
    } else {
      setBreadcrumbs([{ label: "Deliverables", href: "/deliverables" }]);
    }
  }, [data, setBreadcrumbs]);

  if (isLoading) {
    return <PageSkeleton variant="detail" />;
  }

  if (error || !data) {
    return (
      <EmptyState
        icon={Package}
        message={
          error
            ? `Failed to load deliverable: ${(error as Error).message}`
            : "Deliverable not found."
        }
      />
    );
  }

  return <DeliverableDetailView data={data} />;
}

function DeliverableDetailView({ data }: { data: DeliverableDetailType }) {
  const downloadHref = data.contentPath;
  const downloadName = data.originalFilename ?? undefined;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h1 className="text-xl font-semibold text-foreground">{data.title}</h1>
          {data.originalFilename ? (
            <p className="font-mono text-xs text-muted-foreground">{data.originalFilename}</p>
          ) : null}
          {data.summary ? (
            <p className="text-sm text-muted-foreground">{data.summary}</p>
          ) : null}
        </div>
        <Button asChild>
          <a href={downloadHref} download={downloadName}>
            <Download className="h-4 w-4 mr-1.5" />
            Download
          </a>
        </Button>
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <ArtifactPreview data={data} />
        <DetailSidePanel data={data} />
      </div>
    </div>
  );
}

function ArtifactPreview({ data }: { data: DeliverableDetailType }) {
  const { contentPath, contentType, byteSize, originalFilename, title } = data;

  if (isImage(contentType)) {
    return (
      <div className="rounded-md border border-border bg-muted/30 p-2">
        <img
          src={contentPath}
          alt={originalFilename ?? title}
          className="mx-auto block max-h-[70vh] w-auto max-w-full rounded"
        />
      </div>
    );
  }

  if (isPdf(contentType)) {
    return (
      <div className="overflow-hidden rounded-md border border-border bg-muted/30">
        <iframe
          src={contentPath}
          title={originalFilename ?? title}
          className="block h-[70vh] w-full"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-border bg-muted/30 p-8 text-center">
      <Package className="h-10 w-10 text-muted-foreground/60" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">
          {originalFilename ?? title}
        </p>
        <p className="text-xs text-muted-foreground">
          {contentType} · {formatFileSize(byteSize)}
        </p>
      </div>
      <Button asChild size="sm" variant="outline">
        <a href={contentPath} download={originalFilename ?? undefined}>
          <Download className="h-3.5 w-3.5 mr-1.5" />
          Download
        </a>
      </Button>
    </div>
  );
}

function DetailSidePanel({ data }: { data: DeliverableDetailType }) {
  const showRoot = data.rootIssue !== null && data.rootIssue.id !== data.childIssue.id;
  return (
    <aside className="space-y-4 rounded-md border border-border bg-card p-4">
      <h2 className="text-sm font-semibold text-foreground">Details</h2>

      {showRoot && data.rootIssue ? (
        <DetailRow label="Original request">
          <Link to={issueUrl(data.rootIssue)} className="hover:underline">
            <span className="font-mono text-xs text-muted-foreground">
              {data.rootIssue.identifier ?? "(no key)"}
            </span>{" "}
            <span className="text-foreground">{data.rootIssue.title}</span>
          </Link>
        </DetailRow>
      ) : null}

      <DetailRow label="Worked on">
        <Link to={issueUrl(data.childIssue)} className="hover:underline">
          <span className="font-mono text-xs text-muted-foreground">
            {data.childIssue.identifier ?? "(no key)"}
          </span>{" "}
          <span className="text-foreground">{data.childIssue.title}</span>
        </Link>
        <div className="text-[11px] text-muted-foreground">
          Status: {data.childIssue.status}
        </div>
      </DetailRow>

      <DetailRow label="Generated by">
        {data.agent ? (
          <>
            <Link to={agentUrl(data.agent)} className="text-foreground hover:underline">
              {data.agent.name}
            </Link>
            {data.runId && data.agent ? (
              <div className="text-[11px] text-muted-foreground">
                <Link
                  to={`/agents/${data.agent.id}/runs/${data.runId}`}
                  className="hover:underline"
                >
                  View run
                </Link>
              </div>
            ) : null}
          </>
        ) : (
          <span className="text-muted-foreground">Unknown</span>
        )}
      </DetailRow>

      <DetailRow label="Created">
        <span title={formatDateTime(data.createdAt)} className="text-foreground">
          {relativeTime(data.createdAt)}
        </span>
        <div className="text-[11px] text-muted-foreground">
          {formatDateTime(data.createdAt)}
        </div>
      </DetailRow>

      {data.updatedAt && data.updatedAt !== data.createdAt ? (
        <DetailRow label="Updated">
          <span title={formatDateTime(data.updatedAt)} className="text-foreground">
            {relativeTime(data.updatedAt)}
          </span>
        </DetailRow>
      ) : null}

      <DetailRow label="File">
        <span className="text-foreground">{data.contentType}</span>
        <div className="text-[11px] text-muted-foreground">
          {formatFileSize(data.byteSize)}
        </div>
      </DetailRow>

      {data.ancestors.length > 1 ? (
        <DetailRow label="Issue chain">
          <ul className="space-y-1">
            {data.ancestors.map((ancestor) => (
              <li key={ancestor.id}>
                <Link to={issueUrl(ancestor)} className="hover:underline">
                  <span className="font-mono text-xs text-muted-foreground">
                    {ancestor.identifier ?? "(no key)"}
                  </span>{" "}
                  <span className="text-foreground">{ancestor.title}</span>
                </Link>
              </li>
            ))}
          </ul>
        </DetailRow>
      ) : null}
    </aside>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-sm">{children}</div>
    </div>
  );
}
