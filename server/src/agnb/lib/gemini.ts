/**
 * Gemini REST client — ported from agnb lib/integrations/gemini.ts.
 * Uses the Google Generative Language API directly (no SDK). Reads
 * GEMINI_API_KEY from env at call time (not module load) so jobs can no-op
 * gracefully when the key is absent.
 *
 * Docs: https://ai.google.dev/api/generate-content
 */
const BASE = "https://generativelanguage.googleapis.com/v1beta";

export interface GenerateOpts {
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** Force JSON-mode response to the given schema. */
  jsonSchema?: Record<string, unknown>;
  /** System instruction (separate from user content). */
  systemInstruction?: string;
  /** Abort signal — wire ctx.signal so a shutting-down scheduler cancels in-flight calls. */
  signal?: AbortSignal;
  /** Per-call timeout (ms). Default 20s. */
  timeoutMs?: number;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  error?: { code: number; message: string; status: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/** True when GEMINI_API_KEY is present. Jobs check this and no-op when false. */
export function hasGeminiKey(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

function combineSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (a.aborted || b.aborted) ctrl.abort();
  a.addEventListener("abort", onAbort, { once: true });
  b.addEventListener("abort", onAbort, { once: true });
  return ctrl.signal;
}

/**
 * Single-prompt generate. Returns { text, inTok, outTok }. Throws on error.
 */
export async function generate(
  prompt: string,
  opts: GenerateOpts = {},
): Promise<{ text: string; inTok: number; outTok: number }> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");
  const model = opts.model ?? "gemini-flash-latest";

  const body: Record<string, unknown> = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: opts.temperature ?? 0.2,
      maxOutputTokens: opts.maxOutputTokens ?? 1024,
      thinkingConfig: { thinkingBudget: 0 },
      ...(opts.jsonSchema
        ? { responseMimeType: "application/json", responseSchema: opts.jsonSchema }
        : {}),
    },
  };
  if (opts.systemInstruction) {
    body.systemInstruction = { parts: [{ text: opts.systemInstruction }] };
  }

  const timeoutSignal = AbortSignal.timeout(opts.timeoutMs ?? 20_000);
  const signal = combineSignals(opts.signal, timeoutSignal);

  const url = `${BASE}/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Gemini HTTP ${res.status}: ${err.slice(0, 200)}`);
  }
  const json = (await res.json()) as GeminiResponse;
  if (json.error) throw new Error(`Gemini ${json.error.status}: ${json.error.message}`);
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const u = json.usageMetadata ?? {};
  return { text, inTok: u.promptTokenCount ?? 0, outTok: u.candidatesTokenCount ?? 0 };
}

/** Generate + parse JSON. Strips ```json fences if present. */
export async function generateJson<T = unknown>(
  prompt: string,
  opts: GenerateOpts = {},
): Promise<{ data: T; inTok: number; outTok: number }> {
  const { text, inTok, outTok } = await generate(prompt, opts);
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  if (!cleaned) throw new Error("gemini returned empty text");
  return { data: JSON.parse(cleaned) as T, inTok, outTok };
}
