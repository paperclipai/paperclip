import { t, useTranslation } from "@/i18n";
import { useMemo, type CSSProperties } from "react";
import { Folder, GitBranch, GitBranchPlus, Monitor } from "lucide-react";
import type { ExecutionWorkspaceSummary } from "@paperclipai/shared";
import { SearchableSelect, type SearchableSelectOption } from "@/components/SearchableSelect";
import { orderReusableExecutionWorkspaces } from "@/lib/reusable-execution-workspaces";

interface WorktreeOption extends SearchableSelectOption {
  mode: string;
  workspaceId?: string;
  description: string;
}

interface ComposerWorktreePickerProps {
  mode: string;
  workspaceId: string;
  workspaces: readonly ExecutionWorkspaceSummary[];
  onChange: (mode: string, workspaceId: string) => void;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  disabled?: boolean;
  mobile?: boolean;
  contentStyle?: CSSProperties;
  selectedWorkspaceLabel?: string;
}

const MODE_OPTIONS: WorktreeOption[] = [
  { key: "isolated_workspace", value: "isolated_workspace", mode: "isolated_workspace", get label() { return t("oct6Beta.copy117"); }, get description() { return t("oct6Beta.copy118"); } },
  { key: "shared_workspace", value: "shared_workspace", mode: "shared_workspace", get label() { return t("localizationIssuePanels.field_projectWorkspaceId"); }, get description() { return t("oct6Beta.copy119"); } },
  { key: "operator_branch", value: "operator_branch", mode: "operator_branch", get label() { return t("oct6Beta.copy120"); }, get description() { return t("oct6Beta.copy121"); } },
  { key: "agent_default", value: "agent_default", mode: "agent_default", get label() { return t("oct5Core.s0151"); }, get description() { return t("oct6Beta.copy122"); } },
  { key: "inherit", value: "inherit", mode: "inherit", get label() { return t("localizationIssueAux.ui_Project_default_8qthk7"); }, get description() { return t("oct6Beta.copy123"); } },
];

/** Reuses the searchable selector and the existing workspace recency ordering. */
export function ComposerWorktreePicker({
  mode, workspaceId, workspaces, onChange, loading, error, onRetry,
  disabled, mobile, contentStyle, selectedWorkspaceLabel,
}: ComposerWorktreePickerProps) {
  useTranslation();
  const groups = useMemo(() => [
    { id: "new", options: [MODE_OPTIONS[0]!] },
    {
      id: "reuse", label: t("oct6Beta.copy124"),
      options: orderReusableExecutionWorkspaces(workspaces).map((workspace): WorktreeOption => ({
        key: `reuse:${workspace.id}`, value: `reuse:${workspace.id}`,
        workspaceId: workspace.id, mode: "reuse_existing", label: workspace.name,
        description: workspace.branchName ?? t("oct6Beta.copy125"),
        searchText: `${workspace.branchName ?? ""} ${workspace.id}`,
      })),
    },
    {
      id: "other", label: t("oct6Beta.copy126"),
      options: MODE_OPTIONS.filter((option) => option.mode === "shared_workspace"
        || (option.mode !== "isolated_workspace" && option.mode === mode)),
    },
  ], [mode, workspaces]);

  const value = mode === "reuse_existing" ? `reuse:${workspaceId}` : mode;
  return (
    <SearchableSelect<string, WorktreeOption>
      value={value}
      groups={groups}
      onValueChange={(_, option) => onChange(option.mode, option.workspaceId ?? "")}
      placeholder={t("oct6Beta.copy127")}
      triggerAriaLabel={t("oct6Beta.copy127")}
      mobileTitle={t("oct6Beta.copy127")}
      searchPlaceholder={t("oct6Beta.copy128")}
      emptyMessage={t("oct6Beta.copy129")}
      disabled={disabled}
      modal={mobile}
      contentStyle={contentStyle}
      contentWidth="auto"
      className="min-w-0 flex-1 sm:flex-none sm:max-w-72"
      triggerClassName="h-8 gap-1.5 border-0 bg-transparent px-2 text-xs font-medium shadow-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-0"
      renderValue={(option) => (
        <span className="flex min-w-0 items-center gap-1.5">
          <GitBranch className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">
            <span className="hidden text-muted-foreground sm:inline">{t("oct6Beta.copy130")} </span>
            {option?.label ?? selectedWorkspaceLabel ?? t("oct6Beta.copy131")}
          </span>
        </span>
      )}
      renderOption={(option) => {
        const Icon = option.workspaceId ? GitBranch : option.mode === "isolated_workspace" ? GitBranchPlus
          : option.mode === "agent_default" ? Monitor : option.mode === "operator_branch" ? GitBranch : Folder;
        return (
          <>
            <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{option.label}</span>
              <span className="truncate text-xs text-muted-foreground">{option.description}</span>
            </span>
          </>
        );
      }}
      listFooter={loading || error || workspaces.length === 0 ? (
        <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground" role="status">
          {loading ? t("oct6Beta.copy132") : error ? (
            <span className="flex items-center justify-between gap-2">
              {t("oct6Beta.copy133")}
              <button type="button" className="rounded px-2 py-1 text-foreground hover:bg-accent" onClick={onRetry}>{t("oct5Core.s0281")}</button>
            </span>
          ) : t("oct6Beta.copy134")}
        </div>
      ) : undefined}
    />
  );
}
