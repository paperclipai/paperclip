import type { Meta, StoryObj } from "@storybook/react-vite";
import { DevRestartBanner } from "@/components/DevRestartBanner";
import type { DevServerHealthStatus } from "@/api/health";

const restartRequired: DevServerHealthStatus = {
  enabled: true,
  restartRequired: true,
  reason: "backend_changes_and_pending_migrations",
  lastChangedAt: new Date(Date.now() - 7 * 60_000).toISOString(),
  changedPathCount: 4,
  changedPathsSample: [
    "server/src/routes/health.ts",
    "server/src/dev-runner.ts",
    "packages/shared/src/api.ts",
  ],
  pendingMigrations: ["0042_dev_server_health.sql"],
  autoRestartEnabled: false,
  activeRunCount: 0,
  waitingForIdle: false,
  lastRestartAt: new Date(Date.now() - 45 * 60_000).toISOString(),
};

const restartWaitingForIdle: DevServerHealthStatus = {
  ...restartRequired,
  reason: "backend_changes",
  pendingMigrations: [],
  autoRestartEnabled: true,
  activeRunCount: 2,
  waitingForIdle: true,
};

function DevOpsSurfacesStory() {
  return (
    <div className="space-y-6 p-6">
      <section className="overflow-hidden border border-border bg-background">
        <div className="border-b border-border px-5 py-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Dev server restart banner
          </div>
        </div>
        <DevRestartBanner devServer={restartRequired} />
      </section>

      <section className="max-w-[390px] overflow-hidden border border-border bg-background">
        <div className="border-b border-border px-4 py-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Mobile waiting state
          </div>
        </div>
        <DevRestartBanner devServer={restartWaitingForIdle} />
      </section>
    </div>
  );
}

const meta = {
  title: "Product/Dev Ops Surfaces",
  component: DevOpsSurfacesStory,
  parameters: {
    docs: {
      description: {
        component:
          "Shows local development recovery surfaces, including the restart-required banner and its manual restart action.",
      },
    },
  },
} satisfies Meta<typeof DevOpsSurfacesStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const DevOpsSurfaces: Story = {};
