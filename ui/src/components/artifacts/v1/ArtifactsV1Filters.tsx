import { t, useTranslation } from "@/i18n";
import type { ArtifactGroupBy, ArtifactKindFilter } from "@/api/artifacts";
import { TabFilters, type TabBarItem } from "@/components/TabBar";

/**
 * The Artifacts page's one row of views (mock node 2129:133457): Tasks —
 * one tile per task, the default — then every file flat, by type. Grouping
 * and the kind filter are still two URL parameters; a view maps onto both.
 */
export type ArtifactsV1View = "tasks" | Exclude<ArtifactKindFilter, never>;

export const ARTIFACTS_V1_VIEWS: TabBarItem<ArtifactsV1View>[] = [
  { value: "tasks", get label() { return t("task-components:tasks_b3a60e61"); } },
  { value: "all", get label() { return t("final-components-b:artifacts.v1.ArtifactsV1Filters.All_files_866956"); } },
  { value: "image", get label() { return t("task-components:images_be7e2f20"); } },
  { value: "video", get label() { return t("task-components:videos_c9a96394"); } },
  { value: "document", get label() { return t("task-components:documents_b4e929d8"); } },
  { value: "text", get label() { return t("task-components:text_71988c4d"); } },
  { value: "file", get label() { return t("task-components:files_abc7e989"); } },
];

/** Any grouping reads as the Tasks view; flat views are named by their kind. */
export const artifactsV1View = (groupBy: ArtifactGroupBy, kind: ArtifactKindFilter): ArtifactsV1View => (groupBy !== "none" ? "tasks" : kind);

export function ArtifactsV1Filters({ view, onViewChange }: { view: ArtifactsV1View; onViewChange: (view: ArtifactsV1View) => void }) {
  useTranslation("task-components");
  return <TabFilters items={ARTIFACTS_V1_VIEWS} value={view} onValueChange={onViewChange} size="standard" label={t("final-components-b:artifacts.v1.ArtifactsV1Filters.Show_artifacts_by_task_or_by_type_faa1d8")} />;
}
