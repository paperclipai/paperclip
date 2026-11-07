import { useTranslation } from "@/i18n";
import { ToolbarSearch } from "@/components/ToolbarSearch";
import { CatalogSourceFilters, type CatalogSource } from "./CatalogSourceFilters";

/** Shared catalog search and source filters; data and scope changes stay in Browse. */
export function ConnectorsToolbar({ query, onQueryChange, source, onSourceChange }: {
  query: string;
  onQueryChange: (value: string) => void;
  source: CatalogSource;
  onSourceChange: (value: CatalogSource) => void;
}) {
  const { t } = useTranslation("connections");
  return <header data-canonical-toolbar="connectors" role="toolbar" aria-label={t("connectors_controls_350cc1e")} className="flex flex-wrap items-center gap-3">
    <div className="w-full">
      <ToolbarSearch query={query} onQueryChange={onQueryChange} label={t("search_connectors_9ffb52f")} placeholder={t("search_connectors_99e1c59")} inputType="search" />
    </div>
    <CatalogSourceFilters source={source} onChange={onSourceChange} />
  </header>;
}
