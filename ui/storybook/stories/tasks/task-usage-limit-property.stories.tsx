import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Agent, ProviderRateLimitSnapshot } from "@paperclipai/shared";
import { AgentIdentity } from "@/components/AgentIdentity";
import { AgentRateLimitPropertyValue } from "@/components/AgentRateLimitGauge";
import { IssueStatusBadge } from "@/components/StatusBadge";
import { PropertyRow, PropertySection } from "@/components/issue-properties/primitives";

// Local-time ISO strings (no zone) keep the rendered clocks stable across machines.
const NOW = new Date("2026-11-05T15:18:00").getTime();
const at = (local: string) => new Date(local).toISOString();

const window = (id: string, label: string, shortLabel: string, windowMinutes: number, usedPercent: number, resetsAt: string) => ({
  id, label, shortLabel, windowMinutes, usedPercent, resetsAt: at(resetsAt), status: null,
});

const codex: ProviderRateLimitSnapshot = {
  schema: "paperclip.provider.rate_limits.v1",
  provider: "openai",
  windows: [
    window("codex.primary", "5-hour window", "5h", 300, 78, "2026-11-05T15:40:00"),
    window("codex.secondary", "Weekly", "7d", 10080, 41, "2026-11-09T09:00:00"),
  ],
  credits: null,
  limitReached: null,
  observedAt: at("2026-11-05T15:17:00"),
};

const claude: ProviderRateLimitSnapshot = {
  schema: "paperclip.provider.rate_limits.v1",
  provider: "anthropic",
  windows: [
    window("claude.five_hour", "5-hour window", "5h", 300, 86, "2026-11-05T17:05:00"),
    window("claude.seven_day", "Weekly", "7d", 10080, 63, "2026-11-10T08:00:00"),
    window("claude.seven_day_opus", "Weekly (Opus)", "7d Opus", 10080, 52, "2026-11-10T08:00:00"),
  ],
  credits: null,
  limitReached: null,
  observedAt: at("2026-11-05T15:16:00"),
};

const limited: ProviderRateLimitSnapshot = {
  ...codex,
  windows: [
    window("codex.primary", "5-hour window", "5h", 300, 100, "2026-11-05T15:40:00"),
    window("codex.secondary", "Weekly", "7d", 10080, 71, "2026-11-09T09:00:00"),
  ],
  credits: { hasCredits: false, unlimited: false, balance: null },
  limitReached: { windowId: "codex.primary", reason: "rate_limit_reached", resetsAt: at("2026-11-05T15:40:00") },
  observedAt: at("2026-11-05T15:02:00"),
};

const agent = (id: string, name: string) => ({ id, name, companyId: "company-story" }) as unknown as Agent;

function Pane({ caption, assignee, model, snapshot, open }: {
  caption: string;
  assignee: Agent;
  model: string;
  snapshot: ProviderRateLimitSnapshot | null;
  open?: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="text-xs text-muted-foreground">{caption}</div>
      <div className="w-80 border border-border bg-background p-4">
        <PropertySection title="Properties" first streamlined>
          <PropertyRow label="Status"><IssueStatusBadge status="in_progress" /></PropertyRow>
          <PropertyRow label="Assignee"><AgentIdentity agent={assignee} size="sm" /></PropertyRow>
          <PropertyRow label="Model"><span className="truncate font-mono text-xs">{model}</span></PropertyRow>
          {snapshot && (
            <PropertyRow label="Usage limit">
              <AgentRateLimitPropertyValue snapshot={snapshot} now={NOW} defaultOpen={open} detailsHref="/agents/planner" />
            </PropertyRow>
          )}
          <PropertyRow label="Project"><span className="truncate text-sm">Billing revamp</span></PropertyRow>
        </PropertySection>
      </div>
    </div>
  );
}

function UsageLimitProperty() {
  return (
    <div className="flex items-start gap-6 p-6 pb-72">
      <Pane caption="Normal (Codex)" assignee={agent("agent-planner", "Planner")} model="gpt-5.6-sol" snapshot={codex} />
      <Pane caption="Above 80% (Claude)" assignee={agent("agent-engineer", "Founding Engineer")} model="claude-opus-5-5" snapshot={claude} />
      <Pane caption="Limit reached" assignee={agent("agent-reviewer", "Code Reviewer")} model="gpt-5.6-sol" snapshot={limited} />
      <Pane caption="Details popover" assignee={agent("agent-engineer", "Founding Engineer")} model="claude-opus-5-5" snapshot={claude} open />
    </div>
  );
}

const meta = {
  id: "tasks-usage-limit-property",
  title: "Tasks and conversations/Task creation and lifecycle/Usage limit property",
  component: UsageLimitProperty,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "The task properties pane shows the assignee's latest provider usage limit as one line: the fullest current window and its reset, amber above 80%, 'Limited until' while the provider refuses work. Clicking it lists every window. Agents on API-key auth report no limits and show no row.",
      },
    },
    paperclip: {
      capabilities: ["tasks/properties"],
      status: "current",
      implementation: "production",
      boundary: "fixtures",
      notes: "Renders the shipped AgentRateLimitPropertyValue inside the shared property primitives with a fixed clock. Snapshots mirror Codex account/rateLimits/updated and Claude rate_limit_event windows; the runtime-state query is not exercised.",
    },
  },
} satisfies Meta<typeof UsageLimitProperty>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {};
