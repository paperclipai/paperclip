import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import type { PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";

interface HealthData {
  status: string;
  entityCount: number;
  insightCount: number;
  questionCount: number;
  documentCount: number;
  pendingSynth: number;
}

export function KnowledgeTreeHealthWidget({ context }: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<HealthData>("health", {
    companyId: context.companyId,
  });

  if (loading) return <div style={{ padding: 12 }}>Loading knowledge graph…</div>;
  if (error) return <div style={{ padding: 12, color: "red" }}>Error: {error.message}</div>;
  if (!data) return <div style={{ padding: 12 }}>No data available.</div>;

  return (
    <div style={{ padding: 12, fontFamily: "sans-serif" }}>
      <h3 style={{ margin: "0 0 8px" }}>Knowledge Graph Health</h3>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
        <div style={{ background: "#f4f4f5", padding: 8, borderRadius: 6 }}>
          <div style={{ fontSize: 12, color: "#71717a" }}>Entities</div>
          <div style={{ fontSize: 20, fontWeight: 600 }}>{data.entityCount}</div>
        </div>
        <div style={{ background: "#f4f4f5", padding: 8, borderRadius: 6 }}>
          <div style={{ fontSize: 12, color: "#71717a" }}>Insights</div>
          <div style={{ fontSize: 20, fontWeight: 600 }}>{data.insightCount}</div>
        </div>
        <div style={{ background: "#f4f4f5", padding: 8, borderRadius: 6 }}>
          <div style={{ fontSize: 12, color: "#71717a" }}>Questions</div>
          <div style={{ fontSize: 20, fontWeight: 600 }}>{data.questionCount}</div>
        </div>
        <div style={{ background: "#f4f4f5", padding: 8, borderRadius: 6 }}>
          <div style={{ fontSize: 12, color: "#71717a" }}>Documents</div>
          <div style={{ fontSize: 20, fontWeight: 600 }}>{data.documentCount}</div>
        </div>
        <div style={{ background: "#f4f4f5", padding: 8, borderRadius: 6 }}>
          <div style={{ fontSize: 12, color: "#71717a" }}>Pending</div>
          <div style={{ fontSize: 20, fontWeight: 600 }}>{data.pendingSynth}</div>
        </div>
        <div style={{ background: "#f4f4f5", padding: 8, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ fontSize: 12, color: data.status === "ok" ? "#16a34a" : "#dc2626", fontWeight: 600 }}>
            {data.status === "ok" ? "● OK" : "● Error"}
          </div>
        </div>
      </div>
    </div>
  );
}
