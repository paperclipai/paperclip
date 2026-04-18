import { useState } from "react";
import { cn } from "@/lib/utils";

export interface ChatMessage {
  id: string;
  author: string;
  isAgent: boolean;
  body: string;
  timestamp: string;
}

interface IssueChatThreadProps {
  messages: ChatMessage[];
}

export function IssueChatThread({ messages }: IssueChatThreadProps) {
  const [newMessage, setNewMessage] = useState("");

  return (
    <div>
      {/* Message thread */}
      <div className="flex flex-col gap-4">
        {messages.map((message) => (
          <div
            key={message.id}
            className="rounded-lg border p-4"
            style={{ background: "var(--card-bg)", borderColor: "var(--card-border)" }}
          >
            <div className="mb-2 flex items-center gap-2">
              <div
                className={cn("flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold")}
                style={{
                  background: message.isAgent ? "var(--accent-subtle)" : "var(--bg-muted)",
                  color: message.isAgent ? "var(--accent)" : "var(--fg-muted)",
                }}
              >
                {message.author[0]}
              </div>
              <span className="text-[13px] font-medium">{message.author}</span>
              {message.isAgent && (
                <span
                  className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                  style={{ background: "var(--accent-subtle)", color: "var(--accent)" }}
                >
                  Agent
                </span>
              )}
              <span className="text-[11px]" style={{ color: "var(--fg-muted)" }}>
                {message.timestamp}
              </span>
            </div>
            <p className="text-sm leading-relaxed" style={{ color: "var(--fg-secondary)" }}>
              {message.body}
            </p>
          </div>
        ))}
      </div>

      {/* Input */}
      <div
        className="mt-4 rounded-lg border p-3"
        style={{ background: "var(--input-bg)", borderColor: "var(--input-border)" }}
      >
        <textarea
          value={newMessage}
          onChange={(e) => setNewMessage(e.target.value)}
          placeholder="Send a message..."
          rows={3}
          className="w-full resize-none border-none bg-transparent text-sm outline-none"
          style={{ color: "var(--fg)", fontFamily: "var(--font-body)" }}
        />
        <div className="flex justify-end pt-2">
          <button
            disabled={!newMessage.trim()}
            className="rounded-md px-4 py-1.5 text-[13px] font-medium disabled:opacity-40"
            style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
