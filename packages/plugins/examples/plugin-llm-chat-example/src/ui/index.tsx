import type { PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";
import { usePluginData, usePluginAction, usePluginStream } from "@paperclipai/plugin-sdk/ui";
import { useState, useRef, useEffect } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ModelInfo {
  id: string;
  label: string;
}

interface ProviderInfo {
  id: string;
  label: string;
  models: ModelInfo[];
}

interface ProvidersData {
  providers: ProviderInfo[];
}

/** A single message in the chat history. */
interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** Events pushed by the worker through the "llm-chat" SSE channel. */
interface ChatStreamEvent {
  type: "chunk" | "done" | "error" | "close";
  content?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// LlmChatWidget
// ---------------------------------------------------------------------------

/**
 * Dashboard widget that demonstrates ctx.llm: provider/model selection,
 * multi-turn chat with session continuity, and real-time streaming via SSE.
 */
export function LlmChatWidget({ context }: PluginWidgetProps) {
  const companyId = context.companyId;

  // Load the list of LLM providers and their models from the worker.
  const { data: providersData, loading: providersLoading } =
    usePluginData<ProvidersData>("llm.providers", {});

  const providers = providersData?.providers ?? [];
  const [selectedProvider, setSelectedProvider] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>("");

  // Populate defaults once providers are loaded.
  const initializedRef = useRef(false);
  useEffect(() => {
    if (initializedRef.current || providers.length === 0) return;
    initializedRef.current = true;
    const first = providers[0];
    if (!first) return;
    setSelectedProvider(first.id);
    setSelectedModel(first.models[0]?.id ?? "");
  }, [providers]);

  // Update model selection when the provider changes.
  const handleProviderChange = (providerId: string) => {
    setSelectedProvider(providerId);
    const provider = providers.find((p) => p.id === providerId);
    setSelectedModel(provider?.models[0]?.id ?? "");
  };

  const currentProvider = providers.find((p) => p.id === selectedProvider);
  const models = currentProvider?.models ?? [];

  // Chat state.
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [streamingContent, setStreamingContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sendMessage = usePluginAction("llm.chat.send");
  const closeSession = usePluginAction("llm.chat.close");

  // Subscribe to SSE stream for real-time chunk display.
  const { events: streamEvents } = usePluginStream<ChatStreamEvent>("llm-chat", companyId ? { companyId } : undefined);

  // Track the last processed stream event index to avoid replaying old events.
  const lastEventIdxRef = useRef(0);

  useEffect(() => {
    const newEvents = streamEvents.slice(lastEventIdxRef.current);
    if (newEvents.length === 0) return;
    lastEventIdxRef.current = streamEvents.length;

    for (const event of newEvents) {
      if (event.type === "chunk" && event.content) {
        setStreamingContent((prev) => (prev ?? "") + event.content);
      } else if (event.type === "done") {
        // The send() action result will finalise the message; streaming content
        // is cleared once the action promise resolves.
      } else if (event.type === "error" && event.error) {
        setError(event.error);
      }
    }
  }, [streamEvents]);

  const scrollAnchorRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent]);

  async function handleSend() {
    const text = input.trim();
    if (!text || isSending || !selectedProvider || !selectedModel) return;

    setInput("");
    setError(null);
    setStreamingContent(null);
    setIsSending(true);

    // Optimistically add the user message.
    setMessages((prev) => [...prev, { role: "user", content: text }]);

    try {
      const result = (await sendMessage({
        companyId,
        adapterType: selectedProvider,
        model: selectedModel,
        message: text,
        sessionId: sessionId ?? undefined,
      })) as { sessionId: string; content: string };

      setSessionId(result.sessionId);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: result.content || streamingContent || "" },
      ]);
      setStreamingContent(null);
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : typeof err === "object" && err !== null && "message" in err
            ? String((err as { message: unknown }).message)
            : String(err);
      setError(msg);
      setStreamingContent(null);
    } finally {
      setIsSending(false);
    }
  }

  async function handleReset() {
    if (sessionId && companyId) {
      try {
        await closeSession({ companyId, sessionId });
      } catch {
        // Ignore close errors on reset — the session may already be closed.
      }
    }
    setSessionId(null);
    setMessages([]);
    setStreamingContent(null);
    setError(null);
    setInput("");
    lastEventIdxRef.current = 0;
  }

  const canSend = !isSending && !!input.trim() && !!selectedProvider && !!selectedModel;

  return (
    <section aria-label="LLM Chat widget" className="flex flex-col gap-3">
      {/* Provider / model selectors */}
      <div className="flex flex-wrap items-center gap-2">
        {providersLoading ? (
          <span className="text-sm text-muted-foreground">Loading providers…</span>
        ) : providers.length === 0 ? (
          <span className="text-sm text-muted-foreground">
            No LLM providers available. Enable a provider that supports direct LLM sessions.
          </span>
        ) : (
          <>
            <select
              aria-label="Provider"
              className="rounded-md border border-input bg-background px-2 py-1 text-sm"
              value={selectedProvider}
              onChange={(e) => handleProviderChange(e.target.value)}
              disabled={isSending}
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>

            {models.length > 0 && (
              <select
                aria-label="Model"
                className="rounded-md border border-input bg-background px-2 py-1 text-sm"
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                disabled={isSending}
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            )}

            {messages.length > 0 && (
              <button
                type="button"
                className="ml-auto rounded-md border border-input bg-background px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent"
                onClick={() => void handleReset()}
                disabled={isSending}
              >
                New conversation
              </button>
            )}
          </>
        )}
      </div>

      {/* Chat history */}
      {(messages.length > 0 || streamingContent !== null || isSending) && (
        <div className="flex max-h-80 flex-col gap-2 overflow-y-auto rounded-lg border border-border bg-card p-3 text-sm">
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[80%] rounded-lg px-3 py-2 ${
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-foreground"
                }`}
              >
                <p className="whitespace-pre-wrap break-words">{msg.content}</p>
              </div>
            </div>
          ))}

          {/* Streaming assistant response */}
          {streamingContent !== null && (
            <div className="flex justify-start">
              <div className="max-w-[80%] rounded-lg bg-muted px-3 py-2 text-foreground">
                <p className="whitespace-pre-wrap break-words">{streamingContent}</p>
                <span className="mt-1 inline-block h-3 w-1 animate-pulse bg-foreground/50" />
              </div>
            </div>
          )}

          {/* Waiting for first chunk — typing indicator */}
          {isSending && streamingContent === null && (
            <div className="flex justify-start">
              <div className="flex items-center gap-1 rounded-lg bg-muted px-3 py-2">
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-foreground/50 [animation-delay:-0.3s]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-foreground/50 [animation-delay:-0.15s]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-foreground/50" />
              </div>
            </div>
          )}

          <div ref={scrollAnchorRef} />
        </div>
      )}

      {/* Error display */}
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {/* Message input */}
      <div className="flex gap-2">
        <input
          type="text"
          aria-label="Message"
          placeholder={providers.length === 0 ? "No providers available" : "Type a message…"}
          className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
          disabled={isSending || providers.length === 0}
        />
        <button
          type="button"
          className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => void handleSend()}
          disabled={!canSend}
        >
          {isSending ? "…" : "Send"}
        </button>
      </div>

      {sessionId && (
        <p className="text-xs text-muted-foreground">
          Session: <code>{sessionId.slice(0, 8)}…</code>
        </p>
      )}
    </section>
  );
}
