import { t, useTranslation } from "@/i18n";
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
  useTranslation("task-components");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 gap-1 text-xs font-normal" aria-label={t("task-components:sortResults_765b3c6a")}>
          <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          <span className="hidden sm:inline text-muted-foreground">{t("task-components:sort_8f3e7ea6")}</span>
          <span>{SORT_LABELS[value]}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel className="text-xs text-muted-foreground">{t("task-components:sortBy_c9129025")}</DropdownMenuLabel>
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
