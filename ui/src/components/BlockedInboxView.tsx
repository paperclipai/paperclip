import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { Issue } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { applyIssueFilters, type IssueFilterState, type IssueFilterWorkspaceContext } from "../lib/issue-filters";
import {
  blockedRowMatchesSearch,
  buildBlockedInboxRows,
  formatStoppedAge,
  groupBlockedInboxRows,
  sortBlockedInboxRows,
  type BlockedInboxGroupBy,
  type BlockedInboxIssueRow,
  type BlockedInboxSort,
} from "../lib/blockedInbox";
import { BlockedReasonChip } from "./BlockedReasonChip";
import { IssueGroupHeader } from "./IssueGroupHeader";
import { IssueRow } from "./IssueRow";
import { Identity } from "./Identity";
import { StatusIcon } from "./StatusIcon";
import { Button } from "@/components/ui/button";

interface BlockedInboxViewProps {
  companyId: string;
  searchQuery: string;
  agentNameById: ReadonlyMap<string, string>;
  userLabelById?: ReadonlyMap<string, string>;
  issueLinkState: unknown;
  groupBy: BlockedInboxGroupBy;
  sortBy: BlockedInboxSort;
  issueFilters: IssueFilterState;
  currentUserId: string | null;
  liveIssueIds: ReadonlySet<string>;
  workspaceFilterContext: IssueFilterWorkspaceContext;
  showStatusColumn: boolean;
  showIdentifierColumn: boolean;
  showUpdatedColumn: boolean;
}

const BLOCKED_LIST_LIMIT = 200;

export function BlockedInboxView({
  companyId,
  searchQuery,
  agentNameById,
  userLabelById,
  issueLinkState,
  groupBy,
  sortBy,
  issueFilters,
  currentUserId,
  liveIssueIds,
  workspaceFilterContext,
  showStatusColumn,
  showIdentifierColumn,
  showUpdatedColumn,
}: BlockedInboxViewProps) {
  const [collapsedVariants, setCollapsedVariants] = useState<Set<string>>(() => new Set());

  const {
    data: issues = [] as Issue[],
    isLoading,
    isFetching,
    error,
    refetch,
  } = useQuery({
    queryKey: queryKeys.issues.listBlockedAttention(companyId),
    queryFn: () =>
      issuesApi.list(companyId, {
        attention: "blocked",
        includeBlockedInboxAttention: true,
        includeBlockedBy: true,
        limit: BLOCKED_LIST_LIMIT,
      }),
  });

  const allRows = useMemo(() => buildBlockedInboxRows(issues), [issues]);
  const filteredRows = useMemo(
    () => allRows.filter((row) => blockedRowMatchesSearch(row, searchQuery)),
    [allRows, searchQuery],
  );
  const issueFilteredRows = useMemo(() => {
    const visibleIssueIds = new Set(
      applyIssueFilters(
        filteredRows.map((row) => row.issue),
        issueFilters,
        currentUserId,
        true,
        liveIssueIds,
        workspaceFilterContext,
      ).map((issue) => issue.id),
    );
    return filteredRows.filter((row) => visibleIssueIds.has(row.issue.id));
  }, [currentUserId, filteredRows, issueFilters, liveIssueIds, workspaceFilterContext]);
  const sortedRows = useMemo(() => sortBlockedInboxRows(issueFilteredRows, sortBy), [issueFilteredRows, sortBy]);
  const groups = useMemo(
    () => groupBlockedInboxRows(issueFilteredRows, sortBy),
    [issueFilteredRows, sortBy],
  );

  const toggleVariant = (variant: string) => {
    setCollapsedVariants((prev) => {
      const next = new Set(prev);
      if (next.has(variant)) next.delete(variant);
      else next.add(variant);
      return next;
    });
  };

  if (isLoading) {
    return (
      <div data-testid="blocked-inbox-loading" className="space-y-3" aria-busy="true">
        {Array.from({ length: 3 }).map((_, groupIdx) => (
          <div key={groupIdx} className="space-y-1">
            <div className="h-4 w-40 animate-pulse rounded bg-muted/70" />
            {Array.from({ length: 2 }).map((__, rowIdx) => (
              <div
                key={rowIdx}
                className="flex items-center gap-3 border-b border-border/60 px-3 py-2.5 sm:px-4"
              >
                <div className="h-3.5 w-3.5 animate-pulse rounded-full bg-muted" />
                <div className="h-4 w-16 animate-pulse rounded bg-muted/70" />
                <div className="h-4 w-32 animate-pulse rounded-md bg-muted/70" />
                <div className="h-4 flex-1 animate-pulse rounded bg-muted/60" />
                <div className="hidden h-3 w-24 animate-pulse rounded bg-muted/60 sm:block" />
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    const message =
      error instanceof Error ? error.message : "Couldn't load the Blocked tab.";
    return (
      <div
        data-testid="blocked-inbox-error"
        role="alert"
        className="flex flex-col gap-2 rounded-md border border-amber-300/70 bg-amber-50/90 p-4 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
      >
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="flex-1 space-y-1">
            <p className="text-sm font-medium">Couldn't load the Blocked tab.</p>
            <p className="text-xs opacity-80">
              Other Inbox tabs still work. {message}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 shrink-0 border-amber-400/70 bg-white/40 text-amber-900 hover:bg-white/70 dark:bg-amber-500/20 dark:text-amber-100"
            onClick={() => void refetch()}
            disabled={isFetching}
          >
            {isFetching ? "Trying…" : "Try again"}
          </Button>
        </div>
      </div>
    );
  }

  if (allRows.length === 0) {
    return (
      <div
        data-testid="blocked-inbox-empty"
        className="flex flex-col items-center gap-3 rounded-lg border border-border/70 bg-card/40 px-6 py-10 text-center"
      >
        <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
          <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">No work is stopped.</p>
          <p className="text-xs text-muted-foreground">
            Issues that need a decision, recovery, or external action will appear here.
          </p>
        </div>
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="space-y-3">
        <div
          data-testid="blocked-inbox-no-search-results"
          className="rounded-lg border border-border/70 bg-card/40 px-4 py-6 text-center text-sm text-muted-foreground"
        >
          No stopped items match your search.
        </div>
      </div>
    );
  }

  return (
    <div data-testid="blocked-inbox" className="space-y-3">
      <div className="overflow-hidden rounded-xl">
        {groupBy === "none" ? (
          sortedRows.map((row) => (
            <BlockedInboxRow
              key={row.issue.id}
              row={row}
              issueLinkState={issueLinkState}
              agentNameById={agentNameById}
              userLabelById={userLabelById}
              showStatusColumn={showStatusColumn}
              showIdentifierColumn={showIdentifierColumn}
              showUpdatedColumn={showUpdatedColumn}
            />
          ))
        ) : (
          groups.map((group) => {
            const isCollapsed = collapsedVariants.has(group.variant);
            return (
              <div key={group.variant} data-testid={`blocked-inbox-group-${group.variant}`}>
                <div className="px-3 sm:px-4">
                  <IssueGroupHeader
                    label={`${group.label} · ${group.rows.length}`}
                    collapsible
                    collapsed={isCollapsed}
                    onToggle={() => toggleVariant(group.variant)}
                  />
                </div>
                {!isCollapsed && (
                  <div>
                    {group.rows.map((row) => (
                      <BlockedInboxRow
                        key={row.issue.id}
                        row={row}
                        issueLinkState={issueLinkState}
                        agentNameById={agentNameById}
                        userLabelById={userLabelById}
                        showStatusColumn={showStatusColumn}
                        showIdentifierColumn={showIdentifierColumn}
                        showUpdatedColumn={showUpdatedColumn}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

interface BlockedInboxRowProps {
  row: BlockedInboxIssueRow;
  issueLinkState: unknown;
  agentNameById: ReadonlyMap<string, string>;
  userLabelById?: ReadonlyMap<string, string>;
  showStatusColumn: boolean;
  showIdentifierColumn: boolean;
  showUpdatedColumn: boolean;
}

function resolveOwnerName(
  row: BlockedInboxIssueRow,
  agentNameById: ReadonlyMap<string, string>,
  userLabelById?: ReadonlyMap<string, string>,
): { label: string | null; isAgent: boolean } {
  const owner = row.attention.owner;
  if (owner.label) return { label: owner.label, isAgent: owner.type === "agent" };
  if (owner.agentId) {
    return { label: agentNameById.get(owner.agentId) ?? null, isAgent: true };
  }
  if (owner.userId) {
    return { label: userLabelById?.get(owner.userId) ?? null, isAgent: false };
  }
  return { label: null, isAgent: false };
}

function BlockedInboxRow({
  row,
  issueLinkState,
  agentNameById,
  userLabelById,
  showStatusColumn,
  showIdentifierColumn,
  showUpdatedColumn,
}: BlockedInboxRowProps) {
  const { label: ownerName, isAgent } = resolveOwnerName(row, agentNameById, userLabelById);
  const stoppedAge = formatStoppedAge(row.attention.stoppedSinceAt);

  const desktopTrailing = (
    <span className="flex shrink-0 items-center gap-3 text-xs">
      <span
        className="hidden w-[10.5rem] shrink-0 justify-start sm:inline-flex"
        data-testid="blocked-row-reason-column"
      >
        <BlockedReasonChip
          reason={row.attention.reason}
          severity={row.attention.severity}
          className="max-w-full"
        />
      </span>
      {ownerName ? (
        <span className="hidden w-[150px] min-w-0 items-center text-muted-foreground sm:inline-flex">
          <Identity
            name={ownerName}
            size="xs"
            className="max-w-full"
          />
        </span>
      ) : (
        <span className="hidden w-[150px] shrink-0 sm:inline-flex" aria-hidden="true" />
      )}
      {showUpdatedColumn ? (
        <span className="hidden w-[5.75rem] text-right text-muted-foreground sm:inline" data-testid="blocked-row-age">
          {stoppedAge}
        </span>
      ) : null}
    </span>
  );

  const mobileMeta = (
    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
      <span data-testid="blocked-row-age-mobile">{stoppedAge}</span>
      {ownerName ? (
        <>
          <span aria-hidden="true">·</span>
          <span
            className={cn(isAgent ? "font-medium text-foreground/90" : null)}
            data-testid="blocked-row-owner-mobile"
          >
            {ownerName}
          </span>
        </>
      ) : null}
    </span>
  );

  return (
    <IssueRow
      issue={row.issue}
      issueLinkState={issueLinkState}
      desktopMetaLeading={
        <BlockedRowDesktopMeta
          row={row}
          showStatusColumn={showStatusColumn}
          showIdentifierColumn={showIdentifierColumn}
        />
      }
      mobileLeading={
        <span className="flex shrink-0 items-center gap-1.5 pt-px">
          <StatusIcon status={row.issue.status} blockerAttention={row.issue.blockerAttention} />
        </span>
      }
      titleSuffix={
        <BlockedReasonChip
          reason={row.attention.reason}
          severity={row.attention.severity}
          className="ml-2 max-w-[12rem] align-middle sm:hidden"
        />
      }
      mobileMeta={mobileMeta}
      desktopTrailing={desktopTrailing}
    />
  );
}

function BlockedRowDesktopMeta({
  row,
  showStatusColumn,
  showIdentifierColumn,
}: {
  row: BlockedInboxIssueRow;
  showStatusColumn: boolean;
  showIdentifierColumn: boolean;
}) {
  const identifier = row.issue.identifier ?? row.issue.id.slice(0, 8);
  return (
    <span className="hidden shrink-0 items-center gap-2 sm:inline-flex">
      {showStatusColumn ? <StatusIcon status={row.issue.status} blockerAttention={row.issue.blockerAttention} /> : null}
      {showIdentifierColumn ? <span className="font-mono text-xs text-muted-foreground">{identifier}</span> : null}
    </span>
  );
}
