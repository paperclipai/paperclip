import { type ReactNode, useMemo } from "react";
import { useTranslation } from "@/i18n";
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

export function getArtifactGroupOptions(t: (key: string) => string): { value: ArtifactGroupBy; label: string }[] {
  return [
    { value: "none", label: t("artifacts.groupBy.none") },
    { value: "task", label: t("artifacts.groupBy.task") },
    { value: "parent_task", label: t("artifacts.groupBy.parentTask") },
  ];
}

export function artifactGroupByLabel(value: ArtifactGroupBy, t?: (key: string) => string): string {
  if (t) {
    return getArtifactGroupOptions(t).find((option) => option.value === value)?.label ?? t("artifacts.groupBy.none");
  }
  return ARTIFACT_GROUP_OPTIONS.find((option) => option.value === value)?.label ?? "None";
}

/** Canonical collection filters; compact standalone, standard in the toolbar. */
export function ArtifactKindFilters({ kind, onKindChange, size = "compact" }: { kind: ArtifactKindFilter; onKindChange: (value: ArtifactKindFilter) => void; size?: TabSize }) {
  const { t } = useTranslation();
  const items = useMemo(() => [
    { value: "all" as const, label: t("artifacts.filters.all") },
    { value: "image" as const, label: t("artifacts.filters.images") },
    { value: "video" as const, label: t("artifacts.filters.videos") },
    { value: "document" as const, label: t("artifacts.filters.documents") },
    { value: "text" as const, label: t("artifacts.filters.text") },
    { value: "file" as const, label: t("artifacts.filters.files") },
  ], [t]);
  return <TabFilters items={items} value={kind} onValueChange={onKindChange} size={size} label={t("artifacts.filters.label")} />;
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
  const groupOptions = useMemo(() => getArtifactGroupOptions(t), [t]);
  return (
    <div data-canonical-toolbar="artifacts" role="toolbar" aria-label={t("artifacts.toolbar.controlsAria")} className="flex flex-col items-start gap-4">
      <div className="design-toolbar-controls flex w-full flex-wrap items-center gap-4">
        <ToolbarSearch query={draftQuery} onQueryChange={setDraftQuery} label={t("artifacts.toolbar.searchLabel")} placeholder={t("artifacts.toolbar.searchPlaceholder")} clearLabel={t("artifacts.toolbar.clearSearch")} />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={t("artifacts.toolbar.groupAria", { current: artifactGroupByLabel(groupBy, t) })}
              title={t("artifacts.toolbar.groupTitle")}
              data-testid="artifact-group-control"
              data-group-by={groupBy}
              data-active={grouping}
              className={cn("h-8 w-8 shrink-0", grouping && "bg-accent")}
            >
              <Layers className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuLabel>{t("artifacts.toolbar.groupBy")}</DropdownMenuLabel>
            {groupOptions.map((option) => (
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
