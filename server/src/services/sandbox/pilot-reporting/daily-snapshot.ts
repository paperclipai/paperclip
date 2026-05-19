import type {
  BillingCounterSnapshot,
  CapState,
  DailySnapshotInput,
  IsolationIncidentReport,
  KillSwitchState,
  LeaseLatencyAggregate,
  SecretLeakReport,
  VendorStatusPageSnapshot,
} from "./types.js";

const SUMMARY_TRUNCATE = 240;

/**
 * Pure renderer for the Phase 4A-S4 daily Command Center snapshot.
 *
 * Inputs are typed against the projected B2 counter / B3 panel / status-page
 * shapes. Output is a Markdown string suitable for posting as a comment on
 * LET-365 (LET-371 owns the posting). This function does no I/O.
 */
export function renderDailySnapshot(input: DailySnapshotInput): string {
  const lines: string[] = [];
  lines.push(`# ${input.pilotId} — daily snapshot (${input.utcDay} UTC)`);
  lines.push("");
  lines.push(`> Truth label: \`${input.truthLabel}\` — ${truthLabelExplain(input.truthLabel)}`);
  lines.push("");

  lines.push("## Spend vs cap");
  lines.push("");
  lines.push("| Metric | Value | Cap | State |");
  lines.push("|---|---|---|---|");
  lines.push(spendRow("Day-to-date spend", input.billing.dayToDateCents, input.billing.dailyHardCapCents, input.billing.dayState));
  lines.push(spendRow("Month-to-date spend", input.billing.monthToDateCents, input.billing.monthlyHardCapCents, input.billing.monthState));
  lines.push("");

  lines.push("## Lease health");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---|");
  lines.push(`| Lease success rate (running tally) | ${formatRate(successRate(input.leaseTally))} |`);
  lines.push(`| Lease attempts (success / failure) | ${input.leaseTally.successCount} / ${input.leaseTally.failureCount} |`);
  lines.push(`| p95 cold start | ${formatMs(input.leaseTally.coldStartP95Ms)} |`);
  lines.push(`| p95 lease-ready latency | ${formatMs(input.leaseTally.leaseReadyP95Ms)} |`);
  lines.push("");

  lines.push("## Safety counters");
  lines.push("");
  lines.push("| Metric | Count |");
  lines.push("|---|---|");
  lines.push(`| Isolation incidents | ${input.isolationIncidents.length} |`);
  lines.push(`| Raw-secret leaks | ${input.secretLeaks.length} |`);
  if (input.isolationIncidents.length > 0) {
    lines.push("");
    lines.push("### Isolation incident detail");
    for (const incident of input.isolationIncidents) {
      lines.push(`- ${formatIncident(incident)}`);
    }
  }
  if (input.secretLeaks.length > 0) {
    lines.push("");
    lines.push("### Raw-secret leak detail");
    for (const leak of input.secretLeaks) {
      lines.push(`- ${formatLeak(leak)}`);
    }
  }
  lines.push("");

  lines.push("## Vendor health (E2B status page)");
  lines.push("");
  lines.push(formatVendor(input.vendor));
  lines.push("");

  lines.push("## Kill-switch state per layer");
  lines.push("");
  lines.push("| Layer | State | Changed at | Reason |");
  lines.push("|---|---|---|---|");
  for (const layer of input.providerStatus.killSwitches) {
    lines.push(killSwitchRow(layer));
  }
  if (input.providerStatus.killSwitches.length === 0) {
    lines.push("| _no layers reported_ |  |  |  |");
  }
  lines.push("");

  const banners = buildBanners(input);
  if (banners.length > 0) {
    lines.push("## Action banners");
    lines.push("");
    for (const banner of banners) {
      lines.push(`- ${banner}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function truthLabelExplain(label: "preview" | "live"): string {
  return label === "live"
    ? "live pilot data — G2 has fired and the live provider is enabled."
    : "preview / stub data — G2 has NOT fired yet; counters and vendor poll are mocked.";
}

function spendRow(
  label: string,
  cents: number,
  capCents: number,
  state: CapState,
): string {
  return `| ${label} | ${formatUsd(cents)} | ${formatUsd(capCents)} | ${formatCapState(state)} |`;
}

function killSwitchRow(layer: KillSwitchState): string {
  const reason = layer.reason ?? "";
  const changedAt = layer.changedAt ?? "";
  return `| ${layer.layer} | ${formatLayerState(layer.state)} | ${changedAt} | ${escapeCell(reason)} |`;
}

function buildBanners(input: DailySnapshotInput): string[] {
  const banners: string[] = [];

  if (input.billing.dayState === "hard_cap_disabled" || input.billing.monthState === "hard_cap_disabled") {
    banners.push("🛑 **HARD CAP REACHED — provider auto-disabled by B2.** Operator must investigate before re-enable.");
  } else if (input.billing.dayState === "soft_cap" || input.billing.monthState === "soft_cap") {
    banners.push("⚠️ Soft cap reached — operator warning, traffic continues.");
  }

  if (input.isolationIncidents.length > 0) {
    banners.push(`🛑 **${input.isolationIncidents.length} isolation incident(s) flagged this window.** Exit criterion requires 0 — escalate immediately.`);
  }
  if (input.secretLeaks.length > 0) {
    banners.push(`🛑 **${input.secretLeaks.length} raw-secret leak(s) flagged this window.** Exit criterion requires 0 — escalate immediately.`);
  }

  for (const layer of input.providerStatus.killSwitches) {
    if (layer.state === "tripped") {
      banners.push(`🛑 Kill switch \`${layer.layer}\` is **tripped** — traffic halted on this layer.`);
    } else if (layer.state === "manual_disable") {
      banners.push(`⏸️ Kill switch \`${layer.layer}\` is **manually disabled** — operator intent.`);
    }
  }

  if (input.vendor.uptimeRatio !== null && input.vendor.uptimeRatio < 0.995) {
    banners.push(`⚠️ Vendor uptime ${formatRate(input.vendor.uptimeRatio)} is below the 99.5% exit threshold — flag in incident log if the dip persists.`);
  }
  if (input.vendor.activeIncidentIds.length > 0) {
    banners.push(`ℹ️ Vendor reports ${input.vendor.activeIncidentIds.length} active incident(s): ${input.vendor.activeIncidentIds.join(", ")}.`);
  }
  return banners;
}

function formatVendor(vendor: VendorStatusPageSnapshot): string {
  const uptime = vendor.uptimeRatio === null ? "_unknown_" : formatRate(vendor.uptimeRatio);
  const status = vendor.statusText ? ` — ${escapeCell(vendor.statusText)}` : "";
  const incidents = vendor.activeIncidentIds.length === 0
    ? "no active incidents"
    : `active incidents: ${vendor.activeIncidentIds.join(", ")}`;
  return `- Vendor: \`${vendor.vendor}\`\n- Uptime (window): ${uptime}\n- Captured at: ${vendor.capturedAt}\n- ${incidents}${status}`;
}

function formatIncident(incident: IsolationIncidentReport): string {
  const link = incident.link ? ` ([link](${incident.link}))` : "";
  return `\`${incident.id}\` — ${escapeCell(truncate(incident.summary, SUMMARY_TRUNCATE))} (detected ${incident.detectedAt})${link}`;
}

function formatLeak(leak: SecretLeakReport): string {
  const link = leak.link ? ` ([link](${leak.link}))` : "";
  return `\`${leak.id}\` — ${escapeCell(truncate(leak.summary, SUMMARY_TRUNCATE))} (detected ${leak.detectedAt})${link}`;
}

function formatCapState(state: CapState): string {
  switch (state) {
    case "within":
      return "✅ within";
    case "soft_cap":
      return "⚠️ soft cap";
    case "hard_cap_disabled":
      return "🛑 hard cap (auto-disabled)";
  }
}

function formatLayerState(state: KillSwitchState["state"]): string {
  switch (state) {
    case "armed":
      return "✅ armed";
    case "tripped":
      return "🛑 tripped";
    case "manual_disable":
      return "⏸️ manual disable";
  }
}

export function successRate(tally: LeaseLatencyAggregate): number | null {
  const total = tally.successCount + tally.failureCount;
  if (total === 0) return null;
  return tally.successCount / total;
}

function formatRate(rate: number | null): string {
  if (rate === null) return "_no samples_";
  return `${(rate * 100).toFixed(2)}%`;
}

function formatMs(value: number | null): string {
  if (value === null) return "_no samples_";
  return `${value} ms`;
}

function formatUsd(cents: number): string {
  const dollars = cents / 100;
  return `$${dollars.toFixed(2)}`;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

// Re-export a couple of helpers callers need when projecting billing state.
export function resolveCapState(currentCents: number, hardCapCents: number, softCapCents: number | null | undefined): CapState {
  if (currentCents >= hardCapCents) return "hard_cap_disabled";
  if (softCapCents != null && currentCents >= softCapCents) return "soft_cap";
  return "within";
}

export function projectBillingSnapshot(args: {
  utcDay: string;
  dayToDateCents: number;
  monthToDateCents: number;
  dailyHardCapCents: number;
  monthlyHardCapCents: number;
  dailySoftCapCents?: number | null;
  monthlySoftCapCents?: number | null;
}): BillingCounterSnapshot {
  return {
    utcDay: args.utcDay,
    dayToDateCents: args.dayToDateCents,
    monthToDateCents: args.monthToDateCents,
    dailyHardCapCents: args.dailyHardCapCents,
    monthlyHardCapCents: args.monthlyHardCapCents,
    dailySoftCapCents: args.dailySoftCapCents ?? null,
    monthlySoftCapCents: args.monthlySoftCapCents ?? null,
    dayState: resolveCapState(args.dayToDateCents, args.dailyHardCapCents, args.dailySoftCapCents),
    monthState: resolveCapState(args.monthToDateCents, args.monthlyHardCapCents, args.monthlySoftCapCents),
  };
}
