import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  WorkspaceServiceControlBar,
  type WorkspaceServiceControlEntry,
} from "@/components/WorkspaceServiceControlBar";

const noop = () => {};

function entry(overrides: Partial<WorkspaceServiceControlEntry> = {}): WorkspaceServiceControlEntry {
  return {
    key: "svc-dev",
    name: "dev",
    state: "running",
    healthStatus: "healthy",
    url: "http://paperclip-dev:45439",
    port: 45439,
    canStart: true,
    ...overrides,
  };
}

const meta: Meta<typeof WorkspaceServiceControlBar> = {
  title: "Workspaces/Service control bar",
  component: WorkspaceServiceControlBar,
  parameters: {
    layout: "padded",
  },
  args: {
    onAction: noop,
  },
};

export default meta;
type Story = StoryObj<typeof WorkspaceServiceControlBar>;

export const Running: Story = {
  args: { services: [entry()] },
};

export const Stopped: Story = {
  args: { services: [entry({ state: "stopped" })] },
};

export const Starting: Story = {
  args: { services: [entry({ state: "starting" })] },
};

export const Stopping: Story = {
  args: { services: [entry({ state: "stopping" })] },
};

export const Restarting: Story = {
  args: { services: [entry({ state: "restarting" })] },
};

export const RunningUnhealthy: Story = {
  name: "Running · unhealthy",
  args: { services: [entry({ healthStatus: "unhealthy" })] },
};

export const Failed: Story = {
  args: {
    services: [
      entry({
        state: "failed",
        failureDetail: "dev exited with code 1, 12s ago",
      }),
    ],
    onViewLogs: noop,
  },
};

export const StartDisabled: Story = {
  name: "Stopped · start unavailable",
  args: { services: [entry({ state: "stopped", canStart: false })] },
};

export const LongUrl: Story = {
  name: "Running · long URL truncates",
  args: {
    services: [
      entry({
        url: "https://pap-14233-execution-workspace-service-start-stop.preview.paperclip.ing/deeply/nested/path",
      }),
    ],
  },
};

const MULTI_SERVICES: WorkspaceServiceControlEntry[] = [
  entry({ key: "svc-web", name: "web" }),
  entry({ key: "svc-api", name: "api", state: "starting", url: null, port: 8080 }),
  entry({ key: "svc-worker", name: "worker", state: "stopped", url: null, port: null }),
];

export const MultiService: Story = {
  name: "Multiple services (collapsed)",
  args: { services: MULTI_SERVICES },
};

export const MultiServiceOpen: Story = {
  name: "Multiple services (popover open)",
  args: {
    services: MULTI_SERVICES,
    defaultServicesOpen: true,
    onManageServices: noop,
  },
  decorators: [
    (Story) => (
      <div className="flex min-h-96 justify-end pr-4">
        <Story />
      </div>
    ),
  ],
};

export const HeaderContext: Story = {
  name: "In header context",
  render: (args) => (
    <div className="max-w-5xl rounded-xl border border-border bg-background p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Execution workspace
          </div>
          <h1 className="mt-1 truncate text-2xl font-bold text-foreground">
            PAP-14025-skills-need-to-be-organized-in-folders-the-ta…
          </h1>
        </div>
        <WorkspaceServiceControlBar {...args} />
      </div>
      <div className="mt-8 flex gap-6 border-b border-border pb-2 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">Tasks</span>
        <span>Services</span>
        <span>Configuration</span>
        <span>Runtime logs</span>
        <span>Runs</span>
      </div>
    </div>
  ),
  args: { services: [entry()] },
};

export const HeaderContextFailed: Story = {
  name: "In header context · failed",
  render: (args) => (
    <div className="max-w-5xl rounded-xl border border-border bg-background p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Execution workspace
          </div>
          <h1 className="mt-1 truncate text-2xl font-bold text-foreground">
            PAP-14025-skills-need-to-be-organized-in-folders-the-ta…
          </h1>
        </div>
        <WorkspaceServiceControlBar {...args} />
      </div>
      <div className="mt-8 flex gap-6 border-b border-border pb-2 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">Tasks</span>
        <span>Services</span>
        <span>Configuration</span>
      </div>
    </div>
  ),
  args: {
    services: [
      entry({
        state: "failed",
        failureDetail: "dev exited with code 1, 12s ago",
      }),
    ],
    onViewLogs: noop,
  },
};

export const MobileWidth: Story = {
  name: "Mobile width (two-row card)",
  decorators: [
    (Story) => (
      <div className="w-80 rounded-xl border border-dashed border-border p-3">
        <Story />
      </div>
    ),
  ],
  args: { services: [entry()] },
  parameters: {
    viewport: { defaultViewport: "mobile1" },
  },
};

export const AllStates: Story = {
  name: "All states (overview)",
  render: () => (
    <div className="flex max-w-2xl flex-col items-end gap-3">
      {(
        [
          ["Stopped", entry({ state: "stopped" })],
          ["Starting", entry({ state: "starting" })],
          ["Running", entry()],
          ["Unhealthy", entry({ healthStatus: "unhealthy" })],
          ["Stopping", entry({ state: "stopping" })],
          ["Restarting", entry({ state: "restarting" })],
          ["Failed", entry({ state: "failed", failureDetail: "dev exited with code 1, 12s ago" })],
        ] as const
      ).map(([label, service]) => (
        <div key={label} className="flex w-full items-center justify-between gap-6">
          <span className="text-sm font-medium text-muted-foreground">{label}</span>
          <WorkspaceServiceControlBar services={[service]} onAction={noop} onViewLogs={noop} />
        </div>
      ))}
    </div>
  ),
};
