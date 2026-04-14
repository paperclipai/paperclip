import type { ReactNode } from "react";
import type { Issue } from "@paperclipai/shared";
import { createTranslator } from "@paperclipai/i18n";
import { Columns3 } from "lucide-react";
import { pickTextColorForPillBg } from "@/lib/color-contrast";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatAssigneeUserLabel } from "../lib/assignees";
import { useLocale } from "../context/LocaleContext";
import type { InboxIssueColumn } from "../lib/inbox";
import { getCurrentLocale } from "../lib/locale-store";
import { cn } from "../lib/utils";
import { timeAgo } from "../lib/timeAgo";
import { Identity } from "./Identity";
import { StatusIcon } from "./StatusIcon";

export const issueTrailingColumns: InboxIssueColumn[] = ["assignee", "project", "workspace", "parent", "labels", "updated"];

export function issueActivityText(issue: Issue): string {
  const { t } = createTranslator(getCurrentLocale());
  return t("issueColumns.updatedAgo", {
    time: timeAgo(issue.lastActivityAt ?? issue.lastExternalCommentAt ?? issue.updatedAt),
  });
}

function issueTrailingGridTemplate(columns: InboxIssueColumn[]): string {
  return columns
    .map((column) => {
      if (column === "assignee") return "minmax(6rem, 8rem)";
      if (column === "project") return "minmax(4.5rem, 7rem)";
      if (column === "workspace") return "minmax(6rem, 9rem)";
      if (column === "parent") return "minmax(3.5rem, 5.5rem)";
      if (column === "labels") return "minmax(3rem, 6rem)";
      return "minmax(3.5rem, 4.5rem)";
    })
    .join(" ");
}

export function IssueColumnPicker({
  availableColumns,
  visibleColumnSet,
  onToggleColumn,
  onResetColumns,
  title,
  iconOnly = false,
}: {
  availableColumns: InboxIssueColumn[];
  visibleColumnSet: ReadonlySet<InboxIssueColumn>;
  onToggleColumn: (column: InboxIssueColumn, enabled: boolean) => void;
  onResetColumns: () => void;
  title: string;
  iconOnly?: boolean;
}) {
  const { t } = useLocale();
  const issueColumnLabels: Record<InboxIssueColumn, string> = {
    status: t("common.status"),
    id: "ID",
    assignee: t("common.assignee"),
    project: t("common.project"),
    workspace: t("common.workspace"),
    parent: t("issueColumns.parentIssue"),
    labels: t("issueColumns.tags"),
    updated: t("issueColumns.lastUpdated"),
  };
  const issueColumnDescriptions: Record<InboxIssueColumn, string> = {
    status: t("issueColumns.statusDescription"),
    id: t("issueColumns.idDescription"),
    assignee: t("issueColumns.assigneeDescription"),
    project: t("issueColumns.projectDescription"),
    workspace: t("issueColumns.workspaceDescription"),
    parent: t("issueColumns.parentDescription"),
    labels: t("issueColumns.labelsDescription"),
    updated: t("issueColumns.updatedDescription"),
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant={iconOnly ? "outline" : "ghost"}
          size={iconOnly ? "icon" : "sm"}
          className={iconOnly ? "h-8 w-8 shrink-0" : "hidden h-8 shrink-0 px-2 text-xs sm:inline-flex"}
          title={t("issueColumns.columns")}
        >
          <Columns3 className={iconOnly ? "h-3.5 w-3.5" : "mr-1 h-3.5 w-3.5"} />
          {!iconOnly && t("issueColumns.columns")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[300px] rounded-xl border-border/70 p-1.5 shadow-xl shadow-black/10">
        <DropdownMenuLabel className="px-2 pb-1 pt-1.5">
          <div className="space-y-1">
            <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
              {t("issueColumns.desktopIssueRows")}
            </div>
            <div className="text-sm font-medium text-foreground">
              {title}
            </div>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {availableColumns.map((column) => (
          <DropdownMenuCheckboxItem
            key={column}
            checked={visibleColumnSet.has(column)}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(checked) => onToggleColumn(column, checked === true)}
            className="items-start rounded-lg px-3 py-2.5 pl-8"
          >
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-foreground">
                {issueColumnLabels[column]}
              </span>
              <span className="text-xs leading-relaxed text-muted-foreground">
                {issueColumnDescriptions[column]}
              </span>
            </span>
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={onResetColumns}
          className="rounded-lg px-3 py-2 text-sm"
        >
          {t("issueColumns.resetDefaults")}
          <span className="ml-auto text-xs text-muted-foreground">{t("issueColumns.resetDefaultsHint")}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function InboxIssueMetaLeading({
  issue,
  isLive,
  showStatus = true,
  showIdentifier = true,
  statusSlot,
}: {
  issue: Issue;
  isLive: boolean;
  showStatus?: boolean;
  showIdentifier?: boolean;
  statusSlot?: ReactNode;
}) {
  const { t } = useLocale();
  return (
    <>
      {showStatus ? (
        <span className="hidden shrink-0 sm:inline-flex">
          {statusSlot ?? <StatusIcon status={issue.status} />}
        </span>
      ) : null}
      {showIdentifier ? (
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          {issue.identifier ?? issue.id.slice(0, 8)}
        </span>
      ) : null}
      {isLive && (
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 sm:gap-1.5 sm:px-2",
            "bg-blue-500/10",
          )}
        >
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-blue-400 opacity-75" />
            <span
              className={cn(
                "relative inline-flex h-2 w-2 rounded-full",
                "bg-blue-500",
              )}
            />
          </span>
          <span
            className={cn(
              "hidden text-[11px] font-medium sm:inline",
              "text-blue-600 dark:text-blue-400",
            )}
          >
            {t("issueDetail.live")}
          </span>
        </span>
      )}
    </>
  );
}

export function InboxIssueTrailingColumns({
  issue,
  columns,
  projectName,
  projectColor,
  workspaceId,
  workspaceName,
  assigneeName,
  currentUserId,
  parentIdentifier,
  parentTitle,
  assigneeContent,
  onFilterWorkspace,
}: {
  issue: Issue;
  columns: InboxIssueColumn[];
  projectName: string | null;
  projectColor: string | null;
  workspaceId?: string | null;
  workspaceName: string | null;
  assigneeName: string | null;
  currentUserId: string | null;
  parentIdentifier: string | null;
  parentTitle: string | null;
  assigneeContent?: ReactNode;
  onFilterWorkspace?: (workspaceId: string) => void;
}) {
  const { t } = useLocale();
  const activityText = timeAgo(issue.lastActivityAt ?? issue.lastExternalCommentAt ?? issue.updatedAt);
  const userLabel = formatAssigneeUserLabel(issue.assigneeUserId, currentUserId) ?? "User";

  return (
    <span
      className="grid items-center gap-2"
      style={{ gridTemplateColumns: issueTrailingGridTemplate(columns) }}
    >
      {columns.map((column) => {
        if (column === "assignee") {
          if (assigneeContent) {
            return <span key={column} className="min-w-0">{assigneeContent}</span>;
          }

          if (issue.assigneeAgentId) {
            return (
              <span key={column} className="min-w-0 text-xs text-foreground">
                <Identity
                  name={assigneeName ?? issue.assigneeAgentId.slice(0, 8)}
                  size="sm"
                  className="min-w-0"
                />
              </span>
            );
          }

          if (issue.assigneeUserId) {
            return (
              <span key={column} className="min-w-0 truncate text-xs font-medium text-muted-foreground">
                {userLabel}
              </span>
            );
          }

          return (
            <span key={column} className="min-w-0 truncate text-xs text-muted-foreground">
              {t("issueList.unassigned")}
            </span>
          );
        }

        if (column === "project") {
          if (projectName) {
            const accentColor = projectColor ?? "#64748b";
            return (
              <span
                key={column}
                className="inline-flex min-w-0 items-center gap-2 text-xs font-medium"
                style={{ color: pickTextColorForPillBg(accentColor, 0.12) }}
              >
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: accentColor }}
                />
                <span className="truncate">{projectName}</span>
              </span>
            );
          }

          return (
            <span key={column} className="min-w-0 truncate text-xs text-muted-foreground">
              {t("issueDetail.noProject")}
            </span>
          );
        }

        if (column === "labels") {
          if ((issue.labels ?? []).length > 0) {
            return (
              <span key={column} className="flex min-w-0 items-center gap-1 overflow-hidden">
                {(issue.labels ?? []).slice(0, 2).map((label) => (
                  <span
                    key={label.id}
                    className="inline-flex min-w-0 max-w-full shrink-0 items-center rounded-full border px-1.5 py-0 text-[10px] font-medium"
                    style={{
                      borderColor: label.color,
                      color: pickTextColorForPillBg(label.color, 0.12),
                      backgroundColor: `${label.color}1f`,
                    }}
                  >
                    <span className="truncate">{label.name}</span>
                  </span>
                ))}
                {(issue.labels ?? []).length > 2 ? (
                  <span className="shrink-0 text-[10px] font-medium text-muted-foreground">
                    +{(issue.labels ?? []).length - 2}
                  </span>
                ) : null}
              </span>
            );
          }

          return <span key={column} className="min-w-0" aria-hidden="true" />;
        }

        if (column === "workspace") {
          if (!workspaceName) {
            return <span key={column} className="min-w-0" aria-hidden="true" />;
          }

          return (
            <span key={column} className="min-w-0 truncate text-xs text-muted-foreground">
              {workspaceId && onFilterWorkspace ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="truncate rounded-sm text-left text-xs text-muted-foreground transition-colors hover:text-foreground hover:underline"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onFilterWorkspace(workspaceId);
                      }}
                    >
                      {workspaceName}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={6}>
                    {t("issueColumns.filterByWorkspace")}
                  </TooltipContent>
                </Tooltip>
              ) : (
                workspaceName
              )}
            </span>
          );
        }

        if (column === "parent") {
          if (!issue.parentId) {
            return <span key={column} className="min-w-0" aria-hidden="true" />;
          }

          return (
            <span key={column} className="min-w-0 truncate text-xs text-muted-foreground" title={parentTitle ?? undefined}>
              {parentIdentifier ? (
                <span className="font-mono">{parentIdentifier}</span>
              ) : (
                <span className="italic">{t("issueDetail.subIssue")}</span>
              )}
            </span>
          );
        }

        if (column === "updated") {
          return (
            <span key={column} className="min-w-0 truncate text-right text-[11px] font-medium text-muted-foreground">
              {activityText}
            </span>
          );
        }

        return null;
      })}
    </span>
  );
}
