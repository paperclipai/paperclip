import { TabFilters } from "@/components/TabBar";
import { useTranslation } from "@/i18n";

export const CATALOG_SOURCES = ["paperclip", "composio", "arcade", "installed", "all"] as const;
export type CatalogSource = typeof CATALOG_SOURCES[number];
export const CATALOG_SOURCE_NAMES = { paperclip: "Paperclip", composio: "Composio", arcade: "Arcade", executor: "Executor", installed: "Installed", all: "All" };

export function CatalogSourceFilters({ source, onChange }: { source: CatalogSource; onChange: (source: CatalogSource) => void }) {
  const { t } = useTranslation();
  return <TabFilters
    label={t("apps.browse.appFiltersAria", { defaultValue: "App filters" })}
    size="standard"
    items={CATALOG_SOURCES.map(value => ({
      value,
      label: t(`apps.browse.source${value.charAt(0).toUpperCase() + value.slice(1)}`, { defaultValue: CATALOG_SOURCE_NAMES[value] }),
    }))}
    value={source}
    onValueChange={onChange}
  />;
}
