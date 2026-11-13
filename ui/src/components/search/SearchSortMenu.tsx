import { ArrowUpDown, Check } from "lucide-react";
import { COMPANY_SEARCH_SORTS, type CompanySearchSort } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SORT_LABELS } from "@/lib/search-filters";
import { cn } from "@/lib/utils";

export function SearchSortMenu({
  value,
  onChange,
}: {
  value: CompanySearchSort;
  onChange: (next: CompanySearchSort) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 gap-1 text-xs font-normal" aria-label="Sort results">
          <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          <span className="hidden sm:inline text-muted-foreground">Sort:</span>
          <span>{SORT_LABELS[value]}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Sort by</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {COMPANY_SEARCH_SORTS.map((sort) => (
          <DropdownMenuItem key={sort} onSelect={() => onChange(sort)} className="gap-2 text-sm">
            <Check className={cn("h-3.5 w-3.5", sort === value ? "opacity-100 text-primary" : "opacity-0")} />
            {SORT_LABELS[sort]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
