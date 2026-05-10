import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, ChevronDown, FileText, Plus } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { brainApi } from "@/api/brain";
import type { BrainPageMeta } from "@/api/brain";
import { queryKeys } from "@/lib/queryKeys";
import { EntityTypeBadge } from "./EntityTypeBadge";
import { ENTITY_TYPE_LABELS } from "@/lib/brain-utils";
import { timeAgo } from "@/lib/timeAgo";

interface BrainPagesBrowserProps {
  companyId: string;
  onSelectEntity?: (slug: string) => void;
}

export function BrainPagesBrowser({ companyId, onSelectEntity }: BrainPagesBrowserProps) {
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);

  const { data: directories, isLoading: dirsLoading } = useQuery({
    queryKey: queryKeys.brain.directories(companyId),
    queryFn: () => brainApi.listDirectories(companyId),
    enabled: !!companyId,
  });

  const { data: pages } = useQuery({
    queryKey: queryKeys.brain.pages(companyId),
    queryFn: () => brainApi.listPages(companyId),
    enabled: !!companyId,
  });

  const { data: selectedPage } = useQuery({
    queryKey: queryKeys.brain.page(companyId, selectedSlug ?? ""),
    queryFn: () => brainApi.getPage(companyId, selectedSlug!),
    enabled: !!companyId && !!selectedSlug,
  });

  const pagesByDir = useMemo(() => {
    if (!pages) return new Map<string, BrainPageMeta[]>();
    const map = new Map<string, BrainPageMeta[]>();
    for (const p of pages) {
      const dir = p.slug.includes("/") ? p.slug.split("/")[0] : "_root";
      const list = map.get(dir) ?? [];
      list.push(p);
      map.set(dir, list);
    }
    return map;
  }, [pages]);

  const toggleDir = (dir: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
  };

  const handleSelectPage = (slug: string) => {
    setSelectedSlug(slug);
    onSelectEntity?.(slug);
  };

  if (dirsLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-sm text-muted-foreground">Loading pages...</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="w-56 shrink-0 border-r border-border overflow-y-auto">
        <div className="p-2">
          {(directories ?? []).map((dir) => {
            const isExpanded = expandedDirs.has(dir.name);
            const dirPages = pagesByDir.get(dir.name) ?? [];
            return (
              <div key={dir.name}>
                <button
                  onClick={() => toggleDir(dir.name)}
                  className="flex items-center gap-1.5 w-full px-2 py-1.5 rounded text-sm hover:bg-accent/50 transition-colors text-left"
                >
                  {isExpanded ? (
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  )}
                  <span className="truncate flex-1">
                    {ENTITY_TYPE_LABELS[dir.type] ?? dir.name}
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">{dir.count}</span>
                </button>
                {isExpanded && (
                  <div className="ml-3 border-l border-border">
                    {dirPages.map((p) => (
                      <button
                        key={p.slug}
                        onClick={() => handleSelectPage(p.slug)}
                        className={`flex items-center gap-1.5 w-full pl-3 pr-2 py-1 text-[13px] hover:bg-accent/50 transition-colors text-left ${
                          selectedSlug === p.slug ? "bg-accent text-foreground" : "text-foreground/80"
                        }`}
                      >
                        <FileText className="h-3 w-3 text-muted-foreground shrink-0" />
                        <span className="truncate">{p.title}</span>
                      </button>
                    ))}
                    {dirPages.length === 0 && (
                      <p className="pl-3 py-1.5 text-xs text-muted-foreground">No pages</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex-1 min-w-0 overflow-y-auto">
        {selectedPage ? (
          <div className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <h2 className="text-lg font-semibold">{selectedPage.title}</h2>
              <EntityTypeBadge type={selectedPage.type} />
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground mb-4">
              {selectedPage.tier != null && <span>Tier {selectedPage.tier}</span>}
              {selectedPage.sourceAgent && <span>Agent: {selectedPage.sourceAgent}</span>}
              <span>Created {timeAgo(selectedPage.created)}</span>
              <span>Updated {timeAgo(selectedPage.updated)}</span>
            </div>

            <div className="prose prose-sm dark:prose-invert max-w-none [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm [&_p]:text-[13px] [&_li]:text-[13px]">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{selectedPage.content}</ReactMarkdown>
            </div>

            {selectedPage.linkedEntities.length > 0 && (
              <div className="mt-6 pt-4 border-t border-border">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                  Linked Entities
                </h4>
                <div className="flex flex-wrap gap-2">
                  {selectedPage.linkedEntities.map((e) => (
                    <button
                      key={e.slug}
                      onClick={() => handleSelectPage(e.slug)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent/50 transition-colors"
                    >
                      <span>{e.name}</span>
                      <span className="text-muted-foreground">({e.relationship})</span>
                      <EntityTypeBadge type={e.type} className="text-[9px] px-1.5" />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center p-8">
            <FileText className="h-10 w-10 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">Select a page from the directory tree</p>
          </div>
        )}
      </div>
    </div>
  );
}
