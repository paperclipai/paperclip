import type { Meta, StoryObj } from "@storybook/react-vite";
import type {
  Agent,
  ToolCallEvent,
  ToolConnectionLifecycleEvent,
} from "@paperclipai/shared";
import { ActivityPanel } from "@/pages/apps/app-detail/ActivityPanel";
import type { ActivityPanelProps } from "@/pages/apps/app-detail/types";

const CONNECTION_ID = "conn-sheets";
const MIN = 60 * 1000;

const AGENTS = [
  { id: "agent-coder", name: "Coder" },
  { id: "agent-scout", name: "Scout" },
] as unknown as Agent[];

function callEvent(overrides: Partial<ToolCallEvent>): ToolCallEvent {
  return {
    id: "evt",
    companyId: "company-storybook",
    eventType: "call_completed",
    actorType: "agent",
    actorId: "agent-coder",
    agentId: "agent-coder",
    runId: null,
    issueId: null,
    applicationId: "app-sheets",
    connectionId: CONNECTION_ID,
    catalogEntryId: null,
    invocationId: null,
    actionRequestId: null,
    runtimeSlotId: null,
    toolName: "Get value",
    decision: "allow",
    matchedPolicyIds: [],
    reasonCode: null,
    outcome: "success",
    latencyMs: 120,
    requestHash: null,
    requestSummary: null,
    resultHash: null,
    resultSummary: null,
    resultSizeBytes: null,
    redactionPlan: null,
    rateLimitState: null,
    metadata: null,
    errorCode: null,
    errorMessage: null,
    createdAt: new Date(Date.now() - 40 * MIN),
    ...overrides,
  } as ToolCallEvent;
}

function lifecycle(overrides: Partial<ToolConnectionLifecycleEvent>): ToolConnectionLifecycleEvent {
  return {
    id: "life",
    connectionId: CONNECTION_ID,
    type: "app_connected",
    actorType: "user",
    actorId: "user-board",
    agentId: null,
    actorDisplayName: "Dotta",
    details: null,
    createdAt: new Date(Date.now() - 90 * MIN),
    ...overrides,
  };
}

const LIFECYCLE_EVENTS: ToolConnectionLifecycleEvent[] = [
  lifecycle({ id: "life-connected", type: "app_connected", createdAt: new Date(Date.now() - 180 * MIN) }),
  lifecycle({
    id: "life-allowlist",
    type: "allowlist_changed",
    details: { added: 1, removed: 0, total: 3 },
    createdAt: new Date(Date.now() - 120 * MIN),
  }),
  lifecycle({
    id: "life-quarantine",
    type: "actions_quarantined",
    actorType: "system",
    actorId: null,
    actorDisplayName: null,
    details: { count: 2 },
    createdAt: new Date(Date.now() - 60 * MIN),
  }),
  lifecycle({ id: "life-paused", type: "app_paused", details: { enabled: false }, createdAt: new Date(Date.now() - 25 * MIN) }),
  lifecycle({ id: "life-resumed", type: "app_resumed", details: { enabled: true }, createdAt: new Date(Date.now() - 10 * MIN) }),
];

const CALL_EVENTS: ToolCallEvent[] = [
  callEvent({ id: "evt-1", toolName: "Get value", createdAt: new Date(Date.now() - 40 * MIN) }),
  callEvent({
    id: "evt-2",
    eventType: "call_denied",
    toolName: "Delete spreadsheet",
    outcome: "denied",
    createdAt: new Date(Date.now() - 15 * MIN),
  }),
];

function panelProps(overrides: Partial<ActivityPanelProps> = {}): ActivityPanelProps {
  return {
    events: CALL_EVENTS,
    lifecycleEvents: LIFECYCLE_EVENTS,
    issues: {},
    actionRequests: {},
    loading: false,
    agents: AGENTS,
    connectionId: CONNECTION_ID,
    appName: "Google Sheets (stdio smoke)",
    ...overrides,
  };
}

function Panel(props: ActivityPanelProps) {
  return (
    <div className="mx-auto max-w-2xl p-6">
      <ActivityPanel {...props} />
    </div>
  );
}

const meta: Meta = {
  title: "Apps/App detail · Activity (lifecycle)",
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj;

export const MixedTimeline: Story = {
  name: "Tool calls + lifecycle",
  render: () => <Panel {...panelProps()} />,
};

export const LifecycleOnly: Story = {
  name: "Lifecycle only",
  render: () => <Panel {...panelProps({ events: [] })} />,
};

export const Loading: Story = {
  name: "Loading",
  render: () => <Panel {...panelProps({ loading: true })} />,
};

export const Empty: Story = {
  name: "Empty",
  render: () => <Panel {...panelProps({ events: [], lifecycleEvents: [] })} />,
};
