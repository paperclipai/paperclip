import { usePluginData, type PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";

type HealthData = {
  status: "ok" | "degraded" | "error";
  checkedAt: string;
  repositoriesConfigured: number;
  lastDelivery?: unknown;
  lastPrSync?: unknown;
};

export function DashboardWidget(_props: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<HealthData>("health");

  if (loading) return <div>Loading GitHub PR ingress...</div>;
  if (error) return <div>Plugin error: {error.message}</div>;

  return (
    <div style={{ display: "grid", gap: "0.5rem" }}>
      <strong>GitHub PR Ingress</strong>
      <div>Health: {data?.status ?? "unknown"}</div>
      <div>Repos: {data?.repositoriesConfigured ?? 0}</div>
      <div>Checked: {data?.checkedAt ?? "never"}</div>
      <div style={{ fontSize: "12px", opacity: 0.75 }}>
        Last delivery: {data?.lastDelivery ? "seen" : "none"}
      </div>
    </div>
  );
}
