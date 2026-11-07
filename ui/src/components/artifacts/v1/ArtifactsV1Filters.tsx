import { useMemo } from "react";
import type { ArtifactGroupBy, ArtifactKindFilter } from "@/api/artifacts";
import { TabFilters, type TabBarItem } from "@/components/TabBar";
import { useTranslation } from "@/i18n";

/**
 * The Artifacts page's one row of views (mock node 2129:133457): Tasks —
 * one tile per task, the default — then every file flat, by type. Grouping
 * and the kind filter are still two URL parameters; a view maps onto both.
 */
export type ArtifactsV1View = "tasks" | Exclude<ArtifactKindFilter, never>;

export const ARTIFACTS_V1_VIEWS: TabBarItem<ArtifactsV1View>[] = [
  { value: "tasks", label: "Tasks" },
  { value: "all", label: "All files" },
  { value: "image", label: "Images" },
  { value: "video", label: "Videos" },
  { value: "document", label: "Documents" },
  { value: "text", label: "Text" },
  { value: "file", label: "Files" },
];

/** Any grouping reads as the Tasks view; flat views are named by their kind. */
export const artifactsV1View = (groupBy: ArtifactGroupBy, kind: ArtifactKindFilter): ArtifactsV1View => (groupBy !== "none" ? "tasks" : kind);

export function ArtifactsV1Filters({ view, onViewChange }: { view: ArtifactsV1View; onViewChange: (view: ArtifactsV1View) => void }) {
  const { t } = useTranslation();
  const items: TabBarItem<ArtifactsV1View>[] = useMemo(() => [
    { value: "tasks", label: t("artifacts.v1.tasks") },
    { value: "all", label: t("artifacts.v1.allFiles") },
    { value: "image", label: t("artifacts.filters.images") },
    { value: "video", label: t("artifacts.filters.videos") },
    { value: "document", label: t("artifacts.filters.documents") },
    { value: "text", label: t("artifacts.filters.text") },
    { value: "file", label: t("artifacts.filters.files") },
  ], [t]);
  return <TabFilters items={items} value={view} onValueChange={onViewChange} size="standard" label={t("artifacts.v1.filterLabel")} />;
}
