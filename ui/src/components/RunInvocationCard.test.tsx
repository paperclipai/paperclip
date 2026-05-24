// @vitest-environment node

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "../context/ThemeContext";
import { RunInvocationCard } from "../pages/AgentDetail";

describe("RunInvocationCard", () => {
  it("keeps verbose invocation details collapsed by default", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunInvocationCard
          payload={{
            adapterType: "claude_local",
            cwd: "/tmp/workspace",
            command: "claude",
            commandArgs: ["--dangerously-skip-permissions"],
            commandNotes: ["Prompt is piped to claude via stdin."],
            prompt: "very long prompt body",
            context: { triggeredBy: "board" },
            env: { ANTHROPIC_API_KEY: "***REDACTED***" },
          }}
          censorUsernameInLogs={false}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("Invocation");
    expect(html).toContain("Adapter:");
    expect(html).toContain("Working dir:");
    expect(html).toContain("Details");
    expect(html).not.toContain("Command:");
    expect(html).not.toContain("Prompt is piped to claude via stdin.");
    expect(html).not.toContain("very long prompt body");
    expect(html).not.toContain("ANTHROPIC_API_KEY");
    expect(html).not.toContain("triggeredBy");
  });

  // ROCAA-181: plain Tier 0 runs must render exactly as before — no false-
  // positive badge or timeline. This locks the "no regression" acceptance.
  it("renders no tier badge or timeline for plain Tier 0 runs", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunInvocationCard
          payload={{ adapterType: "claude_local", cwd: "/tmp/workspace", command: "claude" }}
          censorUsernameInLogs={false}
        />
      </ThemeProvider>,
    );
    expect(html).not.toContain("tier-failover-badge");
    expect(html).not.toContain("tier-failover-timeline");
    expect(html).not.toContain("Tier transition");
  });

  // Acceptance branch 1: meta carries `failoverEvent` → badge + timeline render.
  it("renders the Tier 1 badge and transition row when meta carries failoverEvent", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunInvocationCard
          payload={{
            adapterType: "claude_local",
            cwd: "/tmp/workspace",
            command: "claude",
            failoverEvent: {
              at: "2026-05-24T18:30:00Z",
              from: "tier_0_claude_cli",
              to: "tier_1_anthropic_sdk",
              reason: "rate_limit",
              classifierMatch: "429 rate-limited",
              billerKeyName: "ANTHROPIC_API_KEY_BLUEPRINT_WORKER",
            },
          }}
          censorUsernameInLogs={false}
        />
      </ThemeProvider>,
    );
    expect(html).toContain("tier-failover-badge");
    expect(html).toContain("Tier 1 (Anthropic SDK)");
    expect(html).toContain("ANTHROPIC_API_KEY_BLUEPRINT_WORKER");
    expect(html).toContain("tier-failover-timeline");
    // from → to chain and reason are rendered in the timeline row.
    expect(html).toContain("Tier 0 (Claude CLI)");
    expect(html).toContain("rate limit");
    expect(html).toContain("429 rate-limited");
  });

  // Acceptance branch 2: meta is missing failoverEvent but the result carries
  // `tierUsed: tier_1_anthropic_sdk` (numeric 1 in usageJson) — still badge.
  it("renders the Tier 1 badge from result-side tierUsed when meta has no failoverEvent", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunInvocationCard
          payload={{ adapterType: "claude_local", cwd: "/tmp/workspace", command: "claude" }}
          censorUsernameInLogs={false}
          tierUsed={1}
        />
      </ThemeProvider>,
    );
    expect(html).toContain("tier-failover-badge");
    expect(html).toContain("Tier 1");
  });

  // Lossy tierTransitions shape ({tier, errorReason}) still renders a row.
  it("renders timeline row from lossy result-side tierTransitions shape", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunInvocationCard
          payload={{ adapterType: "claude_local", cwd: "/tmp/workspace", command: "claude" }}
          censorUsernameInLogs={false}
          tierUsed={1}
          tierTransitions={[{ tier: 1, errorReason: "anthropic_5xx" }]}
        />
      </ThemeProvider>,
    );
    expect(html).toContain("tier-failover-timeline");
    expect(html).toContain("Tier 1 (Anthropic SDK)");
    expect(html).toContain("anthropic 5xx");
  });

  // Post-completion: usageJson.failoverEvent is the canonical record once the
  // run is over (the meta event may have scrolled off the events list).
  it("falls back to runFailoverEvent when meta payload lacks failoverEvent", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunInvocationCard
          payload={{ adapterType: "claude_local", cwd: "/tmp/workspace", command: "claude" }}
          censorUsernameInLogs={false}
          runFailoverEvent={{
            at: "2026-05-24T18:30:00Z",
            from: "tier_0_claude_cli",
            to: "tier_1_anthropic_sdk",
            reason: "network_econnreset",
            classifierMatch: null,
            billerKeyName: "ANTHROPIC_API_KEY_BLUEPRINT_WORKER",
          }}
        />
      </ThemeProvider>,
    );
    expect(html).toContain("tier-failover-badge");
    expect(html).toContain("ANTHROPIC_API_KEY_BLUEPRINT_WORKER");
    expect(html).toContain("network econnreset");
  });
});
