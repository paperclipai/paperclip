import { useEffect, useRef, useState, useMemo } from "react";
import { useNavigate, useSearchParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authApi } from "@/api/auth";
import { healthApi } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";
import { getRememberedInvitePath } from "@/lib/invite-memory";
import { cn } from "@/lib/utils";
import { useTheme } from "@/context/ThemeContext";
import {
  ArrowRight,
  Activity,
  BarChart3,
  Bot,
  CheckSquare,
  ChevronRight,
  Gauge,
  GitBranch,
  Minus,
  Moon,
  Network,
  PenTool,
  Plus,
  Sun,
  Terminal,
  Zap,
} from "lucide-react";

// ─── Palette (warm light, AGNB orange) ───────────────────────────────────────
// page  #F6F3EC · alt #FAF8F4 · card #FFFFFF · heading gray-900 · muted #737373
// accent #f97316 · accent-hover #ea6a0c · borders black/[0.08]

const SERIF: React.CSSProperties = {
  fontFamily: "Georgia, 'Times New Roman', serif",
  fontStyle: "italic",
};

// ─── Auth mode ───────────────────────────────────────────────────────────────

type AuthMode = "sign_in" | "sign_up";

function LoginCard({ nextPath }: { nextPath: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [mode, setMode] = useState<AuthMode>("sign_in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      if (mode === "sign_in") {
        await authApi.signInEmail({ email: email.trim(), password });
        return;
      }
      await authApi.signUpEmail({ name: name.trim(), email: email.trim(), password });
    },
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      navigate(nextPath, { replace: true });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Authentication failed");
    },
  });

  const canSubmit =
    email.trim().length > 0 &&
    password.trim().length > 0 &&
    (mode === "sign_in" || (name.trim().length > 0 && password.trim().length >= 8));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (mutation.isPending || !canSubmit) return;
    setError(null);
    mutation.mutate();
  };

  const inputClass =
    "rounded-lg border border-black/[0.1] dark:border-white/10 bg-[#FAF8F4] dark:bg-neutral-800/60 px-4 py-3 text-[15px] text-gray-900 dark:text-neutral-100 placeholder:text-gray-400 dark:placeholder:text-neutral-500 focus:border-[#f97316] focus:bg-white dark:focus:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-[#f97316]/20 transition";

  return (
    <div
      id="signin"
      className="w-full max-w-md rounded-2xl border border-black/[0.08] dark:border-white/[0.08] bg-white dark:bg-neutral-900 p-7 shadow-[0_8px_40px_rgba(0,0,0,0.06)] sm:p-8"
    >
      <div className="mb-5 flex items-center justify-between">
        <div>
          <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-[#f97316]">
            {mode === "sign_in" ? "Sign in" : "Create account"}
          </p>
          <h2 className="mt-1 text-xl font-bold tracking-tight text-gray-900 dark:text-neutral-100">
            {mode === "sign_in" ? "Get in the cockpit" : "Join the crew"}
          </h2>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[#f97316]/25 bg-[#f97316]/5 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-[#f97316]">
          <span className="size-1.5 animate-pulse rounded-full bg-[#f97316]" /> live
        </span>
      </div>

      <form onSubmit={submit} className="flex flex-col gap-3">
        {mode === "sign_up" && (
          <input
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            autoComplete="name"
            className={inputClass}
          />
        )}
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          aria-label="Email"
          autoComplete="username"
          spellCheck={false}
          autoCapitalize="none"
          className={inputClass}
        />
        <input
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          aria-label="Password"
          autoComplete={mode === "sign_in" ? "current-password" : "new-password"}
          className={inputClass}
        />
        {error && <p className="text-[13px] text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={mutation.isPending || !canSubmit}
          className="group mt-1 inline-flex items-center justify-center gap-2 rounded-lg bg-[#f97316] px-6 py-3 text-sm font-semibold text-white transition hover:bg-[#ea6a0c] disabled:opacity-50"
        >
          {mutation.isPending
            ? "Flooring it…"
            : mode === "sign_in"
              ? "Floor it"
              : "Get in"}
          {!mutation.isPending && (
            <ArrowRight className="size-4 transition group-hover:translate-x-0.5" />
          )}
        </button>
      </form>

      <button
        type="button"
        onClick={() => {
          setError(null);
          setMode(mode === "sign_in" ? "sign_up" : "sign_in");
        }}
        className="mt-4 block w-full text-center text-[13px] text-gray-500 dark:text-neutral-400 transition hover:text-gray-900 dark:hover:text-neutral-100"
      >
        {mode === "sign_in"
          ? "No account yet? Create one →"
          : "Already have access? Sign in →"}
      </button>
    </div>
  );
}

// ─── Stat count-up ────────────────────────────────────────────────────────────

function CountUp({
  to,
  suffix = "",
  duration = 1400,
}: {
  to: number;
  suffix?: string;
  duration?: number;
}) {
  const [val, setVal] = useState(to);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let raf = 0;
    let started = false;
    const animate = (t0: number) => {
      const step = (t: number) => {
        const p = Math.min((t - t0) / duration, 1);
        const eased = 1 - Math.pow(1 - p, 3);
        setVal(Math.round(eased * to));
        if (p < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    };
    const io = new IntersectionObserver(
      (es) => {
        if (es[0].isIntersecting && !started) {
          started = true;
          setVal(0);
          requestAnimationFrame((t) => animate(t));
        }
      },
      { threshold: 0.4 },
    );
    if (ref.current) io.observe(ref.current);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [to, duration]);

  return (
    <span ref={ref}>
      {val}
      {suffix}
    </span>
  );
}

// ─── Live console (stays dark — the product shot) ─────────────────────────────

const JOB_FEED = [
  "outbound-sync ✓ — 26 campaigns ranked by reply rate",
  "blog-auto-drafter ✓ — 1 draft queued",
  "gsc-rank-tracker ✓ — 41 keywords tracked",
  "agent-runner ✓ — PR merged in 4m",
  "mentions-sync ✓ — 60 scanned, 4 hot",
  "pipeline-sync ✓ — 6 deals attributed",
  "issue-planner ✓ — 7 subtasks scaffolded",
  "linkedin-poster ✓ — post scheduled",
  "renewal-reminders ✓ — 2 flagged",
  "code-review ✓ — 3 issues surfaced",
  "daily-digest ✓ — snapshot written",
  "approval-gate ✓ — 1 decision queued",
];

function LiveConsole() {
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    let i = 0;
    const id = setInterval(() => {
      setLines((prev) => {
        const next = [...prev, JOB_FEED[i % JOB_FEED.length]];
        i++;
        return next.slice(-8);
      });
    }, 1100);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="overflow-hidden rounded-2xl border border-black/10 bg-[#0d0d10] font-mono text-[12.5px] shadow-[0_24px_70px_-20px_rgba(0,0,0,0.45)]">
      <div className="flex items-center gap-2 border-b border-white/10 bg-[#16161b] px-4 py-3">
        <span className="size-3 rounded-full bg-red-500/70" />
        <span className="size-3 rounded-full bg-yellow-500/70" />
        <span className="size-3 rounded-full bg-[#f97316]/80" />
        <span className="ml-2 flex items-center gap-1.5 text-[11px] text-neutral-400">
          <Terminal className="size-3" /> agnb-worker · live
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[#f97316]">
          <span className="size-1.5 animate-pulse rounded-full bg-[#f97316]" /> running
        </span>
      </div>
      <div className="h-[240px] space-y-1.5 p-5">
        {lines.length === 0 && (
          <div className="text-neutral-500">booting worker…</div>
        )}
        {lines.map((l, idx) => (
          <div
            key={idx}
            className="flex gap-2"
            style={{
              opacity: 0.4 + (idx / Math.max(lines.length - 1, 1)) * 0.6,
            }}
          >
            <span className="text-[#f97316]/70">›</span>
            <span className="text-neutral-200">{l}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Data ─────────────────────────────────────────────────────────────────────

const STATS = [
  { to: 60, suffix: "s", l: "queue drain interval" },
  { to: 35, suffix: "+", l: "autonomous jobs, 24/7" },
  { to: 9, suffix: "", l: "channels, one cockpit" },
  { to: 0, suffix: "", l: "tabs of busywork" },
];

const MODULES = [
  {
    icon: Bot,
    k: "Autonomous Agents",
    d: "Agents that plan, code, ship — and run your growth ops. Give them a goal and they do the reps: campaigns, content, tickets, syncs. Approval gates when you want them.",
  },
  {
    icon: Network,
    k: "Outbound",
    d: "Campaigns ranked by reply rate, multi-sender across email + LinkedIn, AI reply drafts, sequence control. Stop guessing which campaign works — we rank them.",
  },
  {
    icon: Activity,
    k: "Inbound",
    d: "Every mention, demo, and deal — captured, attributed, scored. Share-of-voice across LLMs, pipeline + funnel sync, review monitoring. Signal, not noise.",
  },
  {
    icon: PenTool,
    k: "Content Studio",
    d: "Idea → published, on rails. Mine Reddit, YouTube + competitors for trends, auto-draft blog & LinkedIn, schedule, then track GSC rank and gaps. The flywheel runs itself.",
  },
  {
    icon: BarChart3,
    k: "Revenue",
    d: "Attribution that isn't a guess. Forecast, renewals, GST invoicing, win/loss. Know what's driving revenue — and what's about to churn — before it does.",
  },
  {
    icon: CheckSquare,
    k: "Work OS",
    d: "Issues, routines, goals, approvals — humans and agents in one surface. The orchestration layer that schedules, assigns, and drives every engine above.",
  },
];

const SURFACES = [
  "Campaigns", "Inbox", "Pipeline", "Mentions", "Blog", "LinkedIn", "YouTube",
  "Experiments", "Buckets", "Attribution", "Forecast", "Renewals", "Win/Loss",
  "Personas", "ICPs", "Agents", "Issues", "Routines", "Goals", "Approvals",
  "Activity", "Costs", "Human Team", "Adapters", "Secrets", "Search",
];

const TESTIMONIALS = [
  {
    quote: "Finally — one place where campaigns, pipeline, and agents all talk to each other. We cut 4 tools in the first week.",
    name: "Yuvraj S.",
    role: "Co-founder",
    metric: "4 tools cut",
  },
  {
    quote: "The outbound loop runs while I sleep. By morning I have ranked campaigns, drafted replies, and synced deals — without touching anything.",
    name: "Diggi H.",
    role: "Founder",
    metric: "Mornings reclaimed",
  },
  {
    quote: "Content gap → blog idea → LinkedIn hook → YouTube title. One research run, three channels. The repurpose job is witchcraft.",
    name: "Aditya K.",
    role: "Head of Growth",
    metric: "3× content output",
  },
];

const TRUSTED_LOGOS = [
  { name: "Snazzy", file: "/customers/snazzy.svg", h: "h-6" },
  { name: "Orbit Wallet", file: "/customers/orbit.svg", h: "h-7" },
  { name: "Frinks AI", file: "/customers/frinks.svg", h: "h-6" },
  { name: "RocketSDR", file: "/customers/rocketsdr.svg", h: "h-5" },
  { name: "PBS", file: "/customers/pbs.svg", h: "h-7" },
  { name: "Tofa", file: "/customers/tofa.svg", h: "h-6" },
];

const INTEGRATIONS = [
  { name: "HubSpot", abbr: "HS" },
  { name: "Google Search Console", abbr: "GSC" },
  { name: "Gemini AI", abbr: "GEM" },
  { name: "PostHog", abbr: "PH" },
  { name: "SerpAPI", abbr: "SERP" },
  { name: "Slack", abbr: "SLK" },
  { name: "LinkedIn", abbr: "LI" },
  { name: "Claude AI", abbr: "CLX" },
];

const LOOP = [
  { icon: Zap, t: "Drain", d: "Event queue flushed every 60s — nothing sits." },
  { icon: Network, t: "Sync", d: "CRM, GSC, mentions, Rocket — pulled on schedule." },
  { icon: PenTool, t: "Draft & ship", d: "Blog, LinkedIn, PRs — written and merged while you sleep." },
  { icon: Gauge, t: "Observe", d: "Attribution, costs, anomalies — flagged before they bite." },
];

const FAQS = [
  {
    q: "What is All Gas No Brakes?",
    a: "Your entire growth engine — outbound, inbound, content, revenue — plus an autonomous agent platform that runs it. One cockpit; the agents do the reps across every channel and your dev work too.",
  },
  {
    q: "Does it really run itself?",
    a: "Yes. 35 scheduled jobs fire around the clock — draining queues, syncing CRMs, drafting content, ranking campaigns, planning tickets, reconciling attribution. You make the calls; it does the work.",
  },
  {
    q: "Is this a marketing tool or a dev tool?",
    a: "Both, fused. AGNB's full growth stack (campaigns, pipeline, content, revenue) and an agent orchestration layer (issues, routines, goals, approvals) live in one surface — and cross-pollinate: an agent can run a campaign, a routine can ship a PR.",
  },
  {
    q: "What does the human actually do?",
    a: "Set direction. Review what matters. Approve what needs approving. The rest floors it on its own.",
  },
];

// ─── Layout helpers ───────────────────────────────────────────────────────────

function Section({
  children,
  className = "",
  id,
}: {
  children: React.ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={`mx-auto max-w-6xl px-6 ${className}`}>{children}</section>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-3 flex items-center gap-2 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-[#f97316]">
      <span className="h-px w-6 bg-[#f97316]/50" />
      {children}
    </p>
  );
}

// ─── Nav ──────────────────────────────────────────────────────────────────────

const NAV_LINKS = [
  { label: "How it runs", href: "#how" },
  { label: "Integrations", href: "#integrations" },
  { label: "FAQ", href: "#faq" },
];

const ENGINES = [
  "Autonomous Agents", "Outbound", "Inbound", "Content Studio", "Revenue", "Work OS",
];

function LandingNav() {
  const [scrolled, setScrolled] = useState(false);
  const [enginesOpen, setEnginesOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const { theme, toggleTheme } = useTheme();

  useEffect(() => {
    const el = document.querySelector(".agnb-scroll");
    const onScroll = () => setScrolled((el?.scrollTop ?? window.scrollY) > 16);
    el?.addEventListener("scroll", onScroll);
    window.addEventListener("scroll", onScroll);
    return () => {
      el?.removeEventListener("scroll", onScroll);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  const linkCls = "rounded-md px-3 py-2 text-[13.5px] font-medium text-gray-500 dark:text-neutral-400 transition hover:text-gray-900 dark:hover:text-neutral-100";

  return (
    <header
      className={cn(
        "sticky top-0 z-50 w-full backdrop-blur-xl transition-all",
        scrolled ? "border-b border-black/[0.06] dark:border-white/[0.06] bg-[#F6F3EC]/80 dark:bg-neutral-950/80" : "border-b border-transparent bg-transparent",
      )}
    >
      <div className="relative mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <a href="#top" className="flex items-center">
          <img src="/logo-full.svg" alt="All Gas No Brakes" className="h-11 w-auto" />
        </a>

        {/* Center nav */}
        <nav className="absolute left-1/2 top-1/2 hidden -translate-x-1/2 -translate-y-1/2 items-center gap-1 lg:flex">
          <div
            className="relative"
            onMouseEnter={() => setEnginesOpen(true)}
            onMouseLeave={() => setEnginesOpen(false)}
          >
            <button className="flex items-center gap-1 rounded-md px-3 py-2 text-[13.5px] font-medium text-gray-500 dark:text-neutral-400 transition hover:text-gray-900 dark:hover:text-neutral-100">
              Engines
              <ChevronRight className={cn("size-3.5 transition", enginesOpen ? "rotate-90" : "")} />
            </button>
            {enginesOpen && (
              <div className="absolute left-1/2 top-full w-56 -translate-x-1/2 pt-2">
                <div className="overflow-hidden rounded-xl border border-black/[0.08] dark:border-white/[0.08] bg-white dark:bg-neutral-900 p-1.5 shadow-xl">
                  {ENGINES.map((e) => (
                    <a
                      key={e}
                      href="#cockpit"
                      className="flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] text-gray-600 dark:text-neutral-400 transition hover:bg-[#FAF8F4] dark:bg-neutral-900 dark:hover:bg-neutral-800 hover:text-gray-900 dark:hover:text-neutral-100"
                    >
                      <span className="size-1.5 rounded-full bg-[#f97316]/60" />
                      {e}
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
          {NAV_LINKS.map((l) => (
            <a key={l.href} href={l.href} className={linkCls}>{l.label}</a>
          ))}
        </nav>

        {/* Right */}
        <div className="flex items-center gap-2.5">
          <button
            onClick={toggleTheme}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            className="inline-flex size-9 items-center justify-center rounded-md text-gray-500 transition hover:bg-black/[0.04] hover:text-gray-900 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-neutral-100"
          >
            {theme === "dark" ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}
          </button>
          <a
            href="mailto:diggi@hirefinn.ai?subject=AGNB%20Access%20Request"
            className="hidden rounded-md px-3.5 py-2 text-[13px] font-medium text-gray-600 dark:text-neutral-400 transition hover:text-gray-900 dark:hover:text-neutral-100 sm:inline-flex"
          >
            Request access
          </a>
          <a
            href="#signin"
            className="rounded-md bg-[#f97316] px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-[#ea6a0c]"
          >
            Sign in
          </a>
          <button
            onClick={() => setMobileOpen((v) => !v)}
            className="inline-flex size-9 items-center justify-center rounded-md text-gray-600 dark:text-neutral-400 transition hover:text-gray-900 dark:hover:text-neutral-100 lg:hidden"
            aria-label="menu"
          >
            {mobileOpen ? <Minus className="size-5" /> : <Plus className="size-5" />}
          </button>
        </div>
      </div>

      {mobileOpen && (
        <div className="border-t border-black/[0.06] dark:border-white/[0.06] bg-[#F6F3EC]/95 dark:bg-neutral-950/95 px-6 py-3 backdrop-blur lg:hidden">
          {[{ label: "Engines", href: "#cockpit" }, ...NAV_LINKS].map((l) => (
            <a
              key={l.href}
              href={l.href}
              onClick={() => setMobileOpen(false)}
              className="block py-2.5 text-[15px] font-medium text-gray-600 dark:text-neutral-400 transition hover:text-gray-900 dark:hover:text-neutral-100"
            >
              {l.label}
            </a>
          ))}
        </div>
      )}
    </header>
  );
}

function Faq({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      onClick={() => setOpen((v) => !v)}
      className="w-full border-b border-black/[0.08] dark:border-white/[0.08] py-5 text-left"
    >
      <div className="flex items-center justify-between gap-4">
        <span className="text-[16px] font-semibold text-gray-900 dark:text-neutral-100">{q}</span>
        {open ? (
          <Minus className="size-4 shrink-0 text-[#f97316]" />
        ) : (
          <Plus className="size-4 shrink-0 text-gray-400 dark:text-neutral-500" />
        )}
      </div>
      {open && (
        <p className="mt-3 max-w-2xl text-[14.5px] leading-relaxed text-gray-500 dark:text-neutral-400">
          {a}
        </p>
      )}
    </button>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function LandingPage() {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const nextPath = useMemo(
    () => searchParams.get("next") || getRememberedInvitePath() || "/",
    [searchParams],
  );

  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });

  const isAuthMode = healthQuery.data?.deploymentMode === "authenticated";
  const isLocalTrusted = healthQuery.data?.deploymentMode === "local_trusted";

  const { data: session, isLoading: isSessionLoading } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: isAuthMode,
    retry: false,
  });

  useEffect(() => {
    if (isAuthMode && session) {
      navigate(nextPath, { replace: true });
    }
  }, [isAuthMode, session, navigate, nextPath]);

  void queryClient;

  const isLoading = healthQuery.isLoading || (isAuthMode && isSessionLoading);

  if (isLoading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-[#F6F3EC] dark:bg-neutral-950">
        <p className="text-sm text-gray-500 dark:text-neutral-400">Loading…</p>
      </div>
    );
  }

  return (
    <div
      className="agnb-scroll h-screen overflow-y-auto bg-[#F6F3EC] dark:bg-neutral-950 text-gray-900 dark:text-neutral-100 antialiased"
      style={{ overflowX: "clip" }}
      id="top"
    >
      <style>{`
        @keyframes agnb-marquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }
        .agnb-marquee { animation: agnb-marquee 30s linear infinite; }
        @keyframes agnb-rev { 0%,100% { transform: scaleY(0.35) } 50% { transform: scaleY(1) } }
        .agnb-rev-bar { display:block; width:2px; height:13px; border-radius:9999px; background:currentColor; transform-origin:bottom; animation: agnb-rev 0.9s ease-in-out infinite; }
      `}</style>

      <LandingNav />

      {/* ── Hero (centered, Finn-style) ── */}
      <Section className="relative pb-12 pt-12 text-center sm:pt-16">
        {/* warm glow */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[420px]"
          style={{
            background:
              "radial-gradient(60% 60% at 50% 0%, rgba(249,115,22,0.10) 0%, transparent 70%)",
          }}
        />

        {/* Announcement pill */}
        <a
          href="#cockpit"
          className="mb-7 inline-flex items-center gap-3 rounded-full border border-black/[0.08] dark:border-white/[0.08] bg-white dark:bg-neutral-900 px-1.5 py-1.5 pr-5 text-[14px] text-gray-800 dark:text-neutral-200 shadow-sm transition hover:shadow"
        >
          <span className="inline-flex items-center gap-[2px] rounded-full bg-[#f97316]/10 px-3 py-1.5 text-[#f97316]">
            <span className="agnb-rev-bar" style={{ animationDelay: "0ms" }} />
            <span className="agnb-rev-bar" style={{ animationDelay: "120ms" }} />
            <span className="agnb-rev-bar" style={{ animationDelay: "240ms" }} />
            <span className="agnb-rev-bar" style={{ animationDelay: "360ms" }} />
          </span>
          <span className="font-medium">New: agents now run your full growth stack.</span>
        </a>

        {/* Headline */}
        <h1 className="mx-auto max-w-[920px] text-[clamp(46px,7vw,80px)] font-extrabold leading-[1.0] tracking-[-0.04em] text-gray-900 dark:text-neutral-100">
          Your growth engine.
          <span
            className="mt-1.5 block bg-gradient-to-r from-amber-500 via-orange-500 to-red-600 bg-clip-text font-medium text-transparent"
            style={SERIF}
          >
            All gas, no brakes.
          </span>
        </h1>

        {/* Subtitle */}
        <p className="mx-auto mb-8 mt-6 max-w-[680px] text-[19px] leading-[1.55] text-gray-500 dark:text-neutral-400">
          Outbound, inbound, content, and revenue — run by autonomous agents in
          one cockpit. They do the reps across every channel and your dev work
          too, while you sleep. Twelve dashboards become one.
        </p>

        {/* CTAs */}
        <div className="inline-flex flex-wrap items-center justify-center gap-3">
          <a
            href="#signin"
            className="group inline-flex items-center gap-2 rounded-lg bg-[#f97316] px-7 py-3.5 text-sm font-semibold text-white transition hover:bg-[#ea6a0c]"
          >
            Floor it <ArrowRight className="size-4 transition group-hover:translate-x-0.5" />
          </a>
          <a
            href="#how"
            className="inline-flex items-center gap-2 rounded-lg border border-black/[0.12] dark:border-white/15 bg-white dark:bg-neutral-900 px-7 py-3.5 text-sm font-semibold text-gray-900 dark:text-neutral-100 transition hover:bg-[#FAF8F4] dark:bg-neutral-900 dark:hover:bg-neutral-800"
          >
            Watch it run
          </a>
        </div>
        <p className="mt-4 text-[12.5px] text-gray-400 dark:text-neutral-500">
          Invite-only beta · No credit card needed · Setup in under 2 minutes
        </p>

        {/* Product shot — live console */}
        <div className="mx-auto mt-14 max-w-4xl">
          <LiveConsole />
        </div>
      </Section>

      {/* ── Trusted by (real Finn customer logos) ── */}
      <Section className="py-12">
        <p className="mb-8 text-center font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-400 dark:text-neutral-500">
          From the team behind <span className="text-gray-700 dark:text-neutral-300">Finn</span> — trusted in production by
        </p>
        <div className="flex flex-wrap items-center justify-center gap-x-12 gap-y-7 opacity-60 grayscale transition hover:opacity-100 hover:grayscale-0 sm:gap-x-16">
          {TRUSTED_LOGOS.map((l) => (
            <img key={l.name} src={l.file} alt={l.name} className={cn(l.h, "w-auto object-contain")} />
          ))}
        </div>
      </Section>

      {/* ── Stats ── */}
      <Section className="border-y border-black/[0.06] dark:border-white/[0.06] py-14">
        <div className="grid grid-cols-2 gap-8 sm:grid-cols-4">
          {STATS.map((s) => (
            <div key={s.l} className="text-center">
              <div className="text-[clamp(36px,4.4vw,56px)] font-extrabold tracking-tight text-[#f97316]">
                <CountUp to={s.to} suffix={s.suffix} />
              </div>
              <div className="mt-1 text-[13px] leading-snug text-gray-500 dark:text-neutral-400">{s.l}</div>
            </div>
          ))}
        </div>
      </Section>

      {/* ── Problem ── */}
      <Section className="py-20">
        <h2 className="max-w-3xl text-[clamp(30px,3.8vw,46px)] font-bold leading-[1.08] tracking-[-0.025em] text-gray-900 dark:text-neutral-100">
          Growth tooling is bloated, siloed, and slow.{" "}
          <span className="text-gray-400 dark:text-neutral-500">You weren't hired to babysit twelve dashboards.</span>
        </h2>
        <p className="mt-6 max-w-2xl text-[17px] leading-relaxed text-gray-500 dark:text-neutral-400">
          Brakes are for people who second-guess. We strip the busywork, wire
          every channel and your dev work into one surface, and hand the grind to
          agents that never clock out. You set the goal. They floor it.
        </p>
      </Section>

      {/* ── Testimonials ── */}
      <Section className="py-12">
        <Eyebrow>From the crew</Eyebrow>
        <h2 className="mb-10 text-[clamp(26px,3.2vw,40px)] font-bold tracking-[-0.02em] text-gray-900 dark:text-neutral-100">
          Real teams. Real momentum.
        </h2>
        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
          {TESTIMONIALS.map((t) => (
            <div key={t.name} className="flex flex-col justify-between rounded-2xl border border-black/[0.07] dark:border-white/[0.08] bg-white dark:bg-neutral-900 p-6 shadow-sm">
              <p className="text-[15px] leading-relaxed text-gray-700 dark:text-neutral-300">&ldquo;{t.quote}&rdquo;</p>
              <div className="mt-6 flex items-center justify-between">
                <div>
                  <p className="text-[13px] font-semibold text-gray-900 dark:text-neutral-100">{t.name}</p>
                  <p className="text-[12px] text-gray-500 dark:text-neutral-400">{t.role}</p>
                </div>
                <span className="rounded-full border border-[#f97316]/25 bg-[#f97316]/10 px-3 py-1 font-mono text-[11px] font-medium text-[#f97316]">
                  {t.metric}
                </span>
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* ── Modules ── */}
      <Section className="scroll-mt-20 py-12" id="cockpit">
        <Eyebrow>The cockpit</Eyebrow>
        <h2 className="mb-10 text-[clamp(28px,3.4vw,42px)] font-bold tracking-[-0.02em] text-gray-900 dark:text-neutral-100">
          Six engines. One throttle.
        </h2>
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
          {MODULES.map((m) => (
            <div key={m.k} className="group rounded-2xl border border-black/[0.07] dark:border-white/[0.08] bg-white dark:bg-neutral-900 p-7 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
              <div className="mb-4 flex size-11 items-center justify-center rounded-xl bg-[#f97316]/10 text-[#f97316]">
                <m.icon className="size-5" />
              </div>
              <h3 className="mb-2 text-[18px] font-semibold text-gray-900 dark:text-neutral-100">{m.k}</h3>
              <p className="text-[14px] leading-relaxed text-gray-500 dark:text-neutral-400">{m.d}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* ── How it runs ── */}
      <Section className="scroll-mt-20 py-20" id="how">
        <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-2">
          <div>
            <Eyebrow>
              <span className="inline-flex items-center gap-1.5">
                <GitBranch className="size-3.5" /> It runs while you sleep
              </span>
            </Eyebrow>
            <h2 className="max-w-md text-[clamp(26px,3.2vw,40px)] font-bold tracking-[-0.02em] text-gray-900 dark:text-neutral-100">
              The pipeline never goes cold.
            </h2>
            <p className="mt-4 max-w-md text-[16px] leading-relaxed text-gray-500 dark:text-neutral-400">
              35 jobs + your agents fire on schedule or on demand — campaigns,
              content, syncs, PRs. Watch the real loop — drain, sync, draft,
              observe — running nonstop.
            </p>
            <div className="mt-8 grid grid-cols-2 gap-6">
              {LOOP.map((s, i) => (
                <div key={s.t}>
                  <div className="mb-2 flex items-center gap-2">
                    <span className="flex size-8 items-center justify-center rounded-lg bg-[#f97316]/10 text-[#f97316]">
                      <s.icon className="size-4" />
                    </span>
                    <span className="font-mono text-[11px] text-gray-400 dark:text-neutral-500">0{i + 1}</span>
                  </div>
                  <h4 className="text-[14px] font-semibold text-gray-900 dark:text-neutral-100">{s.t}</h4>
                  <p className="mt-0.5 text-[12.5px] leading-snug text-gray-500 dark:text-neutral-400">{s.d}</p>
                </div>
              ))}
            </div>
          </div>
          <LiveConsole />
        </div>
      </Section>

      {/* ── Surfaces ── */}
      <Section className="py-12">
        <Eyebrow>Everything in the cockpit</Eyebrow>
        <h2 className="mb-8 max-w-2xl text-[clamp(26px,3.2vw,40px)] font-bold tracking-[-0.02em] text-gray-900 dark:text-neutral-100">
          One login. Every surface. <span className="text-gray-400 dark:text-neutral-500">Zero tab-hopping.</span>
        </h2>
        <div className="flex flex-wrap gap-2.5">
          {SURFACES.map((s) => (
            <span
              key={s}
              className="rounded-lg border border-black/[0.08] dark:border-white/[0.08] bg-white dark:bg-neutral-900 px-3 py-1.5 font-mono text-[12px] text-gray-600 dark:text-neutral-400 transition hover:border-[#f97316]/40 hover:text-gray-900 dark:hover:text-neutral-100"
            >
              {s}
            </span>
          ))}
          <span className="rounded-lg border border-[#f97316]/30 bg-[#f97316]/5 px-3 py-1.5 font-mono text-[12px] text-[#f97316]">
            + more
          </span>
        </div>
      </Section>

      {/* ── Comparison ── */}
      <Section className="py-16">
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <div className="rounded-2xl border border-black/[0.07] dark:border-white/[0.08] bg-white dark:bg-neutral-900 p-8">
            <p className="mb-4 font-mono text-[12px] font-semibold uppercase tracking-wider text-gray-400 dark:text-neutral-500">
              The old way
            </p>
            <ul className="space-y-3 text-[14px] text-gray-400 dark:text-neutral-500">
              {[
                "12 tabs: CRM, Rocket, GSC, Jira, Slack — context lost",
                "Manual CRM syncs + campaign checks at 11pm",
                "Guessing which campaign (or agent) actually worked",
                "Content stuck in drafts; PRs sitting for days",
                "Attribution? A spreadsheet prayer",
              ].map((x) => (
                <li key={x} className="flex gap-2 line-through decoration-gray-300 dark:decoration-neutral-700">
                  <span className="text-gray-300">—</span>
                  {x}
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-2xl border border-[#f97316]/20 bg-[#f97316]/[0.04] p-8">
            <p className="mb-4 font-mono text-[12px] font-semibold uppercase tracking-wider text-[#f97316]">
              All gas
            </p>
            <ul className="space-y-3 text-[14px] text-gray-800 dark:text-neutral-200">
              {[
                "Campaigns, pipeline, content, code — one cockpit, one login",
                "Agents + 35 jobs run the channels 24/7",
                "Campaigns ranked by reply rate; PRs merged on green",
                "Drafts written + scheduled on autopilot",
                "Attribution reconciled automatically",
              ].map((x) => (
                <li key={x} className="flex gap-2">
                  <ChevronRight className="mt-0.5 size-4 shrink-0 text-[#f97316]" />
                  {x}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      {/* ── Integrations ── */}
      <Section className="scroll-mt-20 py-16" id="integrations">
        <Eyebrow>Works with your stack</Eyebrow>
        <h2 className="mb-8 text-[clamp(24px,3vw,38px)] font-bold tracking-[-0.02em] text-gray-900 dark:text-neutral-100">
          Drop it in. Nothing breaks.
        </h2>
        <div className="flex flex-wrap gap-3">
          {INTEGRATIONS.map((i) => (
            <div key={i.name} className="flex items-center gap-2.5 rounded-xl border border-black/[0.08] dark:border-white/[0.08] bg-white dark:bg-neutral-900 px-4 py-2.5 transition hover:border-[#f97316]/40">
              <span className="flex size-6 items-center justify-center rounded bg-[#f97316]/10 font-mono text-[10px] font-bold text-[#f97316]">
                {i.abbr}
              </span>
              <span className="text-[13px] font-medium text-gray-700 dark:text-neutral-300">{i.name}</span>
            </div>
          ))}
        </div>
        <p className="mt-4 text-[12.5px] text-gray-500 dark:text-neutral-400">
          + HubSpot webhooks, GSC property, PostHog events, Slack alerts, LinkedIn API, and more out of the box.
        </p>
      </Section>

      {/* ── Manifesto ── */}
      <Section className="py-16">
        <div className="grid grid-cols-1 gap-8 md:grid-cols-[auto_1fr] md:items-center">
          <Gauge className="size-10 text-[#f97316]" />
          <blockquote className="text-[clamp(24px,3vw,36px)] font-semibold leading-[1.2] tracking-[-0.02em] text-gray-900 dark:text-neutral-100">
            &ldquo;Ship fast, measure everything, automate the rest.
            <span className="text-gray-400 dark:text-neutral-500">
              {" "}The competition is still scheduling a meeting about it.&rdquo;
            </span>
          </blockquote>
        </div>
      </Section>

      {/* ── FAQ ── */}
      <Section className="scroll-mt-20 py-12" id="faq">
        <Eyebrow>Questions</Eyebrow>
        <div className="mt-2">
          {FAQS.map((f) => (
            <Faq key={f.q} {...f} />
          ))}
        </div>
      </Section>

      {/* ── Sign in (moved out of hero) ── */}
      <Section className="py-20">
        <div className="grid grid-cols-1 items-center gap-12 rounded-3xl border border-black/[0.07] dark:border-white/[0.08] bg-white dark:bg-neutral-900 p-8 shadow-sm sm:p-12 lg:grid-cols-2">
          <div>
            <Eyebrow>Your instance. Your agents.</Eyebrow>
            <h2 className="text-[clamp(30px,3.6vw,48px)] font-bold tracking-[-0.025em] text-gray-900 dark:text-neutral-100">
              Get in and floor it.
            </h2>
            <p className="mt-4 max-w-md text-[16px] leading-relaxed text-gray-500 dark:text-neutral-400">
              Sign in and let the agents do the work — outbound, content,
              pipeline, and code, running on their own.
            </p>
            {isLocalTrusted && (
              <button
                onClick={() => navigate(nextPath, { replace: true })}
                className="mt-6 text-[13px] text-gray-500 dark:text-neutral-400 transition hover:text-gray-900 dark:hover:text-neutral-100"
              >
                Skip — enter without signing in →
              </button>
            )}
          </div>
          <div className="flex justify-center lg:justify-end">
            <LoginCard nextPath={nextPath} />
          </div>
        </div>
      </Section>

      {/* ── Footer ── */}
      <footer className="border-t border-black/[0.07] dark:border-white/[0.08]">
        <Section className="flex flex-col items-center justify-between gap-3 py-8 sm:flex-row">
          <div className="flex items-center gap-2 text-[13px] text-gray-500 dark:text-neutral-400">
            <img src="/favicon.svg" alt="" className="h-4 w-4" aria-hidden="true" />
            All Gas No Brakes
          </div>
          <div className="font-mono text-[12px] text-gray-400 dark:text-neutral-500">© 2026 · built in stealth</div>
        </Section>
      </footer>
    </div>
  );
}
