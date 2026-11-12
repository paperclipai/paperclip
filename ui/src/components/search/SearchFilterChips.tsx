import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buildFilterChips, type FilterChipLookups, type SearchFilters } from "@/lib/search-filters";

export function SearchFilterChips({
  filters,
  lookups,
  onChange,
  onClearAll,
}: {
  filters: SearchFilters;
  lookups: FilterChipLookups;
  onChange: (next: SearchFilters) => void;
  onClearAll: () => void;
}) {
  const chips = buildFilterChips(filters, lookups);
  if (chips.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="search-filter-chips">
      {chips.map((chip) => (
        <Badge key={chip.id} variant="secondary" className="gap-1 pr-1 font-normal">
          <span className="truncate">{chip.label}</span>
          <button
            type="button"
            className="rounded-full p-0.5 hover:bg-background/60"
            onClick={() => onChange(chip.remove(filters))}
            aria-label={`Remove filter ${chip.label}`}
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}
      <button
        type="button"
        className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        onClick={onClearAll}
      >
        Clear all
      </button>
    </div>
  );
}
