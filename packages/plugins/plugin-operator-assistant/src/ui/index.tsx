import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  useHostContext,
  usePluginAction,
  usePluginData,
  usePluginStream,
} from "@paperclipai/plugin-sdk/ui";

type Source = {
  id: string;
  identifier: string;
  title: string;
  status: string;
  href: string;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  run_id: string | null;
  evidence?: { sources?: Source[] };
  created_at: string;
};

type ChatState = {
  session: {
    id: string;
    title: string;
    status: string;
    created_at: string;
    updated_at: string;
  } | null;
  messages: ChatMessage[];
};

type AssistantStreamEvent = {
  type: "assistant.started" | "assistant.agent-event" | "assistant.done" | "assistant.error";
  chatSessionId?: string;
  eventType?: string;
  stream?: string | null;
  message?: string | null;
  answer?: string;
  sources?: Source[];
};

const SUGGESTIONS = [
  "What did we work on in the last hour?",
  "What is blocked right now, and why?",
  "Summarize the latest decisions and next steps.",
];

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

function sourceList(message: ChatMessage): Source[] {
  return Array.isArray(message.evidence?.sources) ? message.evidence.sources.slice(0, 8) : [];
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const sources = sourceList(message);
  return (
    <article className={`oa-message oa-message--${message.role}`} aria-label={`${message.role} message`}>
      <div className="oa-message__meta">
        <span>{message.role === "assistant" ? "Assistant" : "You"}</span>
        <time dateTime={message.created_at}>{formatTime(message.created_at)}</time>
      </div>
      <div className="oa-message__body">{message.content}</div>
      {sources.length > 0 ? (
        <div className="oa-sources" aria-label="Sources">
          {sources.map((source) => (
            <a key={source.id} href={source.href} className="oa-source" title={source.title}>
              {source.identifier}
            </a>
          ))}
        </div>
      ) : null}
    </article>
  );
}

export function OperatorAssistantDrawer() {
  const context = useHostContext();
  const companyId = context.companyId;
  const [chatSessionId, setChatSessionId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [streamedAnswer, setStreamedAnswer] = useState("");
  const [streamedSources, setStreamedSources] = useState<Source[]>([]);
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const processedEventCount = useRef(0);
  const autoStartCompanyId = useRef<string | null>(null);

  const chatState = usePluginData<ChatState>("chat-state", {
    ...(companyId ? { companyId } : {}),
    ...(chatSessionId ? { chatSessionId } : {}),
  });
  const startChat = usePluginAction("start-chat");
  const sendMessage = usePluginAction("send-message");
  const channel = chatSessionId ? `operator-assistant:${chatSessionId}` : "operator-assistant:idle";
  const stream = usePluginStream<AssistantStreamEvent>(channel, {
    ...(companyId ? { companyId } : {}),
  });

  useEffect(() => {
    if (!chatSessionId && chatState.data?.session?.id) setChatSessionId(chatState.data.session.id);
  }, [chatSessionId, chatState.data?.session?.id]);

  useEffect(() => {
    processedEventCount.current = 0;
    setStreamedAnswer("");
    setStreamedSources([]);
    setBusy(false);
  }, [channel]);

  useEffect(() => {
    if (
      !companyId
      || chatState.loading
      || chatState.error
      || chatState.data?.session
      || starting
      || autoStartCompanyId.current === companyId
    ) return;
    autoStartCompanyId.current = companyId;
    setStarting(true);
    setActionError(null);
    void startChat({ companyId }).then((result) => {
      const created = result as { session?: { id?: string } };
      if (!created.session?.id) throw new Error("The assistant did not return a chat session.");
      setChatSessionId(created.session.id);
    }).catch((error) => {
      setActionError(error instanceof Error ? error.message : String(error));
    }).finally(() => setStarting(false));
  }, [chatState.data?.session, chatState.error, chatState.loading, companyId, startChat, starting]);

  useEffect(() => {
    const nextEvents = stream.events.slice(processedEventCount.current);
    processedEventCount.current = stream.events.length;
    if (nextEvents.length === 0) return;
    for (const event of nextEvents) {
      if (event.type === "assistant.started") {
        setBusy(true);
        setStreamedAnswer("");
        setStreamedSources([]);
      } else if (
        event.type === "assistant.agent-event"
        && event.eventType === "chunk"
        && event.stream !== "stderr"
        && event.message
      ) {
        setStreamedAnswer((current) => current + event.message);
      } else if (event.type === "assistant.done") {
        if (event.answer) setStreamedAnswer(event.answer);
        setStreamedSources(event.sources ?? []);
        setBusy(false);
        window.setTimeout(() => {
          chatState.refresh();
          setStreamedAnswer("");
          setStreamedSources([]);
        }, 100);
      } else if (event.type === "assistant.error") {
        setBusy(false);
        setActionError(event.message ?? "The assistant run failed.");
        chatState.refresh();
      }
    }
  }, [chatState, stream.events]);

  const messages = chatState.data?.messages ?? [];
  const hasMessages = messages.length > 0 || streamedAnswer.length > 0;
  const newestMessageId = useMemo(() => messages.at(-1)?.id ?? "", [messages]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [newestMessageId, streamedAnswer]);

  async function beginNewChat() {
    if (!companyId || starting || busy) return;
    setStarting(true);
    setActionError(null);
    try {
      const result = await startChat({ companyId }) as { session?: { id?: string } };
      if (!result.session?.id) throw new Error("The assistant did not return a chat session.");
      setChatSessionId(result.session.id);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setStarting(false);
    }
  }

  async function submit(message = draft) {
    const value = message.trim();
    if (!companyId || !chatSessionId || !value || busy) return;
    setBusy(true);
    setActionError(null);
    setDraft("");
    setStreamedAnswer("");
    try {
      await sendMessage({ companyId, chatSessionId, message: value });
      chatState.refresh();
    } catch (error) {
      setBusy(false);
      setActionError(error instanceof Error ? error.message : String(error));
      chatState.refresh();
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void submit();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <section className="oa-shell">
      <style>{styles}</style>
      <header className="oa-header">
        <div>
          <div className="oa-eyebrow"><span className="oa-read-dot" /> Read-only</div>
          <h1>Operator Assistant</h1>
          <p>Ask about work, decisions, blockers, or old issues.</p>
        </div>
        <button className="oa-button oa-button--quiet" type="button" onClick={() => void beginNewChat()} disabled={starting || busy}>
          New chat
        </button>
      </header>

      <div className="oa-feed" ref={scrollRef} aria-live="polite">
        {!companyId ? (
          <div className="oa-state">Select a company to use the assistant.</div>
        ) : chatState.loading || starting ? (
          <div className="oa-loading" aria-label="Loading conversation">
            <span /><span /><span />
          </div>
        ) : chatState.error ? (
          <div className="oa-state oa-state--error">Could not load this conversation: {chatState.error.message}</div>
        ) : !hasMessages ? (
          <div className="oa-empty">
            <div className="oa-empty__mark">A</div>
            <h2>What do you want to know?</h2>
            <p>I retrieve a small evidence set from Paperclip, then answer without creating an issue.</p>
            <div className="oa-suggestions">
              {SUGGESTIONS.map((suggestion) => (
                <button key={suggestion} type="button" onClick={() => void submit(suggestion)} disabled={!chatSessionId || busy}>
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {messages.map((message) => <MessageBubble key={message.id} message={message} />)}
            {streamedAnswer || busy ? (
              <article className="oa-message oa-message--assistant" aria-label="Assistant message in progress">
                <div className="oa-message__meta"><span>Assistant</span><span>{busy ? "Thinking" : ""}</span></div>
                <div className="oa-message__body">
                  {streamedAnswer || <span className="oa-thinking"><i /><i /><i /></span>}
                </div>
                {streamedSources.length > 0 ? (
                  <div className="oa-sources">
                    {streamedSources.slice(0, 8).map((source) => (
                      <a key={source.id} href={source.href} className="oa-source" title={source.title}>{source.identifier}</a>
                    ))}
                  </div>
                ) : null}
              </article>
            ) : null}
          </>
        )}
      </div>

      <footer className="oa-composer">
        {actionError ? <div className="oa-inline-error" role="alert">{actionError}</div> : null}
        <form onSubmit={onSubmit}>
          <label htmlFor="operator-assistant-input">Ask about this company</label>
          <div className="oa-input-row">
            <textarea
              id="operator-assistant-input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder="What did we work on in the last hour?"
              rows={3}
              maxLength={4_000}
              disabled={!companyId || !chatSessionId || starting}
            />
            <button className="oa-button oa-button--send" type="submit" disabled={!draft.trim() || busy || !chatSessionId}>
              {busy ? "Working" : "Send"}
            </button>
          </div>
          <p className="oa-composer__note">Enter to send · Shift + Enter for a new line · No issues are generated</p>
        </form>
      </footer>
    </section>
  );
}

const styles = `
.oa-shell { --oa-accent: var(--primary, #6d5dfc); --oa-border: var(--border, #d9d9df); --oa-muted: var(--muted-foreground, #70717a); display:flex; flex-direction:column; height:min(88vh, 860px); min-height:560px; background:var(--background, #fff); color:var(--foreground, #18181b); font:400 14px/1.5 var(--font-sans, ui-sans-serif, system-ui, sans-serif); }
.oa-header { display:flex; justify-content:space-between; gap:20px; padding:22px 24px 18px; border-bottom:1px solid var(--oa-border); background:var(--background, #fff); }
.oa-header h1 { margin:3px 0 2px; font-size:20px; line-height:1.25; letter-spacing:-.02em; }
.oa-header p { margin:0; color:var(--oa-muted); font-size:13px; }
.oa-eyebrow { display:flex; align-items:center; gap:6px; color:var(--oa-muted); font-size:11px; font-weight:650; letter-spacing:.08em; text-transform:uppercase; }
.oa-read-dot { width:7px; height:7px; border-radius:50%; background:#26a269; box-shadow:0 0 0 3px color-mix(in srgb, #26a269 14%, transparent); }
.oa-button { min-height:38px; border:1px solid var(--oa-border); border-radius:8px; padding:8px 13px; background:var(--background, #fff); color:var(--foreground, #18181b); font:inherit; font-weight:620; cursor:pointer; transition:background .15s ease, border-color .15s ease, opacity .15s ease; }
.oa-button:hover:not(:disabled) { background:var(--muted, #f4f4f5); border-color:color-mix(in srgb, var(--oa-border) 70%, var(--foreground)); }
.oa-button:focus-visible, .oa-suggestions button:focus-visible, .oa-source:focus-visible, .oa-input-row textarea:focus-visible { outline:2px solid var(--oa-accent); outline-offset:2px; }
.oa-button:disabled, .oa-suggestions button:disabled { opacity:.48; cursor:not-allowed; }
.oa-button--quiet { align-self:flex-start; white-space:nowrap; }
.oa-feed { flex:1; overflow:auto; padding:24px; background:color-mix(in srgb, var(--background, #fff) 96%, var(--foreground, #18181b)); scrollbar-gutter:stable; }
.oa-state { margin:40px auto; max-width:440px; padding:16px; border:1px solid var(--oa-border); border-radius:9px; color:var(--oa-muted); text-align:center; }
.oa-state--error, .oa-inline-error { color:var(--destructive, #b42318); background:color-mix(in srgb, var(--destructive, #b42318) 8%, transparent); border-color:color-mix(in srgb, var(--destructive, #b42318) 25%, var(--oa-border)); }
.oa-loading { display:grid; gap:10px; max-width:520px; margin:20px auto; }
.oa-loading span { display:block; height:16px; border-radius:5px; background:linear-gradient(90deg, var(--muted, #eee) 20%, color-mix(in srgb, var(--muted, #eee) 65%, var(--background)) 50%, var(--muted, #eee) 80%); background-size:220% 100%; animation:oa-shimmer 1.2s infinite; }
.oa-loading span:nth-child(2) { width:82%; }.oa-loading span:nth-child(3) { width:55%; }
@keyframes oa-shimmer { to { background-position:-220% 0; } }
.oa-empty { max-width:520px; margin:54px auto; text-align:center; }
.oa-empty__mark { display:grid; place-items:center; width:48px; height:48px; margin:0 auto 16px; border-radius:13px; background:var(--foreground, #18181b); color:var(--background, #fff); font-size:20px; font-weight:760; }
.oa-empty h2 { margin:0 0 7px; font-size:19px; letter-spacing:-.02em; }.oa-empty p { margin:0 auto 22px; max-width:430px; color:var(--oa-muted); }
.oa-suggestions { display:grid; gap:8px; }.oa-suggestions button { width:100%; min-height:43px; padding:10px 13px; border:1px solid var(--oa-border); border-radius:8px; background:var(--background, #fff); color:var(--foreground, #18181b); font:inherit; text-align:left; cursor:pointer; }
.oa-suggestions button:hover:not(:disabled) { border-color:var(--oa-accent); background:color-mix(in srgb, var(--oa-accent) 5%, var(--background)); }
.oa-message { max-width:760px; margin:0 auto 19px; }.oa-message--user { padding-left:56px; }.oa-message__meta { display:flex; justify-content:space-between; gap:12px; margin:0 2px 6px; color:var(--oa-muted); font-size:11px; font-weight:620; }
.oa-message__body { border:1px solid var(--oa-border); border-radius:10px; padding:13px 15px; background:var(--background, #fff); white-space:pre-wrap; overflow-wrap:anywhere; }
.oa-message--user .oa-message__body { background:color-mix(in srgb, var(--oa-accent) 9%, var(--background)); border-color:color-mix(in srgb, var(--oa-accent) 24%, var(--oa-border)); }
.oa-sources { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }.oa-source { border:1px solid var(--oa-border); border-radius:999px; padding:3px 8px; color:var(--oa-muted); background:var(--background, #fff); font-size:11px; font-weight:650; text-decoration:none; }.oa-source:hover { color:var(--foreground); border-color:var(--oa-accent); }
.oa-thinking { display:inline-flex; gap:4px; align-items:center; min-height:21px; }.oa-thinking i { width:6px; height:6px; border-radius:50%; background:var(--oa-muted); animation:oa-bounce 1s infinite ease-in-out; }.oa-thinking i:nth-child(2) { animation-delay:.12s; }.oa-thinking i:nth-child(3) { animation-delay:.24s; }
@keyframes oa-bounce { 0%, 70%, 100% { transform:translateY(0); opacity:.45; } 35% { transform:translateY(-4px); opacity:1; } }
.oa-composer { padding:15px 20px 18px; border-top:1px solid var(--oa-border); background:var(--background, #fff); }.oa-composer form { max-width:780px; margin:0 auto; }.oa-composer label { display:block; margin:0 0 6px; font-size:12px; font-weight:650; }.oa-input-row { display:flex; align-items:flex-end; gap:9px; }.oa-input-row textarea { flex:1; min-height:76px; max-height:180px; resize:vertical; border:1px solid var(--oa-border); border-radius:9px; padding:11px 12px; background:var(--background, #fff); color:var(--foreground, #18181b); font:inherit; line-height:1.45; }.oa-input-row textarea::placeholder { color:var(--oa-muted); }.oa-button--send { min-width:82px; background:var(--foreground, #18181b); border-color:var(--foreground, #18181b); color:var(--background, #fff); }.oa-button--send:hover:not(:disabled) { background:color-mix(in srgb, var(--foreground) 87%, var(--background)); }
.oa-composer__note { margin:6px 1px 0; color:var(--oa-muted); font-size:11px; }.oa-inline-error { max-width:780px; margin:0 auto 10px; border:1px solid; border-radius:7px; padding:8px 10px; font-size:12px; }
@media (max-width:640px) { .oa-shell { min-height:520px; height:88vh; }.oa-header, .oa-feed { padding-left:16px; padding-right:16px; }.oa-message--user { padding-left:24px; }.oa-input-row { align-items:stretch; flex-direction:column; }.oa-button--send { width:100%; }.oa-composer__note { display:none; } }
@media (prefers-reduced-motion:reduce) { .oa-loading span, .oa-thinking i { animation:none; }.oa-feed { scroll-behavior:auto; } }
`;

export default OperatorAssistantDrawer;
