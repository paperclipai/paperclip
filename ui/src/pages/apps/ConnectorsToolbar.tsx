import { ToolbarSearch } from "@/components/ToolbarSearch";
import { CatalogSourceFilters, type CatalogSource } from "./CatalogSourceFilters";
import { useTranslation } from "@/i18n";

/** Shared catalog search and source filters; data and scope changes stay in Browse. */
export function ConnectorsToolbar({ query, onQueryChange, source, onSourceChange }: {
  query: string;
  onQueryChange: (value: string) => void;
  source: CatalogSource;
  onSourceChange: (value: CatalogSource) => void;
}) {
  const { t } = useTranslation();
  return <header data-canonical-toolbar="connectors" role="toolbar" aria-label={t("apps.browse.toolbarControlsAria", { defaultValue: "Connectors controls" })} className="flex flex-wrap items-center gap-3">
    <div className="w-full">
      <ToolbarSearch query={query} onQueryChange={onQueryChange} label={t("apps.browse.searchConnectors", { defaultValue: "Search connectors" })} placeholder={t("apps.browse.searchConnectorsPlaceholder", { defaultValue: "Search connectors…" })} inputType="search" />
    </div>
    <CatalogSourceFilters source={source} onChange={onSourceChange} />
  </header>;
}
