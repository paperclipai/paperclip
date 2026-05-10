import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, Loader2 } from "lucide-react";
import { brainApi } from "@/api/brain";
import { queryKeys } from "@/lib/queryKeys";
import { EntityTypeBadge } from "./EntityTypeBadge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface BrainSearchProps {
  companyId: string;
  onSelectEntity?: (slug: string) => void;
}

type SearchMode = "hybrid" | "keyword" | "semantic";

export function BrainSearch({ companyId, onSelectEntity }: BrainSearchProps) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("hybrid");
  const [submittedQuery, setSubmittedQuery] = useState("");

  const { data: results, isLoading, isFetching } = useQuery({
    queryKey: queryKeys.brain.search(companyId, `${mode}:${submittedQuery}`),
    queryFn: () => brainApi.search(companyId, { query: submittedQuery, mode, limit: 30 }),
    enabled: !!companyId && submittedQuery.length > 0,
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim()) setSubmittedQuery(query.trim());
  };

  return (
    <div className="flex flex-col h-full min-h-0 p-4">
      <form onSubmit={handleSubmit} className="flex items-center gap-2 mb-4 shrink-0">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search the brain..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-md border border-border bg-background pl-9 pr-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <Select value={mode} onValueChange={(v) => setMode(v as SearchMode)}>
          <SelectTrigger className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="hybrid">Hybrid</SelectItem>
            <SelectItem value="keyword">Keyword</SelectItem>
            <SelectItem value="semantic">Semantic</SelectItem>
          </SelectContent>
        </Select>
        <button
          type="submit"
          disabled={!query.trim()}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:pointer-events-none"
        >
          Search
        </button>
      </form>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {isFetching && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {!isFetching && submittedQuery && results && results.length === 0 && (
          <div className="text-center py-8">
            <p className="text-sm text-muted-foreground">No results found for &ldquo;{submittedQuery}&rdquo;</p>
          </div>
        )}

        {!isFetching && results && results.length > 0 && (
          <div className="space-y-1">
            {results.map((result) => (
              <button
                key={result.slug}
                onClick={() => onSelectEntity?.(result.slug)}
                className="flex flex-col w-full rounded-md border border-border px-4 py-3 text-left hover:bg-accent/50 transition-colors"
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-medium truncate">{result.title}</span>
                  <EntityTypeBadge type={result.type} />
                  <span className="ml-auto text-xs text-muted-foreground tabular-nums shrink-0">
                    {(result.score * 100).toFixed(0)}%
                  </span>
                </div>
                <p className="text-xs text-muted-foreground line-clamp-2">{result.snippet}</p>
                {result.sourceAgent && (
                  <span className="text-[10px] text-muted-foreground/70 mt-1">by {result.sourceAgent}</span>
                )}
              </button>
            ))}
          </div>
        )}

        {!submittedQuery && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Search className="h-10 w-10 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">
              Search across all brain knowledge using hybrid, keyword, or semantic search
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
