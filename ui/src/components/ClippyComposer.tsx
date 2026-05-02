import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Send, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { chatApi, type ChatMode, type EffortLevel, type PermissionMode } from "../api/chat";

interface Props {
  mode: ChatMode;
  permissionMode: PermissionMode;
  effort: EffortLevel;
  model: string;
  streaming: boolean;
  onSend: (text: string) => void;
  onAbort: () => void;
  onPatch: (patch: {
    mode?: ChatMode;
    permissionMode?: PermissionMode;
    effort?: EffortLevel;
    model?: string;
  }) => void;
}

export function ClippyComposer({
  mode,
  permissionMode,
  effort,
  model,
  streaming,
  onSend,
  onAbort,
  onPatch,
}: Props) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const modelsQuery = useQuery({
    queryKey: ["clippy", "models"],
    queryFn: () => chatApi.listModels().then((r) => r.models),
    staleTime: 60_000,
  });
  const models = modelsQuery.data ?? [];

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || streaming) return;
    setText("");
    onSend(trimmed);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="border-t border-border bg-background px-3 pb-3 pt-2">
      <div className="mx-auto max-w-3xl">
        <div className="rounded-md border border-border focus-within:ring-1 focus-within:ring-ring">
          <Textarea
            ref={ref}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type your task, use @ to add files or / for commands"
            rows={3}
            className="min-h-[64px] resize-none border-0 bg-transparent text-sm focus-visible:ring-0"
          />
          <div className="flex flex-wrap items-center gap-1.5 border-t border-border px-2 py-1.5 text-xs">
            <Select
              value={mode}
              onValueChange={(v) => onPatch({ mode: v as ChatMode })}
              disabled={streaming}
            >
              <SelectTrigger size="sm" className="h-7 w-auto gap-1 px-2 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="chat">Chat</SelectItem>
                <SelectItem value="agent">Agent</SelectItem>
              </SelectContent>
            </Select>
            {mode === "agent" && (
              <Select
                value={permissionMode}
                onValueChange={(v) => onPatch({ permissionMode: v as PermissionMode })}
                disabled={streaming}
              >
                <SelectTrigger size="sm" className="h-7 w-auto gap-1 px-2 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ask">Ask permission</SelectItem>
                  <SelectItem value="bypass">Bypass permissions</SelectItem>
                </SelectContent>
              </Select>
            )}
            <Select
              value={model}
              onValueChange={(v) => onPatch({ model: v })}
              disabled={streaming || (models.length === 0 && !model)}
            >
              <SelectTrigger size="sm" className="h-7 w-auto gap-1 px-2 text-xs">
                <SelectValue placeholder={model || "Pick a model"} />
              </SelectTrigger>
              <SelectContent>
                {models.length === 0 ? (
                  <SelectItem value={model || "no-model"} disabled>
                    {model || "No models available"}
                  </SelectItem>
                ) : (
                  <>
                    {/* If the session's persisted model isn't in the discovered
                        list (e.g. an adapter was disabled, or a stale id from
                        before the adapter:* encoding), still surface it so the
                        user sees what's selected — disabled, with a hint. */}
                    {model && !models.some((m) => m.model === model) && (
                      <SelectItem value={model} disabled>
                        <span className="font-mono">{model}</span>
                        <span className="ml-2 text-[10px] text-muted-foreground">unavailable</span>
                      </SelectItem>
                    )}
                    {models.map((m) => {
                      // Adapter-routed models are encoded as "adapter:<type>:<modelId>".
                      // Show the user the bare model id with a "via <adapter>" tag so
                      // they know it's running through their adapter's auth (e.g.
                      // Claude Pro), not a direct API key.
                      const isAdapterRouted = m.provider === "adapter" && m.model.startsWith("adapter:");
                      let displayModel = m.model;
                      let label = m.source ? `${m.source} → ${m.provider}` : m.provider;
                      if (isAdapterRouted) {
                        const rest = m.model.slice("adapter:".length);
                        const sep = rest.indexOf(":");
                        if (sep > 0) displayModel = rest.slice(sep + 1);
                        label = `via ${m.source ?? "adapter"}`;
                      }
                      return (
                        <SelectItem key={`${m.provider}:${m.model}:${m.source ?? ""}`} value={m.model}>
                          <span className="font-mono">{displayModel}</span>
                          <span className="ml-2 text-[10px] text-muted-foreground">{label}</span>
                        </SelectItem>
                      );
                    })}
                  </>
                )}
              </SelectContent>
            </Select>
            <Select
              value={effort}
              onValueChange={(v) => onPatch({ effort: v as EffortLevel })}
              disabled={streaming}
            >
              <SelectTrigger size="sm" className="h-7 w-auto gap-1 px-2 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Effort: Auto</SelectItem>
                <SelectItem value="low">Effort: Low</SelectItem>
                <SelectItem value="medium">Effort: Medium</SelectItem>
                <SelectItem value="high">Effort: High</SelectItem>
              </SelectContent>
            </Select>
            <div className="ml-auto">
              {streaming ? (
                <Button size="sm" variant="ghost" onClick={onAbort}>
                  <Square className="mr-1 h-3 w-3" /> Stop
                </Button>
              ) : (
                <Button size="sm" onClick={submit} disabled={!text.trim()}>
                  <Send className="mr-1 h-3 w-3" /> Send
                </Button>
              )}
            </div>
          </div>
        </div>
        {models.length === 0 && (
          <div className="mt-2 text-[11px] text-muted-foreground">
            No LLM provider configured. Set <code>ANTHROPIC_API_KEY</code>,{" "}
            <code>OPENAI_API_KEY</code>, <code>GEMINI_API_KEY</code>, or start a local Ollama (
            <code>OLLAMA_HOST</code>) to enable Clippy.
          </div>
        )}
      </div>
    </div>
  );
}
