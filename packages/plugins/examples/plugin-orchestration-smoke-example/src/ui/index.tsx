import {
  usePluginAction,
  usePluginData,
  type PluginDetailTabProps,
  type PluginSettingsPageProps,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";
import type React from "react";

type SurfaceStatus = {
  status: "ok" | "degraded" | "error";
  checkedAt: string;
  databaseNamespace: string;
  routeKeys: string[];
  capabilities: string[];
  summary: null | {
    rootIssueId: string;
    childIssueId: string | null;
    blockerIssueId: string | null;
    billingCode: string;
    subtreeIssueIds: string[];
    wakeupQueued: boolean;
  };
};

const panelStyle = {
  display: "grid",
  gap: 10,
  fontSize: 13,
  lineHeight: 1.45,
} satisfies React.CSSProperties;

const rowStyle = {
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
} satisfies React.CSSProperties;

const buttonStyle = {
  border: "1px solid #1f2937",
  background: "#111827",
  color: "#fff",
  borderRadius: 6,
  padding: "6px 10px",
  font: "inherit",
  cursor: "pointer",
} satisfies React.CSSProperties;

function SurfaceRows({ data }: { data: SurfaceStatus }) {
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div style={rowStyle}><span>Status</span><strong>{data.status}</strong></div>
      <div style={rowStyle}><span>Namespace</span><code>{data.databaseNamespace}</code></div>
      <div style={rowStyle}><span>Routes</span><code>{data.routeKeys.join(", ")}</code></div>
      <div style={rowStyle}><span>Capabilities</span><strong>{data.capabilities.length}</strong></div>
    </div>
  );
}

export function DashboardWidget({ context }: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<SurfaceStatus>("surface-status", {
    companyId: context.companyId,
  });

  if (loading) return <div>Loading orchestration smoke status...</div>;
  if (error) return <div>Orchestration smoke error: {error.message}</div>;
  if (!data) return null;

  return (
    <div style={panelStyle}>
      <strong>Orchestration Smoke</strong>
      <SurfaceRows data={data} />
      <div>Checked {data.checkedAt}</div>
    </div>
  );
}

export function IssuePanel({ context }: PluginDetailTabProps) {
  const { data, loading, error, refresh } = usePluginData<SurfaceStatus>("surface-status", {
    companyId: context.companyId,
    issueId: context.entityId,
  });
  const initialize = usePluginAction("initialize-smoke");

  if (loading) return <div>Loading orchestration smoke...</div>;
  if (error) return <div>Orchestration smoke error: {error.message}</div>;
  if (!data) return null;

  return (
    <div style={panelStyle}>
      <div style={rowStyle}>
        <strong>Orchestration Smoke</strong>
        <button
          style={buttonStyle}
          onClick={async () => {
            await initialize({ companyId: context.companyId, issueId: context.entityId });
            refresh();
          }}
        >
          Run Smoke
        </button>
      </div>
      <SurfaceRows data={data} />
      {data.summary ? (
        <div style={{ display: "grid", gap: 4 }}>
          <div style={rowStyle}><span>Child</span><code>{data.summary.childIssueId ?? "none"}</code></div>
          <div style={rowStyle}><span>Blocker</span><code>{data.summary.blockerIssueId ?? "none"}</code></div>
          <div style={rowStyle}><span>Billing</span><code>{data.summary.billingCode}</code></div>
          <div style={rowStyle}><span>Subtree</span><strong>{data.summary.subtreeIssueIds.length}</strong></div>
          <div style={rowStyle}><span>Wakeup</span><strong>{data.summary.wakeupQueued ? "queued" : "not queued"}</strong></div>
        </div>
      ) : (
        <div>No smoke run recorded for this issue.</div>
      )}
    </div>
  );
}

export function SettingsPage({ context }: PluginSettingsPageProps) {
  const { data, loading, error } = usePluginData<SurfaceStatus>("surface-status", {
    companyId: context.companyId,
  });

  if (loading) return <div>Loading orchestration smoke settings...</div>;
  if (error) return <div>Orchestration smoke settings error: {error.message}</div>;
  if (!data) return null;

  return (
    <div style={panelStyle}>
      <strong>Orchestration Smoke Surface</strong>
      <SurfaceRows data={data} />
    </div>
  );
}
