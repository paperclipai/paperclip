import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Check, Copy, Download, Menu, X, Upload, Clock, Search, Bell, LayoutDashboard, Paperclip } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../lib/utils";

// ── Agent definitions ─────────────────────────────────────────────────────

type Agent = {
  id: string;
  name: string;
  emoji: string;
  prompt: string;
  color: string;
  responses: string[];
};

const AGENTS: Agent[] = [
  {
    id: "cold-pitch",
    name: "Cold Pitch",
    emoji: "✉️",
    prompt: "Craft compelling initial outreach",
    color: "bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100",
    responses: [
      `Here's a cold pitch tailored to your target:\n\nSubject: Quick idea for [Company]\n\nHi [Name],\n\nI noticed [Company] has been [specific observation]. Most teams in your position struggle with [pain point].\n\nWe helped [similar company] solve exactly this — [specific result] in [timeframe].\n\nWorth a 15-minute call to see if it fits? I have [Day] at [Time] open.\n\n[Your name]`,
      `Cold pitch draft:\n\n**Subject**: One question about [Company]'s [goal]\n\nHi [Name],\n\nApologies for the cold reach — I'll be brief.\n\n[Company] is doing interesting work on [topic]. We've built something that directly addresses [specific challenge], and the ROI has been meaningful for similar teams.\n\nCan I send you a 2-min overview? No call needed unless it sparks interest.\n\nThanks,\n[Your name]`,
    ],
  },
  {
    id: "pricing-reframe",
    name: "Pricing",
    emoji: "💎",
    prompt: "Turn price objections into value",
    color: "bg-purple-50 text-purple-700 border-purple-200 hover:bg-purple-100",
    responses: [
      `When a prospect says "it's too expensive," they're really saying they don't yet see the value. Here's how to reframe:\n\n**Anchor to cost of inaction**: "What does this problem cost you per month right now? If we solve it, the investment pays back in [X weeks]."\n\n**Break it down**: "[Price] sounds large until you divide it by [users/months/deals]. That's [small number] per [unit]."\n\n**Compare to alternatives**: "The question isn't whether this costs money — it's whether it costs less than [current solution / not solving it]."\n\nWhich objection are you facing specifically?`,
      `Price objection response:\n\n"I completely understand — budget decisions deserve scrutiny. Let me offer some context:\n\nOur current customers see an average of [X]% [metric] improvement within [timeframe]. For a company your size, that typically translates to [$Y] in [recovered time / new revenue / saved cost].\n\nIf those numbers hold for you, what would the right investment look like?"\n\nThis flips the conversation from cost to ROI.`,
    ],
  },
  {
    id: "linkedin",
    name: "LinkedIn",
    emoji: "🔗",
    prompt: "Connect and message on LinkedIn",
    color: "bg-sky-50 text-sky-700 border-sky-200 hover:bg-sky-100",
    responses: [
      `LinkedIn connection request (300 chars max):\n\n"Hi [Name], I came across your post on [topic] — [specific detail you liked]. I work on [relevant thing] and think we'd have an interesting conversation. Would love to connect."\n\n**Why it works**: Personal, specific, low-pressure. Not selling anything.\n\n**Follow-up message after connecting** (send 2–3 days later):\n"Thanks for connecting! [Reference their recent content or company news]. Curious — how are you thinking about [relevant challenge]?"`,
      `LinkedIn outreach sequence:\n\n**Day 1 — Connect**: Reference something specific from their profile or content. No pitch.\n\n**Day 4 — Value add**: Share something genuinely useful. "Saw this and thought of your work on [X]" + link.\n\n**Day 10 — Soft ask**: "Been meaning to ask — are you still [challenge]? We've been helping [similar role] with this. Happy to share what we're seeing."`,
    ],
  },
  {
    id: "proposal",
    name: "Proposal",
    emoji: "📄",
    prompt: "Write winning sales proposals",
    color: "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100",
    responses: [
      `**Proposal structure that closes**:\n\n1. **The Problem** — reflect their words back. Show you listened.\n2. **The Cost** — quantify what staying stuck costs them.\n3. **The Approach** — specific to them, not generic.\n4. **Social proof** — one tight case study, same industry/size.\n5. **Investment** — present as a range or tiered options.\n6. **Next step** — one clear action, deadline creates urgency.\n\nKeep it under 4 pages. Decision-makers don't read more.`,
      `Here's a proposal opening that works:\n\n"This proposal responds to [Company]'s goal of [goal] by [timeframe].\n\nBased on our conversation, the core challenge is [problem in their words]. Left unresolved, this costs [quantified impact].\n\nThis engagement delivers [specific outcome] through [approach]. Companies like [example] achieved [result] using this method.\n\n---\n\n**Scope**: [What you'll do]\n**Timeline**: [When]\n**Investment**: Starting at $[X]\n\n**To move forward**: [Single next step]"`,
    ],
  },
  {
    id: "check-in",
    name: "Check-in",
    emoji: "👋",
    prompt: "Follow up and nurture relationships",
    color: "bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100",
    responses: [
      `Follow-up message after a meeting:\n\n"Hi [Name],\n\nGreat talking yesterday. Three things I took away:\n1. [Their priority you'll address]\n2. [Their timeline]\n3. [The concern you'll answer]\n\nAttached is [promised resource]. I'll also send over [next deliverable] by [date].\n\nAny questions before then, I'm here.\n\n[Your name]"\n\n**Why this works**: Shows you listened, sets expectations, opens the door.`,
      `Re-engagement message (60–90 days of silence):\n\n"Hi [Name],\n\nIt's been a while — hope [their company] is going well.\n\nI won't pretend I'm not following up with a purpose. We just [relevant update — new feature, case study, price event].\n\nGiven where you were at when we last spoke on [topic], I thought you'd want to know.\n\nStill exploring options, or has the landscape changed?"\n\nThis is honest and gives them a reason to re-engage.`,
    ],
  },
];

// ── Free runs tracking ────────────────────────────────────────────────────

const FREE_RUNS_KEY = "goffer-free-runs-v1";
const FREE_RUNS_LIMIT = 3;

type FreeRunsStore = Record<string, { count: number; date: string }>;

function getTodayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function loadFreeRuns(): FreeRunsStore {
  try {
    return JSON.parse(localStorage.getItem(FREE_RUNS_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function saveFreeRuns(store: FreeRunsStore) {
  localStorage.setItem(FREE_RUNS_KEY, JSON.stringify(store));
}

function getRemainingRuns(agentId: string): number {
  const store = loadFreeRuns();
  const today = getTodayKey();
  const entry = store[agentId];
  if (!entry || entry.date !== today) return FREE_RUNS_LIMIT;
  return Math.max(0, FREE_RUNS_LIMIT - entry.count);
}

function consumeRun(agentId: string) {
  const store = loadFreeRuns();
  const today = getTodayKey();
  const entry = store[agentId];
  if (!entry || entry.date !== today) {
    store[agentId] = { count: 1, date: today };
  } else {
    store[agentId] = { count: entry.count + 1, date: today };
  }
  saveFreeRuns(store);
}

// ── GA4 telemetry ─────────────────────────────────────────────────────────

const GA_ID = import.meta.env.VITE_GA_MEASUREMENT_ID as string | undefined;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const win = () => window as any;

function initGa4() {
  if (!GA_ID || typeof window === "undefined" || win().__ga4Init) return;
  win().__ga4Init = true;
  win().dataLayer = win().dataLayer || [];
  const push = (...args: unknown[]) => win().dataLayer.push(args);
  push("js", new Date());
  push("config", GA_ID);
  const s = document.createElement("script");
  s.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
  s.async = true;
  document.head.appendChild(s);
}

function ga4Event(event: string, params?: Record<string, unknown>) {
  if (!GA_ID || !Array.isArray(win().dataLayer)) return;
  win().dataLayer.push(["event", event, params ?? {}]);
}

// ── Attribution helpers ───────────────────────────────────────────────────

type ReferrerSource = "twitter" | "indie_hackers" | "direct" | "other";

function detectReferrerSource(): ReferrerSource {
  const params = new URLSearchParams(window.location.search);
  const utmSource = params.get("utm_source")?.toLowerCase() ?? "";

  if (utmSource === "twitter" || utmSource === "x") return "twitter";
  if (utmSource === "indie_hackers" || utmSource === "indiehackers") return "indie_hackers";

  const ref = document.referrer?.toLowerCase() ?? "";
  if (ref.includes("twitter.com") || ref.includes("t.co") || ref.includes("x.com")) return "twitter";
  if (ref.includes("indiehackers.com")) return "indie_hackers";

  return ref ? "other" : "direct";
}

function captureUtmParams() {
  const params = new URLSearchParams(window.location.search);
  return {
    utm_source: params.get("utm_source") ?? "",
    utm_medium: params.get("utm_medium") ?? "",
    utm_campaign: params.get("utm_campaign") ?? "",
  };
}

async function writeGofferSignup(payload: {
  email: string;
  referrer_source: ReferrerSource;
  feature_view_sequence: string[];
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
}) {
  const supabaseUrl = import.meta.env.VITE_GOFFER_SUPABASE_URL?.trim();
  const supabaseKey = import.meta.env.VITE_GOFFER_SUPABASE_ANON_KEY?.trim();

  if (!supabaseUrl || !supabaseKey) {
    console.warn("[goffer] Supabase not configured — signup not persisted");
    return;
  }

  const res = await fetch(`${supabaseUrl}/rest/v1/goffer_signups`, {
    method: "POST",
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      ...payload,
      feature_view_sequence: payload.feature_view_sequence.join(","),
      signed_up_at: new Date().toISOString(),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Supabase ${res.status}: ${body.slice(0, 120)}`);
  }
}

// ── Types ─────────────────────────────────────────────────────────────────

type Message = {
  id: string;
  role: "user" | "assistant";
  agentId: string;
  content: string;
  isStreaming?: boolean;
};

// ── Streaming simulation ──────────────────────────────────────────────────

function pickResponse(agent: Agent): string {
  const i = Math.floor(Math.random() * agent.responses.length);
  return agent.responses[i];
}

async function* streamWords(text: string): AsyncGenerator<string> {
  const words = text.split(/(\s+)/);
  for (const word of words) {
    yield word;
    await new Promise<void>((r) => setTimeout(r, 18 + Math.random() * 22));
  }
}

// ── Sub-components ────────────────────────────────────────────────────────

function AgentPill({
  agent,
  selected,
  disabled,
  runsLeft,
  onClick,
}: {
  agent: Agent;
  selected: boolean;
  disabled: boolean;
  runsLeft: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-all",
        selected
          ? cn(agent.color, "ring-1 ring-current ring-offset-1 shadow-sm")
          : cn(agent.color, "opacity-70"),
        disabled && "cursor-not-allowed opacity-40",
      )}
      title={`${agent.prompt} · ${runsLeft} free run${runsLeft !== 1 ? "s" : ""} left today`}
    >
      <span>{agent.emoji}</span>
      <span>{agent.name}</span>
      {runsLeft < FREE_RUNS_LIMIT && (
        <span className="text-[10px] opacity-60">({runsLeft})</span>
      )}
    </button>
  );
}

function MessageBubble({
  message,
  agent,
  onCopy,
  onDownload,
}: {
  message: Message;
  agent: Agent | undefined;
  onCopy: (text: string) => void;
  onDownload: (text: string, agentName: string) => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    onCopy(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const isUser = message.role === "user";

  return (
    <div className={cn("group flex flex-col chat-message-in", isUser ? "items-end" : "items-start")}>
      {!isUser && agent && (
        <div className="mb-1.5 flex items-center gap-1.5 px-1">
          <span className="text-base leading-none">{agent.emoji}</span>
          <span className="text-xs font-medium text-gray-400">{agent.name}</span>
        </div>
      )}

      <div
        className={cn(
          "relative max-w-[520px] rounded-2xl px-5 py-3.5",
          isUser
            ? "bg-gray-900 text-white"
            : "bg-white/80 text-gray-800 shadow-[0_2px_16px_rgba(0,0,0,0.06)] ring-1 ring-black/5",
          !isUser && message.isStreaming && "breathing-glow",
        )}
      >
        {isUser ? (
          <div className="whitespace-pre-wrap text-sm leading-relaxed">
            {message.content}
          </div>
        ) : (
          <div className="text-sm leading-relaxed prose prose-sm prose-gray max-w-none
            prose-p:my-1 prose-headings:my-2 prose-ul:my-1 prose-ol:my-1
            prose-li:my-0 prose-code:bg-gray-100 prose-code:px-1 prose-code:rounded
            prose-pre:bg-gray-100 prose-pre:rounded-lg">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {message.content}
            </ReactMarkdown>
            {message.isStreaming && (
              <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-current opacity-60" />
            )}
          </div>
        )}

        {!isUser && !message.isStreaming && (
          <div className="mt-2 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              onClick={handleCopy}
              className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              onClick={() => onDownload(message.content, agent?.name ?? "response")}
              className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
            >
              <Download className="h-3 w-3" />
              Save
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Email capture gate ────────────────────────────────────────────────────

function SignupGate({
  referrerSource,
  featureViewSequence,
  utmParams,
}: {
  referrerSource: ReferrerSource;
  featureViewSequence: string[];
  utmParams: { utm_source: string; utm_medium: string; utm_campaign: string };
}) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const handleSubmit = async () => {
    const trimmed = email.trim();
    if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setErrorMsg("Please enter a valid email.");
      return;
    }
    setStatus("loading");
    setErrorMsg("");
    try {
      await writeGofferSignup({
        email: trimmed,
        referrer_source: referrerSource,
        feature_view_sequence: featureViewSequence,
        ...utmParams,
      });
      ga4Event("goffer_signup", {
        referrer_source: referrerSource,
        utm_source: utmParams.utm_source,
        utm_medium: utmParams.utm_medium,
        utm_campaign: utmParams.utm_campaign,
      });
      setStatus("done");
    } catch (err) {
      console.error("[goffer] signup write failed:", err);
      setStatus("error");
      setErrorMsg("Something went wrong. Try again?");
    }
  };

  if (status === "done") {
    return (
      <div className="border-t border-gray-100 px-4 py-3 text-center">
        <p className="text-sm font-medium text-gray-700">You're on the list.</p>
        <p className="mt-0.5 text-xs text-gray-400">We'll reach out with early access.</p>
      </div>
    );
  }

  return (
    <div className="border-t border-gray-100 px-4 py-3">
      <p className="mb-2 text-center text-xs text-gray-500">
        Free runs used · Get unlimited access
      </p>
      <div className="flex gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
          placeholder="your@email.com"
          className="flex-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs text-gray-800 placeholder:text-gray-400 focus:border-gray-400 focus:outline-none"
        />
        <button
          onClick={handleSubmit}
          disabled={status === "loading"}
          className="rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-80 disabled:opacity-50"
        >
          {status === "loading" ? "…" : "Get access"}
        </button>
      </div>
      {errorMsg && <p className="mt-1 text-center text-[11px] text-red-500">{errorMsg}</p>}
    </div>
  );
}

// ── Mobile drawer ─────────────────────────────────────────────────────────

const DRAWER_NAV_ITEMS = [
  { icon: Upload, label: "Upload a file", description: "Attach context for your agents" },
  { icon: LayoutDashboard, label: "Dashboard", description: "Overview of your workspace" },
  { icon: Clock, label: "Chat History", description: "Browse past conversations" },
  { icon: Search, label: "Search Files", description: "Find uploaded documents" },
  { icon: Bell, label: "Reminders", description: "Follow-up and nudge settings" },
] as const;

function MobileDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <>
      {/* Backdrop */}
      {open && (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm md:hidden"
          onClick={onClose}
          aria-label="Close menu"
        />
      )}

      {/* Drawer panel */}
      <div
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-full flex-col bg-[#FAFAF9] transition-transform duration-200 ease-out md:hidden",
          open ? "translate-x-0" : "-translate-x-full",
        )}
        aria-hidden={!open}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
          <span className="text-base font-semibold text-gray-800">goffer</span>
          <button
            onClick={onClose}
            className="flex items-center justify-center rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition-colors"
            aria-label="Close menu"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Nav items */}
        <nav className="flex-1 overflow-y-auto px-3 py-4">
          <ul className="space-y-1">
            {DRAWER_NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              return (
                <li key={item.label}>
                  <button
                    type="button"
                    onClick={onClose}
                    className="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left transition-colors hover:bg-gray-100 active:bg-gray-200"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gray-100">
                      <Icon className="h-[18px] w-[18px] text-gray-600" />
                    </span>
                    <span>
                      <span className="block text-sm font-medium text-gray-800">{item.label}</span>
                      <span className="block text-xs text-gray-400">{item.description}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
    </>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────

export function ChatInterface() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [selectedAgentId, setSelectedAgentId] = useState<string>(AGENTS[0].id);
  const [streaming, setStreaming] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [runsLeft, setRunsLeft] = useState<Record<string, number>>(() =>
    Object.fromEntries(AGENTS.map((a) => [a.id, getRemainingRuns(a.id)])),
  );
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ── GA4 init (once on mount) ─────────────────────────────────────────────
  useEffect(() => { initGa4(); }, []);

  // ── Attribution state (captured once on mount) ──────────────────────────
  const referrerSourceRef = useRef<ReferrerSource>(detectReferrerSource());
  const utmParamsRef = useRef(captureUtmParams());
  // Ordered sequence of agent IDs the user viewed/selected (deduped consecutively)
  const [featureViewSequence, setFeatureViewSequence] = useState<string[]>([AGENTS[0].id]);

  const selectedAgent = AGENTS.find((a) => a.id === selectedAgentId) ?? AGENTS[0];

  const refreshRunsLeft = useCallback(() => {
    setRunsLeft(Object.fromEntries(AGENTS.map((a) => [a.id, getRemainingRuns(a.id)])));
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleAgentSelect = (agentId: string) => {
    setSelectedAgentId(agentId);
    // Track feature view — append only if different from last entry
    setFeatureViewSequence((prev) =>
      prev[prev.length - 1] === agentId ? prev : [...prev, agentId],
    );
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
  };

  const handleDownload = (text: string, agentName: string) => {
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${agentName.toLowerCase().replace(/\s+/g, "-")}-response.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSubmit = async () => {
    const text = input.trim();
    if (!text || streaming) return;
    if (runsLeft[selectedAgentId] <= 0) return;

    const agent = selectedAgent;
    const userMsgId = crypto.randomUUID();
    const assistantMsgId = crypto.randomUUID();

    setMessages((prev) => [
      ...prev,
      { id: userMsgId, role: "user", agentId: agent.id, content: text },
    ]);
    setInput("");
    setStreaming(true);

    consumeRun(agent.id);
    refreshRunsLeft();
    ga4Event("goffer_run", { agent_id: agent.id });

    const responseText = pickResponse(agent);

    setMessages((prev) => [
      ...prev,
      { id: assistantMsgId, role: "assistant", agentId: agent.id, content: "", isStreaming: true },
    ]);

    let accumulated = "";
    for await (const chunk of streamWords(responseText)) {
      accumulated += chunk;
      const snapshot = accumulated;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId ? { ...m, content: snapshot } : m,
        ),
      );
    }

    setMessages((prev) =>
      prev.map((m) =>
        m.id === assistantMsgId ? { ...m, isStreaming: false } : m,
      ),
    );
    setStreaming(false);
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const hasMessages = messages.length > 0;
  const canSend = input.trim().length > 0 && !streaming && runsLeft[selectedAgentId] > 0;
  const selectedAgentRunsLeft = runsLeft[selectedAgentId];

  // Track once per session when the signup gate first appears
  const gateTrackedRef = useRef(false);
  useEffect(() => {
    if (selectedAgentRunsLeft <= 0 && !gateTrackedRef.current) {
      gateTrackedRef.current = true;
      ga4Event("goffer_signup_gate_shown", { agent_id: selectedAgentId });
    }
  }, [selectedAgentRunsLeft, selectedAgentId]);

  return (
    <main className="flex min-h-screen flex-col bg-[#FAFAF9]">
      {/* Mobile drawer */}
      <MobileDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />

      {/* Header: always visible on mobile (for hamburger access), hidden on desktop when no messages */}
      <header
        className={cn(
          "sticky top-0 z-10 flex items-center justify-between border-b border-gray-100/80 bg-[#FAFAF9]/90 px-4 md:px-6 py-3 backdrop-blur-sm transition-all duration-300",
          !hasMessages && "md:opacity-0 md:pointer-events-none",
        )}
      >
        <div className="flex items-center gap-2">
          {/* Hamburger — mobile only */}
          <button
            onClick={() => setDrawerOpen(true)}
            className="md:hidden -ml-1 flex items-center justify-center rounded-lg p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors"
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" />
          </button>
          <span className="text-base">{selectedAgent.emoji}</span>
          <span className="text-sm font-medium text-gray-700">{selectedAgent.name}</span>
        </div>
        <button
          onClick={() => setMessages([])}
          className="rounded-lg px-3 py-1 text-xs text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
        >
          New chat
        </button>
      </header>

      {/* Content area */}
      <div className="flex flex-1 flex-col">
        {!hasMessages ? (
          /* ── Empty / home state ── */
          <div className="flex flex-1 flex-col items-center justify-center px-4 py-20">
            <div className="mb-12 text-center">
              <h1 className="text-3xl font-light tracking-tight text-gray-800">
                What can I help with?
              </h1>
              <p className="mt-3 text-sm text-gray-400">
                Pick an agent and start a conversation
              </p>
            </div>

            {/* Agent cards on home */}
            <div className="mb-10 grid max-w-lg grid-cols-2 gap-3 sm:grid-cols-3 w-full">
              {AGENTS.map((agent) => (
                <button
                  key={agent.id}
                  onClick={() => handleAgentSelect(agent.id)}
                  disabled={runsLeft[agent.id] <= 0}
                  className={cn(
                    "rounded-2xl border p-4 text-left transition-all",
                    agent.color,
                    selectedAgentId === agent.id && "ring-2 ring-current ring-offset-2 shadow-md",
                    runsLeft[agent.id] <= 0 && "cursor-not-allowed opacity-40",
                  )}
                >
                  <div className="mb-2 text-2xl">{agent.emoji}</div>
                  <div className="text-sm font-semibold">{agent.name}</div>
                  <div className="mt-0.5 text-xs opacity-70">{agent.prompt}</div>
                  <div className="mt-2 text-[10px] opacity-50">
                    {runsLeft[agent.id]} run{runsLeft[agent.id] !== 1 ? "s" : ""} left
                  </div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          /* ── Message stream ── */
          <div className="flex-1 overflow-y-auto">
            <div className="mx-auto max-w-[600px] space-y-8 px-4 md:px-6 py-14 pb-32 md:pb-14">
              {messages.map((msg) => (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  agent={AGENTS.find((a) => a.id === msg.agentId)}
                  onCopy={handleCopy}
                  onDownload={handleDownload}
                />
              ))}
              <div ref={messagesEndRef} />
            </div>
          </div>
        )}
      </div>

      {/* ── Input area ──
           On mobile: sticky above MobileBottomNav (h-16 = 4rem); on desktop: sticky at bottom.
           The [&]:bottom-20 targets mobile viewport where MobileBottomNav lives. */}
      <div className="sticky bottom-20 md:bottom-0 bg-gradient-to-t from-[#FAFAF9] via-[#FAFAF9] to-transparent pb-4 md:pb-8 pt-4">
        <div className="mx-auto max-w-[600px] px-4">
          <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-[0_4px_24px_rgba(0,0,0,0.08)] input-warm-focus">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={`Ask ${selectedAgent.name}...`}
              rows={1}
              disabled={streaming || selectedAgentRunsLeft <= 0}
              className={cn(
                "w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-sm text-gray-800 placeholder:text-gray-400 focus:outline-none",
                "min-h-[52px] max-h-40",
              )}
              style={{ height: "auto" }}
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
              }}
            />

            {/* Footer: upload + agent pills (scrollable on mobile) + send */}
            <div className="flex items-center gap-2 px-3 pb-2.5">
              {/* Upload button */}
              <button
                type="button"
                onClick={() => setDrawerOpen(true)}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
                aria-label="Upload file"
                title="Upload a file"
              >
                <Paperclip className="h-4 w-4" />
              </button>

              {/* Agent pills — horizontal scroll on mobile, wrap on desktop */}
              <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto md:flex-wrap [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
                {AGENTS.map((agent) => (
                  <AgentPill
                    key={agent.id}
                    agent={agent}
                    selected={selectedAgentId === agent.id}
                    disabled={streaming}
                    runsLeft={runsLeft[agent.id]}
                    onClick={() => handleAgentSelect(agent.id)}
                  />
                ))}
              </div>

              <button
                onClick={handleSubmit}
                disabled={!canSend}
                className={cn(
                  "flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl transition-all",
                  canSend
                    ? "bg-gray-900 text-white hover:bg-gray-700 shadow-sm"
                    : "bg-gray-100 text-gray-300 cursor-not-allowed",
                )}
                aria-label="Send message"
              >
                <ArrowUp className="h-4 w-4" />
              </button>
            </div>

            {/* Out of runs: email capture gate */}
            {selectedAgentRunsLeft <= 0 && (
              <SignupGate
                referrerSource={referrerSourceRef.current}
                featureViewSequence={featureViewSequence}
                utmParams={utmParamsRef.current}
              />
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
