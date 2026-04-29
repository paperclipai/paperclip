import { createHash } from "node:crypto";
import type { UsageSummary } from "./types.js";

export interface LoopDetectorConfig {
  enabled?: boolean;
  maxSameToolSameArgs30s?: number;
  maxSameTool60s?: number;
  maxSameToolSameArgs5s?: number;
}

export interface RunGuardConfig {
  enabled?: boolean;
  budgetCapUsd?: number;
  loopDetector?: LoopDetectorConfig;
}

interface ToolEvent {
  toolName: string;
  argsHash: string;
  ts: number;
}

export class LoopDetector {
  private events: ToolEvent[] = [];
  private tripped = false;

  constructor(
    private readonly config: LoopDetectorConfig,
    private readonly onTrip: (reason: string) => void,
  ) {}

  observe(toolName: string, argsHash: string): void {
    if (this.tripped) return;
    if (this.config.enabled === false) return;

    const now = Date.now();
    this.events.push({ toolName, argsHash, ts: now });

    // Keep sliding window bounded at 60s
    const cutoff60s = now - 60_000;
    this.events = this.events.filter((e) => e.ts > cutoff60s);

    this.check(toolName, argsHash, now);
  }

  private check(toolName: string, argsHash: string, now: number): void {
    const max30s = this.config.maxSameToolSameArgs30s ?? 10;
    const max60s = this.config.maxSameTool60s ?? 30;
    const max5s = this.config.maxSameToolSameArgs5s ?? 5;

    const cutoff30s = now - 30_000;
    const cutoff5s = now - 5_000;

    const sameToolSameArgs5s = this.events.filter(
      (e) => e.ts > cutoff5s && e.toolName === toolName && e.argsHash === argsHash,
    ).length;
    if (sameToolSameArgs5s >= max5s) {
      this.trip(`${sameToolSameArgs5s}x ${toolName}(same-args) in 5s`);
      return;
    }

    const sameToolSameArgs30s = this.events.filter(
      (e) => e.ts > cutoff30s && e.toolName === toolName && e.argsHash === argsHash,
    ).length;
    if (sameToolSameArgs30s >= max30s) {
      this.trip(`${sameToolSameArgs30s}x ${toolName}(same-args) in 30s`);
      return;
    }

    const sameTool60s = this.events.filter((e) => e.toolName === toolName).length;
    if (sameTool60s >= max60s) {
      this.trip(`${sameTool60s}x ${toolName} in 60s`);
    }
  }

  private trip(reason: string): void {
    this.tripped = true;
    this.onTrip(reason);
  }
}

function hashArgs(input: unknown): string {
  try {
    const json = JSON.stringify(input);
    return createHash("sha256").update(json).digest("hex").slice(0, 8);
  } catch {
    return "unknown";
  }
}

export function observeToolCallsFromChunk(chunk: string, detector: LoopDetector): void {
  for (const line of chunk.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== "{") continue;

    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      event = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = typeof event.type === "string" ? event.type : "";

    // opencode_local: {"type":"tool_use","part":{"name":"toolName","input":{...}}}
    if (type === "tool_use") {
      const part = event.part;
      if (typeof part === "object" && part !== null && !Array.isArray(part)) {
        const p = part as Record<string, unknown>;
        const name = typeof p.name === "string" ? p.name : null;
        if (name) detector.observe(name, hashArgs(p.input));
      }
      continue;
    }

    // claude_local: {"type":"assistant","message":{"content":[{"type":"tool_use","name":"toolName","input":{}}]}}
    if (type === "assistant") {
      const message = event.message;
      if (typeof message === "object" && message !== null && !Array.isArray(message)) {
        const content = (message as Record<string, unknown>).content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block !== "object" || block === null || Array.isArray(block)) continue;
            const b = block as Record<string, unknown>;
            if (b.type === "tool_use" && typeof b.name === "string") {
              detector.observe(b.name, hashArgs(b.input));
            }
          }
        }
      }
    }
  }
}

// Model family rates in $ per token (not per million)
const MODEL_RATES: Record<string, { input: number; output: number }> = {
  "claude-opus": { input: 15 / 1e6, output: 75 / 1e6 },
  "claude-sonnet": { input: 3 / 1e6, output: 15 / 1e6 },
  "claude-haiku": { input: 0.25 / 1e6, output: 1.25 / 1e6 },
};

function resolveModelFamily(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes("opus")) return "claude-opus";
  if (lower.includes("haiku")) return "claude-haiku";
  return "claude-sonnet";
}

export function imputeSubscriptionCostUsd(model: string, usage: UsageSummary): number {
  const rates = MODEL_RATES[resolveModelFamily(model)] ?? MODEL_RATES["claude-sonnet"]!;
  const inputTokens = (usage.inputTokens ?? 0) + (usage.cachedInputTokens ?? 0);
  return inputTokens * rates.input + (usage.outputTokens ?? 0) * rates.output;
}

export interface RunGuardAlertContext {
  runId: string;
  issueId: string | null;
  authToken: string | undefined;
  agentId: string;
}

export async function tryPostRunGuardAlert(ctx: RunGuardAlertContext, message: string): Promise<void> {
  const apiUrl = process.env["PAPERCLIP_API_URL"];
  const token = ctx.authToken ?? process.env["PAPERCLIP_API_KEY"];
  if (!apiUrl || !token || !ctx.issueId) return;

  try {
    await fetch(`${apiUrl}/api/issues/${ctx.issueId}/comments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Paperclip-Run-Id": ctx.runId,
      },
      body: JSON.stringify({ body: message }),
    });
  } catch {
    // Best-effort: alert failure must not interrupt the run result
  }
}
