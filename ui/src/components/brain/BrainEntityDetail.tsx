import { useQuery } from "@tanstack/react-query";
import { ExternalLink, GitBranch, ArrowLeft } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { brainApi } from "@/api/brain";
import { queryKeys } from "@/lib/queryKeys";
import { EntityTypeBadge } from "./EntityTypeBadge";
import { timeAgo } from "@/lib/timeAgo";

interface BrainEntityDetailProps {
  companyId: string;
  slug: string;
  onNavigate?: (slug: string) => void;
  onOpenInGraph?: (slug: string) => void;
  onClose?: () => void;
}

export function BrainEntityDetail({ companyId, slug, onNavigate, onOpenInGraph, onClose }: BrainEntityDetailProps) {
  const { data: page, isLoading } = useQuery({
    queryKey: queryKeys.brain.page(companyId, slug),
    queryFn: () => brainApi.getPage(companyId, slug),
    enabled: !!companyId && !!slug,
  });

  if (isLoading) {
    return (
      <div className="p-4">
        <div className="h-4 w-32 bg-muted animate-pulse rounded mb-3" />
        <div className="h-3 w-48 bg-muted animate-pulse rounded mb-2" />
        <div className="h-3 w-40 bg-muted animate-pulse rounded" />
      </div>
    );
  }

  if (!page) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Page not found: {slug}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-4 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-2 mb-1">
          {onClose && (
            <button onClick={onClose} className="p-0.5 text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-3.5 w-3.5" />
            </button>
          )}
          <h3 className="text-sm font-semibold truncate flex-1">{page.title}</h3>
          <EntityTypeBadge type={page.type} />
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {page.tier != null && <span>Tier {page.tier}</span>}
          <span>Updated {timeAgo(page.updated)}</span>
          {page.sourceAgent && <span>by {page.sourceAgent}</span>}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="px-4 py-3 prose prose-sm dark:prose-invert max-w-none [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm [&_p]:text-[13px] [&_li]:text-[13px]">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{page.content}</ReactMarkdown>
        </div>

        {page.linkedEntities.length > 0 && (
          <div className="px-4 py-3 border-t border-border">
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
              Linked Entities
            </h4>
            <div className="space-y-1.5">
              {page.linkedEntities.map((entity) => (
                <button
                  key={entity.slug}
                  onClick={() => onNavigate?.(entity.slug)}
                  className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-sm hover:bg-accent/50 transition-colors text-left"
                >
                  <GitBranch className="h-3 w-3 text-muted-foreground shrink-0" />
                  <span className="truncate flex-1">{entity.name}</span>
                  <span className="text-xs text-muted-foreground shrink-0">{entity.relationship}</span>
                  <EntityTypeBadge type={entity.type} />
                </button>
              ))}
            </div>
          </div>
        )}

        {page.tags && page.tags.length > 0 && (
          <div className="px-4 py-3 border-t border-border">
            <div className="flex flex-wrap gap-1.5">
              {page.tags.map((tag) => (
                <span key={tag} className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                  {tag}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="px-4 py-3 border-t border-border flex items-center gap-2">
          {onOpenInGraph && (
            <button
              onClick={() => onOpenInGraph(slug)}
              className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
            >
              Open in Graph
            </button>
          )}
          {page.odooRef && (
            <a
              href={`https://odoo.erpeek.ai/web#model=${page.odooRef.split(":")[0]}&id=${page.odooRef.split(":")[1]}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
            >
              View in Odoo <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
