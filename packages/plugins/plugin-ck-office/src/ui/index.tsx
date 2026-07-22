import {
  usePluginData,
  DataTable,
  StatusBadge,
  MetricCard,
  Spinner,
  type PluginPageProps,
  type DataTableColumn,
  type StatusBadgeVariant,
} from "@paperclipai/plugin-sdk/ui";

// Re-export the Meeting Room page so the manifest's `exportName: "MeetingRoomPage"` resolves from
// this single UI bundle entry.
export { MeetingRoomPage } from "./meeting-room.js";
export { CkOrgPage } from "./ck-org.js";
export { CkCrmPage } from "./embeds.js";
export { CkDivinoPage } from "./divino/cockpit.js";
export { CkMemoryPage } from "./ck-memory.js";
export { CkApprovalsPage } from "./ck-approvals.js";

interface EvalAgent {
  id: string;
  name: string;
  department: string;
  type: string;
  certification: string;
  specStatus: string | null;
  verdict: string | null;
  costAdjustedScore: number | null;
  latestEvalAt: string | null;
  recentRuns: number;
}

interface EvalOverview {
  company: string;
  companyId?: string;
  found: boolean;
  generatedAt: string;
  agents: EvalAgent[];
}

const DATA_KEY = "ck-eval-overview";

function verdictVariant(verdict: string | null): StatusBadgeVariant {
  switch (verdict) {
    case "keep":
      return "ok";
    case "tune":
      return "warning";
    case "quarantine":
    case "retire_proposed":
      return "error";
    default:
      return "pending";
  }
}

function certVariant(cert: string): StatusBadgeVariant {
  switch (cert) {
    case "certified":
      return "ok";
    case "draft":
      return "pending";
    case "quarantined":
      return "error";
    case "retired":
      return "info";
    default:
      return "warning";
  }
}

const columns: DataTableColumn<EvalAgent>[] = [
  { key: "name", header: "Agent", width: "24%" },
  {
    key: "department",
    header: "Department",
    render: (value) => (
      <StatusBadge
        label={String(value)}
        status={value === "governance" ? "info" : value === "revenue" ? "ok" : "pending"}
      />
    ),
  },
  { key: "type", header: "Type" },
  {
    key: "certification",
    header: "Certification",
    render: (value) => <StatusBadge label={String(value)} status={certVariant(String(value))} />,
  },
  {
    key: "verdict",
    header: "Latest verdict",
    render: (value) =>
      value ? (
        <StatusBadge label={String(value)} status={verdictVariant(String(value))} />
      ) : (
        <span style={{ opacity: 0.5 }}>none</span>
      ),
  },
  {
    key: "costAdjustedScore",
    header: "Cost-adj. score",
    render: (value) =>
      value == null ? <span style={{ opacity: 0.5 }}>—</span> : <span>{Number(value).toFixed(3)}</span>,
  },
  { key: "recentRuns", header: "Eval runs" },
  {
    key: "latestEvalAt",
    header: "Last evaluated",
    render: (value) =>
      value ? (
        <span>{new Date(String(value)).toLocaleString()}</span>
      ) : (
        <span style={{ opacity: 0.5 }}>—</span>
      ),
  },
];

const pageStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
  padding: 16,
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const cardsRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 12,
  flexWrap: "wrap",
};

export function CkEvaluationPage(_props: PluginPageProps) {
  const { data, loading, error } = usePluginData<EvalOverview>(DATA_KEY);

  if (loading && !data) {
    return (
      <div style={pageStyle}>
        <Spinner />
      </div>
    );
  }

  if (error) {
    return (
      <div style={pageStyle}>
        <StatusBadge label={`Error: ${error.message}`} status="error" />
      </div>
    );
  }

  const agents = data?.agents ?? [];
  const activeRoster = agents.filter(
    (a) => a.certification === "certified" || a.recentRuns > 0 || a.verdict != null,
  );
  const displayAgents = activeRoster.length ? activeRoster : agents;
  const evaluated = displayAgents.filter((a) => a.verdict != null);
  const certified = displayAgents.filter((a) => a.certification === "certified");
  const quarantined = displayAgents.filter((a) => a.verdict === "quarantine" || a.verdict === "retire_proposed");

  return (
    <div style={pageStyle}>
      <div style={headerStyle}>
        <h1 style={{ margin: 0, fontSize: 20 }}>CK Evaluation</h1>
        <span style={{ opacity: 0.7, fontSize: 13 }}>
          {data?.company ?? "CK IT Solutions"} — agent evaluation overview
          {data?.generatedAt ? ` · as of ${new Date(data.generatedAt).toLocaleString()}` : ""}
        </span>
        {quarantined.length > 0 && (
          <span style={{ fontSize: 13, lineHeight: 1.45, maxWidth: 720 }}>
            <strong>Quarantined units ({quarantined.length}):</strong> do not assign new work. Your options:{" "}
            (1) <em>Keep quarantined</em> — leave off the roster; (2) <em>Tune</em> — fix charter/tools and re-run eval;
            (3) <em>Retire</em> — Alan signs off in Founder Brief. Red verdict alone is not auto-retire.
          </span>
        )}
      </div>

      <div style={cardsRowStyle}>
        <MetricCard label="Active roster" value={displayAgents.length} />
        <MetricCard label="Certified" value={certified.length} />
        <MetricCard label="Evaluated" value={evaluated.length} />
        <MetricCard label="Quarantined" value={quarantined.length} />
      </div>

      <DataTable
        columns={columns as unknown as DataTableColumn[]}
        rows={displayAgents as unknown as Record<string, unknown>[]}
        loading={loading}
        emptyMessage="No active agents on the roster."
      />
    </div>
  );
}
