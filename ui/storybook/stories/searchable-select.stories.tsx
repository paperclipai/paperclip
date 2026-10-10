import { useEffect, useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { SearchableSelect, type SearchableSelectGroup } from "@/components/SearchableSelect";
import {
  buildReusableExecutionWorkspaceOptionGroups,
  reusableWorkspaceOptionMatches,
  type ReusableExecutionWorkspaceLike,
  type ReusableWorkspaceOption,
} from "@/lib/reusable-execution-workspaces";

const NOW = new Date("2026-06-24T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const WORKSPACES: ReusableExecutionWorkspaceLike[] = [
  {
    id: "ws-auth-refresh",
    name: "auth-token-refresh",
    cwd: "/srv/paperclip/home/paperclipai/paperclip/.paperclip/worktrees/PAP-11502-auth-token-refresh",
    branchName: "PAP-11502-auth-token-refresh",
    status: "running",
    lastUsedAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
  },
  {
    id: "ws-billing",
    name: "billing-webhooks",
    cwd: "/srv/paperclip/home/paperclipai/paperclip/.paperclip/worktrees/PAP-11380-billing-webhooks",
    branchName: "PAP-11380-billing-webhooks",
    status: "idle",
    lastUsedAt: new Date(NOW.getTime() - 1 * DAY),
  },
  {
    id: "ws-search",
    name: "workspace-selector",
    cwd: "/srv/paperclip/home/paperclipai/paperclip/.paperclip/worktrees/PAP-11722-new-existing-workspace-selector",
    branchName: "PAP-11722-new-existing-workspace-selector",
    status: "idle",
    lastUsedAt: new Date(NOW.getTime() - 2 * DAY),
  },
  {
    id: "ws-docs",
    name: "docs-trust-presets",
    cwd: "/srv/paperclip/home/docs/.paperclip/worktrees/docs-trust-presets",
    branchName: "docs/trust-presets",
    status: "archived",
    lastUsedAt: new Date(NOW.getTime() - 9 * DAY),
  },
  {
    id: "ws-pipeline",
    name: "pipeline-body-doc",
    cwd: "/srv/paperclip/home/paperclipai/paperclip/.paperclip/worktrees/PAP-11567-body-document-ui",
    branchName: "PAP-11567-body-document-ui",
    status: "idle",
    lastUsedAt: new Date(NOW.getTime() - 14 * DAY),
  },
  {
    id: "ws-watchdog",
    name: "task-watchdog",
    cwd: "/srv/paperclip/home/paperclipai/paperclip/.paperclip/worktrees/PAP-11275-task-watchdog",
    branchName: "PAP-11275-task-watchdog",
    status: "idle",
    lastUsedAt: new Date(NOW.getTime() - 21 * DAY),
  },
];

const LONG_WORKSPACES: ReusableExecutionWorkspaceLike[] = [
  {
    id: "ws-long-name",
    name: "paperclip-control-plane-existing-workspace-selector-long-running-validation-branch",
    cwd: "/srv/paperclip/home/paperclipai/paperclip/.paperclip/worktrees/PAP-11722-existing-workspace-selector-with-a-very-long-path-segment-for-review",
    branchName: "feature/existing-workspace-selector-long-path-validation",
    status: "running",
    lastUsedAt: new Date(NOW.getTime() - 90 * 60 * 1000),
  },
  {
    id: "ws-long-cwd",
    name: "adapter-plugin-registry-regression-suite",
    cwd: "/srv/paperclip/home/paperclipai/paperclip/packages/adapters/external-plugin-fixtures/hermes-droid-regression-workspace-with-long-directory-name",
    branchName: null,
    status: "idle",
    lastUsedAt: new Date(NOW.getTime() - 1 * DAY),
  },
  ...WORKSPACES.slice(0, 2),
];

const GROUPS = buildReusableExecutionWorkspaceOptionGroups(WORKSPACES, { now: NOW });

const SELECT_GROUPS: SearchableSelectGroup<string, ReusableWorkspaceOption>[] = GROUPS.map((group) => ({
  id: group.id,
  label: group.label,
  options: group.options,
}));

const COMPACT_TRIGGER = "h-8 px-2 py-1.5 text-xs font-normal";

function WorkspaceSelect({
  triggerClassName,
  loading = false,
  disabled = false,
  groups = SELECT_GROUPS,
  initialValue = "",
  autoOpen = false,
  autoQuery = "",
}: {
  triggerClassName?: string;
  loading?: boolean;
  disabled?: boolean;
  groups?: SearchableSelectGroup<string, ReusableWorkspaceOption>[];
  initialValue?: string;
  autoOpen?: boolean;
  autoQuery?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (!autoOpen && !autoQuery) return;
    let queryTimer: number | undefined;
    const openTimer = window.setTimeout(() => {
      rootRef.current?.querySelector<HTMLButtonElement>("button[role='combobox']")?.click();
      if (!autoQuery) return;
      queryTimer = window.setTimeout(() => {
        const input = rootRef.current?.querySelector<HTMLInputElement>("input[cmdk-input]");
        if (!input) return;
        const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        valueSetter?.call(input, autoQuery);
        input.dispatchEvent(new InputEvent("input", { bubbles: true, data: autoQuery, inputType: "insertText" }));
      }, 0);
    }, 0);
    return () => {
      window.clearTimeout(openTimer);
      if (queryTimer !== undefined) window.clearTimeout(queryTimer);
    };
  }, [autoOpen, autoQuery]);

  return (
    <div ref={rootRef}>
      <SearchableSelect<string, ReusableWorkspaceOption>
        value={value}
        groups={groups}
        onValueChange={(next) => setValue(next)}
        placeholder="Choose an existing workspace"
        searchPlaceholder="Search workspaces..."
        emptyMessage="No matching workspaces."
        loadingMessage="Loading workspaces..."
        loading={loading}
        disabled={disabled}
        triggerClassName={triggerClassName}
        filterOption={(option, query) => reusableWorkspaceOptionMatches(option, query)}
        renderOption={(option, { selected }) => (
          <span className="flex min-w-0 flex-col">
            <span className={`truncate ${selected ? "font-medium" : ""}`}>{option.label}</span>
            <span className="truncate text-[11px] text-muted-foreground">
              {option.workspace.status} - {option.description}
            </span>
          </span>
        )}
      />
    </div>
  );
}

function FormContext({ triggerClassName }: { triggerClassName?: string }) {
  return (
    <div className="w-full max-w-sm rounded-md border border-border bg-card p-0">
      <div className="px-4 py-3 space-y-2">
        <div className="space-y-1.5">
          <div className="text-xs font-medium">Execution workspace</div>
          <div className="text-[11px] text-muted-foreground">
            Control whether this task runs in the shared workspace, a new isolated workspace, or an existing one.
          </div>
          {/* Neighbouring native select (mode picker): the row the combobox must match. */}
          <select
            className="w-full rounded border border-border bg-transparent px-2 py-1.5 text-xs outline-none"
            defaultValue="reuse_existing"
          >
            <option value="shared_workspace">Project default</option>
            <option value="isolated_workspace">New isolated workspace</option>
            <option value="reuse_existing">Reuse existing workspace</option>
          </select>
          <WorkspaceSelect triggerClassName={triggerClassName} />
        </div>
      </div>
    </div>
  );
}

const meta = {
  title: "Components/SearchableSelect/Workspace picker",
  parameters: { layout: "centered" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const EmptyQueryWithRecentAndAllGroups: Story = {
  render: () => (
    <div className="w-80">
      <WorkspaceSelect triggerClassName={COMPACT_TRIGGER} autoOpen />
    </div>
  ),
};

export const FuzzyQueryMatches: Story = {
  render: () => (
    <div className="w-80">
      <WorkspaceSelect triggerClassName={COMPACT_TRIGGER} autoOpen autoQuery="pclip selector" />
    </div>
  ),
};

export const LongNamesAndPaths: Story = {
  render: () => (
    <div className="w-[280px]">
      <WorkspaceSelect
        triggerClassName={COMPACT_TRIGGER}
        groups={buildReusableExecutionWorkspaceOptionGroups(LONG_WORKSPACES, { now: NOW })}
        autoOpen
      />
    </div>
  ),
};

export const NoMatches: Story = {
  render: () => (
    <div className="w-80">
      <WorkspaceSelect triggerClassName={COMPACT_TRIGGER} autoOpen autoQuery="not a workspace" />
    </div>
  ),
};

export const Loading: Story = {
  render: () => (
    <div className="w-80">
      <WorkspaceSelect triggerClassName={COMPACT_TRIGGER} loading autoOpen />
    </div>
  ),
};

export const Disabled: Story = {
  render: () => (
    <div className="w-80">
      <WorkspaceSelect triggerClassName={COMPACT_TRIGGER} disabled />
    </div>
  ),
};

export const SelectedRecentWorkspaceDuplicatedInAllGroup: Story = {
  render: () => (
    <div className="w-80">
      <WorkspaceSelect triggerClassName={COMPACT_TRIGGER} initialValue="ws-auth-refresh" autoOpen />
    </div>
  ),
};

export const DefaultAndCompactSizeComparison: Story = {
  render: () => (
    <div className="flex w-80 flex-col gap-2">
      <select className="w-full rounded border border-border bg-transparent px-2 py-1.5 text-xs outline-none" defaultValue="reuse_existing">
        <option value="reuse_existing">Reuse existing workspace</option>
      </select>
      <WorkspaceSelect />
      <WorkspaceSelect triggerClassName={COMPACT_TRIGGER} />
    </div>
  ),
};

export const InNewIssueContextCompact: Story = {
  render: () => <FormContext triggerClassName={COMPACT_TRIGGER} />,
};
