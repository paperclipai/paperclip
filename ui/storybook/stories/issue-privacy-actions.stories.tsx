import { useMemo } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Issue } from "@paperclipai/shared";
import { IssuePrivacyActions } from "@/components/IssuePrivacyActions";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { queryKeys } from "@/lib/queryKeys";

const COMPANY_ID = "company-storybook";

function makeClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false, gcTime: Infinity } },
  });
  // Seed empty grants so opening Share… from the menu lands on the empty state
  // rather than a spinner.
  client.setQueryData(queryKeys.issues.accessGrants("issue-menu-1"), []);
  return client;
}

/**
 * Renders the privacy `⋯`-menu items inside a faux DropdownMenu surface so the
 * spacing/hover/destructive treatment reads the way it will in the real popover.
 */
function MenuHost({
  visibility,
  canManage,
}: {
  visibility: Issue["visibility"];
  canManage: boolean;
}) {
  const client = useMemo(() => makeClient(), []);
  const issue = {
    id: "issue-menu-1",
    identifier: "PAP-4242",
    visibility,
  } as Pick<Issue, "id" | "identifier" | "visibility">;
  return (
    <QueryClientProvider client={client}>
      <div className="p-6">
        <div className="min-w-[13rem] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
          <div className="px-2 py-1 text-(length:--text-nano) font-medium uppercase tracking-wide text-muted-foreground">
            Privacy
          </div>
          <IssuePrivacyActions
            issue={issue}
            companyId={COMPANY_ID}
            canManage={canManage}
            closeMenu={() => {}}
          />
        </div>
      </div>
    </QueryClientProvider>
  );
}

const meta: Meta<typeof MenuHost> = {
  title: "Privacy/IssuePrivacyActions",
  component: MenuHost,
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj<typeof MenuHost>;

/** Private task, setter: Share… + destructive Make public. */
export const PrivateTaskSetter: Story = {
  args: { visibility: "private", canManage: true },
};

/** Public task, setter: single Make private (no confirm). */
export const PublicTaskSetter: Story = {
  args: { visibility: "open", canManage: true },
};

/** Non-setter: items disabled; tooltip explains why (hover to reveal). */
export const NonSetter: Story = {
  args: { visibility: "private", canManage: false },
};

/**
 * The create-dialog "Private task" toggle row, lifted verbatim from
 * NewIssueDialog so its resting on/off states are screenshot-documented.
 */
function PrivateToggleRow({ checked }: { checked: boolean }) {
  return (
    <div className="max-w-md p-6">
      <div className="rounded-md border border-border/60">
        <div className="flex items-start justify-between gap-3 border-t border-border/60 px-4 py-2.5 first:border-t-0">
          <div className="min-w-0">
            <div className="text-xs font-medium">Private task</div>
            <div className="text-(length:--text-micro) text-muted-foreground">
              Only you and people you share with can read it. Subtasks stay private too.
            </div>
          </div>
          <ToggleSwitch checked={checked} onCheckedChange={() => {}} aria-label="Private task" />
        </div>
      </div>
    </div>
  );
}

export const CreateDialogToggleOff: StoryObj = {
  render: () => <PrivateToggleRow checked={false} />,
};

export const CreateDialogToggleOn: StoryObj = {
  render: () => <PrivateToggleRow checked={true} />,
};
