import type { Finding } from "./types.js";
import {
  CLASSIFIER_SYSTEM_PROMPT,
  type ClassifierResponse,
} from "./classifier-prompt.js";

export interface ClassifierConfig {
  url: string;
  model: string;
  timeoutMs: number;
}

export class DpoUnavailableError extends Error {
  constructor(reason: string) {
    super(`dpo_unavailable: ${reason}`);
  }
}

export async function classifyEntities(
  text: string,
  cfg: ClassifierConfig,
): Promise<Finding[]> {
  let response: Response;
  try {
    response = await fetch(`${cfg.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
        stream: false,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (err) {
    throw new DpoUnavailableError(`fetch_failed: ${(err as Error).message}`);
  }

  if (!response.ok) {
    throw new DpoUnavailableError(`http_${response.status}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string | null } }>;
  };
  const content = data.choices[0]?.message?.content ?? "";

  let parsed: ClassifierResponse;
  try {
    parsed = JSON.parse(content) as ClassifierResponse;
  } catch {
    throw new DpoUnavailableError("invalid_json");
  }
  if (!Array.isArray(parsed.findings)) {
    throw new DpoUnavailableError("schema_mismatch");
  }

  const findings: Finding[] = [];
  for (const f of parsed.findings) {
    const start = text.indexOf(f.value);
    if (start < 0) continue;
    findings.push({
      type: f.type,
      value: f.value,
      start,
      end: start + f.value.length,
      confidence: f.confidence,
      source: "llm",
    });
  }
  return findings;
}
