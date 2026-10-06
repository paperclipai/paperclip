import { t, useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const CATALOG_SOURCES = ["paperclip", "composio", "arcade", "installed", "all"] as const;
export type CatalogSource = typeof CATALOG_SOURCES[number];
export const CATALOG_SOURCE_NAMES = { paperclip: "Paperclip", composio: "Composio", arcade: "Arcade", executor: "Executor", get installed() { return t("oct5Core.s0402"); }, get all() { return t("localizationActivityChrome.all"); } };

export function CatalogSourceFilters({ source, onChange }: { source: CatalogSource; onChange: (source: CatalogSource) => void }) {
  useTranslation();
  return <nav aria-label={t("oct6Beta.copy259")} className="flex flex-wrap gap-1">
    {CATALOG_SOURCES.map(value => <Button key={value} variant="ghost" size="sm" aria-pressed={value === source}
      onClick={() => onChange(value)} className={cn("rounded-full px-4 font-normal", value === source ? "bg-accent text-foreground" : "text-muted-foreground")}>
      {CATALOG_SOURCE_NAMES[value]}
    </Button>)}
  </nav>;
}
