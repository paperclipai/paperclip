import { t, useTranslation } from "@/i18n";
import type { ReactNode } from "react";
import { Check, Layers } from "lucide-react";
import type { ArtifactGroupBy, ArtifactKindFilter } from "@/api/artifacts";
import { TabFilters, type TabSize } from "@/components/TabBar";
import { Button } from "@/components/ui/button";
import { ToolbarSearch } from "@/components/ToolbarSearch";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export const ARTIFACT_KIND_FILTERS: { value: ArtifactKindFilter; label: string }[] = [
  { value: "all", get label() { return t("task-components:all_a52ace42"); } },
  { value: "image", get label() { return t("task-components:images_be7e2f20"); } },
  { value: "video", get label() { return t("task-components:videos_c9a96394"); } },
  { value: "document", get label() { return t("task-components:documents_b4e929d8"); } },
  { value: "text", get label() { return t("task-components:text_71988c4d"); } },
  { value: "file", get label() { return t("task-components:files_abc7e989"); } },
];

export const ARTIFACT_GROUP_OPTIONS: { value: ArtifactGroupBy; label: string }[] = [
  { value: "none", get label() { return t("task-components:none_dc937b59"); } },
  { value: "task", get label() { return t("task-components:task_4bc74b21"); } },
  { value: "parent_task", get label() { return t("task-components:parentTask_fb8d8591"); } },
];

export function artifactGroupByLabel(value: ArtifactGroupBy): string {
  return ARTIFACT_GROUP_OPTIONS.find((option) => option.value === value)?.label ?? t("task-components:none_dc937b59");
}

/** Canonical collection filters; compact standalone, standard in the toolbar. */
export function ArtifactKindFilters({ kind, onKindChange, size = "compact" }: { kind: ArtifactKindFilter; onKindChange: (value: ArtifactKindFilter) => void; size?: TabSize }) {
  useTranslation("task-components");
  return <TabFilters items={ARTIFACT_KIND_FILTERS} value={kind} onValueChange={onKindChange} size={size} label={t("task-components:filterArtifactsByType_ff8bce09")} />;
}

export interface ArtifactsToolbarProps {
  query: string;
  onQueryChange: (value: string) => void;
  groupBy: ArtifactGroupBy;
  onGroupByChange: (value: ArtifactGroupBy) => void;
  kind: ArtifactKindFilter;
  onKindChange: (value: ArtifactKindFilter) => void;
  /** Replaces the kind filter row (Artifacts V1 shows its own view tabs). */
  filters?: ReactNode;
}

/** Shared shipped Artifacts controls. Canonical proposal: Components / Toolbars / Artifacts. */
export function ArtifactsToolbar({ query: draftQuery, onQueryChange: setDraftQuery, groupBy, onGroupByChange: selectGroupBy, kind, onKindChange: selectKind, filters }: ArtifactsToolbarProps) {
  useTranslation("task-components");
  const grouping = groupBy !== "none";
  return (
    <div data-canonical-toolbar="artifacts" role="toolbar" aria-label={t("task-components:artifactsControls_e239d8d3")} className="flex flex-col items-start gap-4">
      <div className="design-toolbar-controls flex w-full flex-wrap items-center gap-4">
        <ToolbarSearch query={draftQuery} onQueryChange={setDraftQuery} label={t("task-components:searchArtifacts_c71436cc")} placeholder={t("task-components:searchArtifacts_394d7417")} clearLabel={t("final-components-a:clearArtifactSearch_3bbc1b58")} />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={t("task-components:groupArtifactsCurrently_e147b6c3", { value1: artifactGroupByLabel(groupBy) })}
              title={t("task-components:groupArtifacts_49a9799e")}
              data-testid="artifact-group-control"
              data-group-by={groupBy}
              data-active={grouping}
              className={cn("h-8 w-8 shrink-0", grouping && "bg-accent")}
            >
              <Layers className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuLabel>{t("task-components:groupBy_956a51f6")}</DropdownMenuLabel>
            {ARTIFACT_GROUP_OPTIONS.map((option) => (
              <DropdownMenuItem
                key={option.value}
                data-testid={`artifact-group-option-${option.value}`}
                aria-selected={groupBy === option.value}
                onSelect={() => selectGroupBy(option.value)}
                className="justify-between"
              >
                {option.label}
                {groupBy === option.value ? <Check className="h-3.5 w-3.5" /> : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {filters ?? <ArtifactKindFilters kind={kind} onKindChange={selectKind} size="standard" />}
    </div>
  );
}
