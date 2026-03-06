import { useState, useRef, useEffect } from "react";

// ── Types ───────────────────────────────────────────────────────────────────

interface UserMessage {
  role: "user";
  content: string;
}

interface AssistantMessage {
  role: "assistant";
  content: string;
}

interface ToolCallMessage {
  role: "tool_call";
  method: string;
  path: string;
  body?: unknown;
}

interface ToolResultMessage {
  role: "tool_result";
  content: string;
  isError: boolean;
}

type DisplayMessage =
  | UserMessage
  | AssistantMessage
  | ToolCallMessage
  | ToolResultMessage;

// ── Sub-components ──────────────────────────────────────────────────────────

function Terminal({
  messages,
  isLoading,
}: {
  messages: DisplayMessage[];
  isLoading: boolean;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <div
      style={{
        flex: 1,
        overflowY: "auto",
        padding: "24px 28px",
        display: "flex",
        flexDirection: "column",
        gap: "20px",
        fontFamily:
          "'Berkeley Mono', 'JetBrains Mono', 'Fira Code', monospace",
      }}
    >
      {messages.length === 0 && (
        <div style={{ color: "#4a5568", fontSize: "13px", marginTop: "8px" }}>
          <div
            style={{
              color: "#718096",
              marginBottom: "16px",
              fontSize: "12px",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
            }}
          >
            Paperclip Board Terminal
          </div>
          <div style={{ color: "#a0aec0", lineHeight: 1.8 }}>
            {[
              "→ What companies are running?",
              "→ Show me the status of all agents",
              "→ Create a task: 'Update customer pricing page'",
              "→ Trigger a heartbeat on the CTO agent",
              "→ What's the dashboard look like?",
              "→ Pause the content writer — it's over budget",
            ].map((hint, i) => (
              <div
                key={i}
                style={{ color: i === 0 ? "#718096" : "#4a5568" }}
              >
                {hint}
              </div>
            ))}
          </div>
        </div>
      )}

      {messages.map((msg, i) => (
        <MessageBlock key={i} msg={msg} />
      ))}

      {isLoading && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            color: "#4a5568",
          }}
        >
          <span
            style={{ color: "#e53e3e", fontWeight: 700, fontSize: "11px" }}
          >
            CLIP
          </span>
          <LoadingDots />
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}

function LoadingDots() {
  return (
    <span
      style={{ display: "inline-flex", gap: "3px", alignItems: "center" }}
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: "4px",
            height: "4px",
            borderRadius: "50%",
            background: "#4a5568",
            animation: `pulse 1.2s ease-in-out ${i * 0.2}s infinite`,
          }}
        />
      ))}
      <style>{`@keyframes pulse { 0%,100%{opacity:.3;transform:scale(.8)} 50%{opacity:1;transform:scale(1)} }`}</style>
    </span>
  );
}

function MessageBlock({ msg }: { msg: DisplayMessage }) {
  if (msg.role === "user") {
    return (
      <div
        style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}
      >
        <span
          style={{
            color: "#4299e1",
            fontWeight: 700,
            fontSize: "11px",
            letterSpacing: "0.05em",
            marginTop: "2px",
            minWidth: "32px",
          }}
        >
          YOU
        </span>
        <div
          style={{
            color: "#e2e8f0",
            fontSize: "13px",
            lineHeight: 1.7,
            flex: 1,
          }}
        >
          {msg.content}
        </div>
      </div>
    );
  }

  if (msg.role === "tool_call") {
    return (
      <div
        style={{
          background: "#1a1f2e",
          border: "1px solid #2d3748",
          borderLeft: "2px solid #2b6cb0",
          borderRadius: "4px",
          padding: "10px 14px",
          fontSize: "11px",
          color: "#4a5568",
        }}
      >
        <div
          style={{
            color: "#2b6cb0",
            marginBottom: "4px",
            letterSpacing: "0.08em",
          }}
        >
          ⬡ {msg.method} {msg.path}
        </div>
        {msg.body && (
          <pre
            style={{
              margin: 0,
              color: "#4a5568",
              fontSize: "10px",
              whiteSpace: "pre-wrap",
            }}
          >
            {JSON.stringify(msg.body, null, 2)}
          </pre>
        )}
      </div>
    );
  }

  if (msg.role === "tool_result") {
    const isError = msg.isError;
    return (
      <div
        style={{
          background: "#111318",
          border: `1px solid ${isError ? "#742a2a" : "#1a202c"}`,
          borderRadius: "4px",
          padding: "10px 14px",
          fontSize: "10px",
          color: isError ? "#fc8181" : "#2d3748",
          maxHeight: "160px",
          overflowY: "auto",
        }}
      >
        <div
          style={{
            color: isError ? "#fc8181" : "#2d3748",
            marginBottom: "4px",
            letterSpacing: "0.08em",
          }}
        >
          {isError ? "✗ ERROR" : "✓ RESPONSE"}
        </div>
        <pre
          style={{
            margin: 0,
            color: isError ? "#feb2b2" : "#4a5568",
            whiteSpace: "pre-wrap",
            fontSize: "10px",
          }}
        >
          {msg.content}
        </pre>
      </div>
    );
  }

  // assistant message
  return (
    <div style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
      <span
        style={{
          color: "#e53e3e",
          fontWeight: 700,
          fontSize: "11px",
          letterSpacing: "0.05em",
          marginTop: "2px",
          minWidth: "32px",
        }}
      >
        CLIP
      </span>
      <div
        style={{
          color: "#cbd5e0",
          fontSize: "13px",
          lineHeight: 1.8,
          flex: 1,
        }}
      >
        <RichText text={msg.content} />
      </div>
    </div>
  );
}

function RichText({ text }: { text: string }) {
  if (!text) return null;
  const lines = text.split("\n");
  return (
    <div>
      {lines.map((line, i) => {
        if (line.startsWith("### "))
          return (
            <div
              key={i}
              style={{
                color: "#e2e8f0",
                fontWeight: 700,
                marginTop: "12px",
                marginBottom: "4px",
              }}
            >
              {line.slice(4)}
            </div>
          );
        if (line.startsWith("## "))
          return (
            <div
              key={i}
              style={{
                color: "#e2e8f0",
                fontWeight: 700,
                fontSize: "14px",
                marginTop: "14px",
                marginBottom: "6px",
                borderBottom: "1px solid #2d3748",
                paddingBottom: "4px",
              }}
            >
              {line.slice(3)}
            </div>
          );
        if (line.startsWith("# "))
          return (
            <div
              key={i}
              style={{
                color: "#fff",
                fontWeight: 700,
                fontSize: "15px",
                marginTop: "16px",
                marginBottom: "8px",
              }}
            >
              {line.slice(2)}
            </div>
          );
        if (line.startsWith("- ") || line.startsWith("* "))
          return (
            <div key={i} style={{ paddingLeft: "12px", color: "#a0aec0" }}>
              · {line.slice(2)}
            </div>
          );
        if (line.startsWith("  - "))
          return (
            <div key={i} style={{ paddingLeft: "24px", color: "#718096" }}>
              · {line.slice(4)}
            </div>
          );
        if (/^\d+\./.test(line))
          return (
            <div key={i} style={{ paddingLeft: "12px", color: "#a0aec0" }}>
              {line}
            </div>
          );
        if (line === "") return <div key={i} style={{ height: "6px" }} />;
        const parts = line.split(/(`[^`]+`)/g);
        return (
          <div key={i}>
            {parts.map((part, j) =>
              part.startsWith("`") && part.endsWith("`") ? (
                <code
                  key={j}
                  style={{
                    background: "#1a202c",
                    color: "#68d391",
                    padding: "1px 5px",
                    borderRadius: "3px",
                    fontSize: "11px",
                  }}
                >
                  {part.slice(1, -1)}
                </code>
              ) : (
                <span key={j}>{part}</span>
              ),
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export function BoardTerminal() {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [history, setHistory] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  async function handleSubmit() {
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;
    setInput("");

    const userMsg: DisplayMessage = { role: "user", content: trimmed };
    setMessages((prev) => [...prev, userMsg]);
    const currentHistory = [...history, userMsg];

    setIsLoading(true);
    try {
      const res = await fetch("/api/board/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ message: trimmed, history }),
      });

      const data = await res.json();

      if (!res.ok) {
        const errMsg: DisplayMessage = {
          role: "assistant",
          content: `Error: ${data.error || JSON.stringify(data)}`,
        };
        setMessages((prev) => [...prev, errMsg]);
        return;
      }

      const newMessages: DisplayMessage[] = data.messages ?? [];
      setMessages((prev) => [...prev, ...newMessages]);
      setHistory([...currentHistory, ...newMessages]);
    } catch (err: unknown) {
      const errMsg: DisplayMessage = {
        role: "assistant",
        content: `Connection error: ${err instanceof Error ? err.message : String(err)}`,
      };
      setMessages((prev) => [...prev, errMsg]);
    } finally {
      setIsLoading(false);
      inputRef.current?.focus();
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  return (
    <div
      style={{
        height: "100%",
        background: "#0d0f14",
        display: "flex",
        flexDirection: "column",
        fontFamily:
          "'Berkeley Mono', 'JetBrains Mono', 'Fira Code', monospace",
        color: "#cbd5e0",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "14px 28px",
          borderBottom: "1px solid #1a202c",
          background: "#0a0c10",
        }}
      >
        <div
          style={{ display: "flex", alignItems: "center", gap: "12px" }}
        >
          <div
            style={{
              width: "8px",
              height: "8px",
              borderRadius: "50%",
              background: "#e53e3e",
              boxShadow: "0 0 6px #e53e3e",
            }}
          />
          <span
            style={{
              color: "#e2e8f0",
              fontWeight: 700,
              fontSize: "13px",
              letterSpacing: "0.1em",
            }}
          >
            PAPERCLIP
          </span>
          <span style={{ color: "#2d3748", fontSize: "11px" }}>
            board terminal
          </span>
        </div>
      </div>

      {/* Messages */}
      <Terminal messages={messages} isLoading={isLoading} />

      {/* Input */}
      <div
        style={{
          borderTop: "1px solid #1a202c",
          padding: "16px 28px",
          background: "#0a0c10",
          display: "flex",
          gap: "12px",
          alignItems: "flex-end",
        }}
      >
        <div style={{ flex: 1, position: "relative" }}>
          <span
            style={{
              position: "absolute",
              left: "12px",
              top: "50%",
              transform: "translateY(-50%)",
              color: "#4299e1",
              fontSize: "12px",
              fontWeight: 700,
              pointerEvents: "none",
            }}
          >
            ›
          </span>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about your Paperclip instance..."
            rows={1}
            style={{
              width: "100%",
              background: "#111318",
              border: "1px solid #1e2533",
              borderRadius: "4px",
              color: "#e2e8f0",
              fontSize: "13px",
              padding: "10px 12px 10px 28px",
              resize: "none",
              outline: "none",
              fontFamily: "inherit",
              boxSizing: "border-box",
              lineHeight: 1.5,
            }}
          />
        </div>
        <button
          onClick={handleSubmit}
          disabled={isLoading || !input.trim()}
          style={{
            background: isLoading || !input.trim() ? "#1a202c" : "#e53e3e",
            border: "none",
            borderRadius: "4px",
            color: isLoading || !input.trim() ? "#2d3748" : "#fff",
            fontSize: "11px",
            fontWeight: 700,
            letterSpacing: "0.1em",
            padding: "10px 16px",
            cursor:
              isLoading || !input.trim() ? "default" : "pointer",
            transition: "background 0.15s",
            fontFamily: "inherit",
          }}
        >
          RUN
        </button>
      </div>
    </div>
  );
}
