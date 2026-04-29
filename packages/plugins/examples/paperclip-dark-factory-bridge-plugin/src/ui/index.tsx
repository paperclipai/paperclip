import {
  useState,
} from "react";
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
  journalCursor: JournalCursor;
  lastSequenceNo: number;
  projectionStatus: string;
  callbackReceiptId: string;
  staleReason: string | null;
  degradedReason: string | null;
  blockedReason: string | null;
  projection: {
    runId: string;
    linkedRunId: string;
    projectionStatus: string;
    journalCursor: JournalCursor;
    journalCursorMetadata: JournalCursor;
    lastSequenceNo: number;
    callbackReceiptId: string;
    staleReason: string | null;
    degradedReason: string | null;
    blockedReason: string | null;
    callbackReceipt: {
      receiptId: string;
      status: string;
      terminalStateAdvanced: boolean;
    };
    flags: {
      degraded: boolean;
      blocked: boolean;
      needsApproval: boolean;
      stale: boolean;
    };
    lastUpdatedAt: string;
  };
  providerHealth: {
    providerRole: string;
    modelRole: string;
    modelSelection: {
      policy: string;
      protocolMustSpecifyConcreteModel: boolean;
      configuredModelName: string | null;
    };
    providerState: string;
    degraded: boolean;
    blocked: boolean;
    fallbackTriggered: boolean;
    degradedReason: string | null;
    blockedReason: string | null;
    fallbackReason: string | null;
    breakerState: string;
    lastUpdatedAt: string;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    openReason: string | null;
    cooldownUntil: string | null;
  };
};

type JournalCursor = {
  cursorId: string;
  runId: string;
  journalCursor: string;
  lastSequenceNo: number;
  lastJournalSequenceNo: number;
  journalRef: string;
  sourceJournalRef: string;
  monotonic: boolean;
  gapDetected: boolean;
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

const badgeStyle = {
  border: "1px solid #cbd5e1",
  background: "#f8fafc",
  borderRadius: 999,
  padding: "2px 8px",
  fontSize: 12,
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

const errorStyle = {
  border: "1px solid #fecaca",
  background: "#fef2f2",
  color: "#991b1b",
  borderRadius: 6,
  padding: "6px 8px",
} satisfies React.CSSProperties;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function Disclaimer() {
  return <div style={noticeStyle}>{DISCLAIMER}</div>;
}

function Badge({ label, active, reason }: { label: string; active: boolean; reason?: string | null }) {
  if (!active) return null;
  return <span style={badgeStyle}>{label}{reason ? `: ${reason}` : ""}</span>;
}

function ProjectionRows({ data }: { data: ProjectionSummary }) {
  const projection = data.projection;
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div style={rowStyle}><span>Linked Run id</span><code>{projection.linkedRunId}</code></div>
      <div style={rowStyle}><span>Journal cursor</span><code>{projection.journalCursorMetadata.journalCursor}</code></div>
      <div style={rowStyle}><span>Source journal ref</span><code>{projection.journalCursorMetadata.sourceJournalRef}</code></div>
      <div style={rowStyle}><span>Last sequence</span><strong>{projection.lastSequenceNo}</strong></div>
      <div style={rowStyle}><span>Projection status</span><strong>{projection.projectionStatus}</strong></div>
      <div style={rowStyle}><span>Callback receipt</span><code>{projection.callbackReceiptId}</code></div>
      <div style={rowStyle}><span>Receipt status</span><strong>{projection.callbackReceipt.status}</strong></div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        <Badge label="degraded" active={projection.flags.degraded} reason={projection.degradedReason} />
        <Badge label="blocked" active={projection.flags.blocked} reason={projection.blockedReason} />
        <Badge label="stale" active={projection.flags.stale} reason={projection.staleReason} />
        <Badge label="needs approval" active={projection.flags.needsApproval} />
      </div>
    </div>
  );
}

function ProviderHealthRows({ data }: { data: ProjectionSummary }) {
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div style={rowStyle}><span>Provider role</span><code>{data.providerHealth.providerRole}</code></div>
      <div style={rowStyle}><span>Model role</span><code>{data.providerHealth.modelRole}</code></div>
      <div style={rowStyle}><span>Model policy</span><code>{data.providerHealth.modelSelection.policy}</code></div>
      <div style={rowStyle}><span>Concrete model protocol MUST</span><strong>{data.providerHealth.modelSelection.protocolMustSpecifyConcreteModel ? "yes" : "no"}</strong></div>
      <div style={rowStyle}><span>Breaker state</span><strong>{data.providerHealth.breakerState}</strong></div>
      <div style={rowStyle}><span>Provider state</span><strong>{data.providerHealth.providerState}</strong></div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        <Badge label="provider degraded" active={data.providerHealth.degraded} reason={data.providerHealth.degradedReason} />
        <Badge label="provider blocked" active={data.providerHealth.blocked} reason={data.providerHealth.blockedReason} />
        <Badge label="fallback" active={data.providerHealth.fallbackTriggered} reason={data.providerHealth.fallbackReason} />
      </div>
      <div style={rowStyle}><span>Last updated</span><code>{data.providerHealth.lastUpdatedAt}</code></div>
      <div style={rowStyle}><span>Last success</span><code>{data.providerHealth.lastSuccessAt ?? "none"}</code></div>
      <div style={rowStyle}><span>Last failure</span><code>{data.providerHealth.lastFailureAt ?? "none"}</code></div>
      <div style={rowStyle}><span>Open reason</span><code>{data.providerHealth.openReason ?? "none"}</code></div>
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
      <ProjectionRows data={data} />
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
  const [rehydrateError, setRehydrateError] = useState<string | null>(null);
  const [rehydratePending, setRehydratePending] = useState(false);

  if (loading) return <div>Loading Dark Factory projection...</div>;
  if (error) return <div>Dark Factory bridge error: {error.message}</div>;
  if (!data) return null;

  return (
    <div style={panelStyle}>
      <div style={rowStyle}>
        <strong>Dark Factory Projection</strong>
        <button
          style={buttonStyle}
          title="Submits a receipt-only rehydrate intention; it does not mean terminal success."
          disabled={rehydratePending}
          onClick={async () => {
            setRehydrateError(null);
            setRehydratePending(true);
            try {
              await requestRehydrate({ companyId: context.companyId, issueId: context.entityId, reason: "operator refresh from task detail tab" });
              refresh();
            } catch (error) {
              setRehydrateError(errorMessage(error));
            } finally {
              setRehydratePending(false);
            }
          }}
        >
          {rehydratePending ? "Requesting..." : "Request rehydrate (receipt only)"}
        </button>
      </div>
      <Disclaimer />
      <div style={noticeStyle}>Request Rehydrate only submits an intention/receipt. It does not advance terminal success and does not make this projection authoritative.</div>
      {rehydrateError ? <div role="alert" style={errorStyle}>Rehydrate request failed: {rehydrateError}</div> : null}
      <ProjectionRows data={data} />
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
      <ProjectionRows data={data} />
      <ProviderHealthRows data={data} />
    </div>
  );
}
