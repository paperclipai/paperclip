import { t, useTranslation, Trans } from "@/i18n";
import { AgentIdentity } from "@/components/AgentIdentity";
import type { AvatarAgent } from "./AgentAvatar";
import type { ReactNode } from "react";
import { deriveOriginatingActor, type Issue } from "@paperclipai/shared";
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
import type { InboxIssueColumn } from "../lib/inbox";
import { cn } from "../lib/utils";
import { timeAgo } from "../lib/timeAgo";
import { Identity } from "./Identity";
import { StatusIcon } from "./StatusIcon";
import { Badge } from "@/components/ui/badge";

export const issueTrailingColumns: InboxIssueColumn[] = ["assignee", "kickedOffBy", "project", "workspace", "parent", "labels", "updated"];

const issueColumnLabels: Record<InboxIssueColumn, string> = {
  get status() { return t("final-components-a:status_920e413c"); },
  id: "ID",
  get assignee() { return t("final-components-a:responsible_bc110a6d"); },
  get kickedOffBy() { return t("final-components-a:kickedOffBy_927efd2b"); },
  get project() { return t("final-components-a:project_98595978"); },
  get workspace() { return t("final-components-a:workspace_87bb59ba"); },
  get parent() { return t("final-components-a:parentTask_fb8d8591"); },
  get labels() { return t("final-components-a:tags_1331275b"); },
  get updated() { return t("final-components-a:lastUpdated_382ac5f3"); },
};

const issueColumnDescriptions: Record<InboxIssueColumn, string> = {
  get status() { return t("final-components-a:taskStateChipOnThe_2a80b434"); },
  get id() { return t("final-components-a:ticketIdentifierLikePAP1009_4710c06f"); },
  get assignee() { return t("final-components-a:responsibleAgentOrBoardUser_c67ac961"); },
  get kickedOffBy() { return t("final-components-a:boardUserOrAgentWho_4e377625"); },
  get project() { return t("final-components-a:linkedProjectPillWithIts_d615593a"); },
  get workspace() { return t("final-components-a:executionOrProjectWorkspaceUsed_a2570417"); },
  get parent() { return t("final-components-a:parentTaskIdentifierAndTitle_84f24885"); },
  get labels() { return t("final-components-a:taskLabelsAndTags_d1cda43e"); },
  get updated() { return t("final-components-a:latestVisibleActivityTime_6d595ff1"); },
};

export function issueColumnDescription(
  column: InboxIssueColumn,
  presentation: "legacy" | "task" = "legacy",
): string {
  if (column === "id" && presentation === "task") {
    return t("final-components-a:taskIdentifierLikePAP1009_8a525f1e");
  }
  if (column === "status" && presentation === "task") {
    return t("final-components-a:taskStateIconOnThe_460d683b");
  }
  return issueColumnDescriptions[column];
}

export function issueActivityTimestamp(issue: Issue): string {
  return timeAgo(issue.lastActivityAt ?? issue.lastExternalCommentAt ?? issue.updatedAt);
}

export function issueActivityText(issue: Issue): string {
  return t("final-components-a:updatedTime_6379f4b4", { time: issueActivityTimestamp(issue) });
}

function issueTrailingGridTemplate(columns: InboxIssueColumn[]): string {
  return columns
    .map((column) => {
      if (column === "assignee") return "minmax(6rem, 8rem)";
      if (column === "kickedOffBy") return "minmax(6rem, 8rem)";
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
  showDateGroupSeparators,
  onToggleDateGroupSeparators,
  onResetColumns,
  title,
  iconOnly = false,
  rowPresentation = "legacy",
}: {
  availableColumns: InboxIssueColumn[];
  visibleColumnSet: ReadonlySet<InboxIssueColumn>;
  onToggleColumn: (column: InboxIssueColumn, enabled: boolean) => void;
  showDateGroupSeparators?: boolean;
  onToggleDateGroupSeparators?: (enabled: boolean) => void;
  onResetColumns: () => void;
  title: string;
  iconOnly?: boolean;
  rowPresentation?: "legacy" | "task";
}) {
  useTranslation("task-components");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant={iconOnly ? "outline" : "ghost"}
          size={iconOnly ? "icon" : "sm"}
          className={iconOnly ? "h-8 w-8 shrink-0" : "hidden h-8 shrink-0 px-2 text-xs sm:inline-flex"}
          title={t("task-components:columns_53aade77")}
        >
          <Columns3 className={iconOnly ? "h-3.5 w-3.5" : "mr-1 h-3.5 w-3.5"} />
          {!iconOnly && t("task-components:columns_53aade77")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-(--sz-300px) rounded-xl border-border/70 p-1.5 shadow-xl shadow-black/10">
        <DropdownMenuLabel className="px-2 pb-1 pt-1.5">
          <div className="space-y-1">
            <div className="text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">{t("task-components:desktopTaskRows_9ead53df")}</div>
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
                {issueColumnDescription(column, rowPresentation)}
              </span>
            </span>
          </DropdownMenuCheckboxItem>
        ))}
        {showDateGroupSeparators !== undefined && onToggleDateGroupSeparators ? (
          <DropdownMenuCheckboxItem
            checked={showDateGroupSeparators}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(checked) => onToggleDateGroupSeparators(checked === true)}
            className="items-start rounded-lg px-3 py-2.5 pl-8"
          >
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-foreground">{t("task-components:dateGroupSeparators_738875ea")}</span>
              <span className="text-xs leading-relaxed text-muted-foreground">{t("task-components:showTodayYesterdayAndEarlierRulesOn_2c8dbf56")}</span>
            </span>
          </DropdownMenuCheckboxItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={onResetColumns}
          className="rounded-lg px-3 py-2 text-sm"
        >{t("task-components:resetDefaults_4542d49a")}<span className="ml-auto text-xs text-muted-foreground">{t("task-components:statusIdUpdated_5fd9f7e2")}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function InboxIssueMetaLeading({
  issue,
  isLive,
  subtreeLiveCount = 0,
  showSubtreeLiveChip = true,
  showStatus = true,
  showIdentifier = true,
  statusSlot,
  checklistStepNumber = null,
}: {
  issue: Issue;
  isLive: boolean;
  subtreeLiveCount?: number;
  showSubtreeLiveChip?: boolean;
  showStatus?: boolean;
  showIdentifier?: boolean;
  statusSlot?: ReactNode;
  checklistStepNumber?: number | string | null;
}) {
  useTranslation("task-components");
  return (
    <>
      {showStatus ? (
        <span className="hidden shrink-0 items-center sm:inline-flex">
          {statusSlot ?? <StatusIcon status={issue.status} displayStatus={issue.displayStatus} externalConversationState={issue.externalConversationState} blockerAttention={issue.blockerAttention} />}
        </span>
      ) : null}
      {checklistStepNumber !== null ? (
        <span className="shrink-0 font-mono text-xs text-muted-foreground" aria-hidden="true">
          {checklistStepNumber}.
        </span>
      ) : null}
      {showIdentifier ? (
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          {issue.identifier ?? issue.id.slice(0, 8)}
        </span>
      ) : null}
      {isLive && (
        <Badge variant="ghost"
          className={cn(
            "px-1.5 sm:gap-1.5 sm:px-2",
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
              "hidden text-(length:--text-micro) font-medium sm:inline",
              "text-blue-600 dark:text-blue-400",
            )}
          >{t("task-components:live_b64ac05f")}</span>
        </Badge>
      )}
      {showSubtreeLiveChip && !isLive && subtreeLiveCount > 0 && (
        <Badge variant="outline"
          className={cn(
            "px-1.5 sm:gap-1.5 sm:px-2",
            "border-border bg-transparent",
          )}
          title={t("task-components:subTaskRunningBelow_e26bf8be", { value1: subtreeLiveCount, value2: t("task-components:pluralSuffix", { count: subtreeLiveCount }) })}
        >
          <span
            className={cn(
              "h-2 w-2 shrink-0 rounded-full border",
              "border-muted-foreground/60 bg-transparent",
            )}
            aria-hidden="true"
          />
          <span className="hidden text-(length:--text-micro) font-medium text-muted-foreground sm:inline"><Trans ns="final-components-a" i18nKey="numeric_f58857686088" values={{ subtreeLiveCount: subtreeLiveCount }} /></span>
        </Badge>
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
  assigneeAgent,
  creatorAgent,
  assigneeUserName,
  assigneeUserAvatarUrl,
  creatorAgentName,
  creatorUserName,
  creatorUserAvatarUrl,
  viaAgentName,
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
  assigneeAgent?: AvatarAgent;
  creatorAgent?: AvatarAgent;
  assigneeUserName?: string | null;
  assigneeUserAvatarUrl?: string | null;
  creatorAgentName?: string | null;
  creatorUserName?: string | null;
  creatorUserAvatarUrl?: string | null;
  viaAgentName?: string | null;
  currentUserId: string | null;
  parentIdentifier: string | null;
  parentTitle: string | null;
  assigneeContent?: ReactNode;
  onFilterWorkspace?: (workspaceId: string) => void;
}) {
  useTranslation("task-components");
  const activityText = issueActivityTimestamp(issue);
  const userLabel = assigneeUserName ?? formatAssigneeUserLabel(issue.assigneeUserId, currentUserId) ?? t("task-components:user_b512d97e");
  const originatingActor = deriveOriginatingActor(issue);
  const originatingUserId = originatingActor?.kind === "user" ? originatingActor.id : null;
  const creatorUserLabel = creatorUserName ?? formatAssigneeUserLabel(originatingUserId, currentUserId) ?? t("task-components:user_b512d97e");

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
                <AgentIdentity
                  agent={assigneeAgent ?? { id: issue.assigneeAgentId, name: assigneeName ?? issue.assigneeAgentId.slice(0, 8) }}
                  size="sm"
                  className="min-w-0"
                />
              </span>
            );
          }

          if (issue.assigneeUserId) {
            return (
              <span key={column} className="min-w-0 text-xs text-foreground">
                <Identity
                  name={userLabel}
                  avatarUrl={assigneeUserAvatarUrl}
                  size="sm"
                  className="min-w-0"
                />
              </span>
            );
          }

          return (
            <span key={column} className="min-w-0 truncate text-xs text-muted-foreground">{t("task-components:unassigned_14d33bd0")}</span>
          );
        }

        if (column === "kickedOffBy") {
          if (originatingActor?.kind === "agent") {
            const name = creatorAgentName ?? originatingActor.id.slice(0, 8);
            return (
              <Tooltip key={column}>
                <TooltipTrigger asChild>
                  <span className="min-w-0 text-xs text-foreground">
                    <AgentIdentity
                      agent={creatorAgent ?? { id: originatingActor.id, name }}
                      size="sm"
                      className="min-w-0"
                    />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6}>{name}</TooltipContent>
              </Tooltip>
            );
          }

          if (originatingActor?.kind === "user") {
            const tooltipText = viaAgentName ? t("final-components-a:userViaAgent_24752efb", { user: creatorUserLabel, agent: viaAgentName }) : creatorUserLabel;
            return (
              <Tooltip key={column}>
                <TooltipTrigger asChild>
                  <span className="min-w-0 text-xs text-foreground">
                    <Identity
                      name={creatorUserLabel}
                      avatarUrl={creatorUserAvatarUrl}
                      size="sm"
                      className="min-w-0"
                    />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6}>{tooltipText}</TooltipContent>
              </Tooltip>
            );
          }

          return (
            <span key={column} className="min-w-0 truncate text-xs text-muted-foreground">{t("task-components:unknown_b764cdc0")}</span>
          );
        }

        if (column === "project") {
          if (projectName) {
            // token-extraction: allowlisted — accentColor also feeds pickTextColorForPillBg() contrast math; a var() string can't be parsed as a hex color there.
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
            <span key={column} className="min-w-0 truncate text-xs text-muted-foreground">{t("task-components:noProject_f34c2be0")}</span>
          );
        }

        if (column === "labels") {
          if ((issue.labels ?? []).length > 0) {
            return (
              <span key={column} className="flex min-w-0 items-center gap-1 overflow-hidden">
                {(issue.labels ?? []).slice(0, 2).map((label) => (
                  <Badge variant="outline"
                    key={label.id}
                    className="min-w-0 max-w-full px-1.5 py-0 text-(length:--text-nano)"
                    style={{
                      borderColor: label.color,
                      color: pickTextColorForPillBg(label.color, 0.12),
                      backgroundColor: `${label.color}1f`,
                    }}
                  >
                    <span className="truncate">{label.name}</span>
                  </Badge>
                ))}
                {(issue.labels ?? []).length > 2 ? (
                  <span className="shrink-0 text-(length:--text-nano) font-medium text-muted-foreground">
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
                  <TooltipContent side="top" sideOffset={6}>{t("task-components:filterByWorkspace_7e5aae00")}</TooltipContent>
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
                <span className="italic">{t("task-components:subTask_17aa97a0")}</span>
              )}
            </span>
          );
        }

        if (column === "updated") {
          return (
            <span key={column} className="min-w-0 truncate text-right text-(length:--text-micro) font-medium text-muted-foreground">
              {activityText}
            </span>
          );
        }

        return null;
      })}
    </span>
  );
}
