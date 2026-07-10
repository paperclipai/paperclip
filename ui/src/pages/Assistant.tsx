import { useEffect, useRef, useState } from "react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { streamAssistantChat, type AssistantMessage } from "../api/assistant";
import { MarkdownBody } from "../components/MarkdownBody";
import { ThinkingCursor } from "../components/ThinkingCursor";
import { EmptyState } from "../components/EmptyState";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";
import { MessageSquare, Send } from "lucide-react";

// CEO / portfolio Assistant — a direct-Anthropic streaming chat. Advisory only:
// it reads the company's live control-plane state and answers questions about it.
export function Assistant() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Assistant" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, streaming]);

  useEffect(() => () => abortRef.current?.abort(), []);

  async function send() {
    const text = draft.trim();
    if (!text || streaming || !selectedCompanyId) return;

    const outgoing: AssistantMessage[] = [...messages, { role: "user", content: text }];
    setMessages([...outgoing, { role: "assistant", content: "" }]);
    setDraft("");
    setError(null);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamAssistantChat(selectedCompanyId, outgoing, {
        signal: controller.signal,
        onDelta: (delta) => {
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === "assistant") next[next.length - 1] = { ...last, content: last.content + delta };
            return next;
          });
        },
      });
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : "The assistant failed to respond.");
        // Drop the empty assistant placeholder if nothing streamed.
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          return last?.role === "assistant" && last.content === "" ? prev.slice(0, -1) : prev;
        });
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Don't submit on the Enter that confirms an IME composition (CJK, etc.).
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div className="flex h-full flex-col px-4 py-4 sm:px-6 sm:py-6">
      <header className="mb-4 shrink-0">
        <div className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground/60">Company</div>
        <h1 className="font-serif text-2xl tracking-tight text-foreground">Assistant</h1>
        <p className="mt-0.5 text-[12px] text-muted-foreground">
          Ask about spend, agents, or issue flow. Reads live state — advisory only, it doesn't take actions.
        </p>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        {messages.length === 0 && (
          <EmptyState
            icon={MessageSquare}
            message="Ask about spend, agents, or issue flow — e.g. “How are we tracking against budget this month?” or “Which agents are idle and what's blocked?”"
          />
        )}
        {messages.map((m, i) => {
          // While the last assistant turn is still streaming, render plain text so we
          // don't re-parse the whole growing markdown string on every token; swap to
          // the full Markdown renderer once it settles.
          const isStreamingLast = streaming && i === messages.length - 1;
          return (
            <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
              <div
                className={cn(
                  "max-w-[85%] rounded-[3px] border px-3 py-2 text-[13px] leading-relaxed",
                  m.role === "user"
                    ? "border-primary/30 bg-primary/10 text-foreground"
                    : "border-border bg-card/40 text-foreground",
                )}
              >
                {m.role === "assistant" ? (
                  m.content ? (
                    isStreamingLast ? (
                      <span className="whitespace-pre-wrap">{m.content}</span>
                    ) : (
                      <MarkdownBody>{m.content}</MarkdownBody>
                    )
                  ) : (
                    <ThinkingCursor />
                  )
                ) : (
                  <span className="whitespace-pre-wrap">{m.content}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {error && (
        <div className="mt-3 shrink-0 rounded-[3px] border border-status-error/40 bg-status-error/10 px-3 py-2 text-[12px] text-status-error">
          {error}
        </div>
      )}

      <div className="mt-3 flex shrink-0 items-end gap-2 border-t border-border pt-3">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder="Ask the assistant…"
          disabled={streaming || !selectedCompanyId}
          className="min-h-[44px] flex-1 resize-none rounded-[3px] border border-border bg-background px-3 py-2 text-[13px] text-foreground outline-none focus:border-primary/60 disabled:opacity-50"
        />
        <Button onClick={() => void send()} disabled={streaming || !draft.trim() || !selectedCompanyId} size="sm">
          <Send className="h-3.5 w-3.5" /> Send
        </Button>
      </div>
    </div>
  );
}
