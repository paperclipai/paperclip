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
  { value: "all", label: "All" },
  { value: "image", label: "Images" },
  { value: "video", label: "Videos" },
  { value: "document", label: "Documents" },
  { value: "text", label: "Text" },
  { value: "file", label: "Files" },
];

export const ARTIFACT_GROUP_OPTIONS: { value: ArtifactGroupBy; label: string }[] = [
  { value: "none", label: "None" },
  { value: "task", label: "Task" },
  { value: "parent_task", label: "Parent task" },
];

export const ARTIFACT_KIND_LABEL_KEYS = {
  "all": "oct26Artifacts.kind.all",
  "image": "oct26Artifacts.kind.image",
  "video": "oct26Artifacts.kind.video",
  "document": "oct26Artifacts.kind.document",
  "text": "oct26Artifacts.kind.text",
  "file": "oct26Artifacts.kind.file"
} as const;
const GROUP_LABEL_KEYS = {
  "none": "oct26Artifacts.group.none",
  "task": "oct26Artifacts.group.task",
  "parent_task": "oct26Artifacts.group.parent_task"
} as const;

export function artifactGroupByLabel(value: ArtifactGroupBy): string {
  return t(GROUP_LABEL_KEYS[value] ?? GROUP_LABEL_KEYS.none);
}

/** Canonical collection filters; compact standalone, standard in the toolbar. */
export function ArtifactKindFilters({ kind, onKindChange, size = "compact" }: { kind: ArtifactKindFilter; onKindChange: (value: ArtifactKindFilter) => void; size?: TabSize }) {
  const { t } = useTranslation();
  return <TabFilters items={ARTIFACT_KIND_FILTERS.map(option => ({ ...option, label: t(ARTIFACT_KIND_LABEL_KEYS[option.value]) }))} value={kind} onValueChange={onKindChange} size={size} label={t("oct26Artifacts.filterByType")} />;
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
  const { t } = useTranslation();
  const grouping = groupBy !== "none";
  return (
    <div data-canonical-toolbar="artifacts" role="toolbar" aria-label={t("oct26Artifacts.controls")} className="flex flex-col items-start gap-4">
      <div className="design-toolbar-controls flex w-full flex-wrap items-center gap-4">
        <ToolbarSearch query={draftQuery} onQueryChange={setDraftQuery} label={t("oct26Artifacts.search")} placeholder={t("oct26Artifacts.searchPlaceholder")} clearLabel={t("oct26Artifacts.clearSearch")} />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={t("oct26Artifacts.currentGrouping", { group: artifactGroupByLabel(groupBy) })}
              title={t("oct26Artifacts.groupArtifacts")}
              data-testid="artifact-group-control"
              data-group-by={groupBy}
              data-active={grouping}
              className={cn("h-8 w-8 shrink-0", grouping && "bg-accent")}
            >
              <Layers className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuLabel>{t("oct26Artifacts.groupBy")}</DropdownMenuLabel>
            {ARTIFACT_GROUP_OPTIONS.map((option) => (
              <DropdownMenuItem
                key={option.value}
                data-testid={`artifact-group-option-${option.value}`}
                aria-selected={groupBy === option.value}
                onSelect={() => selectGroupBy(option.value)}
                className="justify-between"
              >
                {artifactGroupByLabel(option.value)}
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
