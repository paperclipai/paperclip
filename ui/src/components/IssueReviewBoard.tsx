import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { IssueReviewItem, IssueReviewPack, IssueReviewPackSurface } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { issuesApi } from "../api/issues";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import {
  describeIssueReviewItemSurfaceState,
  getIssueReviewActionItem,
  getIssueReviewItemKindLabel,
  getIssueReviewItemSourceHref,
  getIssueReviewPackEvidenceItems,
  getIssueReviewPackPrimaryItems,
  indexIssueReviewItems,
} from "../lib/review-items";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import {
  AlertTriangle,
  ArrowRight,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  Link2,
  Package,
  Store,
} from "lucide-react";

interface IssueReviewBoardProps {
  issueId: string;
  items: readonly IssueReviewItem[];
  surface?: IssueReviewPackSurface | null;
  onOpenItem?: (item: IssueReviewItem) => void;
}

function cardIcon(kind: IssueReviewItem["kind"]) {
  switch (kind) {
    case "image":
      return <ImageIcon className="h-4 w-4" />;
    case "file":
    case "document":
      return <FileText className="h-4 w-4" />;
    case "marketplace_link":
      return <Store className="h-4 w-4" />;
    case "work_product":
      return <Package className="h-4 w-4" />;
    default:
      return <Link2 className="h-4 w-4" />;
  }
}

function packTone(status: IssueReviewPack["status"]) {
  if (status === "blocked") return "border-red-500/30 bg-red-500/8";
  if (status === "warning") return "border-amber-500/30 bg-amber-500/8";
  if (status === "reviewed") return "border-emerald-500/25 bg-emerald-500/8";
  return "border-border/70 bg-card/85";
}

function resolveActionHref(target: IssueReviewPackSurface["blockers"][number]["actionTarget"]) {
  if (!target) return null;
  if (target.type === "issue") return createIssueDetailPath(target.value);
  if (target.type === "agent") return `/agents/${target.value}`;
  if (target.type === "comment") return `#comment-${target.value}`;
  return null;
}

function ReviewPackHeroPreview({
  item,
  snippet,
  isLoading,
}: {
  item: IssueReviewItem | null;
  snippet: {
    kind: "text" | "image" | "summary";
    body: string;
    contentPath?: string | null;
  } | null;
  isLoading: boolean;
}) {
  return (
    <div className="rounded-xl border border-border/70 bg-background/55">
      <div className="flex items-start justify-between gap-3 border-b border-border/70 px-4 py-3">
        <div className="space-y-1">
          <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Primary deliverable
          </div>
          <div className="text-sm font-semibold">{item?.title ?? "Primary deliverable"}</div>
          {item?.subtitle ? <div className="text-xs text-muted-foreground">{item.subtitle}</div> : null}
        </div>
        {item ? (
          <div className="rounded-md border border-border/70 bg-accent/20 p-2 text-muted-foreground">
            {cardIcon(item.kind)}
          </div>
        ) : null}
      </div>

      <div className="min-h-[220px] px-4 py-4">
        {isLoading ? (
          <div className="flex min-h-[188px] items-center justify-center rounded-lg border border-dashed border-border/70 bg-accent/10 px-4 text-sm text-muted-foreground">
            Loading live preview…
          </div>
        ) : snippet?.kind === "text" ? (
          <pre className="max-h-[320px] overflow-auto rounded-lg border border-border/70 bg-accent/10 p-4 font-mono text-xs leading-5 text-foreground/85">
            {snippet.body}
          </pre>
        ) : snippet?.kind === "image" && snippet.contentPath ? (
          <img
            src={snippet.contentPath}
            alt={item?.title ?? "Review preview"}
            className="max-h-[320px] w-full rounded-lg border border-border/70 object-contain"
          />
        ) : (
          <div className="flex min-h-[188px] flex-col justify-between rounded-lg border border-border/70 bg-accent/10 p-4">
            <div className="space-y-2">
              <div className="text-sm font-medium text-foreground/90">
                {item ? describeIssueReviewItemSurfaceState(item) : "Review target surfaced."}
              </div>
              {snippet?.body ? (
                <div className="text-sm leading-6 text-muted-foreground">{snippet.body}</div>
              ) : null}
            </div>
            {item?.resolvedTarget.path ? (
              <div className="pt-4 font-mono text-xs text-muted-foreground">{item.resolvedTarget.path}</div>
            ) : item?.resolvedTarget.url ? (
              <div className="truncate pt-4 font-mono text-xs text-muted-foreground">{item.resolvedTarget.url}</div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function ReviewQueueCard({
  pack,
  item,
  onOpenItem,
}: {
  pack: IssueReviewPack;
  item: IssueReviewItem | null;
  onOpenItem?: (item: IssueReviewItem) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        if (item) onOpenItem?.(item);
      }}
      className={cn(
        "rounded-xl border px-4 py-4 text-left transition-colors hover:bg-accent/20",
        packTone(pack.status),
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">Next up</Badge>
            {item ? <Badge variant="secondary">{getIssueReviewItemKindLabel(item.kind)}</Badge> : null}
          </div>
          <div className="space-y-1">
            <div className="text-sm font-semibold">{pack.title}</div>
            <div className="text-xs text-muted-foreground">{pack.reason}</div>
          </div>
        </div>
        {item?.resolvedTarget.url ? <ExternalLink className="h-4 w-4 text-muted-foreground" /> : null}
      </div>
      <div className="mt-3 text-sm text-muted-foreground">
        {item ? describeIssueReviewItemSurfaceState(item) : pack.summary ?? "Additional review target surfaced."}
      </div>
    </button>
  );
}

export function IssueReviewBoard({
  issueId,
  items,
  surface,
  onOpenItem,
}: IssueReviewBoardProps) {
  const itemsById = useMemo(() => indexIssueReviewItems(items), [items]);
  const heroPack = surface?.heroPack ?? null;
  const heroPrimaryItems = useMemo(
    () => (heroPack ? getIssueReviewPackPrimaryItems(heroPack, itemsById) : []),
    [heroPack, itemsById],
  );
  const heroEvidenceItems = useMemo(
    () => (heroPack ? getIssueReviewPackEvidenceItems(heroPack, itemsById) : []),
    [heroPack, itemsById],
  );
  const surfaceEvidenceItems = useMemo(
    () => (surface?.evidence ?? [])
      .map((itemId) => itemsById.get(itemId))
      .filter((item): item is IssueReviewItem => Boolean(item)),
    [itemsById, surface?.evidence],
  );
  const [selectedHeroItemId, setSelectedHeroItemId] = useState<string | null>(heroPrimaryItems[0]?.id ?? null);
  const [queueExpanded, setQueueExpanded] = useState(false);

  useEffect(() => {
    if (heroPrimaryItems.length === 0) {
      setSelectedHeroItemId(null);
      return;
    }
    setSelectedHeroItemId((current) =>
      current && heroPrimaryItems.some((item) => item.id === current)
        ? current
        : heroPrimaryItems[0]?.id ?? null,
    );
  }, [heroPrimaryItems]);

  if (!surface || (!surface.heroPack && surface.blockers.length === 0 && surface.queue.length === 0 && surface.evidence.length === 0)) {
    return null;
  }

  const selectedHeroItem = heroPrimaryItems.find((item) => item.id === selectedHeroItemId) ?? heroPrimaryItems[0] ?? null;
  const selectedHeroPath = selectedHeroItem?.resolvedTarget.path ?? null;
  const { data: heroPreview, isLoading: heroPreviewLoading } = useQuery({
    queryKey: selectedHeroPath ? queryKeys.issues.filePreview(issueId, selectedHeroPath) : ["issues", "file-preview", issueId, "__hero-idle__"],
    queryFn: () => issuesApi.getFilePreview(issueId, selectedHeroPath!),
    enabled: Boolean(selectedHeroPath),
    retry: false,
  });
  const actionItem = selectedHeroItem
    ?? getIssueReviewActionItem(heroPack?.nextActionTarget, itemsById)
    ?? null;
  const selectedHeroSourceHref = selectedHeroItem ? getIssueReviewItemSourceHref(selectedHeroItem) : null;
  const visibleQueue = queueExpanded ? surface.queue : surface.queue.slice(0, 4);
  const hiddenQueueCount = Math.max(surface.queue.length - 4, 0);
  const heroPreviewContent = (() => {
    if (heroPreview?.kind === "text" && heroPreview.snippet) {
      return { kind: "text" as const, body: heroPreview.snippet };
    }
    if (heroPreview?.kind === "image" && heroPreview.contentPath) {
      return { kind: "image" as const, body: selectedHeroItem?.title ?? "Preview", contentPath: heroPreview.contentPath };
    }
    if (selectedHeroItem?.kind === "image" && selectedHeroItem.thumbnailUrl) {
      return { kind: "image" as const, body: selectedHeroItem.title, contentPath: selectedHeroItem.thumbnailUrl };
    }
    if (!selectedHeroItem) return null;

    const detail = selectedHeroItem.summary
      ?? selectedHeroItem.subtitle
      ?? (selectedHeroItem.resolvedTarget.url ? selectedHeroItem.resolvedTarget.url : null)
      ?? (selectedHeroItem.resolvedTarget.path ? selectedHeroItem.resolvedTarget.path : null);

    return detail ? { kind: "summary" as const, body: detail } : null;
  })();

  return (
    <section className="space-y-4" aria-label="Review pack">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Review pack</h2>
          <p className="text-sm text-muted-foreground">
            One operator-facing review task with the primary deliverable, risks, and supporting evidence surfaced first.
          </p>
        </div>
        <Badge variant="outline" className="rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.18em]">
          {items.length} assets
        </Badge>
      </div>

      {surface.blockers.length > 0 ? (
        <section className="space-y-2" aria-label="Review blockers">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Review blockers
          </div>
          <div className="space-y-2">
            {surface.blockers.map((blocker) => {
              const actionHref = resolveActionHref(blocker.actionTarget);
              return (
                <div
                  key={blocker.id}
                  className={cn(
                    "flex flex-col gap-3 rounded-xl border px-4 py-3 shadow-xs md:flex-row md:items-center md:justify-between",
                    blocker.severity === "critical"
                      ? "border-amber-500/30 bg-amber-500/10"
                      : "border-red-500/25 bg-red-500/8",
                  )}
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      <AlertTriangle className="h-4 w-4" />
                      <span>{blocker.title}</span>
                    </div>
                    {blocker.summary ? (
                      <p className="text-sm text-muted-foreground">{blocker.summary}</p>
                    ) : null}
                  </div>
                  {actionHref && blocker.actionLabel ? (
                    <Button asChild size="sm" variant="outline" className="shrink-0">
                      <Link to={actionHref}>{blocker.actionLabel}</Link>
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {heroPack ? (
        <Card className={cn("overflow-hidden border shadow-xs", packTone(heroPack.status))}>
          <CardHeader className="space-y-4 border-b border-border/60 pb-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">Hero review</Badge>
              {selectedHeroItem ? <Badge variant="secondary">{getIssueReviewItemKindLabel(selectedHeroItem.kind)}</Badge> : null}
              {heroPack.hints.map((hint) => (
                <Badge
                  key={hint.code}
                  variant="outline"
                  className={cn(
                    hint.severity === "critical" && "border-red-500/30 text-red-300",
                    hint.severity === "warning" && "border-amber-500/30 text-amber-300",
                  )}
                >
                  {hint.label}
                </Badge>
              ))}
            </div>

            <div className="grid gap-4 lg:grid-cols-[1.4fr,0.9fr]">
              <div className="space-y-3">
                <div className="space-y-2">
                  <CardTitle className="text-lg">{heroPack.title}</CardTitle>
                  <p className="text-sm text-muted-foreground">{heroPack.reason}</p>
                  {heroPack.summary ? <p className="text-sm text-muted-foreground">{heroPack.summary}</p> : null}
                </div>

                {heroPrimaryItems.length > 1 ? (
                  <div className="flex flex-wrap gap-2">
                    {heroPrimaryItems.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setSelectedHeroItemId(item.id)}
                        className={cn(
                          "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                          selectedHeroItem?.id === item.id
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border/70 bg-background/60 text-muted-foreground hover:bg-accent/20",
                        )}
                      >
                        {item.title}
                      </button>
                    ))}
                  </div>
                ) : null}

                <div className="space-y-3">
                  <ReviewPackHeroPreview
                    item={selectedHeroItem}
                    snippet={heroPreviewContent}
                    isLoading={heroPreviewLoading}
                  />
                  <div className="grid gap-3 rounded-xl border border-border/70 bg-background/35 px-4 py-3 text-xs text-muted-foreground sm:grid-cols-3">
                    <div>
                      <div className="font-semibold uppercase tracking-[0.14em] text-muted-foreground">Deliverables</div>
                      <div className="mt-1 text-sm font-medium text-foreground/90">{heroPrimaryItems.length}</div>
                    </div>
                    <div>
                      <div className="font-semibold uppercase tracking-[0.14em] text-muted-foreground">Mentions</div>
                      <div className="mt-1 text-sm font-medium text-foreground/90">{heroPack.mentionCount}</div>
                    </div>
                    <div>
                      <div className="font-semibold uppercase tracking-[0.14em] text-muted-foreground">Evidence</div>
                      <div className="mt-1 text-sm font-medium text-foreground/90">{heroEvidenceItems.length}</div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="space-y-3 rounded-xl border border-border/70 bg-background/40 p-4">
                <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  Next action
                </div>
                <div className="space-y-2">
                  <div className="text-sm font-semibold">{heroPack.nextActionLabel ?? "Inspect deliverable"}</div>
                  <div className="text-sm text-muted-foreground">
                    Open the primary deliverable first, then verify the supporting evidence below.
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    onClick={() => {
                      if (actionItem) onOpenItem?.(actionItem);
                    }}
                  >
                    {heroPack.nextActionLabel ?? "Inspect deliverable"}
                    <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                  </Button>
                  {selectedHeroSourceHref ? (
                    <Button asChild size="sm" variant="outline">
                      <a href={selectedHeroSourceHref}>Jump to source</a>
                    </Button>
                  ) : null}
                </div>

                {heroEvidenceItems.length > 0 ? (
                  <div className="space-y-2 pt-2">
                    <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                      In this pack
                    </div>
                    <div className="space-y-2">
                      {heroEvidenceItems.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => onOpenItem?.(item)}
                          className="flex w-full items-center justify-between rounded-lg border border-border/70 bg-background/60 px-3 py-2 text-left text-sm transition-colors hover:bg-accent/20"
                        >
                          <div className="min-w-0">
                            <div className="truncate font-medium">{item.title}</div>
                            <div className="truncate text-xs text-muted-foreground">{item.subtitle ?? item.summary ?? ""}</div>
                          </div>
                          <Badge variant="outline">{getIssueReviewItemKindLabel(item.kind)}</Badge>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </CardHeader>
        </Card>
      ) : null}

      {surface.queue.length > 0 ? (
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold">Next up</div>
              <div className="text-xs text-muted-foreground">Other review targets surfaced after the hero pack.</div>
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {visibleQueue.map((pack) => (
              <ReviewQueueCard
                key={pack.id}
                pack={pack}
                item={itemsById.get(pack.primaryItemIds[0] ?? "") ?? null}
                onOpenItem={onOpenItem}
              />
            ))}
          </div>
          {hiddenQueueCount > 0 ? (
            <Button variant="outline" size="sm" onClick={() => setQueueExpanded((current) => !current)}>
              {queueExpanded ? "Show less" : `Show ${hiddenQueueCount} more`}
            </Button>
          ) : null}
        </section>
      ) : null}

      {surfaceEvidenceItems.length > 0 ? (
        <section className="space-y-3">
          <div>
            <div className="text-sm font-semibold">Supporting evidence</div>
            <div className="text-xs text-muted-foreground">
              Dense references that help verify the review task without competing with the hero surface.
            </div>
          </div>
          <div className="space-y-2">
            {surfaceEvidenceItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onOpenItem?.(item)}
                className="flex w-full items-center justify-between gap-3 rounded-lg border border-border/70 bg-card/70 px-3 py-2 text-left transition-colors hover:bg-accent/20"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{item.title}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {item.subtitle ?? describeIssueReviewItemSurfaceState(item)}
                  </div>
                </div>
                <Badge variant="outline">{item.mentionCount}</Badge>
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </section>
  );
}
