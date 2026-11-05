import { useTranslation, t as translate } from "@/i18n";
import { TabFilters } from "@/components/TabBar";

export const CATALOG_SOURCES = ["paperclip", "composio", "arcade", "installed", "all"] as const;
export type CatalogSource = typeof CATALOG_SOURCES[number];
export const CATALOG_SOURCE_NAMES = { paperclip: "Paperclip", composio: "Composio", arcade: "Arcade", get executor() { return translate("connections:executor_c1f6604"); }, get installed() { return translate("connections:installed_7bb4405"); }, get all() { return translate("connections:all_6a72085"); } };

export function CatalogSourceFilters({ source, onChange }: { source: CatalogSource; onChange: (source: CatalogSource) => void }) {
  const { t } = useTranslation("connections");
  return <TabFilters label={t("app_filters_75b363a")} size="standard" items={CATALOG_SOURCES.map(value => ({ value, label: CATALOG_SOURCE_NAMES[value] }))} value={source} onValueChange={onChange} />;
}
