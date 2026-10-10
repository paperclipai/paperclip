// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import type { HeartbeatRun } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { RunAccountingMetrics } from "./AgentDetail";
import { hasUnavailableProviderAccounting } from "../lib/utils";

const unavailable = { providerAccounting: { usage: null, cost: null, externallyBilled: true } };
const run = (usageJson: HeartbeatRun["usageJson"], resultJson: HeartbeatRun["resultJson"] = null) => ({ usageJson, resultJson } as HeartbeatRun);

describe("run accounting provenance", () => {
  it("renders persisted unavailable accounting without zero usage or zero dollars", () => {
    const markup = renderToStaticMarkup(<RunAccountingMetrics run={run({ inputTokens: 0, outputTokens: 0, costUsd: 0 }, unavailable)} />);
    expect(markup.match(/Unavailable/g)).toHaveLength(4);
    expect(markup).not.toContain("$0");
    expect(markup).not.toContain(">0<");
  });

  it("retains reported historical usage independently of the agent's current provider", () => {
    const markup = renderToStaticMarkup(<RunAccountingMetrics run={run({ inputTokens: 120, outputTokens: 20, cachedInputTokens: 40, costUsd: 0.12 })} />);
    expect(markup).toContain("120");
    expect(markup).toContain("20");
    expect(markup).toContain("40");
    expect(markup).toContain("$0.1200");
    expect(markup).not.toContain("Unavailable");
  });

  it("requires the saved externally billed and unavailable facts", () => {
    expect(hasUnavailableProviderAccounting(unavailable)).toBe(true);
    expect(hasUnavailableProviderAccounting(null)).toBe(false);
    expect(hasUnavailableProviderAccounting({ providerAccounting: { usage: null, cost: null } })).toBe(false);
    expect(hasUnavailableProviderAccounting({ providerAccounting: { usage: { inputTokens: 2 }, cost: 1, externallyBilled: true } })).toBe(false);
  });
});
