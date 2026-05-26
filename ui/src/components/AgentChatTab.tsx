import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Send, Trash2, ChevronDown, ImagePlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

interface PendingImage {
  mediaType: string; // image/png | image/jpeg | image/webp | image/gif
  data: string; // base64, no data: prefix
  preview: string; // data: URL for thumbnail
}

const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB

// Read a File into a base64 PendingImage (or null if unsupported / too large).
function fileToPendingImage(file: File): Promise<PendingImage | null> {
  return new Promise((resolve) => {
    if (!ALLOWED_IMAGE_TYPES.includes(file.type) || file.size > MAX_IMAGE_BYTES) {
      resolve(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result); // data:<mime>;base64,<data>
      const comma = result.indexOf(",");
      resolve(comma < 0 ? null : { mediaType: file.type, data: result.slice(comma + 1), preview: result });
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

interface AgentChatTabProps {
  agentId: string;
  agentName?: string;
}

function UserBubble({ msg }: { msg: ChatMessage }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[75%] rounded-2xl rounded-tr-sm bg-primary px-4 py-2.5 text-primary-foreground text-sm whitespace-pre-wrap leading-relaxed">
        {msg.content}
      </div>
    </div>
  );
}

function AssistantBubble({ content, streaming }: { content: string; streaming?: boolean }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] rounded-2xl rounded-tl-sm border border-border bg-card px-4 py-2.5 text-sm">
        {content ? (
          <div className="prose prose-sm dark:prose-invert max-w-none leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            {streaming && <span className="animate-pulse ml-0.5 inline-block w-2 h-3 bg-current align-middle opacity-60" />}
          </div>
        ) : (
          <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="inline-block h-1.5 w-1.5 rounded-full bg-current animate-bounce"
                style={{ animationDelay: `${i * 150}ms` }}
              />
            ))}
            <span className="ml-1">Thinking…</span>
          </span>
        )}
      </div>
    </div>
  );
}

export function AgentChatTab({ agentId, agentName }: AgentChatTabProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [toolCall, setToolCall] = useState<string | null>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const atBottomRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    const converted = (await Promise.all(list.map(fileToPendingImage))).filter(
      (im): im is PendingImage => im !== null,
    );
    if (converted.length) setPendingImages((prev) => [...prev, ...converted].slice(0, MAX_IMAGES));
  }, []);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
      if (files.length) { e.preventDefault(); void addFiles(files); }
    },
    [addFiles],
  );

  // Load history on mount
  useEffect(() => {
    fetch(`/api/agents/${encodeURIComponent(agentId)}/chat/messages`)
      .then((r) => r.json())
      .then((d: { messages: ChatMessage[] }) => setMessages(d.messages ?? []))
      .catch(() => {});
  }, [agentId]);

  // Scroll to bottom when messages change
  useEffect(() => {
    if (atBottomRef.current) {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [messages, streamText, streaming]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 48;
    setShowScrollBtn(!atBottomRef.current);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) { el.scrollTop = el.scrollHeight; atBottomRef.current = true; setShowScrollBtn(false); }
  }, []);

  const clearHistory = useCallback(() => {
    fetch(`/api/agents/${encodeURIComponent(agentId)}/chat/messages`, { method: "DELETE" })
      .then(() => setMessages([]))
      .catch(() => {});
  }, [agentId]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if ((!text && pendingImages.length === 0) || streaming) return;
    const imgs = pendingImages;
    setInput("");
    setPendingImages([]);
    setStreaming(true);
    setStreamText("");
    setToolCall(null);
    atBottomRef.current = true;

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const resp = await fetch(`/api/agents/${encodeURIComponent(agentId)}/chat/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          images: imgs.map(({ mediaType, data }) => ({ mediaType, data })),
        }),
        signal: abort.signal,
      });

      if (!resp.body) throw new Error("no body");

      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";

        for (const part of parts) {
          const lines = part.trim().split("\n");
          let ev = "", data = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) ev = line.slice(7).trim();
            if (line.startsWith("data: ")) data = line.slice(6);
          }
          if (!ev || !data) continue;
          try {
            const payload = JSON.parse(data);
            if (ev === "user_message") {
              setMessages((prev) => [...prev, payload as ChatMessage]);
            } else if (ev === "delta") {
              setStreamText((t) => t + (payload.text ?? ""));
            } else if (ev === "tool_call") {
              setToolCall(payload.command ?? payload.name ?? "…");
            } else if (ev === "assistant_message") {
              setStreamText("");
              setToolCall(null);
              setMessages((prev) => [...prev, payload as ChatMessage]);
              setStreaming(false);
            } else if (ev === "error") {
              setStreamText("");
              setMessages((prev) => [
                ...prev,
                { id: `${Date.now()}-err`, role: "assistant", content: `⚠ ${payload.message}`, timestamp: Date.now() },
              ]);
              setStreaming(false);
            }
          } catch { /* malformed */ }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setStreamText("");
        setMessages((prev) => [
          ...prev,
          { id: `${Date.now()}-err`, role: "assistant", content: "⚠ Connection failed. Try again.", timestamp: Date.now() },
        ]);
      }
      setStreaming(false);
    }

    abortRef.current = null;
    setStreaming(false);
    inputRef.current?.focus();
  }, [agentId, input, streaming, pendingImages]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    },
    [sendMessage],
  );

  const isEmpty = messages.length === 0 && !streaming;

  return (
    <div className="flex flex-col" style={{ height: "calc(100vh - 260px)", minHeight: "420px" }}>
      {/* Header */}
      <div className="flex items-center justify-between pb-2 border-b border-border mb-2">
        <span className="text-xs text-muted-foreground">
          Chat with <span className="font-medium text-foreground">{agentName ?? "agent"}</span>
          <span className="ml-2 text-[10px] font-mono text-muted-foreground/50">claude-sonnet-4-6</span>
        </span>
        <Button variant="ghost" size="sm" onClick={clearHistory} disabled={streaming || isEmpty}
          className="h-6 px-2 text-xs gap-1 text-muted-foreground hover:text-foreground">
          <Trash2 className="h-3 w-3" /> Clear
        </Button>
      </div>

      {/* Messages */}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto space-y-3 pr-1">
        {isEmpty ? (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            Send a message to start chatting
          </div>
        ) : (
          <>
            {messages.map((msg) =>
              msg.role === "user"
                ? <UserBubble key={msg.id} msg={msg} />
                : <AssistantBubble key={msg.id} content={msg.content} />
            )}
            {streaming && (
              <>
                <AssistantBubble content={streamText} streaming />
                {toolCall && !streamText && (
                  <div className="flex justify-start">
                    <div className="max-w-[85%] rounded-2xl rounded-tl-sm border border-border bg-card px-4 py-2 text-xs font-mono text-muted-foreground flex items-center gap-2">
                      <span className="animate-pulse">⚙</span>
                      <span className="truncate max-w-[400px]">{toolCall}</span>
                    </div>
                  </div>
                )}
              </>
            )}
          </>
        )}
        <div style={{ height: 4 }} />
      </div>

      {/* Scroll button */}
      {showScrollBtn && (
        <div className="flex justify-center py-1">
          <Button variant="outline" size="sm" onClick={scrollToBottom} className="h-6 gap-1 text-xs">
            <ChevronDown className="h-3 w-3" /> Latest
          </Button>
        </div>
      )}

      {/* Input */}
      <div className="pt-2 border-t border-border mt-2">
        {pendingImages.length > 0 && (
          <div className="flex flex-wrap gap-2 pb-2">
            {pendingImages.map((img, i) => (
              <div key={i} className="relative h-14 w-14 overflow-hidden rounded-md border border-border">
                <img src={img.preview} alt="attachment" className="h-full w-full object-cover" />
                <button
                  type="button"
                  onClick={() => setPendingImages((prev) => prev.filter((_, j) => j !== i))}
                  className="absolute right-0 top-0 rounded-bl bg-background/80 p-0.5 text-muted-foreground hover:text-foreground"
                  aria-label="Remove image"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            className="hidden"
            onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ""; }}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={streaming || pendingImages.length >= MAX_IMAGES}
            className="self-end h-9 w-9 shrink-0 p-0"
            title="Attach image"
          >
            <ImagePlus className="h-4 w-4" />
          </Button>
          <Textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={streaming ? "Agent is responding…" : "Message agent… (paste or attach images · Enter to send)"}
            className="min-h-[60px] max-h-[180px] resize-none text-sm"
            disabled={streaming}
          />
          <Button onClick={sendMessage} disabled={(!input.trim() && pendingImages.length === 0) || streaming}
            size="sm" className="self-end h-9 w-9 p-0 shrink-0">
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
