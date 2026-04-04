import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { asString } from "../utils.js";

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, agent, context } = ctx;

  // Get API endpoint and key
  const apiUrl = asString(config.url, "https://ollama.com/api/chat");
  const apiKey = asString(config.apiKey, process.env.OLLAMA_API_KEY ?? "");
  const model = asString(config.model, "kimi-k2.5:cloud");
  const maxTokens = typeof config.maxOutputTokens === "number" ? config.maxOutputTokens : 4096;

  if (!apiKey) {
    throw new Error("Ollama Cloud adapter missing API key (set OLLAMA_API_KEY or configure in agent)");
  }

  // Build messages from context. All context values are unknown — coerce to string safely.
  const messages: Array<{ role: string; content: string }> = [];

  function strVal(v: unknown): string {
    return typeof v === "string" ? v : "";
  }

  // System prompt from agent instructions
  const systemPrompt = strVal(context.systemPrompt) || strVal(context.ironworksSystemPrompt);
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }

  // Morning briefing / session context
  const morningBriefing = strVal(context.ironworksMorningBriefing);
  if (morningBriefing) {
    messages.push({ role: "system", content: morningBriefing });
  }

  // Onboarding packet for contractors
  const onboardingContext = strVal(context.ironworksOnboardingContext);
  if (onboardingContext) {
    messages.push({ role: "system", content: onboardingContext });
  }

  // Recent documents
  const recentDocuments = strVal(context.ironworksRecentDocuments);
  if (recentDocuments) {
    messages.push({ role: "system", content: `## Your Recent Documents\n${recentDocuments}` });
  }

  // The actual task/issue context
  const taskContext = strVal(context.taskContext) || strVal(context.issueContext);
  if (taskContext) {
    messages.push({ role: "user", content: taskContext });
  }

  // Latest comments/messages
  const latestComment = strVal(context.latestComment);
  if (latestComment) {
    messages.push({ role: "user", content: latestComment });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000); // 2 min timeout

  try {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        options: {
          num_predict: maxTokens,
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => "");
      throw new Error(`Ollama Cloud API returned ${res.status}: ${errorText}`);
    }

    const data = await res.json() as {
      message?: { content?: string };
      eval_count?: number;
      prompt_eval_count?: number;
    };

    const responseContent = data.message?.content ?? "";
    const outputTokens = data.eval_count ?? 0;
    const inputTokens = data.prompt_eval_count ?? 0;

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: responseContent,
      model,
      provider: "ollama_cloud",
      usage: {
        inputTokens,
        outputTokens,
      },
    };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return {
        exitCode: 1,
        signal: "SIGTERM",
        timedOut: true,
        summary: "Ollama Cloud request timed out after 120s",
      };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
