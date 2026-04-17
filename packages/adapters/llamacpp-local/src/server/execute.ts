import { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  buildConversationContext,
  createInMemorySessionStore,
  ConversationTurn,
} from "@paperclipai/adapter-utils/conversation-history";
import {
  compressPrompt,
  formatCaveman,
} from "@paperclipai/adapter-utils/compression";
import {
  buildToolSchemas,
  buildLlamaToolSchema,
} from "@paperclipai/adapter-utils/tool-schema";

const sessionStore = createInMemorySessionStore();

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const {
    runId,
    agent,
    config,
    context,
    onLog,
  } = ctx;

  const model = asString(config.model, "qwen3.5-9b-q4");
  const llamacppUrl = asString(config.llamacppUrl, "http://localhost:8000");
  const contextLimit = asNumber(config.contextLimit, 8192);
  const sessionId = context.sessionId || runId;

  // Step 1: Load or create session
  let conversation = await sessionStore.loadSession(sessionId);
  if (!conversation) {
    conversation = {
      sessionId,
      turns: [],
      totalTokens: 0,
      contextLimit,
    };
  }

  // Step 2: Build compressed prompt
  const compressedPrompt = compressPrompt(buildPrompt(ctx));

  // Step 3: Compress output style (caveman)
  const compressionLevel = asString(config.compressionLevel, "full");

  // Step 4: Build tool definitions
  const tools = config.tools !== false
    ? buildLlamaToolSchema(buildToolSchemas(context.tools ?? []))
    : [];

  // Step 5: Call llama.cpp API
  const startTime = Date.now();

  try {
    const response = await fetch(`${llamacppUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          ...conversation.turns.map(t => ({
            role: t.role,
            content: t.content,
          })),
          { role: "user", content: compressedPrompt },
        ],
        tools: tools.length > 0 ? tools : undefined,
        tool_choice: tools.length > 0 ? "auto" : undefined,
        temperature: asNumber(config.temperature, 0.7),
        top_p: asNumber(config.topP, 0.9),
        max_tokens: 2048,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`llama.cpp API error: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    const responseText = result.choices?.[0]?.message?.content ?? "";
    const toolCalls = result.choices?.[0]?.message?.tool_calls ?? [];

    // Step 6: Apply caveman formatting to output
    const formattedOutput = formatCaveman(responseText, {
      intensity: compressionLevel as any,
      preserveCodeBlocks: true,
      preserveJsonOutput: true,
    });

    // Step 7: Save conversation turn
    const userTurn: ConversationTurn = {
      role: "user",
      content: compressedPrompt,
      tokens: Math.ceil(compressedPrompt.length / 4), // Rough estimation
      timestamp: startTime,
    };

    const assistantTurn: ConversationTurn = {
      role: "assistant",
      content: formattedOutput,
      tokens: Math.ceil(formattedOutput.length / 4),
      timestamp: Date.now(),
    };

    conversation.turns.push(userTurn);
    conversation.turns.push(assistantTurn);

    // Trim if over context limit
    const trimmed = buildConversationContext(sessionId, conversation.turns, contextLimit);
    conversation = trimmed;

    // Save updated session
    await sessionStore.saveSession(sessionId, conversation);

    // Step 8: Return result
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      usage: {
        inputTokens: Math.ceil(compressedPrompt.length / 4),
        cachedInputTokens: 0,
        outputTokens: Math.ceil(formattedOutput.length / 4),
      },
      sessionId,
      provider: "local",
      biller: "free",
      model,
      billingType: "free",
      costUsd: 0,
      summary: formattedOutput,
    };

  } catch (error) {
    await onLog("stderr", `Error calling llama.cpp: ${error}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `llama.cpp server error: ${error instanceof Error ? error.message : String(error)}`,
      errorCode: null,
    };
  }
}

function buildPrompt(ctx: AdapterExecutionContext): string {
  // Build compressed prompt using caveman rules
  // (Reuse logic from Phase 1)
  return "";
}

// Helper functions
function asString(value: unknown, defaultValue: string): string {
  return typeof value === 'string' ? value : defaultValue;
}

function asNumber(value: unknown, defaultValue: number): number {
  return typeof value === 'number' ? value : defaultValue;
}