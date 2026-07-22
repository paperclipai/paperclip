import {
  usePluginData,
  StatusBadge,
  Spinner,
  type PluginPageProps,
  type StatusBadgeVariant,
} from "@paperclipai/plugin-sdk/ui";

// ── data shapes (mirror the worker's `ck-org` endpoint) ─────────────────────────
interface OrgUnit {
  id: string;
  name: string;
  dept: string;
  type: string;
  certification: string;
  verdict: string | null;
  costAdjustedScore: number | null;
  verifiers: number;
}
interface OrgDept {
  code: string;
  key: string;
  label: string;
  specCount: number;
  builtCount: number;
  units: OrgUnit[];
}
interface OrgApex {
  name: string;
  title: string;
  note: string;
}
interface OrgData {
  company: string;
  found: boolean;
  generatedAt: string;
  principle: string;
  apex: OrgApex | null;
  coordination: OrgUnit[];
  verifierMesh: OrgUnit[];
  departments: OrgDept[];
  stats: { builtUnits: number; certified: number; draft: number; specdTotal: number } | null;
}

const DATA_KEY = "ck-org";

function certVariant(cert: string): StatusBadgeVariant {
  switch (cert) {
    case "certified":
      return "ok";
    case "draft":
      return "pending";
    case "quarantined":
    case "retired":
      return "error";
    default:
      return "warning";
  }
}

// ── styles ──────────────────────────────────────────────────────────────────────
const pageStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 18,
  padding: 20,
  maxWidth: 1180,
  margin: "0 auto",
};
const sectionLabel: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.8,
  textTransform: "uppercase",
  opacity: 0.55,
  textAlign: "center",
};
const rowCenter: React.CSSProperties = {
  display: "flex",
  gap: 12,
  flexWrap: "wrap",
  justifyContent: "center",
};
const connector: React.CSSProperties = {
  width: 2,
  height: 22,
  background: "linear-gradient(#cbd5e1, transparent)",
  margin: "0 auto",
};

function typeTag(type: string): string {
  if (type === "deterministic") return "D";
  if (type === "judgment") return "J";
  if (type === "hybrid") return "H";
  return "—";
}

// A single unit chip: name + cert badge + D/J tag + verifier dots.
function UnitChip({ u, accent }: { u: OrgUnit; accent: string }) {
  return (
    <div
      style={{
        border: `1px solid ${u.certification === "certified" ? accent : "#e2e8f0"}`,
        background: u.certification === "certified" ? `${accent}0d` : "#fff",
        borderRadius: 8,
        padding: "7px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 5,
        minWidth: 168,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span
          title={u.type}
          style={{
            fontSize: 10,
            fontWeight: 700,
            width: 16,
            height: 16,
            borderRadius: 4,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            background: u.type === "judgment" ? "#fef3c7" : "#e0f2fe",
            color: u.type === "judgment" ? "#92400e" : "#075985",
            flexShrink: 0,
          }}
        >
          {typeTag(u.type)}
        </span>
        <span style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.2 }}>{u.name}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <StatusBadge label={u.certification} status={certVariant(u.certification)} />
        {u.verdict ? (
          <span style={{ fontSize: 10.5, opacity: 0.6 }}>verdict: {u.verdict}</span>
        ) : null}
        {u.verifiers > 0 ? (
          <span
            title={`${u.verifiers} dedicated verifier (ADR-019)`}
            style={{ fontSize: 10.5, color: "#7c3aed", display: "inline-flex", alignItems: "center", gap: 3 }}
          >
            {"●".repeat(u.verifiers)} verifier
          </span>
        ) : (
          <span title="deterministic — kernel checks it, no dedicated verifier (ADR-019)" style={{ fontSize: 10.5, opacity: 0.4 }}>
            kernel-checked
          </span>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div
      style={{
        border: "1px solid #e2e8f0",
        borderRadius: 10,
        padding: "10px 14px",
        minWidth: 120,
        background: "#fff",
      }}
    >
      <div style={{ fontSize: 22, fontWeight: 700 }}>{value}</div>
      <div style={{ fontSize: 11.5, opacity: 0.6 }}>{label}</div>
      {sub ? <div style={{ fontSize: 10.5, opacity: 0.45, marginTop: 2 }}>{sub}</div> : null}
    </div>
  );
}

export function CkOrgPage(_props: PluginPageProps) {
  const { data, loading, error } = usePluginData<OrgData>(DATA_KEY);

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
  if (!data || !data.found || !data.apex) {
    return (
      <div style={pageStyle}>
        <StatusBadge label={`No org found for ${data?.company ?? "CK IT Solutions"}.`} status="warning" />
      </div>
    );
  }

  const { apex, coordination, verifierMesh, departments, stats } = data;
  const govAccent = "#6366f1";
  const lineAccent = "#0ea5e9";

  return (
    <div style={pageStyle}>
      {/* header */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <h1 style={{ margin: 0, fontSize: 21 }}>CK Org — the wide-flat verifier mesh</h1>
        <p style={{ margin: 0, fontSize: 12.5, opacity: 0.7, lineHeight: 1.5 }}>{data.principle}</p>
      </div>

      {stats ? (
        <div style={{ ...rowCenter, justifyContent: "flex-start" }}>
          <StatCard label="Units built" value={stats.builtUnits} sub={`of ${stats.specdTotal} spec'd`} />
          <StatCard label="Certified" value={stats.certified} sub="proven vs ground truth" />
          <StatCard label="Draft seats" value={stats.draft} sub="registered, golden set pending" />
          <StatCard
            label="Departments live"
            value={`${departments.filter((d) => d.builtCount > 0).length + 1}/${departments.length + 1}`}
            sub="GOV + line depts"
          />
        </div>
      ) : null}

      {/* apex — Alan */}
      <div style={sectionLabel}>Apex</div>
      <div style={rowCenter}>
        <div
          style={{
            border: "2px solid #0f172a",
            borderRadius: 12,
            padding: "12px 22px",
            textAlign: "center",
            background: "#0f172a",
            color: "#fff",
            maxWidth: 460,
          }}
        >
          <div style={{ fontSize: 17, fontWeight: 700 }}>{apex.name}</div>
          <div style={{ fontSize: 12, opacity: 0.85, marginTop: 2 }}>{apex.title}</div>
          <div style={{ fontSize: 11, opacity: 0.7, marginTop: 6, lineHeight: 1.4 }}>{apex.note}</div>
        </div>
      </div>
      <div style={connector} />

      {/* coordination layer */}
      <div style={sectionLabel}>Coordination layer · thin · absorbs &amp; protects Alan's attention</div>
      <div style={rowCenter}>
        {coordination.length ? (
          coordination.map((u) => <UnitChip key={u.id} u={u} accent={govAccent} />)
        ) : (
          <span style={{ fontSize: 12, opacity: 0.5 }}>none built yet</span>
        )}
      </div>
      <div style={connector} />

      {/* verifier mesh */}
      <div style={sectionLabel}>
        Verifier mesh · the governance spine that grades every unit · watches the watchers
      </div>
      <div style={rowCenter}>
        {verifierMesh.length ? (
          verifierMesh.map((u) => <UnitChip key={u.id} u={u} accent={govAccent} />)
        ) : (
          <span style={{ fontSize: 12, opacity: 0.5 }}>none built yet</span>
        )}
      </div>
      <div style={connector} />

      {/* line departments */}
      <div style={sectionLabel}>Line departments · each unit graded by the mesh against ground truth</div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(290px, 1fr))",
          gap: 14,
        }}
      >
        {departments.map((d) => {
          const built = d.builtCount > 0;
          return (
            <div
              key={d.key}
              style={{
                border: `1px solid ${built ? lineAccent : "#e2e8f0"}`,
                borderRadius: 12,
                padding: 14,
                background: built ? "#fff" : "#f8fafc",
                opacity: built ? 1 : 0.78,
                display: "flex",
                flexDirection: "column",
                gap: 10,
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 800, color: built ? lineAccent : "#94a3b8" }}>
                    {d.code}
                  </span>
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>{d.label}</span>
                </div>
                <StatusBadge
                  label={built ? `${d.builtCount}/${d.specCount} built` : `0/${d.specCount} · planned`}
                  status={built ? "ok" : "pending"}
                />
              </div>
              {built ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {d.units.map((u) => (
                    <UnitChip key={u.id} u={u} accent={lineAccent} />
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 11.5, opacity: 0.6, lineHeight: 1.5 }}>
                  Spec'd in the catalog ({d.specCount} units) — not yet built. Each unit needs an Agent Spec +
                  golden set before it is hired (no hire without a scorecard).
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* legend */}
      <div
        style={{
          borderTop: "1px solid #e2e8f0",
          paddingTop: 12,
          fontSize: 11,
          opacity: 0.6,
          display: "flex",
          gap: 18,
          flexWrap: "wrap",
        }}
      >
        <span><b>D</b> deterministic (script/cron) · <b>J</b> judgment (LLM) · <b>H</b> hybrid</span>
        <span><span style={{ color: "#7c3aed" }}>●</span> dedicated verifier (ADR-019: J→1, outward→3, D→kernel)</span>
        <span>Certified = proven vs ground truth · Draft = registered, golden set pending</span>
        <span style={{ marginLeft: "auto" }}>as of {new Date(data.generatedAt).toLocaleString()}</span>
      </div>
    </div>
  );
}
