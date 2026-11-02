import { t, useTranslation } from "@/i18n";
import { ToolbarSearch } from "@/components/ToolbarSearch";
import { CatalogSourceFilters, type CatalogSource } from "./CatalogSourceFilters";

/** Shared catalog search and source filters; data and scope changes stay in Browse. */
export function ConnectorsToolbar({ query, onQueryChange, source, onSourceChange }: {
  query: string;
  onQueryChange: (value: string) => void;
  source: CatalogSource;
  onSourceChange: (value: CatalogSource) => void;
}) {
  useTranslation();
  return <header data-canonical-toolbar="connectors" role="toolbar" aria-label={t("oct26Toolbar.connectorsControls")} className="flex flex-wrap items-center gap-3">
    <div className="w-full">
      <ToolbarSearch query={query} onQueryChange={onQueryChange} label={t("oct26Toolbar.searchConnectors")} placeholder={t("oct26Toolbar.searchConnectorsPlaceholder")} inputType="search" />
    </div>
    <CatalogSourceFilters source={source} onChange={onSourceChange} />
  </header>;
}
