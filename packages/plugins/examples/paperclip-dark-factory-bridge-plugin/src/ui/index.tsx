import {
  usePluginAction,
  usePluginData,
  type PluginDetailTabProps,
  type PluginSettingsPageProps,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";
import type React from "react";

const DISCLAIMER = "Projection only — Dark Factory Journal remains truth source";

type ProjectionSummary = {
  source: "dark-factory-projection";
  truthSource: "dark-factory-journal";
  authoritative: false;
  disclaimer: string;
  projection: {
    linkedRunId: string;
    projectionStatus: string;
    journalCursor: {
      cursorId: string;
      lastJournalSequenceNo: number;
      journalRef: string;
      monotonic: boolean;
      gapDetected: boolean;
    };
    callbackReceipt: {
      receiptId: string;
      status: string;
      terminalStateAdvanced: boolean;
    };
    flags: {
      degraded: boolean;
      blocked: boolean;
      needsApproval: boolean;
    };
    lastUpdatedAt: string;
  };
  providerHealth: {
    providerRole: string;
    breakerState: string;
    lastUpdatedAt: string;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    openReason: string | null;
    cooldownUntil: string | null;
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

const noticeStyle = {
  border: "1px solid #f59e0b",
  background: "#fffbeb",
  color: "#92400e",
  borderRadius: 6,
  padding: "6px 8px",
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

function Disclaimer() {
  return <div style={noticeStyle}>{DISCLAIMER}</div>;
}

function ProviderHealthRows({ data }: { data: ProjectionSummary }) {
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div style={rowStyle}><span>Provider role</span><code>{data.providerHealth.providerRole}</code></div>
      <div style={rowStyle}><span>Breaker state</span><strong>{data.providerHealth.breakerState}</strong></div>
      <div style={rowStyle}><span>Last updated</span><code>{data.providerHealth.lastUpdatedAt}</code></div>
      <div style={rowStyle}><span>Last success</span><code>{data.providerHealth.lastSuccessAt ?? "none"}</code></div>
      <div style={rowStyle}><span>Last failure</span><code>{data.providerHealth.lastFailureAt ?? "none"}</code></div>
    </div>
  );
}

export function DashboardWidget({ context }: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<ProjectionSummary>("projection-summary", {
    companyId: context.companyId,
  });

  if (loading) return <div>Loading Dark Factory provider health projection...</div>;
  if (error) return <div>Dark Factory bridge error: {error.message}</div>;
  if (!data) return null;

  return (
    <div style={panelStyle}>
      <strong>Dark Factory Bridge Projection</strong>
      <Disclaimer />
      <ProviderHealthRows data={data} />
    </div>
  );
}

export function IssuePanel({ context }: PluginDetailTabProps) {
  const { data, loading, error, refresh } = usePluginData<ProjectionSummary>("projection-summary", {
    companyId: context.companyId,
    issueId: context.entityId,
  });
  const requestRehydrate = usePluginAction("request-rehydrate");

  if (loading) return <div>Loading Dark Factory projection...</div>;
  if (error) return <div>Dark Factory bridge error: {error.message}</div>;
  if (!data) return null;

  return (
    <div style={panelStyle}>
      <div style={rowStyle}>
        <strong>Dark Factory Projection</strong>
        <button
          style={buttonStyle}
          onClick={async () => {
            await requestRehydrate({ companyId: context.companyId, issueId: context.entityId, reason: "operator refresh from task detail tab" });
            refresh();
          }}
        >
          Request rehydrate
        </button>
      </div>
      <Disclaimer />
      <div style={rowStyle}><span>Linked Run id</span><code>{data.projection.linkedRunId}</code></div>
      <div style={rowStyle}><span>Journal cursor</span><code>{data.projection.journalCursor.journalRef}</code></div>
      <div style={rowStyle}><span>Sequence</span><strong>{data.projection.journalCursor.lastJournalSequenceNo}</strong></div>
      <div style={rowStyle}><span>Projection status</span><strong>{data.projection.projectionStatus}</strong></div>
      <div style={rowStyle}><span>Callback receipt</span><code>{data.projection.callbackReceipt.receiptId}</code></div>
      <div style={rowStyle}><span>Receipt status</span><strong>{data.projection.callbackReceipt.status}</strong></div>
      <div style={rowStyle}><span>Degraded</span><strong>{data.projection.flags.degraded ? "yes" : "no"}</strong></div>
      <div style={rowStyle}><span>Blocked</span><strong>{data.projection.flags.blocked ? "yes" : "no"}</strong></div>
      <div style={rowStyle}><span>Needs approval</span><strong>{data.projection.flags.needsApproval ? "yes" : "no"}</strong></div>
      <ProviderHealthRows data={data} />
    </div>
  );
}

export function SettingsPage({ context }: PluginSettingsPageProps) {
  const { data, loading, error } = usePluginData<ProjectionSummary>("projection-summary", {
    companyId: context.companyId,
  });

  if (loading) return <div>Loading Dark Factory bridge settings...</div>;
  if (error) return <div>Dark Factory bridge settings error: {error.message}</div>;
  if (!data) return null;

  return (
    <div style={panelStyle}>
      <strong>Dark Factory Bridge Settings</strong>
      <Disclaimer />
      <div>Mock projection mode. No real Dark Factory connection is configured, and no token or secret is stored.</div>
      <ProviderHealthRows data={data} />
    </div>
  );
}
