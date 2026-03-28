import { useState, useEffect, useRef, useCallback, type KeyboardEvent, type MouseEvent } from "react";
import {
  useHostContext,
  usePluginAction,
  usePluginData,
  usePluginNavigate,
  usePluginStream,
  usePluginToast,
  type PluginPageProps,
  type PluginSidebarProps,
  type PluginSettingsPageProps,
} from "@paperclipai/plugin-sdk/ui";
import { ACTION_KEYS, DATA_KEYS, PLUGIN_ID, SLOT_IDS, STREAM_CHANNELS } from "../constants.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pluginPagePath(companyPrefix: string | null | undefined): string {
  // The page slot declares routePath: "chat", which maps to /:companyPrefix/:pluginRoutePath
  // in the host router. Use the routePath directly under the company prefix.
  return companyPrefix ? `/${companyPrefix}/chat` : `/chat`;
}

// ---------------------------------------------------------------------------
// Internal components
// ---------------------------------------------------------------------------

function MessageBubble({ message }: { message: { role: string; text: string; timestamp: string } }) {
  const isUser = message.role === "user";
  return (
    <div style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start" }}>
      <div
        style={{
          maxWidth: "75%",
          padding: "8px 12px",
          borderRadius: isUser ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
          background: isUser ? "var(--primary)" : "var(--accent)",
          color: isUser ? "var(--primary-foreground)" : "var(--foreground)",
          fontSize: 14,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {message.text}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChatSidebarLink
// ---------------------------------------------------------------------------

export function ChatSidebarLink({ context }: PluginSidebarProps) {
  const navigate = usePluginNavigate();
  const href = pluginPagePath(context.companyPrefix);
  const isActive = typeof window !== "undefined" && window.location.pathname === href;

  function handleClick(e: MouseEvent<HTMLAnchorElement>) {
    e.preventDefault();
    navigate(href);
  }

  return (
    <a
      href={href}
      onClick={handleClick}
      aria-current={isActive ? "page" : undefined}
      className={[
        "flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium transition-colors",
        isActive
          ? "bg-accent text-foreground"
          : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
      ].join(" ")}
    >
      <span className="relative shrink-0">
        <svg
          viewBox="0 0 24 24"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </span>
      <span className="flex-1 truncate">Chat</span>
    </a>
  );
}

// ---------------------------------------------------------------------------
// ChatSidebarPanel
// ---------------------------------------------------------------------------

export function ChatSidebarPanel() {
  const context = useHostContext();
  const companyId = context.companyId ?? "";
  const userId = context.userId ?? "default";

  const history = usePluginData<{ messages: Array<{ role: string; text: string; timestamp: string }>; sessionKey: string }>(
    DATA_KEYS.sessionHistory,
    { companyId, userId, sessionId: "default" },
  );

  const messages = history.data?.messages ?? [];
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const preview = lastAssistant
    ? lastAssistant.text.slice(0, 80) + (lastAssistant.text.length > 80 ? "…" : "")
    : "No messages yet";

  return (
    <div style={{ padding: "8px 12px", fontSize: 12 }}>
      <strong style={{ display: "block", marginBottom: 4 }}>Chat</strong>
      <div style={{ color: "var(--muted-foreground)", marginBottom: 6 }}>{preview}</div>
      <a href={pluginPagePath(context.companyPrefix)} style={{ fontSize: 12 }}>
        Open chat
      </a>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChatPage
// ---------------------------------------------------------------------------

type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
};

export function ChatPage({ context }: PluginPageProps) {
  const companyId = context.companyId ?? "";
  const userId = context.userId ?? "anonymous";

  const [sessionId, setSessionId] = useState("default");
  const [inputText, setInputText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamBuffer, setStreamBuffer] = useState("");
  const [localMessages, setLocalMessages] = useState<ChatMessage[]>([]);

  const scrollRef = useRef<HTMLDivElement>(null);

  const history = usePluginData<{ messages: ChatMessage[] }>(DATA_KEYS.sessionHistory, {
    companyId,
    userId,
    sessionId,
  });

  const configData = usePluginData<{ gatewayUrl?: string; defaultAgentId?: string }>(DATA_KEYS.config, {});

  const sendMessage = usePluginAction(ACTION_KEYS.sendMessage);
  const newSession = usePluginAction(ACTION_KEYS.newSession);
  const toast = usePluginToast();

  const streamChannel = `${STREAM_CHANNELS.chat}:${companyId}:${userId}:${sessionId}`;
  const stream = usePluginStream<{ type: string; text?: string; message?: string }>(streamChannel, { companyId });

  // Sync history into local messages
  useEffect(() => {
    if (history.data?.messages) {
      setLocalMessages(history.data.messages);
    }
  }, [history.data]);

  // Handle stream events
  useEffect(() => {
    const event = stream.lastEvent;
    if (!event) return;
    if (event.type === "token" && event.text) {
      setStreamBuffer((prev) => prev + event.text);
    } else if (event.type === "done") {
      setLocalMessages((prev) => [
        ...prev,
        { role: "assistant", text: streamBuffer + (event.text ?? ""), timestamp: new Date().toISOString() },
      ]);
      setStreamBuffer("");
      setIsStreaming(false);
      history.refresh();
    } else if (event.type === "error") {
      toast({ title: "Chat error", body: event.message ?? "Unknown error", tone: "error" });
      setIsStreaming(false);
      setStreamBuffer("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream.lastEvent]);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [localMessages, streamBuffer]);

  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text || isStreaming) return;

    setLocalMessages((prev) => [...prev, { role: "user", text, timestamp: new Date().toISOString() }]);
    setInputText("");
    setIsStreaming(true);

    try {
      await sendMessage({ companyId, userId, sessionId, text });
    } catch (err) {
      toast({
        title: "Send failed",
        body: err instanceof Error ? err.message : String(err),
        tone: "error",
      });
      setIsStreaming(false);
    }
  }, [inputText, isStreaming, sendMessage, companyId, userId, sessionId, toast]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  const handleNewSession = useCallback(async () => {
    try {
      const result = (await newSession({ companyId, userId })) as { sessionId: string };
      setSessionId(result.sessionId);
      setLocalMessages([]);
      setStreamBuffer("");
      setIsStreaming(false);
    } catch (err) {
      toast({
        title: "Failed to start new session",
        body: err instanceof Error ? err.message : String(err),
        tone: "error",
      });
    }
  }, [newSession, companyId, userId, toast]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", maxWidth: 800, margin: "0 auto" }}>
      {/* Header */}
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Agent Chat</h1>
        <button
          onClick={() => void handleNewSession()}
          style={{
            padding: "6px 12px",
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "var(--background)",
            color: "var(--foreground)",
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          New Session
        </button>
      </div>

      {/* Message list */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "16px",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        {localMessages.map((msg, i) => (
          <MessageBubble key={i} message={msg} />
        ))}
        {isStreaming && streamBuffer && (
          <MessageBubble message={{ role: "assistant", text: streamBuffer + "▊", timestamp: "" }} />
        )}
        {isStreaming && !streamBuffer && (
          <div style={{ color: "var(--muted-foreground)", fontSize: 13 }}>Thinking…</div>
        )}
      </div>

      {/* Input */}
      <div style={{ padding: "12px 16px", borderTop: "1px solid var(--border)" }}>
        <div style={{ display: "flex", gap: 8 }}>
          <textarea
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
            disabled={isStreaming}
            rows={2}
            style={{
              flex: 1,
              resize: "none",
              padding: "8px 12px",
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "var(--background)",
              color: "var(--foreground)",
              fontSize: 14,
            }}
          />
          <button
            onClick={() => void handleSend()}
            disabled={isStreaming || !inputText.trim()}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              background: "var(--primary)",
              color: "var(--primary-foreground)",
              border: "none",
              cursor: isStreaming || !inputText.trim() ? "not-allowed" : "pointer",
              fontWeight: 500,
              opacity: isStreaming || !inputText.trim() ? 0.6 : 1,
            }}
          >
            Send
          </button>
        </div>
        <div style={{ fontSize: 12, color: "var(--muted-foreground)", marginTop: 4 }}>
          {configData.data?.gatewayUrl
            ? `Connected to ${configData.data.gatewayUrl}`
            : "Configure gateway URL in plugin settings"}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChatSettingsPage
// ---------------------------------------------------------------------------

export function ChatSettingsPage(_props: PluginSettingsPageProps) {
  const config = usePluginData<{ gatewayUrl?: string; defaultAgentId?: string }>(DATA_KEYS.config, {});

  return (
    <div style={{ maxWidth: 600, padding: 24 }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 16 }}>Chat Settings</h1>
      <p style={{ fontSize: 14, color: "var(--muted-foreground)", marginBottom: 24 }}>
        These settings are managed via the plugin admin panel. Update them there to change the gateway
        connection.
      </p>

      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>Current Configuration</h2>

        <div>
          <div style={{ fontSize: 12, color: "var(--muted-foreground)", marginBottom: 2 }}>Gateway URL</div>
          <code
            style={{
              fontSize: 13,
              background: "var(--accent)",
              padding: "4px 8px",
              borderRadius: 4,
              display: "block",
            }}
          >
            {config.data?.gatewayUrl ?? "Not configured"}
          </code>
        </div>

        <div>
          <div style={{ fontSize: 12, color: "var(--muted-foreground)", marginBottom: 2 }}>Default Agent ID</div>
          <code
            style={{
              fontSize: 13,
              background: "var(--accent)",
              padding: "4px 8px",
              borderRadius: 4,
              display: "block",
            }}
          >
            {config.data?.defaultAgentId || "(none)"}
          </code>
        </div>
      </div>

      <div
        style={{
          marginTop: 24,
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>Test Connection</h2>
        <p style={{ fontSize: 13, color: "var(--muted-foreground)", margin: 0 }}>
          The plugin will connect to the OpenClaw gateway at:
        </p>
        <code
          style={{
            fontSize: 13,
            background: "var(--accent)",
            padding: "4px 8px",
            borderRadius: 4,
            display: "block",
          }}
        >
          {config.data?.gatewayUrl ?? "ws://127.0.0.1:21007"}
        </code>
        <p style={{ fontSize: 12, color: "var(--muted-foreground)", margin: 0 }}>
          To update this URL, go to the plugin admin panel and edit the instance configuration.
        </p>
      </div>
    </div>
  );
}
