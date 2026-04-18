import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { IssueReviewItem } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import {
  getIssueReviewItemKindLabel,
  getIssueReviewItemPrimaryActionLabel,
  getIssueReviewItemPrimaryHref,
  getIssueReviewItemSourceHref,
  getLatestReviewItemSource,
} from "../lib/review-items";
import { formatDateTime } from "../lib/utils";

interface IssueReviewItemDrawerProps {
  issueId: string;
  item: IssueReviewItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function IssueReviewItemDrawer({
  issueId,
  item,
  open,
  onOpenChange,
}: IssueReviewItemDrawerProps) {
  const filePath = item?.resolvedTarget.path ?? null;
  const { data: preview, isLoading } = useQuery({
    queryKey: filePath ? queryKeys.issues.filePreview(issueId, filePath) : ["issues", "file-preview", issueId, "__idle__"],
    queryFn: () => issuesApi.getFilePreview(issueId, filePath!),
    enabled: open && Boolean(filePath),
    retry: false,
  });

  const latestSource = useMemo(() => (item ? getLatestReviewItemSource(item) : null), [item]);
  const sourceHref = item ? getIssueReviewItemSourceHref(item) : null;
  const primaryHref = item ? getIssueReviewItemPrimaryHref(item, preview) : null;
  const primaryActionLabel = item ? getIssueReviewItemPrimaryActionLabel(item, preview) : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-xl">
        {item ? (
          <>
            <SheetHeader className="border-b border-border/70 pb-4">
              <div className="flex items-center gap-2">
                <Badge variant="outline">{getIssueReviewItemKindLabel(item.kind)}</Badge>
                {item.status === "unavailable" ? (
                  <Badge variant="outline" className="border-amber-500/30 text-amber-700 dark:text-amber-300">
                    Unavailable
                  </Badge>
                ) : null}
              </div>
              <SheetTitle className="text-base">{item.title}</SheetTitle>
              <SheetDescription>{item.subtitle ?? "Review item preview and provenance."}</SheetDescription>
            </SheetHeader>

            <ScrollArea className="flex-1">
              <div className="space-y-5 p-4">
                <section className="space-y-3">
                  <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    Preview
                  </div>
                  {isLoading ? (
                    <div className="rounded-lg border border-border/70 bg-accent/10 px-4 py-3 text-sm text-muted-foreground">
                      Loading preview…
                    </div>
                  ) : preview?.kind === "text" && preview.snippet ? (
                    <pre className="overflow-x-auto rounded-lg border border-border/70 bg-accent/10 p-4 text-xs leading-5 text-foreground/80">
                      {preview.snippet}
                    </pre>
                  ) : preview?.kind === "image" && preview.contentPath ? (
                    <img
                      src={preview.contentPath}
                      alt={item.title}
                      className="w-full rounded-lg border border-border/70 object-contain"
                    />
                  ) : item.kind === "image" && item.thumbnailUrl ? (
                    <img
                      src={item.thumbnailUrl}
                      alt={item.title}
                      className="w-full rounded-lg border border-border/70 object-contain"
                    />
                  ) : item.summary ? (
                    <div className="rounded-lg border border-border/70 bg-accent/10 px-4 py-3 text-sm text-muted-foreground">
                      {item.summary}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-border/70 bg-accent/10 px-4 py-3 text-sm text-muted-foreground">
                      {preview?.kind === "unsupported"
                        ? "Preview unavailable for this file type."
                        : "No inline preview is available for this item."}
                    </div>
                  )}
                </section>

                <section className="space-y-3">
                  <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    Actions
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {primaryHref && primaryActionLabel ? (
                      <Button asChild size="sm" variant="outline">
                        <a
                          href={primaryHref}
                          target={primaryHref.startsWith("#") ? undefined : "_blank"}
                          rel={primaryHref.startsWith("#") ? undefined : "noreferrer"}
                        >
                          {primaryActionLabel}
                        </a>
                      </Button>
                    ) : null}
                    {sourceHref ? (
                      <Button asChild size="sm" variant="outline">
                        <a href={sourceHref}>Jump to source</a>
                      </Button>
                    ) : null}
                  </div>
                </section>

                <section className="space-y-3">
                  <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    Provenance
                  </div>
                  <div className="space-y-2 rounded-lg border border-border/70 bg-card/80 p-4 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-muted-foreground">Mentions</span>
                      <span>{item.mentionCount}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-muted-foreground">Latest source</span>
                      <span>{latestSource?.sourceType.replace(/_/g, " ") ?? "Unknown"}</span>
                    </div>
                    {latestSource ? (
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-muted-foreground">Last mentioned</span>
                        <span>{formatDateTime(latestSource.createdAt)}</span>
                      </div>
                    ) : null}
                  </div>
                </section>
              </div>
            </ScrollArea>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
