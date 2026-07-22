// The IDS "brain" caller. Two interchangeable callers behind one interface:
//   * a free deterministic STUB that returns plausible JSON (proves the IDS kernel at zero spend), and
//   * the real DEEPSEEK-direct caller (cheap model). The API key is injected (never hardcoded, never
//     logged, never returned) and used only for the Authorization header.
// Determinism-first: the stub proves the machine; DeepSeek validates the real LLM + real-cost path.

export interface ChatRequest {
  system: string;
  user: string;
  maxTokens?: number;
  /** Model id override (e.g. a diverse model for the Red-Team seat). */
  model?: string;
  /** 0 = deterministic; higher loosens the Red-Team a touch. */
  temperature?: number;
  /** Ask the provider for a strict JSON object back. */
  json?: boolean;
}

export interface ChatResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number; // float; rounded to int only when stored
  model: string;
}

export interface ModelCaller {
  readonly provider: string;
  chat(req: ChatRequest): Promise<ChatResult>;
}

type DeepseekModel = "deepseek-v4-flash" | "deepseek-v4-pro" | "deepseek-chat" | "deepseek-reasoner";

interface DeepseekRates {
  cacheHitInputCentsPerToken: number;
  cacheMissInputCentsPerToken: number;
  outputCentsPerToken: number;
}

const DEEPSEEK_RATE_TABLE: Record<DeepseekModel, DeepseekRates> = {
  "deepseek-v4-flash": {
    cacheHitInputCentsPerToken: (0.0028 / 1_000_000) * 100,
    cacheMissInputCentsPerToken: (0.14 / 1_000_000) * 100,
    outputCentsPerToken: (0.28 / 1_000_000) * 100,
  },
  "deepseek-v4-pro": {
    cacheHitInputCentsPerToken: (0.003625 / 1_000_000) * 100,
    cacheMissInputCentsPerToken: (0.435 / 1_000_000) * 100,
    outputCentsPerToken: (0.87 / 1_000_000) * 100,
  },
  // The legacy aliases still route to v4-flash non-thinking/thinking modes.
  "deepseek-chat": {
    cacheHitInputCentsPerToken: (0.0028 / 1_000_000) * 100,
    cacheMissInputCentsPerToken: (0.14 / 1_000_000) * 100,
    outputCentsPerToken: (0.28 / 1_000_000) * 100,
  },
  "deepseek-reasoner": {
    cacheHitInputCentsPerToken: (0.0028 / 1_000_000) * 100,
    cacheMissInputCentsPerToken: (0.14 / 1_000_000) * 100,
    outputCentsPerToken: (0.28 / 1_000_000) * 100,
  },
};

function normalizeDeepseekModel(model: string): DeepseekModel {
  const lower = model.toLowerCase();
  if (lower in DEEPSEEK_RATE_TABLE) return lower as DeepseekModel;
  if (lower.includes("pro")) return "deepseek-v4-pro";
  return "deepseek-v4-flash";
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getDeepseekUsageCost(model: string, usage: Record<string, unknown> | null | undefined): number {
  const rates = DEEPSEEK_RATE_TABLE[normalizeDeepseekModel(model)];
  const promptTokens = readFiniteNumber(usage?.prompt_tokens) ?? 0;
  const cacheHitTokens = readFiniteNumber(usage?.prompt_cache_hit_tokens) ?? 0;
  const cacheMissTokens =
    readFiniteNumber(usage?.prompt_cache_miss_tokens) ?? Math.max(0, promptTokens - cacheHitTokens);
  const outputTokens = readFiniteNumber(usage?.completion_tokens) ?? 0;

  return (
    cacheHitTokens * rates.cacheHitInputCentsPerToken +
    cacheMissTokens * rates.cacheMissInputCentsPerToken +
    outputTokens * rates.outputCentsPerToken
  );
}

// Real DeepSeek caller (OpenAI-compatible). Returns real token counts + computed cost.
export class DeepseekCaller implements ModelCaller {
  readonly provider = "deepseek";
  constructor(
    private readonly apiKey: string,
    private readonly defaultModel: string = "deepseek-v4-flash",
  ) {
    if (!apiKey) throw new Error("DeepseekCaller: API key required (inject at runtime; never hardcode)");
  }
  async chat(req: ChatRequest): Promise<ChatResult> {
    const model = req.model ?? this.defaultModel;
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model,
        temperature: req.temperature ?? 0,
        max_tokens: req.maxTokens ?? 220,
        ...(req.json ? { response_format: { type: "json_object" } } : {}),
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`deepseek ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const usage = data.usage as Record<string, unknown> | undefined;
    const inTok = readFiniteNumber(usage?.prompt_tokens) ?? 0;
    const outTok = readFiniteNumber(usage?.completion_tokens) ?? 0;
    return {
      text: data.choices?.[0]?.message?.content ?? "",
      inputTokens: inTok,
      outputTokens: outTok,
      costCents: getDeepseekUsageCost(model, usage),
      model: typeof data.model === "string" && data.model.trim().length > 0 ? data.model : model,
    };
  }
}

// Free deterministic stub. Produces role-appropriate JSON so the IDS kernel can be proven end-to-end
// with zero spend. It reads simple cues from the user payload to stay plausible.
export class StubCaller implements ModelCaller {
  readonly provider = "stub";
  async chat(req: ChatRequest): Promise<ChatResult> {
    const role = /red.?team|opposing|refute|disagree/i.test(req.system) ? "redteam" : /decision|solve|converge/i.test(req.system) ? "solve" : "identify";
    const title = (/title[":]\s*([^\n"}]+)/i.exec(req.user)?.[1] ?? "the issue").trim().slice(0, 80);
    let obj: unknown;
    if (role === "identify") {
      obj = {
        root_cause: `Underlying cause behind "${title}": a process/threshold drift, not the surface number.`,
        and_what_else: ["A paired-indicator gap may be masking the real driver.", "Check whether an upstream owner changed cadence."],
      };
    } else if (role === "redteam") {
      obj = {
        opposing_hypothesis: `The promoted signal may itself be measurement drift, not a real regression in "${title}".`,
        evidence: "The control limits were computed on a short baseline; the deviation is ~3σ, borderline.",
        observation: "Observation, not accusation: the metric moved; the cause is not yet established.",
      };
    } else {
      obj = {
        decision: `Assign an owner to investigate and correct the root cause of "${title}" within the week.`,
        owner_unit: "GOV-24",
        due_in_days: 7,
        golden_rule: `If this metric pattern recurs, it must be re-flagged as special-cause and routed to IDS, not absorbed as noise.`,
        consequence: "tune",
      };
    }
    const text = JSON.stringify(obj);
    // Charge a nominal token estimate so the budget machinery is exercised even on the free path.
    const inTok = Math.ceil((req.system.length + req.user.length) / 4);
    const outTok = Math.ceil(text.length / 4);
    return { text, inputTokens: inTok, outputTokens: outTok, costCents: 0, model: "stub" };
  }
}
