/**
 * Local LLM shortcut for conversational messages.
 *
 * Routes trivial/quick questions through LM Studio (localhost:1234)
 * instead of creating a Paperclip issue. Uses the OpenAI-compatible
 * chat completions API.
 *
 * Fallback: if LM Studio is down or returns an error, the message
 * falls through to the normal Paperclip issue path.
 */

export type LocalLlmConfig = {
  baseUrl: string;
  model: string;
  /** Max tokens for the response. Keep short — these are conversational. */
  maxTokens: number;
  /** Timeout in ms for the LLM call. */
  timeoutMs: number;
};

export const DEFAULT_LOCAL_LLM_CONFIG: LocalLlmConfig = {
  baseUrl: process.env.LM_STUDIO_URL ?? "http://localhost:1234",
  model: process.env.LM_STUDIO_MODEL ?? "qwen3-4b-instruct-2507",
  maxTokens: 300,
  timeoutMs: 15_000,
};

/**
 * System prompt for conversational responses. Short and direct —
 * this is for quick Qs, not deep work.
 */
const CONVERSATIONAL_SYSTEM_PROMPT = `You are Karl, Matt's personal agent. You're answering a quick conversational message from Matt via Telegram. Be brief, casual, and helpful. No bullet points, no markdown headers — just talk like a quick text reply. If the question needs tools (email, calendar, code, files), say you'll need to create a task for that and suggest Matt phrase it as a task. Keep responses under 3 sentences unless the question genuinely needs more.`;

export type ConversationalResponse = {
  ok: true;
  text: string;
  model: string;
} | {
  ok: false;
  error: string;
  /** If true, the caller should fall through to the Paperclip issue path. */
  fallbackToIssue: boolean;
};

/**
 * Send a conversational message to the local LLM and get a reply.
 * Returns the reply text, or a fallback signal if the LLM is unavailable.
 */
export async function answerConversational(
  userMessage: string,
  config: LocalLlmConfig = DEFAULT_LOCAL_LLM_CONFIG,
): Promise<ConversationalResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const res = await fetch(`${config.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: CONVERSATIONAL_SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        max_tokens: config.maxTokens,
        temperature: 0.7,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "<no body>");
      return {
        ok: false,
        error: `LM Studio ${res.status}: ${body.slice(0, 200)}`,
        fallbackToIssue: true,
      };
    }

    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      model?: string;
    };

    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) {
      return {
        ok: false,
        error: "empty response from LM Studio",
        fallbackToIssue: true,
      };
    }

    return { ok: true, text, model: data.model ?? config.model };
  } catch (err: any) {
    const isAbort = err?.name === "AbortError";
    return {
      ok: false,
      error: isAbort ? "LM Studio timeout" : (err?.message ?? String(err)),
      fallbackToIssue: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Quick health check — is LM Studio available?
 */
export async function isLmStudioAvailable(
  config: LocalLlmConfig = DEFAULT_LOCAL_LLM_CONFIG,
): Promise<boolean> {
  try {
    const res = await fetch(`${config.baseUrl}/v1/models`, {
      signal: AbortSignal.timeout(3_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
