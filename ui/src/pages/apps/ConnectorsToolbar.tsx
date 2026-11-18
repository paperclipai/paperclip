import type { ReactNode } from "react";
import { ToolbarSearch } from "@/components/ToolbarSearch";
import { CatalogSourceFilters, type CatalogSource } from "./CatalogSourceFilters";

/** Shared catalog search and source filters; data and scope changes stay in Browse. */
export function ConnectorsToolbar({ query, onQueryChange, source, onSourceChange, action }: {
  query: string;
  onQueryChange: (value: string) => void;
  source: CatalogSource;
  onSourceChange: (value: CatalogSource) => void;
  action?: ReactNode;
}) {
  return <header data-canonical-toolbar="connectors" role="toolbar" aria-label="Connectors controls" className="flex flex-wrap items-center gap-3">
    <div className="flex w-full items-center gap-3">
      <div className="min-w-0 flex-1">
        <ToolbarSearch query={query} onQueryChange={onQueryChange} label="Search connectors" placeholder="Search connectors…" inputType="search" />
      </div>
      {action}
    </div>
    <CatalogSourceFilters source={source} onChange={onSourceChange} />
  </header>;
}
