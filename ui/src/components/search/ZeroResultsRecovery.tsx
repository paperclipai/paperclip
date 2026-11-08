import { t, useTranslation } from "@/i18n";
import { FilterX, RotateCcw } from "lucide-react";
import type { CompanySearchZeroResults } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import {
  clearFilterDimension,
  countActiveFilters,
  describeLoosenSuggestion,
  type FilterChipLookups,
  type SearchFilters,
} from "@/lib/search-filters";

export function ZeroResultsRecovery({
  query,
  filters,
  zeroResults,
  lookups,
  onChange,
  onClearAll,
}: {
  query: string;
  filters: SearchFilters;
  zeroResults: CompanySearchZeroResults;
  lookups: FilterChipLookups;
  onChange: (next: SearchFilters) => void;
  onClearAll: () => void;
}) {
  useTranslation("task-components");
  const activeCount = countActiveFilters(filters);
  const { unfilteredTotal } = zeroResults;
  // Rank suggestions by how many results each one recovers (highest impact first).
  const suggestions = [...zeroResults.loosenSuggestions].sort(
    (a, b) => b.additionalCount - a.additionalCount,
  );

  return (
    <div
      className="mx-auto flex w-full max-w-xl flex-col items-center gap-4 px-4 py-12 text-center"
      data-testid="search-zero-results-recovery"
    >
      <FilterX className="h-10 w-10 text-muted-foreground" aria-hidden />
      <div className="space-y-1">
        <div className="text-base font-semibold">{t("task-components:noResultsWithTheseFilters_9005fe70")}</div>
        <p className="text-sm text-muted-foreground">
          {query ? t(activeCount === 1 ? "deep-ui:search_hidden_query_single_filter" : "deep-ui:search_hidden_query", { count: unfilteredTotal, query, filters: activeCount }) : t(activeCount === 1 ? "deep-ui:search_hidden_single_filter" : "deep-ui:search_hidden", { count: unfilteredTotal, filters: activeCount })}
        </p>
      </div>

      {suggestions.length > 0 ? (
        <div className="flex w-full flex-col gap-1.5">
          <div className="text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">{t("task-components:loosenAFilter_bbc8b39a")}</div>
          {suggestions.map((suggestion) => (
            <button
              key={`${suggestion.filter}:${suggestion.values.join(",")}`}
              type="button"
              className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-left text-sm hover:border-foreground/30 hover:bg-accent/40"
              onClick={() => onChange(clearFilterDimension(filters, suggestion.filter))}
            >
              <span className="min-w-0 truncate">{t("task-components:remove_c3812fc4")}{" "}
                <span className="font-medium">
                  {describeLoosenSuggestion(suggestion.filter, suggestion.values, lookups)}
                </span>
              </span>
              <span className="shrink-0 tabular-nums text-emerald-600 dark:text-emerald-400">
                +{suggestion.additionalCount} {suggestion.additionalCount === 1 ? t("task-components:result_f6a214f7") : t("task-components:results_c099142b")}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      <Button onClick={onClearAll} variant="default" size="sm">
        <RotateCcw className="mr-1.5 h-4 w-4" />{t("task-components:clearAllFilters_de22447d")}</Button>
    </div>
  );
}
