import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Hexagon, Loader2, Sparkles } from "lucide-react";
import { issuesApi, type ProjectSuggestion } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

/**
 * One-click project classification for an unclassified issue.
 *
 * Renders in place of the "No project" placeholder. Pulls ranked suggestions
 * from the heuristic classifier (`GET /issues/:id/project-suggestions`) and:
 *  - offers the conservative one-click default (`topConfident`) as a primary
 *    "분류: <project>" chip that applies via the parent's PATCH projectId, and
 *  - exposes the full ranked list in a dropdown for manual override.
 *
 * When the classifier has no usable signal it falls back to the plain
 * "프로젝트 없음" placeholder, so the chip never blocks or misleads.
 */
export function IssueProjectSuggestionChip({
  issueId,
  onApply,
  isApplying,
  enabled = true,
}: {
  issueId: string;
  onApply: (projectId: string) => void;
  isApplying: boolean;
  enabled?: boolean;
}) {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.issues.projectSuggestions(issueId),
    queryFn: () => issuesApi.getProjectSuggestions(issueId),
    enabled,
    staleTime: 60_000,
  });

  const placeholder = (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground opacity-50 px-1 -mx-1 py-0.5">
      <Hexagon className="h-3 w-3 shrink-0" />
      프로젝트 없음
    </span>
  );

  if (isLoading) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground opacity-60 px-1 -mx-1 py-0.5">
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
        분류 제안 확인 중…
      </span>
    );
  }

  const suggestions = data?.suggestions ?? [];
  if (suggestions.length === 0) {
    return placeholder;
  }

  const top = data?.topConfident ?? null;

  const formatScore = (score: number) => `${Math.round(score * 100)}%`;

  const renderMenu = (suggestionList: ProjectSuggestion[]) => (
    <DropdownMenuContent align="start" className="w-72">
      <DropdownMenuLabel className="text-[11px] font-medium text-muted-foreground">
        프로젝트 분류 제안
      </DropdownMenuLabel>
      <DropdownMenuSeparator />
      {suggestionList.map((s) => (
        <DropdownMenuItem
          key={s.projectId}
          disabled={isApplying}
          onSelect={(event) => {
            event.preventDefault();
            onApply(s.projectId);
          }}
          className="flex flex-col items-start gap-0.5"
        >
          <div className="flex w-full items-center justify-between gap-2">
            <span className="truncate font-medium">{s.projectName}</span>
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
              {formatScore(s.score)}
            </span>
          </div>
          {s.matchedTerms.length > 0 ? (
            <span className="w-full truncate text-[10px] text-muted-foreground">
              {s.matchedTerms.join(", ")}
            </span>
          ) : null}
        </DropdownMenuItem>
      ))}
    </DropdownMenuContent>
  );

  // Confident default → primary one-click apply, with a caret for the ranked
  // override list. Otherwise (ambiguous) → caret-only "제안" dropdown.
  if (top) {
    return (
      <span className="inline-flex items-center rounded-full border border-primary/40 bg-primary/10 text-xs text-primary">
        <button
          type="button"
          disabled={isApplying}
          onClick={() => onApply(top.projectId)}
          title={top.reason}
          className="inline-flex items-center gap-1 rounded-l-full px-2 py-0.5 transition-colors hover:bg-primary/20 disabled:opacity-60"
        >
          {isApplying ? (
            <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
          ) : (
            <Sparkles className="h-3 w-3 shrink-0" />
          )}
          <span className="truncate">분류: {top.projectName}</span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={isApplying}
              title="다른 프로젝트로 분류"
              className="inline-flex items-center rounded-r-full border-l border-primary/30 px-1 py-0.5 transition-colors hover:bg-primary/20 disabled:opacity-60"
            >
              <ChevronDown className="h-3 w-3 shrink-0" />
            </button>
          </DropdownMenuTrigger>
          {renderMenu(suggestions)}
        </DropdownMenu>
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={isApplying}
          title="프로젝트 분류 제안 보기"
          className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs text-primary transition-colors hover:bg-primary/20 disabled:opacity-60"
        >
          {isApplying ? (
            <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
          ) : (
            <Sparkles className="h-3 w-3 shrink-0" />
          )}
          <span>분류 제안 {suggestions.length}</span>
          <ChevronDown className="h-3 w-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      {renderMenu(suggestions)}
    </DropdownMenu>
  );
}
