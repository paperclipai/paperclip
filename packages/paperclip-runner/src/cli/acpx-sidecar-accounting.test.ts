import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";
import { readProviderUsageBilling } from "../contracts/usage-billing.js";
import { readProviderTokenAccounting, type ProviderTokenAccounting } from "../contracts/usage-tokens.js";
import { bindAcpxExtensionTurn, createAcpxProfileExtensionAdapter } from "../drivers/acpx/profile-extensions.js";
import { acpxUsageEstimateNotice, persistedAcpxTurnUsage, qualifiedAcpxUsageBreakdown } from "../drivers/acpx/usage-accounting.js";
import { boundedSidecarValue, record, text } from "../drivers/acpx/sidecar-protocol.js";

const source = readFileSync(new URL("./acpx-runtime-sidecar.ts", import.meta.url), "utf8");
function section(start: string, end: string): string {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  if (first < 0 || last < first) throw new Error("Production sidecar section missing: " + start);
  return source.slice(first, last);
}

// Execute the production turn admission, pump and sanitizer with a deterministic
// native host. This catches missing callbacks and receipt loss in the actual
// sidecar path, which in-process driver tests cannot establish.
async function terminalReceipt(receipt: ProviderTokenAccounting, notifications = 1) {
  const frames: Array<{ event: string; payload: Record<string, unknown>; turn: string }> = [];
  let finish!: () => void;
  const ended = new Promise<void>(resolve => { finish = resolve; });
  let statusReads = 0;
  const host = {
    identity: () => ({ backendSessionId: "backend-1" }),
    steeringCapability: () => null,
    startTurn(options: { requestId: string; onExtensionNotification(method: string, params: Record<string, unknown>): void }) {
      return {
        requestId: options.requestId,
        promptStarted: Promise.resolve(),
        result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
        events: (async function* () {
          for (let index = 0; index < notifications; index++) options.onExtensionNotification("_hermes/usage", {
            version: 1, sessionId: "backend-1", tokens: "reported", cost: "unavailable", tokenAccounting: receipt,
          });
        })(),
      };
    },
  };
  const dependencies = {
    host, openParams: { agent: "hermes", workingDirectory: "/workspace" }, initializedAgent: "hermes",
    requireHost: () => host, turnControls: { begin() {} },
    boundedIdentity: (value: unknown) => value,
    boundedText: (value: unknown) => value,
    parseNativeUserAttachments: () => [], validateNativeUserMessageSize() {},
    bindAcpxExtensionTurn, createAcpxProfileExtensionAdapter,
    acpxProfileActivity: () => ({}),
    readSidecarHostStatusWithin: async () => ++statusReads === 1 ? {} : {
      lastRequestId: "run-1:turn-1",
      // Deliberately incomplete accepted-response counters. Complete wire
      // authority must override these; partial wire receipts must stay unknown.
      requestTokenUsage: { native: { input_tokens: 1, output_tokens: 1 } },
    },
    createAcpxToolEventNormalizer: () => (event: unknown) => event,
    createGrokMessageNormalizer: () => (event: unknown) => event,
    persistedAcpxTurnUsage, acpxUsageEstimateNotice, qualifiedAcpxUsageBreakdown,
    readProviderUsageBilling, readProviderTokenAccounting, boundedSidecarValue, record, text,
    isHermesCommittedHumanInputCompletion: () => false,
    rejectTurnWaiters() {}, diagnostic() {},
    safeMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
    safeText: (value: unknown) => typeof value === "string" ? value : "",
    boundedOptionalText: (value: unknown, fallback: string, max: number) => typeof value === "string" ? value.slice(0, max) : fallback,
    AcpxApprovalRequiredError: class extends Error {},
    emit(event: string, payload: Record<string, unknown>, turn: string) {
      frames.push({ event, payload, turn });
      if (event === "runtime.turn_terminal") finish();
    },
  };
  const code = transformSync(`
    let turnId = null, runId = "run-1";
    const MAX_PENDING_INPUTS = 16;
    async function start(request) {
      ${section('  if (request.command === "turn.start") {', '  if (request.command === "turn.steer") {')}
    }
    ${section("async function pumpTurn(", "async function waitForTool(")}
    ${section("function sanitizeRuntimeEvent(", "function sanitizeRuntimeStatus(")}
    ${section("function safeUsage(", "function safeOutput(")}
  `, { loader: "ts", target: "es2022" }).code;
  const start = new Function(...Object.keys(dependencies), code + "\nreturn start;")(...Object.values(dependencies));
  await start({ command: "turn.start", params: { turnId: "turn-1", message: "Work" } });
  await ended;
  return frames;
}

describe("native ACPX sidecar API token authority", () => {
  const receipt = (biller: "anthropic" | "openai", complete: boolean): ProviderTokenAccounting => ({
    schema: "paperclip.usage.tokens/v1", source: "provider_wire", biller,
    model: biller === "anthropic" ? "claude-haiku-4-5-20251001" : "gpt-6-luna",
    protocol: biller === "anthropic" ? "messages" : "chat_completions",
    complete, requestCount: 2, reportedRequestCount: complete ? 2 : 1,
    tokens: { inputTokens: 21, outputTokens: 13, cacheReadTokens: 8, cacheWriteTokens: 5 },
    pricingContext: { serviceTier: "standard", contextTier: "short" },
  });

  it.each(["anthropic", "openai"] as const)("settles complete %s receipts through native admission, pump and sanitization", async biller => {
    const tokenAccounting = receipt(biller, true);
    const frames = await terminalReceipt(tokenAccounting);
    expect(frames.at(-1)).toEqual({ event: "runtime.turn_terminal", payload: { status: "completed", stopReason: "end_turn" }, turn: "turn-1" });
    const usage = frames.filter(frame => frame.event === "runtime.event" && frame.payload.tag === "usage_update");
    expect(usage).toHaveLength(1);
    expect(usage[0]!.payload).toMatchObject({ tokenAccounting, cost: null, breakdown: {
      inputTokens: 21, outputTokens: 13, cachedReadTokens: 8, cachedWriteTokens: 5, thoughtTokens: 0, totalTokens: 47,
    } });
    expect(usage[0]!.payload).not.toHaveProperty("billing");
  });

  it.each(["anthropic", "openai"] as const)("keeps partial %s authority without certifying accepted-response counters", async biller => {
    const tokenAccounting = receipt(biller, false);
    const frames = await terminalReceipt(tokenAccounting);
    expect(frames.at(-1)!.payload.status).toBe("completed");
    const usage = frames.find(frame => frame.event === "runtime.event" && frame.payload.tag === "usage_update")!.payload;
    expect(usage).toMatchObject({ tokenAccounting, cost: null, breakdown: {
      inputTokens: null, outputTokens: null, cachedReadTokens: null, cachedWriteTokens: null, totalTokens: null,
    } });
  });

  it("rejects duplicate native token authorities before publishing successful completion", async () => {
    const frames = await terminalReceipt(receipt("anthropic", true), 2);
    expect(frames.at(-1)!.payload).toMatchObject({ status: "failed", error: { message: "Hermes supplied more than one token accounting receipt" } });
    expect(frames.some(frame => frame.event === "runtime.event" && frame.payload.tag === "usage_update")).toBe(false);
  });

  it("rejects credential-bearing token receipts at the native extension boundary", async () => {
    const frames = await terminalReceipt({ ...receipt("openai", true), apiKey: "must-not-cross" } as ProviderTokenAccounting);
    expect(frames.at(-1)!.payload.status).toBe("failed");
    expect(JSON.stringify(frames)).not.toContain("must-not-cross");
    expect(frames.some(frame => frame.event === "runtime.event" && frame.payload.tag === "usage_update")).toBe(false);
  });
});
