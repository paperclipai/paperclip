export type RunReconcilerMetricSample = {
  runId: string;
  adapterType: string;
  agentNameKey: string | null;
  active: 0 | 1;
  lastOutputAgeSeconds: number;
  childPidAlive: 0 | 1;
};

let latestSamples: RunReconcilerMetricSample[] = [];

export function setRunReconcilerMetricSamples(samples: RunReconcilerMetricSample[]) {
  latestSamples = samples;
}

export function renderRunReconcilerPrometheusMetrics(now = new Date()) {
  const lines = [
    "# HELP paperclip_run_active Whether a heartbeat run is currently active (1) or not (0).",
    "# TYPE paperclip_run_active gauge",
    "# HELP paperclip_run_last_output_age_seconds Seconds since the run last produced observable output.",
    "# TYPE paperclip_run_last_output_age_seconds gauge",
    "# HELP paperclip_run_child_pid_alive Whether the tracked child PID for a run is alive (1) or not (0).",
    "# TYPE paperclip_run_child_pid_alive gauge",
  ];

  for (const sample of latestSamples) {
    const adapter = escapePrometheusLabelValue(sample.adapterType);
    const agent = escapePrometheusLabelValue(sample.agentNameKey ?? "unknown");
    const runId = escapePrometheusLabelValue(sample.runId);
    lines.push(
      `paperclip_run_active{adapter="${adapter}",agent="${agent}",runId="${runId}"} ${sample.active}`,
      `paperclip_run_last_output_age_seconds{adapter="${adapter}",runId="${runId}"} ${sample.lastOutputAgeSeconds}`,
      `paperclip_run_child_pid_alive{runId="${runId}"} ${sample.childPidAlive}`,
    );
  }

  if (latestSamples.length === 0) {
    lines.push("paperclip_run_active{adapter=\"none\",agent=\"none\",runId=\"none\"} 0");
  }

  lines.push(
    "# HELP paperclip_run_reconciler_metrics_generated_timestamp_seconds Unix timestamp when these metrics were last generated.",
    "# TYPE paperclip_run_reconciler_metrics_generated_timestamp_seconds gauge",
    `paperclip_run_reconciler_metrics_generated_timestamp_seconds ${Math.floor(now.getTime() / 1000)}`,
  );
  return `${lines.join("\n")}\n`;
}

function escapePrometheusLabelValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}
