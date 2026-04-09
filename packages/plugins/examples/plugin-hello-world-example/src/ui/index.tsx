import type { PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";

const WIDGET_LABEL = "Company pulse widget";

type CompanyPulseData = {
  companyId: string | null;
  counts: {
    projects: number;
    issues: number;
    openIssues: number;
    goals: number;
    activeGoals: number;
    agents: number;
    activeAgents: number;
  };
  summary: string;
};

function MetricCard({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        display: "grid",
        gap: "2px",
        padding: "10px 12px",
        borderRadius: "12px",
        border: "1px solid var(--border)",
        background: "color-mix(in oklab, var(--card) 92%, var(--background))",
      }}
    >
      <span style={{ fontSize: "11px", color: "var(--muted-foreground)" }}>{label}</span>
      <strong style={{ fontSize: "20px", lineHeight: 1.1 }}>{value}</strong>
    </div>
  );
}

/**
 * Dashboard widget that turns the old hello-world scaffold into a compact
 * operational summary for the selected company.
 */
export function HelloWorldDashboardWidget({ context }: PluginWidgetProps) {
  const pulse = usePluginData<CompanyPulseData>("company-pulse", {
    companyId: context.companyId,
  });

  const counts = pulse.data?.counts ?? {
    projects: 0,
    issues: 0,
    openIssues: 0,
    goals: 0,
    activeGoals: 0,
    agents: 0,
    activeAgents: 0,
  };

  return (
    <section
      aria-label={WIDGET_LABEL}
      style={{
        display: "grid",
        gap: "12px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "flex-start" }}>
        <div style={{ display: "grid", gap: "4px" }}>
          <strong style={{ fontSize: "16px" }}>Company Pulse</strong>
          <div style={{ fontSize: "12px", color: "var(--muted-foreground)" }}>
            {pulse.loading ? "Loading company activity..." : pulse.data?.summary ?? "No data available."}
          </div>
        </div>
        <span
          style={{
            padding: "4px 8px",
            borderRadius: "999px",
            fontSize: "11px",
            border: "1px solid var(--border)",
            color: "var(--muted-foreground)",
          }}
        >
          {context.companyId ? "Company scoped" : "No company selected"}
        </span>
      </div>

      <div
        style={{
          display: "grid",
          gap: "10px",
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
        }}
      >
        <MetricCard label="Projects" value={counts.projects} />
        <MetricCard label="Open issues" value={counts.openIssues} />
        <MetricCard label="Active agents" value={counts.activeAgents} />
        <MetricCard label="All issues" value={counts.issues} />
        <MetricCard label="Goals" value={counts.goals} />
        <MetricCard label="Active goals" value={counts.activeGoals} />
      </div>
    </section>
  );
}
