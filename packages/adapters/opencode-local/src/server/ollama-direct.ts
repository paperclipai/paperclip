export interface OllamaGenerateResult {
  ok: boolean;
  timedOut: boolean;
  responseText: string;
  rawJson: Record<string, unknown> | null;
  statusCode?: number;
  errorMessage?: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function readNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function parseObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function parseOllamaModelId(model: string | null | undefined): string | null {
  const trimmed = (model ?? "").trim();
  if (!trimmed) return null;
  if (!trimmed.includes("/")) return null;
  const provider = trimmed.slice(0, trimmed.indexOf("/")).trim().toLowerCase();
  const modelId = trimmed.slice(trimmed.indexOf("/") + 1).trim();
  return provider === "ollama" && modelId ? modelId : null;
}

export function shouldUseDirectOllamaApi(config: Record<string, unknown>, model: string): boolean {
  if (!parseOllamaModelId(model)) return false;
  const explicit =
    config.useDirectOllamaApi ?? config.directOllamaApi ?? config.directOllama ?? config.useOllamaApi;
  return readBoolean(explicit, true);
}

export function resolveOllamaBaseUrl(
  config: Record<string, unknown>,
  env: Record<string, string>,
): string {
  const configured =
    readString(config.ollamaApiBaseUrl).trim() ||
    readString(config.ollamaBaseUrl).trim() ||
    readString(config.ollamaHost).trim() ||
    env.OLLAMA_HOST ||
    process.env.OLLAMA_HOST ||
    "http://127.0.0.1:11434";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(configured)
    ? configured
    : `http://${configured}`;
  return withScheme.replace(/\/+$/, "");
}

function compactError(value: unknown): string {
  if (typeof value === "string") return value.trim();
  const rec = parseObject(value);
  const message = readString(rec.message).trim();
  if (message) return message;
  const error = readString(rec.error).trim();
  if (error) return error;
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parseObject(parsed);
  } catch {
    return null;
  }
}

export async function runDirectOllamaGenerate(input: {
  baseUrl: string;
  model: string;
  prompt: string;
  timeoutSec: number;
}): Promise<OllamaGenerateResult> {
  const timeoutMs = Math.max(1, input.timeoutSec) * 1000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === "function") timer.unref();

  try {
    const response = await fetch(`${input.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: input.model,
        prompt: input.prompt,
        stream: false,
      }),
      signal: controller.signal,
    });
    const bodyText = await response.text();
    const parsed = parseJson(bodyText);
    const responseText = readString(parsed?.response).trim();

    if (!response.ok) {
      return {
        ok: false,
        timedOut: false,
        responseText,
        rawJson: parsed,
        statusCode: response.status,
        errorMessage:
          compactError(parsed?.error) ||
          compactError(parsed) ||
          bodyText.trim() ||
          `Ollama API request failed with HTTP ${response.status}`,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }

    return {
      ok: true,
      timedOut: false,
      responseText,
      rawJson: parsed,
      statusCode: response.status,
      usage: {
        inputTokens: readNumber(parsed?.prompt_eval_count, 0),
        outputTokens: readNumber(parsed?.eval_count, 0),
      },
    };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      timedOut,
      responseText: "",
      rawJson: null,
      errorMessage: timedOut
        ? `Timed out after ${input.timeoutSec}s`
        : err instanceof Error
          ? err.message
          : String(err),
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  } finally {
    clearTimeout(timer);
  }
}
