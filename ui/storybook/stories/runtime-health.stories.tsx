import { useMemo } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ToolConnection,
  ToolRuntimeAlertRecommendation,
  ToolRuntimeHealthSummary,
  ToolRuntimeSlot,
} from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { queryKeys } from "@/lib/queryKeys";
import { RuntimeTab } from "@/pages/tools/RuntimeTab";

const COMPANY = "company-storybook";

function slot(overrides: Partial<ToolRuntimeSlot> = {}): ToolRuntimeSlot {
  return {
    id: "slot-gmail",
    companyId: COMPANY,
    applicationId: "app-gmail",
    connectionId: "conn-gmail",
    projectWorkspaceId: null,
    executionWorkspaceId: null,
    issueId: null,
    ownerScopeType: "company",
    ownerScopeId: null,
    runtimeKind: "local_stdio",
    slotKey: "gmail-stdio-local",
    status: "running",
    reuseKey: null,
    workspaceScope: null,
    credentialScopeHash: null,
    provider: null,
    providerRef: null,
    processId: 41832,
    commandTemplateKey: "gmail",
    healthStatus: "healthy",
    lastHealthCheckAt: null,
    idleExpiresAt: null,
    startedAt: new Date("2026-06-13T10:46:00Z"),
    stoppedAt: null,
    lastUsedAt: new Date("2026-06-13T12:55:00Z"),
    lastError: null,
    metadata: null,
    createdAt: new Date("2026-06-13T10:46:00Z"),
    updatedAt: new Date("2026-06-13T13:00:00Z"),
    ...overrides,
  } as ToolRuntimeSlot;
}

function connection(overrides: Partial<ToolConnection> = {}): ToolConnection {
  return {
    id: "conn-gmail",
    companyId: COMPANY,
    applicationId: "app-gmail",
    name: "Gmail",
    connectionKind: "managed",
    transport: "local_stdio",
    status: "active",
    transportConfig: {},
    credentialSecretRefs: [],
    healthStatus: "healthy",
    healthCheckedAt: null,
    lastError: null,
    enabled: true,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-06-13T10:46:00Z"),
    updatedAt: new Date("2026-06-13T13:00:00Z"),
    ...overrides,
  } as ToolConnection;
}

const SLOTS: ToolRuntimeSlot[] = [
  slot(),
  slot({
    id: "slot-sheets",
    applicationId: "app-sheets",
    connectionId: "conn-sheets",
    slotKey: "sheets-stdio-local",
    commandTemplateKey: "google_sheets",
    processId: 41877,
    lastUsedAt: new Date("2026-06-13T12:51:00Z"),
  }),
  slot({
    id: "slot-slack",
    applicationId: "app-slack",
    connectionId: "conn-slack",
    runtimeKind: "remote_session",
    slotKey: "slack-remote",
    commandTemplateKey: null,
    providerRef: "slack",
    processId: null,
    lastUsedAt: new Date("2026-06-13T12:42:00Z"),
  }),
  slot({
    id: "slot-github",
    applicationId: "app-github",
    connectionId: "conn-github",
    slotKey: "github-stdio-local",
    commandTemplateKey: "github",
    processId: 41901,
    lastUsedAt: new Date("2026-06-13T12:59:00Z"),
  }),
];

const CONNECTIONS: ToolConnection[] = [
  connection(),
  connection({ id: "conn-sheets", applicationId: "app-sheets", name: "Google Sheets" }),
  connection({ id: "conn-slack", applicationId: "app-slack", name: "Slack", transport: "remote_http" }),
  connection({ id: "conn-github", applicationId: "app-github", name: "GitHub" }),
];

function alert(overrides: Partial<ToolRuntimeAlertRecommendation> = {}): ToolRuntimeAlertRecommendation {
  return {
    name: "mcp_runtime_stuck_running_slot",
    severity: "critical",
    status: "firing",
    threshold: "Any running slot with no progress for 5 minutes.",
    observed: "1 stuck running slot(s).",
    description: "A runtime slot is running but has not recorded progress inside the supervisor stuck-slot window.",
    firstResponderAction: "Inspect recent audit events and active tool calls; restart the slot only after confirming no healthy call is still in progress.",
    runbookSection: "runbook.md#stuck-running-slot",
    ...overrides,
  };
}

function health(overrides: Partial<ToolRuntimeHealthSummary> = {}): ToolRuntimeHealthSummary {
  return {
    status: "ok",
    generatedAt: new Date("2026-06-13T13:00:00Z"),
    runbookPath: "docs/runbooks/mcp-runtime.md",
    metrics: {
      windowStartedAt: new Date("2026-06-13T12:00:00Z"),
      windowEndedAt: new Date("2026-06-13T13:00:00Z"),
      activeSlots: 4,
      startingSlots: 0,
      runningSlots: 4,
      idleSlots: 0,
      failedSlots: 0,
      stoppedSlots: 0,
      stuckStartingSlots: 0,
      stuckRunningSlots: 0,
      capacityDeferralsLastHour: 0,
      restartAttemptsLastHour: 0,
      restartSuppressionsLastHour: 0,
      idleEvictionsLastHour: 0,
      toolCallsLastHour: 128,
      toolTimeoutsLastHour: 0,
      toolFailuresLastHour: 0,
      timeoutRateLastHour: 0,
      failureRateLastHour: 0,
      averageToolLatencyMsLastHour: 1200,
      p95ToolLatencyMsLastHour: 2100,
      missingSecretFailuresLastHour: 0,
      auditWriteFailuresLastHour: 0,
      activeConnections: 4,
      disabledConnections: 0,
      degradedConnections: 0,
      remoteHttpConnections: 1,
      localStdioConnections: 3,
    },
    supportMatrix: {
      remoteHttp: { supported: true, note: "" },
      localStdio: { supported: true, note: "" },
    },
    alerts: [],
    recommendations: [],
    ...overrides,
  };
}

function Seeded({
  slots,
  connections,
  summary,
}: {
  slots: ToolRuntimeSlot[];
  connections: ToolConnection[];
  summary: ToolRuntimeHealthSummary;
}) {
  const client = useMemo(() => {
    const c = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity, retry: false, refetchOnMount: false } },
    });
    c.setQueryData(queryKeys.tools.runtimeSlots(COMPANY), { runtimeSlots: slots });
    c.setQueryData(queryKeys.tools.runtimeHealth(COMPANY), summary);
    c.setQueryData(queryKeys.tools.connections(COMPANY), { connections });
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <div className="mx-auto max-w-5xl p-6">
          <RuntimeTab companyId={COMPANY} />
        </div>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

const meta: Meta = {
  title: "Tools/Health (runtime)",
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj;

export const AllGood: Story = {
  name: "All good",
  render: () => <Seeded slots={SLOTS} connections={CONNECTIONS} summary={health()} />,
};

export const NeedsAttention: Story = {
  name: "Needs attention",
  render: () => (
    <Seeded
      slots={[
        slot({ healthStatus: "error", lastError: "MCP request timed out after 30000ms" }),
        ...SLOTS.slice(1),
      ]}
      connections={[connection({ healthStatus: "degraded" }), ...CONNECTIONS.slice(1)]}
      summary={health({
        status: "degraded",
        metrics: {
          ...health().metrics,
          runningSlots: 3,
          degradedConnections: 1,
          toolFailuresLastHour: 11,
          toolTimeoutsLastHour: 3,
          timeoutRateLastHour: 12,
          averageToolLatencyMsLastHour: 2400,
          p95ToolLatencyMsLastHour: 5200,
        },
        alerts: [alert(), alert({ name: "mcp_runtime_connection_health_degraded", observed: "1 degraded connection(s), 0 disabled connection(s)." })],
      })}
    />
  ),
};

export const RowExpanded: Story = {
  name: "Row expanded (use the chevron)",
  render: () => <Seeded slots={SLOTS} connections={CONNECTIONS} summary={health()} />,
};
