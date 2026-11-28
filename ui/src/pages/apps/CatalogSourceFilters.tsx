import { TabFilters } from "@/components/TabBar";

export const CATALOG_SOURCES = ["all", "composio", "arcade", "installed"] as const;
export type CatalogSource = typeof CATALOG_SOURCES[number];
export const CATALOG_SOURCE_NAMES = { composio: "Composio", arcade: "Arcade", executor: "Executor", installed: "Installed", all: "All" };

export function CatalogSourceFilters({ source, onChange }: { source: CatalogSource; onChange: (source: CatalogSource) => void }) {
  return <TabFilters label="App filters" size="standard" items={CATALOG_SOURCES.map(value => ({ value, label: CATALOG_SOURCE_NAMES[value] }))} value={source} onValueChange={onChange} />;
}
