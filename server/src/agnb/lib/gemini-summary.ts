import { generate, hasGeminiKey } from "./gemini.js";

/**
 * Compose a short daily ops summary using Gemini — ported from
 * agnb lib/agnb/gemini-summary.ts. Single-shot, no streaming.
 */
export interface SummaryInput {
  bucketsTotal: number;
  bucketsRunning: number;
  sent24h: number;
  positive24h: number;
  meetings24h: number;
  deals24h: number;
  revenueUsd24h: number;
  verdictChanges24h: Array<{ from: string; to: string; bucket_name?: string }>;
  topBucket: { name: string; positive_rate: number | null; sent: number } | null;
}

export async function generateDailySummary(
  input: SummaryInput,
  opts?: { signal?: AbortSignal },
): Promise<{ ok: boolean; text?: string; error?: string; inTok?: number; outTok?: number }> {
  if (!hasGeminiKey()) return { ok: false, error: "GEMINI_API_KEY not set" };

  const prompt = `You are the AGNB ops co-pilot. Write a terse 3-bullet daily digest for the Launch HQ dashboard. Each bullet must be under 22 words. No filler. State the number, then the implication.

State:
- ${input.bucketsTotal} buckets (${input.bucketsRunning} running)
- last 24h: ${input.sent24h} sent · ${input.positive24h} positive replies · ${input.meetings24h} meetings · ${input.deals24h} deals · $${input.revenueUsd24h.toLocaleString()}
- top bucket: ${input.topBucket ? `${input.topBucket.name} (${input.topBucket.sent} sent, ${input.topBucket.positive_rate != null ? (input.topBucket.positive_rate * 100).toFixed(2) + "%" : "n/a"} positive)` : "none"}
- verdict changes: ${input.verdictChanges24h.length === 0 ? "none" : input.verdictChanges24h.map((v) => `${v.bucket_name ?? "?"} ${v.from}→${v.to}`).join(", ")}

Output exactly 3 bullets, each starting with "• ". No preamble, no closing line.`;

  try {
    const { text, inTok, outTok } = await generate(prompt, {
      temperature: 0.4,
      maxOutputTokens: 400,
      timeoutMs: 8_000,
      signal: opts?.signal,
    });
    if (!text) return { ok: false, error: "empty response" };
    return { ok: true, text: text.trim(), inTok, outTok };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
