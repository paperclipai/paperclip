import { generateJson } from "./gemini.js";

/**
 * Shared Gemini JSON helper for content-studio generators — ported from
 * agnb lib/agnb/gemini-json.ts. Forces JSON output. Throws on non-OK / parse
 * errors. Returns just the parsed payload (token usage discarded).
 */
export async function geminiJson<T>(
  prompt: string,
  opts?: { temperature?: number; maxTokens?: number; signal?: AbortSignal },
): Promise<T> {
  const { data } = await generateJson<T>(prompt, {
    temperature: opts?.temperature ?? 0.7,
    maxOutputTokens: opts?.maxTokens ?? 2000,
    signal: opts?.signal,
  });
  return data;
}
