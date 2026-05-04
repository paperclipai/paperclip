import { collectDefaultMetrics, Counter, Registry } from "prom-client";

export const register = new Registry();

collectDefaultMetrics({ register });

export const placeholderCapHits = new Counter<"agent_id" | "issue_id">({
  name: "paperclip_placeholder_cap_hits_total",
  help: "Times the placeholder-comment cap blocked an agent comment post.",
  labelNames: ["agent_id", "issue_id"] as const,
  registers: [register],
});

export const placeholderCapOverrides = new Counter<"agent_id">({
  name: "paperclip_placeholder_cap_overrides_total",
  help: "Times a board override bypassed the placeholder-comment cap.",
  labelNames: ["agent_id"] as const,
  registers: [register],
});
