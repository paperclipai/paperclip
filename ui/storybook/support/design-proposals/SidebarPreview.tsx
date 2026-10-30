import { CommandPalette } from "@/components/CommandPalette";
import { DesignPageShell } from "@/components/DesignPageShell";
import { DesignSidebar, type DesignSidebarRecentTask } from "@/components/DesignSidebar";
import { NewIssueDialog } from "@/components/NewIssueDialog";
import { useDialogActions } from "@/context/DialogContext";
import { DesignProposalAccess } from "./DesignProposalAccess";
import { recentTasks } from "./task-page-data";

export type SidebarPreviewProps = {
  scenario: "default" | "narrow" | "long-labels" | "many-recents" | "empty-recents" | "organization-menu" | "account-menu";
};

const defaultRecents = recentTasks.map(item => item.issue);
const longRecents = defaultRecents.map((task, index) => ({
  ...task,
  title: index === 0 ? "Review the connector recovery experience across organizations and shared workspaces" : task.title,
}));
const manyRecents: DesignSidebarRecentTask[] = Array.from({ length: 30 }, (_, index) => ({
  ...defaultRecents[index % defaultRecents.length]!,
  id: `sidebar-recent-${index}`,
  identifier: `PAP-${500 + index}`,
}));

function SidebarContent({ scenario }: SidebarPreviewProps) {
  const { openNewIssue } = useDialogActions();
  const tasks = scenario === "empty-recents" ? [] : scenario === "many-recents" ? manyRecents : scenario === "long-labels" ? longRecents : defaultRecents;
  return <>
    <DesignPageShell
      title="Sidebar"
      sidebarStorageKey={`paperclip.design-proposal.sidebar-review.${scenario}.width`}
      sidebar={<DesignSidebar recentTasks={tasks} onNewTask={() => openNewIssue()} />}
    >
      <div className="max-w-xl space-y-4 text-sm text-muted-foreground">
        <h2 className="text-lg font-semibold text-foreground">Sidebar component</h2>
        <p>This is the same sidebar used by Pages → Tasks. Resize its right edge, hover truncated labels, or use the organization, account and global-search controls.</p>
        <p>Navigation uses a fixture router. New Task and global search mount the existing dialogs; this preview does not establish backend behavior.</p>
      </div>
    </DesignPageShell>
    <NewIssueDialog />
    <CommandPalette />
  </>;
}

export function SidebarPreview(props: SidebarPreviewProps) {
  return <DesignProposalAccess><SidebarContent {...props} /></DesignProposalAccess>;
}
