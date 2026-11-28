import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Pencil, X } from "lucide-react";
import { AgentsToolbar } from "@/components/AgentsToolbar";
import { IssueRowDetailsNotice } from "@/components/IssueRowDetailsNotice";
import { MobileBottomNav } from "@/components/MobileBottomNav";
import { ToastViewport } from "@/components/ToastViewport";
import { ToolbarSearch } from "@/components/ToolbarSearch";
import { Button } from "@/components/ui/button";
import { useToastActions } from "@/context/ToastContext";
import { companyProjectsQuery } from "@/lib/company-projects-query";
import { queryKeys } from "@/lib/queryKeys";
import { AgentConfigSaveBar } from "@/pages/agent-detail/AgentConfigSaveBar";
import { ProfileWizard } from "@/pages/tools/profiles/ProfileWizard";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { storybookAgents, storybookProjects } from "../../fixtures/paperclipData";

const MOBILE_MAIN_STYLE = {
  "--tc-composer-bottom": "var(--tc-composer-visible-nav-offset)",
} as CSSProperties;

function MobileShell({ children, padded = true }: { children: ReactNode; padded?: boolean }) {
  return (
    <div className="min-h-dvh w-full overflow-x-clip bg-background text-foreground">
      <main
        id="main-content"
        style={MOBILE_MAIN_STYLE}
        className={padded ? "p-4 pb-(--sz-calc-14)" : "pb-(--sz-calc-14)"}
      >
        {children}
      </main>
      <MobileBottomNav visible />
    </div>
  );
}

function CoordinatorToolbarStory() {
  const [inboxQuery, setInboxQuery] = useState("");
  const [agentsQuery, setAgentsQuery] = useState("");
  const [agentView, setAgentView] = useState<"list" | "org">("list");

  return (
    <MobileShell>
      <div className="space-y-8">
        <section className="coordinator-needs-you w-full space-y-3" aria-label="Inbox toolbar">
          <h1 className="text-lg font-semibold">Coordinator inbox</h1>
          <div data-canonical-toolbar="inbox" className="design-page-toolbar" role="toolbar" aria-label="Decisions controls">
            <ToolbarSearch
              query={inboxQuery}
              onQueryChange={setInboxQuery}
              label="Search decisions"
              placeholder="Search…"
            />
            <div className="design-toolbar-actions">
              <Button variant="ghost" size="sm">By agents<ChevronDown className="size-4" /></Button>
              <Button variant="ghost" size="sm">By projects<ChevronDown className="size-4" /></Button>
              <Button variant="ghost" size="sm">All assignees<ChevronDown className="size-4" /></Button>
              <Button variant="ghost" size="sm">By type<ChevronDown className="size-4" /></Button>
              <Button variant="ghost" size="sm" data-attention-view-menu>View<ChevronDown className="size-4" /></Button>
            </div>
          </div>
        </section>

        <section className="space-y-3" aria-label="Agents toolbar">
          <h2 className="text-lg font-semibold">Agents (list view)</h2>
          <AgentsToolbar
            query={agentsQuery}
            onQueryChange={setAgentsQuery}
            view={agentView}
            onViewChange={setAgentView}
            onNewAgent={() => undefined}
            orgActions={{
              zoomIn: () => undefined,
              zoomOut: () => undefined,
              fit: () => undefined,
            }}
          />
        </section>
      </div>
    </MobileShell>
  );
}

function SeededToastsAndNoticeStory() {
  const { pushToast } = useToastActions();

  useEffect(() => {
    pushToast({
      title: "Agent configuration saved",
      body: "Changes are live for the next run.",
      tone: "success",
      ttlMs: 0,
    });
    pushToast({
      title: "Sync warning",
      body: "Secondary workspace metadata will refresh shortly.",
      tone: "warn",
      ttlMs: 0,
    });
  }, [pushToast]);

  return (
    <MobileShell>
      <div className="space-y-3">
        <h1 className="text-lg font-semibold">Toasts and floating notices</h1>
        <p className="text-sm text-muted-foreground">
          Floating notifications and retry alerts sit cleanly above MobileBottomNav without overflowing the viewport.
        </p>
      </div>
      <ToastViewport />
      <IssueRowDetailsNotice
        error={new Error("Failed to load optional task details")}
        onRetry={() => undefined}
      />
    </MobileShell>
  );
}

function SaveBarStory() {
  return (
    <MobileShell>
      <div className="agent-settings-with-save-bar space-y-4">
        <h1 className="text-lg font-semibold">Agent settings</h1>
        <p className="text-sm text-muted-foreground">
          The fixed save bar tracks the mobile bottom navigation offset so Discard and Save changes stay clear of MobileBottomNav.
        </p>
        <div className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
          Runtime harness, model defaults, and secret bindings appear here.
        </div>
        <AgentConfigSaveBar
          dirty
          saving={false}
          onDiscard={() => undefined}
          onSave={() => undefined}
        />
      </div>
    </MobileShell>
  );
}

function ProfileWizardStory() {
  const queryClient = useQueryClient();
  const companyId = "company-storybook";
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    queryClient.setQueryData(queryKeys.tools.profiles(companyId), { profiles: [] });
    queryClient.setQueryData(queryKeys.tools.applications(companyId), { applications: [] });
    queryClient.setQueryData(queryKeys.tools.connections(companyId), { connections: [] });
    queryClient.setQueryData(queryKeys.agents.list(companyId), storybookAgents);
    queryClient.setQueryData(companyProjectsQuery(companyId).queryKey, storybookProjects);
    queryClient.setQueryData(queryKeys.routines.list(companyId), []);
    setSeeded(true);
  }, [queryClient, companyId]);

  return (
    <MobileShell>
      {seeded ? <ProfileWizard companyId={companyId} /> : null}
    </MobileShell>
  );
}

function SelectionBarStory() {
  return (
    <MobileShell>
      <div className="space-y-3">
        <h1 className="text-lg font-semibold">Agent bulk selection</h1>
        <p className="text-sm text-muted-foreground">
          The bulk selection bar floats cleanly above MobileBottomNav when agents are selected.
        </p>
      </div>
      <div
        role="region"
        aria-label="Bulk actions"
        data-state="open"
        className="agent-selection-bar flex flex-wrap items-center gap-3 rounded-lg border bg-background p-3"
      >
        <span className="text-sm font-medium">3 selected</span>
        <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
          <Button size="sm" variant="outline">
            <Pencil className="size-3.5" aria-hidden />
            Edit connection &amp; model
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="Clear selection">
            <X className="size-4" />
          </Button>
        </div>
      </div>
    </MobileShell>
  );
}

const meta = {
  id: "mobile-overlays-clearance",
  title: "Oversight and operation/Navigation, profile, and announcements/Mobile/Overlays & Toolbar Clearance",
  component: CoordinatorToolbarStory,
  decorators: [
    (Story) => (
      <PluginLauncherProvider>
        <Story />
      </PluginLauncherProvider>
    ),
  ],
  globals: {
    viewport: { value: "mobile", isRotated: false },
  },
  parameters: {
    layout: "fullscreen",
    waitForViewport: true,
    docs: {
      description: {
        component:
          "Mobile viewport verification for wrapped toolbars, collapsed org-chart controls, and bottom-nav clearance on fixed save bars, wizard footers, selection bars, toasts, and floating notices.",
      },
    },
    paperclip: {
      capabilities: ["navigation-preferences/navigation"],
      implementation: "production",
      boundary: "fixtures",
    },
  },
} satisfies Meta<typeof CoordinatorToolbarStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const CoordinatorToolbarMobile: Story = {
  render: () => <CoordinatorToolbarStory />,
};

export const ToastAndNoticeAboveBottomNavMobile: Story = {
  render: () => <SeededToastsAndNoticeStory />,
};

export const SaveBarsAboveBottomNavMobile: Story = {
  render: () => <SaveBarStory />,
};

export const ProfileWizardFooterMobile: Story = {
  render: () => <ProfileWizardStory />,
};

export const SelectionBarAboveBottomNavMobile: Story = {
  render: () => <SelectionBarStory />,
};
