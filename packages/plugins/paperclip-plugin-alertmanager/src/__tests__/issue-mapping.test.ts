import { describe, expect, it } from "vitest";
import {
  alertMatchesLabelFilter,
  buildIssueDescription,
  buildIssueTitle,
  effectiveAlertStatus,
  extractObservabilityUrls,
  renderDrillInLinks,
  severityToPriority,
} from "../issue-mapping.js";
import type { AlertmanagerAlert } from "../types.js";

const baseAlert = (overrides: Partial<AlertmanagerAlert> = {}): AlertmanagerAlert => ({
  status: "firing",
  labels: {
    alertname: "CiliumPolicyDropsHigh",
    severity: "critical",
    team: "platform",
    node: "pve-3",
  },
  annotations: {
    summary: "261 GB of EGRESS traffic dropped on pve-3 in 21h",
    description: "Sustained policy-denied drops",
    runbook_url: "https://wiki/runbooks/cilium-drops",
  },
  startsAt: "2026-04-29T08:00:00Z",
  endsAt: "0001-01-01T00:00:00Z",
  generatorURL: "http://prometheus-0:9090/graph?g0.expr=foo",
  fingerprint: "9a3b1e4c5f6d7890",
  ...overrides,
});

describe("severityToPriority", () => {
  it("uses default mappings when no override is supplied", () => {
    expect(severityToPriority("critical")).toBe("critical");
    expect(severityToPriority("warning")).toBe("high");
    expect(severityToPriority("info")).toBe("medium");
  });

  it("falls back to medium for unknown severities", () => {
    expect(severityToPriority("page")).toBe("medium");
    expect(severityToPriority(undefined)).toBe("medium");
    expect(severityToPriority("")).toBe("medium");
  });

  it("matches case-insensitively", () => {
    expect(severityToPriority("CRITICAL")).toBe("critical");
    expect(severityToPriority(" Warning ")).toBe("high");
  });

  it("operator override wins over the default map", () => {
    expect(
      severityToPriority("critical", { critical: "high", warning: "low" }),
    ).toBe("high");
    // Unmapped keys fall through to the default map, not the fallback.
    expect(
      severityToPriority("warning", { critical: "high" }),
    ).toBe("high");
  });
});

describe("buildIssueTitle", () => {
  it("formats per spec §7.1", () => {
    expect(buildIssueTitle(baseAlert())).toBe(
      "[critical] CiliumPolicyDropsHigh · platform",
    );
  });

  it("falls back to node when team is missing", () => {
    const alert = baseAlert({
      labels: {
        alertname: "PodOOMKilled",
        severity: "warning",
        node: "pve-3",
      },
    });
    expect(buildIssueTitle(alert)).toBe("[warning] PodOOMKilled · pve-3");
  });

  it("omits the trailing context when neither team nor node is set", () => {
    const alert = baseAlert({
      labels: { alertname: "Watchdog", severity: "info" },
    });
    expect(buildIssueTitle(alert)).toBe("[info] Watchdog");
  });

  it("falls back to envelope.commonLabels when alert labels are bare", () => {
    const alert = baseAlert({
      labels: { alertname: "GenericAlert", severity: "warning" },
    });
    expect(
      buildIssueTitle(alert, { commonLabels: { team: "networking" } }),
    ).toBe("[warning] GenericAlert · networking");
  });
});

describe("extractObservabilityUrls", () => {
  it("pulls reserved annotation keys plus generatorURL", () => {
    const alert = baseAlert({
      annotations: {
        dashboard_url: "https://grafana/d/xyz",
        trace_url: "https://grafana/explore",
        runbook_url: "https://runbooks/x",
        // Not in the allowlist — must NOT show up in result.
        random_url: "https://attacker/",
      },
    });
    const urls = extractObservabilityUrls(alert);
    expect(urls).toEqual({
      dashboard_url: "https://grafana/d/xyz",
      trace_url: "https://grafana/explore",
      runbook_url: "https://runbooks/x",
      generator_url: "http://prometheus-0:9090/graph?g0.expr=foo",
    });
  });

  it("returns an empty object when nothing is set", () => {
    const alert = baseAlert({
      annotations: {},
      generatorURL: undefined,
    });
    expect(extractObservabilityUrls(alert)).toEqual({});
  });
});

describe("renderDrillInLinks", () => {
  it("renders a markdown list under a `### Drill in` header", () => {
    const rendered = renderDrillInLinks({
      dashboard_url: "https://grafana/d/xyz",
      profile_url: "https://pyroscope/x",
      generator_url: "https://prom/graph",
    });
    expect(rendered).toBe(
      [
        "### Drill in",
        "- [Dashboard](https://grafana/d/xyz)",
        "- [Pyroscope flamegraph](https://pyroscope/x)",
        "- [Source query in Prometheus](https://prom/graph)",
      ].join("\n"),
    );
  });

  it("returns empty string when there's nothing to render", () => {
    expect(renderDrillInLinks({})).toBe("");
  });

  it("preserves the canonical key order regardless of input ordering", () => {
    const rendered = renderDrillInLinks({
      generator_url: "g",
      dashboard_url: "d",
      runbook_url: "r",
    });
    const expectedOrder = ["Dashboard", "Runbook", "Source query in Prometheus"];
    for (let i = 0; i < expectedOrder.length - 1; i++) {
      const cur = rendered.indexOf(expectedOrder[i]!);
      const next = rendered.indexOf(expectedOrder[i + 1]!);
      expect(cur).toBeGreaterThanOrEqual(0);
      expect(next).toBeGreaterThan(cur);
    }
  });
});

describe("buildIssueDescription", () => {
  it("includes summary, description, metadata block, labels table, and drill-in links", () => {
    const alert = baseAlert({
      annotations: {
        summary: "Lots of drops",
        description: "Egress drops sustained",
        runbook_url: "https://runbooks/x",
        dashboard_url: "https://grafana/d/y",
      },
    });
    const body = buildIssueDescription(alert);
    expect(body).toContain("**Summary**: Lots of drops");
    expect(body).toContain("Egress drops sustained");
    expect(body).toContain("**Started**: 2026-04-29T08:00:00Z");
    expect(body).toContain("**Severity**: critical");
    expect(body).toContain("**Source**: http://prometheus-0:9090/graph?g0.expr=foo");
    expect(body).toContain("**Runbook**: https://runbooks/x");
    expect(body).toContain("### Labels");
    expect(body).toContain("| alertname | CiliumPolicyDropsHigh |");
    expect(body).toContain("### Drill in");
    expect(body).toContain("[Dashboard](https://grafana/d/y)");
    expect(body).toContain("[Runbook](https://runbooks/x)");
  });

  it("renders cleanly when annotations are empty", () => {
    const alert = baseAlert({ annotations: {} });
    const body = buildIssueDescription(alert);
    expect(body).toContain("**Summary**: CiliumPolicyDropsHigh");
    expect(body).toContain("**Runbook**: —");
    // No drill-in section header when there's nothing to render apart from
    // generator_url — but generator_url IS present here, so the section
    // should appear with just that one entry.
    expect(body).toContain("### Drill in");
    expect(body).toContain("[Source query in Prometheus]");
  });
});

describe("alertMatchesLabelFilter", () => {
  it("accepts when filter is empty / unset", () => {
    expect(alertMatchesLabelFilter(baseAlert(), undefined)).toBe(true);
    expect(alertMatchesLabelFilter(baseAlert(), {})).toBe(true);
  });

  it("requires every filter pair to match exactly", () => {
    const alert = baseAlert({
      labels: { alertname: "X", severity: "info", paperclip: "true" },
    });
    expect(alertMatchesLabelFilter(alert, { paperclip: "true" })).toBe(true);
    expect(alertMatchesLabelFilter(alert, { paperclip: "false" })).toBe(false);
    expect(
      alertMatchesLabelFilter(alert, { paperclip: "true", severity: "info" }),
    ).toBe(true);
    expect(
      alertMatchesLabelFilter(alert, { paperclip: "true", severity: "warning" }),
    ).toBe(false);
  });
});

describe("effectiveAlertStatus", () => {
  it("prefers the per-alert status", () => {
    expect(
      effectiveAlertStatus(baseAlert({ status: "resolved" }), { status: "firing" }),
    ).toBe("resolved");
  });
});
