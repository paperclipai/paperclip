import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { logger } from "../middleware/logger.js";
import type { AnthropicToolSpec } from "./chat-tools.js";

// Canonical (Anthropic-shape) content blocks. Both providers translate
// to/from this so storage and the rest of the system stay provider-agnostic.
//
// `image` and `file` blocks are produced when the user attaches media in the
// composer. `attachmentId` is the row in `chat_attachments` (so we can
// re-resolve bytes on demand for provider replays); `url` is the in-app
// download path used by the UI to display the attachment.
export type CanonicalContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  | {
      type: "image";
      attachmentId: string;
      url: string;
      mediaType: string;
      name: string;
    }
  | {
      type: "file";
      attachmentId: string;
      url: string;
      mediaType: string;
      name: string;
      sizeBytes: number;
    };

export type CanonicalMessage =
  | { role: "user"; content: CanonicalContentBlock[] | string }
  | { role: "assistant"; content: CanonicalContentBlock[] | string };

export type EffortLevel = "auto" | "low" | "medium" | "high";

/**
 * Resolved bytes for an attachment, keyed by attachmentId. The chat
 * orchestrator pre-loads everything referenced in the message history so
 * providers can splice base64 inline without touching disk during the
 * stream.
 */
export interface ResolvedAttachment {
  data: Buffer;
  mediaType: string;
  name: string;
}
export type ResolvedAttachments = Map<string, ResolvedAttachment>;

export type ProviderTurnInput = {
  model: string;
  system: string;
  messages: CanonicalMessage[];
  tools?: AnthropicToolSpec[];
  /**
   * "auto" leaves the provider's defaults alone. low/medium/high enable
   * provider-native reasoning controls where supported (Anthropic
   * `thinking`, OpenAI `reasoning_effort`); other providers ignore.
   */
  effort?: EffortLevel;
  /**
   * Cancels the in-flight request — both the network call and any
   * provider-side token generation. Wired to the runTurn abort flag so the
   * Stop button actually stops billing, not just the UI.
   */
  signal?: AbortSignal;
  /**
   * Pre-resolved bytes for canonical `image` / `file` blocks referenced in
   * `messages`. Providers that send media inline read from this map; ones
   * that can't use it gracefully fall back to a text mention.
   */
  resolvedAttachments?: ResolvedAttachments;
  /**
   * Adapter-specific extras populated when the chat is routed through an
   * AdapterExecuteProvider. Native providers ignore this field.
   */
  adapterContext?: AdapterTurnContext;
};

export interface AdapterTurnContext {
  sessionId: string;
  companyId: string | null;
  boardUserId: string;
  /** Returned by the adapter on the previous turn; null on first turn. */
  prevSessionParams: Record<string, unknown> | null;
  /** Persist updated sessionParams (or null to clear) for the next turn. */
  saveSessionParams: (params: Record<string, unknown> | null) => Promise<void>;
}

export type ProviderStreamEvent =
  | { type: "text_delta"; delta: string };

export type ProviderTurnResult = {
  content: CanonicalContentBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop" | "other";
};

export interface ChatProvider {
  name: "anthropic" | "openai" | "ollama" | "gemini" | "adapter";
  isConfigured(): boolean;
  supportsModel(model: string): boolean;
  defaultModel(): string;
  listModels(): string[] | Promise<string[]>;
  streamTurn(input: ProviderTurnInput): AsyncGenerator<ProviderStreamEvent, ProviderTurnResult, void>;
}

const ANTHROPIC_MODELS = [
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
];

const OPENAI_MODELS = ["gpt-5", "gpt-4.1", "gpt-4o", "gpt-4o-mini", "o4-mini"];

const MAX_TOKENS = 4096;

// ---------- Anthropic ----------

class AnthropicProvider implements ChatProvider {
  name = "anthropic" as const;

  isConfigured() {
    return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
  }
  supportsModel(model: string) {
    return model.startsWith("claude-");
  }
  defaultModel() {
    return process.env.PAPERCLIP_CHAT_DEFAULT_MODEL?.startsWith("claude-")
      ? process.env.PAPERCLIP_CHAT_DEFAULT_MODEL
      : "claude-opus-4-7";
  }
  listModels() {
    return ANTHROPIC_MODELS;
  }

  async *streamTurn(input: ProviderTurnInput): AsyncGenerator<ProviderStreamEvent, ProviderTurnResult, void> {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "" });
    // Map effort → extended thinking budget. Budget must be >=1024 and
    // strictly less than max_tokens, so we bump max_tokens to fit.
    const thinking = anthropicThinkingFor(input.effort);
    const maxTokens = thinking ? thinking.budget_tokens + MAX_TOKENS : MAX_TOKENS;
    const params: Anthropic.MessageCreateParamsStreaming = {
      model: input.model,
      max_tokens: maxTokens,
      system: input.system,
      messages: input.messages.map((m) => ({
        role: m.role,
        content: typeof m.content === "string"
          ? m.content
          : translateBlocksForAnthropic(m.content, input.resolvedAttachments),
      })),
      stream: true,
    };
    if (thinking) params.thinking = thinking;
    if (input.tools && input.tools.length > 0) {
      params.tools = input.tools as Anthropic.Tool[];
    }

    const stream = client.messages.stream(params, { signal: input.signal ?? null });
    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta" &&
        typeof event.delta.text === "string"
      ) {
        yield { type: "text_delta", delta: event.delta.text };
      }
    }
    const finalMessage = await stream.finalMessage();
    return {
      content: finalMessage.content.map((b): CanonicalContentBlock => {
        if (b.type === "text") return { type: "text", text: b.text };
        if (b.type === "tool_use") return { type: "tool_use", id: b.id, name: b.name, input: b.input };
        // thinking, etc. — skip by mapping to empty text
        return { type: "text", text: "" };
      }).filter((b) => !(b.type === "text" && b.text === "")),
      stopReason: mapAnthropicStopReason(finalMessage.stop_reason),
    };
  }
}

function translateBlocksForAnthropic(
  blocks: CanonicalContentBlock[],
  resolved: ResolvedAttachments | undefined,
): Anthropic.ContentBlockParam[] {
  const out: Anthropic.ContentBlockParam[] = [];
  for (const b of blocks) {
    if (b.type === "image") {
      const r = resolved?.get(b.attachmentId);
      if (r && /^image\/(png|jpeg|jpg|gif|webp)$/.test(r.mediaType)) {
        const mediaType = r.mediaType === "image/jpg" ? "image/jpeg" : r.mediaType;
        out.push({
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
            data: r.data.toString("base64"),
          },
        });
      } else {
        // Couldn't resolve / unsupported image type — describe it instead so
        // the model at least knows it was attached.
        out.push({ type: "text", text: `[Attached image: ${b.name}]` });
      }
      continue;
    }
    if (b.type === "file") {
      const r = resolved?.get(b.attachmentId);
      if (r && r.mediaType === "application/pdf") {
        out.push({
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: r.data.toString("base64"),
          },
        });
      } else if (r && r.mediaType.startsWith("text/")) {
        // Text files inline — Claude reads text directly anyway.
        out.push({
          type: "text",
          text: `Attached file ${b.name}:\n\n${r.data.toString("utf8").slice(0, 200_000)}`,
        });
      } else {
        out.push({
          type: "text",
          text: `[Attached file: ${b.name} (${b.mediaType}, ${formatBytes(b.sizeBytes)})]`,
        });
      }
      continue;
    }
    // text, tool_use, tool_result already match Anthropic shape.
    out.push(b as unknown as Anthropic.ContentBlockParam);
  }
  return out;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function anthropicThinkingFor(effort: EffortLevel | undefined): Anthropic.ThinkingConfigEnabled | null {
  switch (effort) {
    case "low":
      return { type: "enabled", budget_tokens: 1024 };
    case "medium":
      return { type: "enabled", budget_tokens: 4096 };
    case "high":
      return { type: "enabled", budget_tokens: 16384 };
    default:
      return null;
  }
}

function mapAnthropicStopReason(reason: Anthropic.Message["stop_reason"]): ProviderTurnResult["stopReason"] {
  if (reason === "end_turn") return "end_turn";
  if (reason === "tool_use") return "tool_use";
  if (reason === "max_tokens") return "max_tokens";
  if (reason === "stop_sequence") return "stop";
  return "other";
}

// ---------- OpenAI ----------

class OpenAIProvider implements ChatProvider {
  name = "openai" as const;

  isConfigured() {
    return Boolean(process.env.OPENAI_API_KEY?.trim());
  }
  supportsModel(model: string) {
    return model.startsWith("gpt-") || model.startsWith("o");
  }
  defaultModel() {
    if (process.env.PAPERCLIP_CHAT_DEFAULT_MODEL?.startsWith("gpt-")) {
      return process.env.PAPERCLIP_CHAT_DEFAULT_MODEL;
    }
    return "gpt-4.1";
  }
  listModels() {
    return OPENAI_MODELS;
  }

  async *streamTurn(input: ProviderTurnInput): AsyncGenerator<ProviderStreamEvent, ProviderTurnResult, void> {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? "" });

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: input.system },
    ];
    for (const m of input.messages) {
      if (typeof m.content === "string") {
        messages.push({ role: m.role, content: m.content } as OpenAI.Chat.ChatCompletionMessageParam);
        continue;
      }
      if (m.role === "user") {
        // user-shaped content can have either text blocks or tool_result blocks (our convention for tool replies)
        const toolResultBlocks = m.content.filter(
          (b): b is Extract<CanonicalContentBlock, { type: "tool_result" }> => b.type === "tool_result",
        );
        const textBlocks = m.content.filter(
          (b): b is Extract<CanonicalContentBlock, { type: "text" }> => b.type === "text",
        );
        const imageBlocks = m.content.filter(
          (b): b is Extract<CanonicalContentBlock, { type: "image" }> => b.type === "image",
        );
        const fileBlocks = m.content.filter(
          (b): b is Extract<CanonicalContentBlock, { type: "file" }> => b.type === "file",
        );
        if (toolResultBlocks.length > 0) {
          for (const tr of toolResultBlocks) {
            messages.push({
              role: "tool",
              tool_call_id: tr.tool_use_id,
              content: tr.content,
            });
          }
        }
        if (textBlocks.length > 0 || imageBlocks.length > 0 || fileBlocks.length > 0) {
          messages.push({
            role: "user",
            content: buildOpenAIUserContent(
              textBlocks,
              imageBlocks,
              fileBlocks,
              input.resolvedAttachments,
            ),
          });
        }
      } else {
        // assistant: text + tool_use blocks
        const text = m.content
          .filter((b): b is Extract<CanonicalContentBlock, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("");
        const toolUses = m.content.filter(
          (b): b is Extract<CanonicalContentBlock, { type: "tool_use" }> => b.type === "tool_use",
        );
        const assistantMsg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
          role: "assistant",
          content: text || null,
        };
        if (toolUses.length > 0) {
          assistantMsg.tool_calls = toolUses.map((t) => ({
            id: t.id,
            type: "function" as const,
            function: {
              name: t.name,
              arguments: JSON.stringify(t.input ?? {}),
            },
          }));
        }
        messages.push(assistantMsg);
      }
    }

    const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
      model: input.model,
      max_tokens: MAX_TOKENS,
      messages,
      stream: true,
    };
    // reasoning_effort is only honored by reasoning-capable models
    // (o-series, gpt-5). For others OpenAI rejects the param, so we gate it.
    const reasoningEffort = openaiReasoningEffortFor(input.effort, input.model);
    if (reasoningEffort) params.reasoning_effort = reasoningEffort;
    if (input.tools && input.tools.length > 0) {
      params.tools = input.tools.map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      }));
    }

    let textBuf = "";
    const toolCallAccum = new Map<
      number,
      { id: string; name: string; argsBuf: string }
    >();
    let finishReason: string | null = null;

    const stream = await client.chat.completions.create(params, { signal: input.signal ?? null });
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === "string" && delta.content.length > 0) {
        textBuf += delta.content;
        yield { type: "text_delta", delta: delta.content };
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const existing = toolCallAccum.get(idx) ?? {
            id: tc.id ?? `call_${idx}`,
            name: tc.function?.name ?? "",
            argsBuf: "",
          };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name = tc.function.name;
          if (tc.function?.arguments) existing.argsBuf += tc.function.arguments;
          toolCallAccum.set(idx, existing);
        }
      }
      if (chunk.choices[0]?.finish_reason) {
        finishReason = chunk.choices[0].finish_reason;
      }
    }

    const blocks: CanonicalContentBlock[] = [];
    if (textBuf.length > 0) blocks.push({ type: "text", text: textBuf });
    for (const tc of toolCallAccum.values()) {
      let parsed: unknown = {};
      try {
        parsed = tc.argsBuf ? JSON.parse(tc.argsBuf) : {};
      } catch (err) {
        logger.warn({ err, name: tc.name }, "OpenAI tool arguments JSON parse failed; passing raw");
        parsed = { _raw: tc.argsBuf };
      }
      blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: parsed });
    }

    return {
      content: blocks,
      stopReason: mapOpenAiStopReason(finishReason),
    };
  }
}

function mapOpenAiStopReason(reason: string | null): ProviderTurnResult["stopReason"] {
  if (reason === "stop") return "end_turn";
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  return "other";
}

function buildOpenAIUserContent(
  textBlocks: Array<Extract<CanonicalContentBlock, { type: "text" }>>,
  imageBlocks: Array<Extract<CanonicalContentBlock, { type: "image" }>>,
  fileBlocks: Array<Extract<CanonicalContentBlock, { type: "file" }>>,
  resolved: ResolvedAttachments | undefined,
): string | OpenAI.Chat.ChatCompletionContentPart[] {
  const parts: OpenAI.Chat.ChatCompletionContentPart[] = [];
  const text = textBlocks.map((t) => t.text).join("\n").trim();
  if (text.length > 0) parts.push({ type: "text", text });
  for (const f of fileBlocks) {
    const r = resolved?.get(f.attachmentId);
    if (r && r.mediaType.startsWith("text/")) {
      parts.push({
        type: "text",
        text: `Attached file ${f.name}:\n\n${r.data.toString("utf8").slice(0, 200_000)}`,
      });
    } else {
      parts.push({ type: "text", text: `[Attached file: ${f.name} (${f.mediaType})]` });
    }
  }
  for (const img of imageBlocks) {
    const r = resolved?.get(img.attachmentId);
    if (r) {
      parts.push({
        type: "image_url",
        image_url: { url: `data:${r.mediaType};base64,${r.data.toString("base64")}` },
      });
    } else {
      parts.push({ type: "text", text: `[Attached image: ${img.name}]` });
    }
  }
  // OpenAI accepts string OR array — collapse to plain text when there's no
  // media so older non-vision models work too.
  if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
  if (parts.length === 0) return "";
  return parts;
}

function openaiReasoningEffortFor(
  effort: EffortLevel | undefined,
  model: string,
): "low" | "medium" | "high" | null {
  if (!effort || effort === "auto") return null;
  // o-series (o1, o3, o4, ...) and gpt-5 support reasoning_effort. Older
  // gpt-4.x models reject the parameter.
  const isReasoning = /^o[1-9]/.test(model) || model.startsWith("gpt-5");
  if (!isReasoning) return null;
  return effort;
}

// ---------- Ollama (local) ----------

class OllamaProvider implements ChatProvider {
  name = "ollama" as const;

  baseUrl(): string {
    return (process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434").replace(/\/$/, "");
  }

  // Ollama is local and free. Treat it as configured if explicitly opted out
  // is NOT set — we'll discover at request time whether it's actually reachable
  // and surface a clear error if not.
  isConfigured(): boolean {
    if (process.env.PAPERCLIP_OLLAMA_DISABLED?.trim()) return false;
    return true;
  }

  supportsModel(model: string): boolean {
    return model.startsWith("ollama:") || /^(llama|qwen|phi|mistral|mixtral|gemma|deepseek|codestral|yi)/i.test(model);
  }

  defaultModel(): string {
    return process.env.PAPERCLIP_CHAT_DEFAULT_MODEL?.startsWith("ollama:")
      ? process.env.PAPERCLIP_CHAT_DEFAULT_MODEL.slice("ollama:".length)
      : "llama3.2";
  }

  async listModels(): Promise<string[]> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const res = await fetch(`${this.baseUrl()}/api/tags`, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return [];
      const body = (await res.json()) as { models?: Array<{ name?: string }> };
      return (body.models ?? []).map((m) => m.name ?? "").filter(Boolean);
    } catch {
      // Ollama not reachable — return empty so it's a no-op rather than blocking.
      return [];
    }
  }

  async *streamTurn(input: ProviderTurnInput): AsyncGenerator<ProviderStreamEvent, ProviderTurnResult, void> {
    const messages: Array<{ role: string; content: string; tool_calls?: unknown }> = [
      { role: "system", content: input.system },
    ];
    for (const m of input.messages) {
      if (typeof m.content === "string") {
        messages.push({ role: m.role, content: m.content });
        continue;
      }
      if (m.role === "user") {
        const textParts: string[] = [];
        const images: string[] = [];
        for (const b of m.content) {
          if (b.type === "text" && b.text) textParts.push(b.text);
          if (b.type === "image") {
            const r = input.resolvedAttachments?.get(b.attachmentId);
            if (r) images.push(r.data.toString("base64"));
            else textParts.push(`[Attached image: ${b.name}]`);
          }
          if (b.type === "file") {
            const r = input.resolvedAttachments?.get(b.attachmentId);
            if (r && r.mediaType.startsWith("text/")) {
              textParts.push(`Attached file ${b.name}:\n\n${r.data.toString("utf8").slice(0, 200_000)}`);
            } else {
              textParts.push(`[Attached file: ${b.name} (${b.mediaType})]`);
            }
          }
        }
        const text = textParts.join("\n");
        if (text || images.length > 0) {
          const userMsg: { role: string; content: string; images?: string[] } = {
            role: "user",
            content: text,
          };
          if (images.length > 0) userMsg.images = images;
          messages.push(userMsg);
        }
        for (const b of m.content) {
          if (b.type === "tool_result") {
            messages.push({
              role: "tool",
              content: typeof b.content === "string" ? b.content : JSON.stringify(b.content),
            });
          }
        }
      } else {
        const text = m.content
          .filter((b): b is Extract<CanonicalContentBlock, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("");
        messages.push({ role: "assistant", content: text });
      }
    }

    const modelId = input.model.startsWith("ollama:") ? input.model.slice("ollama:".length) : input.model;
    const body: Record<string, unknown> = {
      model: modelId,
      messages,
      stream: true,
    };
    if (input.tools && input.tools.length > 0) {
      body.tools = input.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      }));
    }

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl()}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: input.signal,
      });
    } catch (err) {
      throw new Error(
        `Ollama is not reachable at ${this.baseUrl()}. Set OLLAMA_HOST or start Ollama. Underlying: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`Ollama responded ${res.status}: ${text || "(no body)"}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let textBuf = "";
    const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];
    let stopReason: ProviderTurnResult["stopReason"] = "end_turn";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let chunk: {
          message?: { content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> };
          done?: boolean;
          done_reason?: string;
        };
        try {
          chunk = JSON.parse(line);
        } catch {
          continue;
        }
        const content = chunk.message?.content;
        if (typeof content === "string" && content.length > 0) {
          textBuf += content;
          yield { type: "text_delta", delta: content };
        }
        if (chunk.message?.tool_calls) {
          for (const tc of chunk.message.tool_calls) {
            const args = tc.function?.arguments;
            const parsed: unknown =
              typeof args === "string"
                ? (() => {
                    try {
                      return JSON.parse(args);
                    } catch {
                      return { _raw: args };
                    }
                  })()
                : args ?? {};
            toolCalls.push({
              id: tc.id ?? `call_${toolCalls.length}`,
              name: tc.function?.name ?? "",
              input: parsed,
            });
          }
        }
        if (chunk.done) {
          if (toolCalls.length > 0) stopReason = "tool_use";
          else if (chunk.done_reason === "length") stopReason = "max_tokens";
        }
      }
    }

    const blocks: CanonicalContentBlock[] = [];
    if (textBuf.length > 0) blocks.push({ type: "text", text: textBuf });
    for (const tc of toolCalls) {
      blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
    }
    return { content: blocks, stopReason };
  }
}

// ---------- Gemini (Google AI Studio) ----------

class GeminiProvider implements ChatProvider {
  name = "gemini" as const;

  apiKey(): string {
    return process.env.GEMINI_API_KEY?.trim() ?? process.env.GOOGLE_API_KEY?.trim() ?? "";
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey());
  }

  supportsModel(model: string): boolean {
    return model.startsWith("gemini-") || model.startsWith("models/gemini-");
  }

  defaultModel(): string {
    return process.env.PAPERCLIP_CHAT_DEFAULT_MODEL?.startsWith("gemini-")
      ? process.env.PAPERCLIP_CHAT_DEFAULT_MODEL
      : "gemini-2.0-flash";
  }

  listModels(): string[] {
    return ["gemini-2.0-flash", "gemini-2.0-pro", "gemini-1.5-pro", "gemini-1.5-flash"];
  }

  async *streamTurn(input: ProviderTurnInput): AsyncGenerator<ProviderStreamEvent, ProviderTurnResult, void> {
    const modelId = input.model.startsWith("models/") ? input.model.slice("models/".length) : input.model;

    type GeminiPart =
      | { text: string }
      | { functionCall: { name: string; args: unknown } }
      | { functionResponse: { name: string; response: unknown } }
      | { inlineData: { mimeType: string; data: string } };
    type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

    const contents: GeminiContent[] = [];
    for (const m of input.messages) {
      if (typeof m.content === "string") {
        contents.push({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] });
        continue;
      }
      if (m.role === "user") {
        const parts: GeminiPart[] = [];
        for (const b of m.content) {
          if (b.type === "text" && b.text) parts.push({ text: b.text });
          if (b.type === "tool_result") {
            parts.push({
              functionResponse: {
                name: b.tool_use_id,
                response: { content: b.content },
              },
            });
          }
          if (b.type === "image" || b.type === "file") {
            const r = input.resolvedAttachments?.get(b.attachmentId);
            if (r) {
              parts.push({
                inlineData: { mimeType: r.mediaType, data: r.data.toString("base64") },
              });
            } else {
              parts.push({
                text: b.type === "image" ? `[Attached image: ${b.name}]` : `[Attached file: ${b.name}]`,
              });
            }
          }
        }
        if (parts.length > 0) contents.push({ role: "user", parts });
      } else {
        const parts: GeminiPart[] = [];
        for (const b of m.content) {
          if (b.type === "text" && b.text) parts.push({ text: b.text });
          if (b.type === "tool_use") {
            parts.push({ functionCall: { name: b.name, args: b.input ?? {} } });
          }
        }
        if (parts.length > 0) contents.push({ role: "model", parts });
      }
    }

    const body: Record<string, unknown> = {
      contents,
      systemInstruction: { role: "system", parts: [{ text: input.system }] },
    };
    if (input.tools && input.tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: input.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
          })),
        },
      ];
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:streamGenerateContent?alt=sse&key=${this.apiKey()}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: input.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`Gemini responded ${res.status}: ${text || "(no body)"}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let textBuf = "";
    const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];
    let stopReason: ProviderTurnResult["stopReason"] = "end_turn";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        let dataLine: string | null = null;
        for (const line of block.split("\n")) {
          if (line.startsWith("data:")) dataLine = (dataLine ?? "") + line.slice(5).trimStart();
        }
        if (!dataLine || dataLine === "[DONE]") continue;
        let chunk: {
          candidates?: Array<{
            content?: { parts?: GeminiPart[] };
            finishReason?: string;
          }>;
        };
        try {
          chunk = JSON.parse(dataLine);
        } catch {
          continue;
        }
        const candidate = chunk.candidates?.[0];
        for (const part of candidate?.content?.parts ?? []) {
          if ("text" in part && typeof part.text === "string" && part.text.length > 0) {
            textBuf += part.text;
            yield { type: "text_delta", delta: part.text };
          }
          if ("functionCall" in part) {
            toolCalls.push({
              id: `gemini_call_${toolCalls.length}`,
              name: part.functionCall.name,
              input: part.functionCall.args ?? {},
            });
          }
        }
        if (candidate?.finishReason) {
          if (toolCalls.length > 0 || candidate.finishReason === "TOOL_CALLS") stopReason = "tool_use";
          else if (candidate.finishReason === "MAX_TOKENS") stopReason = "max_tokens";
        }
      }
    }

    const blocks: CanonicalContentBlock[] = [];
    if (textBuf.length > 0) blocks.push({ type: "text", text: textBuf });
    for (const tc of toolCalls) {
      blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
    }
    return { content: blocks, stopReason };
  }
}

// ---------- Adapter-execute (CLI-authenticated adapters) ----------
//
// Routes a chat turn through `ServerAdapterModule.execute()` instead of a
// native HTTP/SDK call. This is what makes Claude Pro auth via the
// claude_local adapter work in Clippy without an ANTHROPIC_API_KEY:
// the adapter shells out to the locally-authenticated CLI and we stream its
// stdout back into Clippy as text deltas.
//
// Models routed this way are encoded as `adapter:<adapterType>:<modelId>`
// so a single registry entry handles all installed adapters generically.

const ADAPTER_PREFIX = "adapter:";

export interface AdapterRoutingDecoded {
  adapterType: string;
  modelId: string;
}

export function decodeAdapterModel(model: string): AdapterRoutingDecoded | null {
  if (!model.startsWith(ADAPTER_PREFIX)) return null;
  const rest = model.slice(ADAPTER_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0) return null;
  const adapterType = rest.slice(0, sep);
  const modelId = rest.slice(sep + 1);
  if (!adapterType || !modelId) return null;
  return { adapterType, modelId };
}

export function encodeAdapterModel(adapterType: string, modelId: string): string {
  return `${ADAPTER_PREFIX}${adapterType}:${modelId}`;
}

class AdapterExecuteProvider implements ChatProvider {
  name = "adapter" as const;

  isConfigured(): boolean {
    // True as long as at least one adapter is registered. The per-call
    // streamTurn() will fail-clean if the specific adapter type can't be
    // found at request time.
    return true;
  }

  supportsModel(model: string): boolean {
    return decodeAdapterModel(model) !== null;
  }

  defaultModel(): string {
    return "";
  }

  listModels(): string[] {
    // The discovery layer below enumerates adapter models directly. Returning
    // [] here keeps this provider out of the static native model list.
    return [];
  }

  async *streamTurn(
    input: ProviderTurnInput,
  ): AsyncGenerator<ProviderStreamEvent, ProviderTurnResult, void> {
    const decoded = decodeAdapterModel(input.model);
    if (!decoded) {
      throw new Error(`AdapterExecuteProvider got non-adapter model id "${input.model}"`);
    }
    const ctx = input.adapterContext;
    if (!ctx) {
      throw new Error("AdapterExecuteProvider requires adapterContext to be passed in");
    }

    const { findActiveServerAdapter } = await import("../adapters/registry.js");
    const adapter = findActiveServerAdapter(decoded.adapterType);
    if (!adapter) {
      throw new Error(
        `Adapter "${decoded.adapterType}" is not registered. Install or enable it under /instance/settings/adapters.`,
      );
    }

    // Latest user message is the new prompt; older history was provided to the
    // adapter on prior turns and re-anchored via sessionParams resume.
    const lastUserMsg = [...input.messages].reverse().find((m) => m.role === "user");
    const userPrompt = lastUserMsg
      ? typeof lastUserMsg.content === "string"
        ? lastUserMsg.content
        : lastUserMsg.content
            .map((b) => {
              if (b.type === "text") return b.text;
              if (b.type === "image") return `[Attached image: ${b.name}]`;
              if (b.type === "file") return `[Attached file: ${b.name} (${b.mediaType})]`;
              return "";
            })
            .filter(Boolean)
            .join("\n")
      : "";

    const cwd = await ensureClippyWorkspace(ctx.sessionId);

    // Streaming bridge: adapter.execute() is a Promise; onLog fires during
    // execution. Push parsed text into a queue and yield from the generator.
    const queue: ProviderStreamEvent[] = [];
    let resolveNext: (() => void) | null = null;
    const wake = () => {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r();
      }
    };
    const enqueue = (ev: ProviderStreamEvent) => {
      queue.push(ev);
      wake();
    };

    let stdoutBuf = "";
    let accumulatedText = "";
    let executeDone = false;
    let executeError: unknown = null;

    const emitText = (text: string) => {
      if (!text) return;
      accumulatedText += text;
      enqueue({ type: "text_delta", delta: text });
    };

    const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
      if (stream !== "stdout") return;
      stdoutBuf += chunk;

      if (decoded.adapterType === "claude_local") {
        // claude-local emits one JSON event per line; extract assistant text
        // incrementally. Buffer partial lines until newline arrives.
        let nl;
        while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
          const line = stdoutBuf.slice(0, nl).trim();
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (!line) continue;
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (event.type !== "assistant") continue;
          const message = event.message as
            | { content?: Array<{ type?: string; text?: string }> }
            | undefined;
          for (const block of message?.content ?? []) {
            if (block?.type === "text" && typeof block.text === "string" && block.text.length > 0) {
              emitText(block.text);
            }
          }
        }
      } else {
        // Generic fallback: stream raw stdout. Many adapters print human-readable
        // text; some print structured output we don't yet parse. The user sees
        // the raw stream until per-adapter parsers are added.
        if (chunk) emitText(chunk);
      }
    };

    // Synthesize a minimal AdapterExecutionContext. We use the session's
    // companyId so company-scoped adapter operations (secrets, runtime state,
    // budget) resolve to a real company; agent.id is synthetic since Clippy
    // is not a real registered agent.
    const executePromise = (async () => {
      const runId = randomId();
      const config: Record<string, unknown> = {
        model: decoded.modelId,
        // claude-local-specific defaults; harmless for other adapters since
        // they read what they understand and ignore the rest.
        promptTemplate: "",
        dangerouslySkipPermissions: true,
        maxTurnsPerRun: 0,
      };
      const adapterContext: Record<string, unknown> = {
        paperclipTaskMarkdown: userPrompt,
        clippy: true,
      };
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await adapter.execute({
          runId,
          agent: {
            id: `clippy-${ctx.sessionId}`,
            companyId: ctx.companyId ?? "",
            name: "Clippy",
            adapterType: decoded.adapterType,
            adapterConfig: config,
          },
          runtime: {
            sessionId: ctx.prevSessionParams
              ? (ctx.prevSessionParams.sessionId as string | undefined) ?? null
              : null,
            sessionParams: ctx.prevSessionParams,
            sessionDisplayId: null,
            taskKey: `clippy:${ctx.sessionId}`,
          },
          config,
          context: adapterContext,
          onLog,
        } as Parameters<typeof adapter.execute>[0]);
        return result;
      } catch (err) {
        executeError = err;
        throw err;
      } finally {
        executeDone = true;
        wake();
      }
    })();
    void cwd; // reserved for future per-turn cwd injection into adapter config

    // Drain queue until execute() resolves — or the caller aborts. We can't
    // reach inside adapter.execute() to terminate the underlying CLI, but
    // we stop yielding events so the SSE consumer winds down immediately.
    const onAbort = () => wake();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      while (true) {
        if (input.signal?.aborted) break;
        if (queue.length > 0) {
          yield queue.shift()!;
        } else if (executeDone) {
          break;
        } else {
          await new Promise<void>((res) => {
            resolveNext = res;
          });
        }
      }
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
    }

    if (executeError) {
      const message = executeError instanceof Error ? executeError.message : String(executeError);
      throw new Error(`Adapter "${decoded.adapterType}" execute() failed: ${message}`);
    }

    const result = await executePromise;
    // Persist sessionParams for next-turn continuity. Adapters that don't
    // produce sessionParams just clear (null) — also fine.
    await ctx.saveSessionParams(result.sessionParams ?? null);

    // The chat orchestrator persists the returned content blocks as the
    // assistant message; we accumulated the streamed text as it arrived so
    // the persisted message is reconstructable on reload.
    const content: CanonicalContentBlock[] = [];
    if (accumulatedText) content.push({ type: "text", text: accumulatedText });
    return { content, stopReason: "end_turn" };
  }
}

async function ensureClippyWorkspace(sessionId: string): Promise<string> {
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { promises: fs } = await import("node:fs");
  const dir = path.join(os.homedir(), ".paperclip", "clippy-workspaces", sessionId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Best-effort delete of the per-session adapter workspace created by
 * {@link ensureClippyWorkspace}. Called when a chat session is deleted so
 * we don't leak directories under `~/.paperclip/clippy-workspaces/`.
 */
export async function removeClippyWorkspace(sessionId: string): Promise<void> {
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { promises: fs } = await import("node:fs");
  const dir = path.join(os.homedir(), ".paperclip", "clippy-workspaces", sessionId);
  await fs.rm(dir, { recursive: true, force: true });
}

function randomId(): string {
  // RFC4122 v4 lite — adequate for short-lived adapter run identifiers.
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------- Registry ----------

const PROVIDERS: ChatProvider[] = [
  new AnthropicProvider(),
  new OpenAIProvider(),
  new OllamaProvider(),
  new GeminiProvider(),
  new AdapterExecuteProvider(),
];

export function getProviderForModel(model: string): ChatProvider | null {
  return PROVIDERS.find((p) => p.supportsModel(model)) ?? null;
}

export function listConfiguredProviders(): ChatProvider[] {
  return PROVIDERS.filter((p) => p.isConfigured());
}

export async function listAvailableModels(): Promise<{ provider: string; model: string; source?: string }[]> {
  const out: { provider: string; model: string; source?: string }[] = [];
  for (const p of PROVIDERS) {
    if (!p.isConfigured()) continue;
    if (p.name === "adapter") continue; // enumerated separately below
    const models = await p.listModels();
    for (const m of models) out.push({ provider: p.name, model: m });
  }

  // Surface adapter-discovered models. For each adapter we add an
  // `adapter:<type>:<modelId>` entry that routes through AdapterExecuteProvider
  // (using the adapter's own auth/CLI). When the same model id also exists in
  // a configured native provider (e.g. claude-opus-4-7 on both Anthropic SDK
  // and claude_local adapter), both entries are shown so the user can pick
  // their auth path.
  try {
    const { listEnabledServerAdapters, listAdapterModels } = await import("../adapters/registry.js");
    const adapters = listEnabledServerAdapters();
    const seen = new Set(out.map((m) => `${m.provider}:${m.model}`));
    for (const adapter of adapters) {
      let adapterModels: { id: string; label: string }[] = [];
      try {
        adapterModels = await listAdapterModels(adapter.type);
      } catch (err) {
        logger.warn({ err, adapterType: adapter.type }, "listAdapterModels failed");
        continue;
      }
      for (const m of adapterModels) {
        const encoded = encodeAdapterModel(adapter.type, m.id);
        const key = `adapter:${encoded}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ provider: "adapter", model: encoded, source: adapter.type });
      }
    }
  } catch (err) {
    logger.warn({ err }, "failed to enrich model list with adapter-discovered models");
  }
  return out;
}

export function resolveDefaultModel(): { provider: ChatProvider; model: string } | null {
  const requested = process.env.PAPERCLIP_CHAT_DEFAULT_MODEL?.trim();
  if (requested) {
    const p = getProviderForModel(requested);
    if (p?.isConfigured()) return { provider: p, model: requested };
  }
  // Prefer Anthropic, then OpenAI
  for (const p of PROVIDERS) {
    if (p.isConfigured()) return { provider: p, model: p.defaultModel() };
  }
  return null;
}

/**
 * Picks the best model from everything currently available — including
 * adapter-routed entries. Used to seed `chat_sessions.model` so a fresh
 * Clippy session picks something the user will actually want by default
 * instead of the hardcoded `claude-opus-4-7` (which requires
 * ANTHROPIC_API_KEY).
 *
 * Scoring is **model-family-first**: a Claude model wins regardless of how
 * it's routed, because operators almost always prefer Claude when it's
 * available. Routing is a tiebreaker — among same-family models, prefer
 * the path that doesn't need a separate API key (adapter-routed
 * claude_local for Claude Pro users, etc.).
 */
export async function pickBestDefaultModel(): Promise<string> {
  const explicit = process.env.PAPERCLIP_CHAT_DEFAULT_MODEL?.trim();
  if (explicit) {
    const p = getProviderForModel(explicit);
    if (p?.isConfigured()) return explicit;
  }
  const models = await listAvailableModels();
  if (models.length === 0) return "claude-opus-4-7";

  function score(m: { provider: string; model: string; source?: string }): number {
    let s = 0;
    const lower = m.model.toLowerCase();

    // (1) Model family — the dominant signal. A Claude Opus available
    // anywhere should beat a llama via Aider hands down.
    if (lower.includes("claude") && lower.includes("opus")) s += 200;
    else if (lower.includes("claude") && lower.includes("sonnet")) s += 180;
    else if (lower.includes("claude")) s += 160; // any other claude (haiku, etc.)
    else if (lower.includes("gpt-5")) s += 140;
    else if (lower.includes("gpt-4")) s += 120;
    else if (lower.includes("o4") || lower.includes("o3")) s += 110;
    else if (lower.includes("gemini-2")) s += 90;
    else if (lower.includes("gemini")) s += 80;
    else if (lower.includes("qwen") && lower.includes("coder")) s += 60;
    else if (lower.includes("llama")) s += 50;
    else if (lower.includes("deepseek") || lower.includes("mistral") || lower.includes("qwen")) s += 45;
    else s += 20;

    // (2) Routing — tiebreaker among same-family models. CLI-authenticated
    // adapter routing wins (no API key needed); then native SDKs.
    const isAdapter = m.provider === "adapter";
    if (isAdapter && m.source === "claude_local") s += 6;
    else if (isAdapter && m.source === "codex_local") s += 5;
    else if (isAdapter && m.source === "gemini_local") s += 4;
    else if (m.provider === "anthropic") s += 3;
    else if (isAdapter) s += 2;
    else if (m.provider === "openai") s += 2;
    else if (m.provider === "ollama") s += 1;
    else if (m.provider === "gemini") s += 1;

    return s;
  }

  return [...models].sort((a, b) => score(b) - score(a))[0].model;
}
