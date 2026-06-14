const cache = new Map<string, "reasoning" | "fast">();
const CACHE_MAX = 1_000;

/** Test-only: clear the per-issue verdict cache. */
export function __resetClassifierCache(): void {
  cache.clear();
}

const PROMPT = (title: string, description: string) =>
  `Classify the task. Answer with exactly one word: REASONING if it needs multi-step reasoning, planning, coding or debugging; FAST if it is simple retrieval, formatting, summarizing or classification.\n\nTitle: ${title}\nDetails: ${description.slice(0, 1000)}`;

/**
 * Ask a small warm model whether a task needs reasoning. Fails safe to
 * "reasoning" on any error/ambiguity. Cached per issueId.
 */
export async function classifyTaskComplexity(input: {
  issueId: string;
  title: string;
  description: string;
  baseUrl: string; // e.g. http://localhost:1234/v1
  model: string;   // e.g. gemma-4-31b-it-mlx
  fetchImpl?: typeof fetch;
}): Promise<"reasoning" | "fast"> {
  const cached = cache.get(input.issueId);
  if (cached) return cached;

  const doFetch = input.fetchImpl ?? fetch;
  let verdict: "reasoning" | "fast" = "reasoning"; // safe default
  try {
    const res = await doFetch(`${input.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // bound the call so a slow local model can't stall dispatch
      signal: AbortSignal.timeout(5_000),
      body: JSON.stringify({
        model: input.model,
        temperature: 0,
        max_tokens: 4,
        messages: [{ role: "user", content: PROMPT(input.title, input.description) }],
      }),
    });
    if (res.ok) {
      const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const word = (json.choices?.[0]?.message?.content ?? "").trim().toUpperCase();
      if (word.startsWith("FAST")) verdict = "fast";
      else if (word.startsWith("REASONING")) verdict = "reasoning";
    }
  } catch {
    // keep the safe "reasoning" default
  }
  cache.set(input.issueId, verdict);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return verdict;
}
