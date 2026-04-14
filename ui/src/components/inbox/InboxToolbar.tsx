import { Archive, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageTabBar } from "../PageTabBar";
import type { InboxCategoryFilter } from "./inboxTypes";
import type { InboxApprovalFilter, InboxTab } from "../../lib/inbox";

interface InboxToolbarProps {
  tab: InboxTab;
  onTabChange: (value: string) => void;
  // Mark all read
  canMarkAllRead: boolean;
  isMarkingAllRead: boolean;
  onMarkAllRead: () => void;
  // Bulk select
  selectableIssueIds: string[];
  selectedIssueIds: Set<string>;
  allSelected: boolean;
  someSelected: boolean;
  onSelectAll: () => void;
  isBulkArchiving: boolean;
  onBulkArchive: () => void;
  // Group by agent
  groupByAgent: boolean;
  onToggleGroupByAgent: () => void;
  // All-tab filters
  allCategoryFilter: InboxCategoryFilter;
  onCategoryFilterChange: (value: InboxCategoryFilter) => void;
  allApprovalFilter: InboxApprovalFilter;
  onApprovalFilterChange: (value: InboxApprovalFilter) => void;
  showApprovalsCategory: boolean;
}

export function InboxToolbar({
  tab,
  onTabChange,
  canMarkAllRead,
  isMarkingAllRead,
  onMarkAllRead,
  selectableIssueIds,
  selectedIssueIds,
  allSelected,
  someSelected,
  onSelectAll,
  isBulkArchiving,
  onBulkArchive,
  groupByAgent,
  onToggleGroupByAgent,
  allCategoryFilter,
  onCategoryFilterChange,
  allApprovalFilter,
  onApprovalFilterChange,
  showApprovalsCategory,
}: InboxToolbarProps) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-wrap items-center gap-2">
        <Tabs value={tab} onValueChange={onTabChange}>
          <PageTabBar
            items={[
              { value: "mine", label: "Mine" },
              { value: "recent", label: "Recent" },
              { value: "unread", label: "Unread" },
              { value: "all", label: "All" },
            ]}
          />
        </Tabs>

        {canMarkAllRead && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 shrink-0"
            onClick={onMarkAllRead}
            disabled={isMarkingAllRead}
          >
            {isMarkingAllRead ? "Marking..." : "Mark all as read"}
          </Button>
        )}

        {tab === "mine" && selectableIssueIds.length > 0 && (
          <div className="flex items-center gap-2">
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground select-none">
              <Checkbox
                checked={allSelected}
                onCheckedChange={onSelectAll}
                aria-label="Select all missions"
                className="h-3.5 w-3.5"
              />
              Select all
            </label>
            {someSelected && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 shrink-0"
                onClick={onBulkArchive}
                disabled={isBulkArchiving}
              >
                <Archive className="mr-1.5 h-3.5 w-3.5" />
                {isBulkArchiving
                  ? "Archiving..."
                  : `Archive ${selectedIssueIds.size} selected`}
              </Button>
            )}
          </div>
        )}

        <Button
          variant={groupByAgent ? "default" : "outline"}
          size="sm"
          className="h-8 shrink-0"
          onClick={onToggleGroupByAgent}
        >
          <Users className="mr-1.5 h-3.5 w-3.5" />
          Group by agent
        </Button>
      </div>

      {tab === "all" && (
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          <Select
            value={allCategoryFilter}
            onValueChange={(value) => onCategoryFilterChange(value as InboxCategoryFilter)}
          >
            <SelectTrigger className="h-8 w-[170px] text-xs">
              <SelectValue placeholder="Category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="everything">All categories</SelectItem>
              <SelectItem value="issues_i_touched">My recent missions</SelectItem>
              <SelectItem value="join_requests">Join requests</SelectItem>
              <SelectItem value="approvals">Approvals</SelectItem>
              <SelectItem value="failed_runs">Failed runs</SelectItem>
              <SelectItem value="alerts">Alerts</SelectItem>
            </SelectContent>
          </Select>

          {showApprovalsCategory && (
            <Select
              value={allApprovalFilter}
              onValueChange={(value) => onApprovalFilterChange(value as InboxApprovalFilter)}
            >
              <SelectTrigger className="h-8 w-[170px] text-xs">
                <SelectValue placeholder="Approval status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All approval statuses</SelectItem>
                <SelectItem value="actionable">Needs action</SelectItem>
                <SelectItem value="resolved">Resolved</SelectItem>
              </SelectContent>
            </Select>
          )}
        </div>
      )}
    </div>
  );
}
