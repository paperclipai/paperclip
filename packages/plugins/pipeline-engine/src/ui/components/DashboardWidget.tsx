import { usePluginData, useHostContext } from "@paperclipai/plugin-sdk/ui";
import type { PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";
import { DATA_KEYS } from "../constants.js";

interface HealthMetrics {
  active: number;
  stuck: number;
  completed: number;
  failed: number;
  escalated: number;
}

interface ListRunsResult {
  metrics: HealthMetrics;
}

function MetricCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div
      style={{
        background: "#111827",
        border: `1px solid ${color}33`,
        borderRadius: 8,
        padding: "12px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        flex: 1,
        minWidth: 80,
      }}
    >
      <div
        style={{
          fontSize: 24,
          fontWeight: 700,
          color,
          lineHeight: 1,
        }}
      >
        {value}
      </div>
      <div
        style={{
          fontSize: 11,
          color: "#9ca3af",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          fontWeight: 600,
        }}
      >
        {label}
      </div>
    </div>
  );
}

export function PipelineHealthWidget({ context }: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<ListRunsResult>(DATA_KEYS.LIST_RUNS, {
    companyId: context.companyId,
    summary: true,
  });

  if (loading) {
    return (
      <div style={{ padding: 16, color: "#9ca3af", fontSize: 12 }}>
        Loading pipeline health...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 16, color: "#ef4444", fontSize: 12 }}>
        Pipeline health unavailable: {error.message}
      </div>
    );
  }

  const metrics: HealthMetrics = data?.metrics ?? {
    active: 0,
    stuck: 0,
    completed: 0,
    failed: 0,
    escalated: 0,
  };

  return (
    <div
      style={{
        background: "#1f2937",
        borderRadius: 10,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ color: "#f9fafb", fontSize: 14, fontWeight: 700 }}>Pipeline Health</div>
        {metrics.stuck > 0 && (
          <div
            style={{
              background: "#f59e0b22",
              color: "#f59e0b",
              border: "1px solid #f59e0b44",
              borderRadius: 4,
              fontSize: 10,
              fontWeight: 700,
              padding: "2px 8px",
              letterSpacing: "0.05em",
            }}
          >
            {metrics.stuck} STUCK
          </div>
        )}
        {metrics.escalated > 0 && (
          <div
            style={{
              background: "#f9730022",
              color: "#f97300",
              border: "1px solid #f9730044",
              borderRadius: 4,
              fontSize: 10,
              fontWeight: 700,
              padding: "2px 8px",
              letterSpacing: "0.05em",
            }}
          >
            {metrics.escalated} ESCALATED
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <MetricCard label="Active" value={metrics.active} color="#3b82f6" />
        <MetricCard label="Stuck" value={metrics.stuck} color="#f59e0b" />
        <MetricCard label="Completed" value={metrics.completed} color="#22c55e" />
        <MetricCard label="Failed" value={metrics.failed} color="#ef4444" />
      </div>
    </div>
  );
}
