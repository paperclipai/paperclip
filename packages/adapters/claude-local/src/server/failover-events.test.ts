import { describe, expect, it, vi } from "vitest";

import type { AdapterInvocationMeta } from "@paperclipai/adapter-utils";

import {
  buildFailoverEvent,
  buildFailoverLogLine,
  buildTierTransition,
  emitFailoverVisibility,
  FAILOVER_CLASSIFIER_VERSION,
} from "./failover-events.js";
import { BLUEPRINT_WORKER_SECRET_NAME } from "./secret-fetch.js";

type LogFn = (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
type MetaFn = (meta: AdapterInvocationMeta) => Promise<void>;

const FIXED_AT = "2026-05-22T19:00:00.000Z";
const now = () => FIXED_AT;

describe("failover-events", () => {
  it("FAILOVER_CLASSIFIER_VERSION is stable", () => {
    expect(FAILOVER_CLASSIFIER_VERSION).toBe("1.0.0");
  });

  it("builds a tier_transitions[] entry that satisfies the log-schema fields", () => {
    const t = buildTierTransition({
      verdict: { reason: "rate_limit", match: "HTTP 429", detail: "Tier 0 stderr matched rate_limit" },
      fromExitCode: 1,
      fromParsed: true,
      now,
    });
    expect(t).toEqual({
      at: FIXED_AT,
      from: "tier_0_claude_cli",
      to: "tier_1_anthropic_sdk",
      reason: "rate_limit",
      classifierMatch: "HTTP 429",
      detail: "Tier 0 stderr matched rate_limit",
      fromExitCode: 1,
      fromParsed: true,
    });
  });

  it("truncates classifierMatch and detail to bounded lengths", () => {
    const huge = "x".repeat(1000);
    const t = buildTierTransition({
      verdict: { reason: "anthropic_5xx", match: huge, detail: huge },
      fromExitCode: 1,
      fromParsed: false,
      now,
    });
    expect(t.classifierMatch?.length).toBe(240);
    expect(t.detail?.length).toBe(240);
  });

  it("builds a failoverEvent with the biller key name surfaced", () => {
    const evt = buildFailoverEvent({
      verdict: { reason: "anthropic_5xx", match: "HTTP 529 overloaded_error" },
      fromExitCode: 1,
      fromParsed: true,
      now,
    });
    expect(evt.billerKeyName).toBe(BLUEPRINT_WORKER_SECRET_NAME);
    expect(evt.reason).toBe("anthropic_5xx");
    expect(evt.classifierMatch).toBe("HTTP 529 overloaded_error");
  });

  it("builds a stdout line with both Tier 0 and Tier 1 substrings and the biller key name", () => {
    const line = buildFailoverLogLine({
      verdict: { reason: "rate_limit", match: "HTTP 429" },
      fromExitCode: 1,
      fromParsed: true,
      now,
    });
    expect(line).toContain("Tier 0");
    expect(line).toContain("Tier 1");
    expect(line).toContain("reason=rate_limit");
    expect(line).toContain('match="HTTP 429"');
    expect(line).toContain(BLUEPRINT_WORKER_SECRET_NAME);
    expect(line).toMatch(/\[paperclip\] Tier 0 .* Failing over to Tier 1/);
  });

  it("emits onLog + onMeta together with a shared timestamp", async () => {
    const logCalls: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    const metaCalls: AdapterInvocationMeta[] = [];
    const onLog: LogFn = async (stream, chunk) => {
      logCalls.push({ stream, chunk });
    };
    const onMeta: MetaFn = async (meta) => {
      metaCalls.push(meta);
    };

    const { transition, event } = await emitFailoverVisibility({
      verdict: { reason: "network_econnreset", match: "read ECONNRESET" },
      fromExitCode: 1,
      fromParsed: false,
      onLog,
      onMeta,
      baseMeta: { adapterType: "claude_local", command: "claude" },
      now,
    });

    expect(transition.at).toBe(FIXED_AT);
    expect(event.at).toBe(FIXED_AT);
    expect(logCalls).toHaveLength(1);
    expect(logCalls[0]!.stream).toBe("stdout");
    expect(logCalls[0]!.chunk).toContain("Tier 0");
    expect(logCalls[0]!.chunk).toContain("Tier 1");
    expect(logCalls[0]!.chunk).toContain("reason=network_econnreset");

    expect(metaCalls).toHaveLength(1);
    const metaArg = metaCalls[0]!;
    expect(metaArg.adapterType).toBe("claude_local");
    expect(metaArg.failoverEvent).toBeDefined();
    expect(metaArg.failoverEvent!.reason).toBe("network_econnreset");
    expect(metaArg.failoverEvent!.billerKeyName).toBe(BLUEPRINT_WORKER_SECRET_NAME);
  });

  it("emits onLog even when onMeta is not provided (cost-visibility test #3 per ROCAA-29 scope)", async () => {
    const logCalls: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    const onLog: LogFn = async (stream, chunk) => {
      logCalls.push({ stream, chunk });
    };
    await emitFailoverVisibility({
      verdict: { reason: "claude_cli_panic", match: "panic: runtime error" },
      fromExitCode: 1,
      fromParsed: false,
      onLog,
      now,
    });
    expect(logCalls).toHaveLength(1);
    expect(logCalls[0]!.chunk).toContain("Tier 0");
    expect(logCalls[0]!.chunk).toContain("Tier 1");
    expect(logCalls[0]!.chunk).toContain("reason=claude_cli_panic");
  });

  it("escapes double-quotes inside match so the stdout line stays parseable", async () => {
    const logCalls: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    const onLog: LogFn = async (stream, chunk) => {
      logCalls.push({ stream, chunk });
    };
    await emitFailoverVisibility({
      verdict: { reason: "anthropic_5xx", match: 'inner "quoted" segment' },
      fromExitCode: 1,
      fromParsed: false,
      onLog,
      now,
    });
    expect(logCalls[0]!.chunk).toContain('match="inner \\"quoted\\" segment"');
  });
});
