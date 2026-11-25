import { ToolbarSearch } from "@/components/ToolbarSearch";
import { CatalogSourceFilters, type CatalogSource } from "./CatalogSourceFilters";

/** Shared catalog search and source filters; data and scope changes stay in Browse. */
export function ConnectorsToolbar({ query, onQueryChange, source, onSourceChange }: {
  query: string;
  onQueryChange: (value: string) => void;
  source: CatalogSource;
  onSourceChange: (value: CatalogSource) => void;
}) {
  return <header data-canonical-toolbar="connectors" role="toolbar" aria-label="Connectors controls" className="flex flex-wrap items-center gap-3">
    <CatalogSourceFilters source={source} onChange={onSourceChange} />
    <div className="ml-auto w-full sm:w-80">
      <ToolbarSearch query={query} onQueryChange={onQueryChange} label="Search connectors" placeholder="Search connectors…" inputType="search" />
    </div>
  </header>;
}
