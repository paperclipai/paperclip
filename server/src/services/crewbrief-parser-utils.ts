import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { readConfigFile } from "../config-file.js";

const require = createRequire(import.meta.url);

export function resolveOpenAiApiKey(): string | null {
  const envKey = process.env.OPENAI_API_KEY?.trim();
  if (envKey) return envKey;
  const config = readConfigFile();
  if (config?.llm?.provider !== "openai") return null;
  const configKey = config.llm.apiKey?.trim();
  return configKey && configKey.length > 0 ? configKey : null;
}

export function resolveAnthropicApiKey(): string | null {
  const envKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (envKey) return envKey;
  const config = readConfigFile();
  if (config?.llm?.provider !== "claude") return null;
  const configKey = config.llm.apiKey?.trim();
  return configKey && configKey.length > 0 ? configKey : null;
}

export function determineProvider(): "openai" | "claude" | null {
  if (resolveOpenAiApiKey()) return "openai";
  if (resolveAnthropicApiKey()) return "claude";
  const config = readConfigFile();
  if (config?.llm?.provider === "openai" && config.llm.apiKey) return "openai";
  if (config?.llm?.provider === "claude" && config.llm.apiKey) return "claude";
  return null;
}

export async function callOpenAI<T>(systemPrompt: string, userPrompt: string, apiKey: string): Promise<T> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${err}`);
  }

  const data = (await response.json()) as { choices: { message: { content: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned empty response");

  return parseLLMResult<T>(content);
}

export async function callClaude<T>(systemPrompt: string, userPrompt: string, apiKey: string): Promise<T> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: systemPrompt,
      messages: [
        { role: "user", content: userPrompt },
      ],
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${err}`);
  }

  const data = (await response.json()) as { content: { text: string }[] };
  const contentBlock = data.content?.[0];
  if (!contentBlock?.text) throw new Error("Anthropic returned empty response");

  return parseLLMResult<T>(contentBlock.text);
}

export function parseLLMResult<T>(raw: string): T {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const parsed = JSON.parse(cleaned);

  if (parsed.error) {
    throw new Error(parsed.error);
  }

  return parsed as T;
}

export async function extractPdfText(pdfBuffer: Buffer): Promise<string> {
  const result = spawnSync("python3", ["-c", `
import sys
from io import BytesIO
from pdfminer.high_level import extract_text
data = sys.stdin.buffer.read()
text = extract_text(BytesIO(data))
sys.stdout.write(text)
`], { input: pdfBuffer, maxBuffer: 50 * 1024 * 1024, timeout: 30000 });

  if (result.error) throw new Error(`PDF extraction subprocess failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`PDF extraction subprocess exited ${result.status}: ${result.stderr.toString().slice(0, 500)}`);

  const text = result.stdout.toString().trim();
  if (!text) throw new Error("PDF text extraction returned empty result");
  return text;
}

export function callLLMWithFallback<T>(
  systemPrompt: string,
  userContent: string,
): Promise<T> {
  const provider = determineProvider();
  if (!provider) {
    throw new Error(
      "No LLM provider configured. " +
      "Set OPENAI_API_KEY or ANTHROPIC_API_KEY environment variable, " +
      "or configure llm.provider and llm.apiKey in your paperclip config.",
    );
  }

  if (provider === "openai") {
    return callOpenAI<T>(systemPrompt, userContent, resolveOpenAiApiKey()!);
  }
  return callClaude<T>(systemPrompt, userContent, resolveAnthropicApiKey()!);
}
