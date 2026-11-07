import { t, useTranslation, i18n } from "@/i18n";
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
  { key: "isolated_workspace", value: "isolated_workspace", mode: "isolated_workspace", get label() { return t("task-components:newWorktree_4f210afe"); }, get description() { return t("task-components:startInAnIsolatedCheckout_3bbfcd45"); } },
  { key: "shared_workspace", value: "shared_workspace", mode: "shared_workspace", get label() { return t("task-components:projectWorkspace_ce016e7f"); }, get description() { return t("task-components:useTheProjectSSharedCheckout_87c10cff"); } },
  { key: "operator_branch", value: "operator_branch", mode: "operator_branch", get label() { return t("task-components:newBranch_7f445154"); }, get description() { return t("task-components:createABranchInTheProjectWorkspace_a18ecefd"); } },
  { key: "agent_default", value: "agent_default", mode: "agent_default", get label() { return t("task-components:agentDefault_90340504"); }, get description() { return t("task-components:letTheAgentChooseItsWorkspace_b2670138"); } },
  { key: "inherit", value: "inherit", mode: "inherit", get label() { return t("task-components:projectDefault_e8cb80e5"); }, get description() { return t("task-components:useTheProjectSWorktreeSettings_6ae5d813"); } },
];

/** Reuses the searchable selector and the existing workspace recency ordering. */
export function ComposerWorktreePicker({
  mode, workspaceId, workspaces, onChange, loading, error, onRetry,
  disabled, mobile, contentStyle, selectedWorkspaceLabel,
}: ComposerWorktreePickerProps) {
  useTranslation("task-components");
  const groups = useMemo(() => [
    { id: "new", options: [MODE_OPTIONS[0]!] },
    {
      id: "reuse", label: t("task-components:reuseAWorktree_b15c650e"),
      options: orderReusableExecutionWorkspaces(workspaces).map((workspace): WorktreeOption => ({
        key: `reuse:${workspace.id}`, value: `reuse:${workspace.id}`,
        workspaceId: workspace.id, mode: "reuse_existing", label: workspace.name,
        description: workspace.branchName ?? t("task-chat-ui:existingWorkspace"),
        searchText: `${workspace.branchName ?? ""} ${workspace.id}`,
      })),
    },
    {
      id: "other", label: t("task-components:otherOptions_2cbe8465"),
      options: MODE_OPTIONS.filter((option) => option.mode === "shared_workspace"
        || (option.mode !== "isolated_workspace" && option.mode === mode)),
    },
  ], [mode, workspaces, i18n.language]);

  const value = mode === "reuse_existing" ? `reuse:${workspaceId}` : mode;
  return (
    <SearchableSelect<string, WorktreeOption>
      value={value}
      groups={groups}
      onValueChange={(_, option) => onChange(option.mode, option.workspaceId ?? "")}
      placeholder={t("task-components:worktrees_aec2f93d")}
      triggerAriaLabel={t("task-chat-ui:worktrees")}
      mobileTitle={t("task-chat-ui:worktrees")}
      searchPlaceholder={t("task-chat-ui:searchWorktrees")}
      emptyMessage={t("task-components:noMatchingWorktrees_220f5956")}
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
            <span className="hidden text-muted-foreground sm:inline">{t("task-components:worktrees_0b4b48f7")}{" "}</span>
            {option?.label ?? selectedWorkspaceLabel ?? t("task-components:selectWorktree_0b86e7de")}
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
          {loading ? t("task-components:loadingExistingWorktrees_d52f3d5a") : error ? (
            <span className="flex items-center justify-between gap-2">{t("task-components:couldnTLoadWorktrees_33ebd590")}<button type="button" className="rounded px-2 py-1 text-foreground hover:bg-accent" onClick={onRetry}>{t("task-components:retry_942087cc")}</button>
            </span>
          ) : t("task-components:noExistingWorktreesYetChooseNewWorktree_3024c664")}
        </div>
      ) : undefined}
    />
  );
}
