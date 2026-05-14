const LABEL_NAME = "agent_id";

const METRIC_DEFINITIONS = [
  {
    name: "paperclip_placeholder_cap_hits_total",
    help: "Times the placeholder-comment cap blocked an agent comment post.",
  },
  {
    name: "paperclip_placeholder_cap_overrides_total",
    help: "Times a board override bypassed the placeholder-comment cap.",
  },
] as const;

type MetricName = typeof METRIC_DEFINITIONS[number]["name"];

const counters = new Map<MetricName, Map<string, number>>(
  METRIC_DEFINITIONS.map((metric) => [metric.name, new Map<string, number>()]),
);

export function recordPlaceholderCapHit(agentId: string): void {
  incrementCounter("paperclip_placeholder_cap_hits_total", agentId);
}

export function recordPlaceholderCapOverride(agentId: string): void {
  incrementCounter("paperclip_placeholder_cap_overrides_total", agentId);
}

export function renderMetrics(): string {
  const lines: string[] = [];

  for (const metric of METRIC_DEFINITIONS) {
    lines.push(`# HELP ${metric.name} ${metric.help}`);
    lines.push(`# TYPE ${metric.name} counter`);

    const samples = counters.get(metric.name);
    if (!samples) continue;

    for (const [agentId, count] of [...samples.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`${metric.name}{${LABEL_NAME}="${escapeLabelValue(agentId)}"} ${count}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function incrementCounter(metricName: MetricName, agentId: string): void {
  const samples = counters.get(metricName);
  if (!samples) {
    throw new Error(`Unknown counter: ${metricName}`);
  }

  samples.set(agentId, (samples.get(agentId) ?? 0) + 1);
}

function escapeLabelValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, "\\\"");
}
