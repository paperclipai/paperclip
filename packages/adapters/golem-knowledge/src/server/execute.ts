import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  parseObject,
  renderPaperclipWakePrompt,
} from "@paperclipai/adapter-utils/server-utils";

const DEFAULT_TIMEOUT_SEC = 120;

// ---------------------------------------------------------------------------
// Golem XIV SSE event types (matching GolemOutput sealed interface)
// ---------------------------------------------------------------------------

type GolemOutput =
  | { type: "Welcome"; message: string; neo4jBrowserUrl: string }
  | { type: "CognitionAdded"; cognitionId: number }
  | { type: "CognitionUpdated"; cognitionId: number }
  | { type: "Message"; cognitionId: number; expression: unknown }
  | { type: "Cognition"; cognitionId: number; event: CognitionEvent };

type CognitionEvent =
  | { type: "ExpressionInitiation"; expressionId: number; agent: { type: string } }
  | { type: "ExpressionCulmination"; expressionId: number }
  | { type: "TextUnfolding"; id: number; expressionId: number; textDelta: string }
  | { type: "IntentInitiation"; id: number; expressionId: number; systemId: string }
  | { type: "FulfillmentUnfolding"; id: number; expressionId: number; textDelta: string }
  | { type: string; [key: string]: unknown };

function parseGolemOutput(line: string): GolemOutput | null {
  const prefix = "data: ";
  if (!line.startsWith(prefix)) return null;
  const json = line.slice(prefix.length).trim();
  if (!json) return null;
  try {
    return JSON.parse(json) as GolemOutput;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Session cookie login (Ktor form auth)
// ---------------------------------------------------------------------------

async function loginForCookie(baseUrl: string, password: string): Promise<string | null> {
  const loginUrl = `${baseUrl}/login`;
  const body = new URLSearchParams({ name: "golem", password });

  const res = await fetch(loginUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
  });

  // Ktor responds with a redirect (3xx) after successful login; session cookie is in Set-Cookie
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) return null;

  // Extract "name=value" before any cookie attributes
  const match = setCookie.match(/^([^;]+)/);
  return match ? match[1].trim() : null;
}

// ---------------------------------------------------------------------------
// Build the prompt sent to Golem as wake text
// ---------------------------------------------------------------------------

function buildGolemPrompt(ctx: AdapterExecutionContext): string {
  const wakePrompt = renderPaperclipWakePrompt(ctx.context?.paperclipWake);
  const wakeReason = asString((ctx.context as Record<string, unknown>)?.wakeReason, "");
  const agentName = ctx.agent.name;

  const parts: string[] = [];

  if (wakeReason) {
    parts.push(`Wake reason: ${wakeReason}`);
  }

  if (wakePrompt) {
    parts.push(wakePrompt);
  }

  if (parts.length === 0) {
    parts.push(`Agent "${agentName}" is requesting knowledge from the graph. Please share relevant insights from your knowledge base.`);
  }

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Main execute function
// ---------------------------------------------------------------------------

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const config = parseObject(ctx.config);
  const baseUrl = asString(config.url, "").replace(/\/$/, "");
  const authPassword = asString(config.authPassword, "");
  const timeoutSec = asNumber(config.timeoutSec, DEFAULT_TIMEOUT_SEC);

  if (!baseUrl) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "golem_knowledge adapter: url is required in adapter config",
    };
  }

  const wakeText = buildGolemPrompt(ctx);
  await ctx.onLog("stdout", `[golem] Connecting to Golem XIV at ${baseUrl}\n`);

  // ---------------------------------------------------------------------------
  // Step 1: Authenticate (if password configured)
  // ---------------------------------------------------------------------------

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  if (authPassword) {
    await ctx.onLog("stdout", "[golem] Authenticating...\n");
    const cookie = await loginForCookie(baseUrl, authPassword).catch(() => null);
    if (!cookie) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage:
          "golem_knowledge: login failed — check authPassword config and that Golem XIV is running",
      };
    }
    headers["Cookie"] = cookie;
    await ctx.onLog("stdout", "[golem] Authenticated\n");
  }

  // ---------------------------------------------------------------------------
  // Step 2: PUT /api/cognitions — start cognition, receive cognitionId
  // ---------------------------------------------------------------------------

  await ctx.onLog("stdout", `[golem] Starting cognition...\n`);

  let cognitionId: number;
  try {
    const putRes = await fetch(`${baseUrl}/api/cognitions`, {
      method: "PUT",
      headers,
      body: JSON.stringify([{ type: "Text", id: -1, text: wakeText }]),
      signal: AbortSignal.timeout(30000),
    });

    if (!putRes.ok) {
      const body = await putRes.text().catch(() => "");
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: `golem_knowledge: PUT /api/cognitions failed (${putRes.status}): ${body}`,
      };
    }
    cognitionId = (await putRes.json()) as number;
  } catch (err) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `golem_knowledge: failed to start cognition: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  await ctx.onLog("stdout", `[golem] Cognition started (id=${cognitionId})\n`);

  // ---------------------------------------------------------------------------
  // Step 3: Stream GET /events SSE — collect text until cognition completes
  // ---------------------------------------------------------------------------

  const sseHeaders: Record<string, string> = {
    Accept: "text/event-stream",
    "Cache-Control": "no-cache",
  };
  if (headers["Cookie"]) sseHeaders["Cookie"] = headers["Cookie"];

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutSec * 1000);

  let outputText = "";
  let timedOut = false;
  let streamError: string | undefined;

  // Completion state tracking — mirrors CognitionPresenter.kt logic:
  // cognition is complete when ExpressionCulmination fires for an AI expression
  // that had NO IntentInitiation (pure text turn = end of loop).
  const aiExpressionIds = new Set<number>();
  const expressionsWithIntent = new Set<number>();
  let done = false;

  try {
    const sseRes = await fetch(`${baseUrl}/events`, {
      headers: sseHeaders,
      signal: controller.signal,
    });

    if (!sseRes.ok || !sseRes.body) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: `golem_knowledge: GET /events failed (${sseRes.status})`,
      };
    }

    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (!done) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (err: unknown) {
        const name = (err as { name?: string }).name;
        if (name === "AbortError" || name === "TimeoutError") {
          timedOut = true;
          break;
        }
        throw err;
      }

      if (result.done) break;

      buffer += decoder.decode(result.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const output = parseGolemOutput(line);
        if (!output) continue;

        // Skip events from other cognitions
        if (
          output.type !== "Welcome" &&
          "cognitionId" in output &&
          (output as { cognitionId: number }).cognitionId !== cognitionId
        ) {
          continue;
        }

        if (output.type === "Cognition") {
          const event = (output as Extract<GolemOutput, { type: "Cognition" }>).event;

          if (event.type === "ExpressionInitiation") {
            const e = event as Extract<CognitionEvent, { type: "ExpressionInitiation" }>;
            if (e.agent?.type === "AI") {
              aiExpressionIds.add(e.expressionId);
            }
          } else if (event.type === "TextUnfolding") {
            const e = event as Extract<CognitionEvent, { type: "TextUnfolding" }>;
            outputText += e.textDelta;
            await ctx.onLog("stdout", e.textDelta);
          } else if (event.type === "IntentInitiation") {
            const e = event as Extract<CognitionEvent, { type: "IntentInitiation" }>;
            expressionsWithIntent.add(e.expressionId);
            await ctx.onLog("stdout", `\n[golem] Tool: ${e.systemId}\n`);
          } else if (event.type === "FulfillmentUnfolding") {
            const e = event as Extract<CognitionEvent, { type: "FulfillmentUnfolding" }>;
            await ctx.onLog("stdout", `[golem] Tool result: ${e.textDelta}\n`);
          } else if (event.type === "ExpressionCulmination") {
            const e = event as Extract<CognitionEvent, { type: "ExpressionCulmination" }>;
            const wasAI = aiExpressionIds.delete(e.expressionId);
            const hadIntent = expressionsWithIntent.delete(e.expressionId);
            if (wasAI && !hadIntent) {
              // Final AI text turn with no tool calls — Golem's loop has exited
              done = true;
              await ctx.onLog("stdout", "\n[golem] Cognition complete\n");
            }
          }
        }
      }
    }

    reader.cancel().catch(() => {});
  } catch (err: unknown) {
    const name = (err as { name?: string }).name;
    if (name === "AbortError" || name === "TimeoutError") {
      timedOut = true;
    } else {
      streamError = err instanceof Error ? err.message : String(err);
    }
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (timedOut) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: true,
      errorMessage: `golem_knowledge: cognition timed out after ${timeoutSec}s`,
      summary: outputText || undefined,
    };
  }

  if (streamError) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `golem_knowledge: SSE stream error: ${streamError}`,
      summary: outputText || undefined,
    };
  }

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    summary: outputText || "(no text output from Golem)",
    provider: "golem_xiv",
    model: "claude-opus-4-6",
  };
}
