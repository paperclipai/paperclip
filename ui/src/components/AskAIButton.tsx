import { useState, useRef, useEffect, useCallback } from "react";
import { useLocation } from "@/lib/router";
import { cn } from "../lib/utils";
import { Input } from "@/components/ui/input";
import { Bot, Send, X, Trash2 } from "lucide-react";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

function getPageContext(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  const meaningful = segments.length > 1 ? segments.slice(1) : segments;
  if (meaningful.length === 0) return "Dashboard";
  const page = meaningful[0];
  const pageMap: Record<string, string> = {
    dashboard: "War Room",
    issues: "Issues",
    goals: "Goals",
    agents: "Agents",
    projects: "Projects",
    routines: "Routines",
    playbooks: "Playbooks",
    costs: "Costs",
    activity: "Activity",
    knowledge: "Knowledge Base",
    library: "Library",
    org: "Org Chart",
    inbox: "Inbox",
    settings: "Settings",
    performance: "Agent Performance",
    deliverables: "Deliverables",
    channels: "Channels",
    "board-briefing": "Board Briefing",
    hiring: "Hiring",
  };
  return pageMap[page] ?? page.charAt(0).toUpperCase() + page.slice(1);
}

function generateMockResponse(pageContext: string, userMessage: string): string {
  const lowerMsg = userMessage.toLowerCase();
  if (lowerMsg.includes("help") || lowerMsg.includes("what can")) {
    return `I can help you with the ${pageContext} page. Here are some things I can assist with:\n\n- Explain what you see on this page\n- Help you take actions\n- Answer questions about your data\n- Suggest next steps\n\nWhat would you like to know?`;
  }
  if (lowerMsg.includes("create") || lowerMsg.includes("add") || lowerMsg.includes("new")) {
    return `To create something new on the ${pageContext} page, look for the "+" or "New" button in the top area. I can walk you through the process if you need guidance.`;
  }
  if (lowerMsg.includes("filter") || lowerMsg.includes("search") || lowerMsg.includes("find")) {
    return `You can use the search and filter controls at the top of the ${pageContext} page to narrow down results. Try the search field or use Cmd+K for quick access.`;
  }
  return `I can help you with ${pageContext}. Based on your question, here are some suggestions:\n\n1. Check the current page for relevant actions\n2. Use the sidebar to navigate to related sections\n3. Try the search (Cmd+K) for quick access\n\nWould you like more specific help?`;
}

/** Header bar trigger button - renders inline in the header */
export function AskAIHeaderButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
      title="Chat with Iris"
    >
      <Bot className="h-3.5 w-3.5" />
      <span className="hidden sm:inline">Iris</span>
    </button>
  );
}

/** The chat panel that drops down from the header */
export function AskAIPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const pageContext = getPageContext(location.pathname);

  // Focus input when panel opens
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 100);
  }, [open]);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Welcome message
  useEffect(() => {
    if (open && messages.length === 0) {
      setMessages([{
        id: "welcome",
        role: "assistant",
        content: `Hi, I'm Iris. I can help you with the ${pageContext} page. What would you like to know?`,
      }]);
    }
  }, [open, pageContext, messages.length]);

  // Click outside to close
  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
      onClose();
    }
  }, [onClose]);

  useEffect(() => {
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [open, handleClickOutside]);

  // Escape to close
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  function handleSend() {
    const trimmed = input.trim();
    if (!trimmed) return;
    setMessages((prev) => [...prev, { id: `user-${Date.now()}`, role: "user", content: trimmed }]);
    setInput("");
    setIsTyping(true);
    setTimeout(() => {
      setMessages((prev) => [...prev, {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: generateMockResponse(pageContext, trimmed),
      }]);
      setIsTyping(false);
    }, 800 + Math.random() * 500);
  }

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      className={cn(
        "fixed right-4 top-14 z-[100]",
        "w-80 sm:w-96 h-[28rem]",
        "rounded-xl border border-border bg-card shadow-2xl",
        "flex flex-col overflow-hidden",
        "animate-in fade-in slide-in-from-top-2 duration-200",
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-border bg-muted/30">
        <div className="flex items-center gap-2 min-w-0">
          <Bot className="h-4 w-4 text-primary shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-semibold">Iris</div>
            <div className="text-[10px] text-muted-foreground truncate">Context: {pageContext}</div>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {messages.length > 1 && (
            <button onClick={() => setMessages([])} className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors" title="Clear chat">
              <Trash2 className="h-3 w-3" />
            </button>
          )}
          <button onClick={onClose} className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors" title="Close">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.map((msg) => (
          <div key={msg.id} className={cn("flex", msg.role === "user" ? "justify-end" : "justify-start")}>
            <div className={cn(
              "max-w-[85%] rounded-lg px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap",
              msg.role === "user"
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-foreground",
            )}>
              {msg.content}
            </div>
          </div>
        ))}
        {isTyping && (
          <div className="flex justify-start">
            <div className="bg-muted rounded-lg px-3 py-2 text-xs text-muted-foreground">
              <span className="inline-flex gap-0.5">
                <span className="animate-bounce" style={{ animationDelay: "0ms" }}>.</span>
                <span className="animate-bounce" style={{ animationDelay: "150ms" }}>.</span>
                <span className="animate-bounce" style={{ animationDelay: "300ms" }}>.</span>
              </span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-border p-2 flex gap-2">
        <Input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
          placeholder="Ask anything..."
          className="h-8 text-xs"
        />
        <button
          onClick={handleSend}
          disabled={!input.trim() || isTyping}
          className="shrink-0 w-8 h-8 flex items-center justify-center rounded-md bg-primary text-primary-foreground disabled:opacity-50 transition-opacity"
        >
          <Send className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

/** Legacy export for backward compatibility - no longer renders floating button */
export function AskAIButton() {
  return null;
}
