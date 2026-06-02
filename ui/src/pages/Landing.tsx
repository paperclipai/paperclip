import { useEffect, useRef, useState, useMemo } from "react";
import { useNavigate, useSearchParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authApi } from "@/api/auth";
import { healthApi } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";
import { getRememberedInvitePath } from "@/lib/invite-memory";
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
  Network,
  PenTool,
  Plus,
  Sparkles,
  Target,
  Terminal,
  Users,
  Zap,
} from "lucide-react";

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
    "rounded-md border border-border bg-background px-4 py-3 text-base text-foreground placeholder:text-muted-foreground focus:border-[#86c277] focus:outline-none";

  return (
    <div
      id="signin"
      className="w-full max-w-md rounded-2xl border border-border bg-card/70 p-6 shadow-2xl backdrop-blur sm:p-8"
    >
      <div className="mb-5 flex items-center justify-between">
        <div>
          <p className="font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-[#86c277]">
            {mode === "sign_in" ? "Sign in" : "Create account"}
          </p>
          <h2 className="mt-1 text-lg font-semibold text-foreground">
            {mode === "sign_in" ? "Instance access" : "Join the crew"}
          </h2>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[#86c277]/30 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-[#86c277]">
          <span className="size-1.5 animate-pulse rounded-full bg-[#86c277]" /> live
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
        {error && <p className="text-[13px] text-destructive">{error}</p>}
        <button
          type="submit"
          disabled={mutation.isPending || !canSubmit}
          className="group inline-flex items-center justify-center gap-2 rounded-md bg-[#86c277] px-6 py-3 text-sm font-semibold text-[#0A0A0A] transition hover:bg-[#a3d98f] disabled:opacity-50"
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
        className="mt-3 block w-full text-center text-[13px] text-muted-foreground transition hover:text-foreground"
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

// ─── Live console ─────────────────────────────────────────────────────────────

const JOB_FEED = [
  "agent-runner ✓ — PR merged in 4m",
  "issue-planner ✓ — 7 subtasks scaffolded",
  "code-review ✓ — 3 issues surfaced",
  "routine-sync ✓ — 12 agents checked in",
  "test-runner ✓ — 94/94 passing",
  "goal-tracker ✓ — 2 milestones closed",
  "inbox-triage ✓ — 8 tasks dispatched",
  "deploy-check ✓ — staging green",
  "cost-sweep ✓ — $0.34 this run",
  "approval-gate ✓ — 1 decision queued",
  "workspace-sync ✓ — env patched",
  "agent-heartbeat ✓ — all systems nominal",
];

function LiveConsole() {
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    let i = 0;
    const id = setInterval(() => {
      setLines((prev) => {
        const next = [...prev, JOB_FEED[i % JOB_FEED.length]];
        i++;
        return next.slice(-7);
      });
    }, 1100);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-background font-mono text-[12.5px] shadow-2xl">
      <div className="flex items-center gap-2 border-b border-border bg-card px-4 py-2.5">
        <span className="size-2.5 rounded-full bg-red-500/70" />
        <span className="size-2.5 rounded-full bg-yellow-500/70" />
        <span className="size-2.5 rounded-full bg-[#86c277]/80" />
        <span className="ml-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Terminal className="size-3" /> paperclip-worker · live
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[#86c277]">
          <span className="size-1.5 animate-pulse rounded-full bg-[#86c277]" /> running
        </span>
      </div>
      <div className="h-[200px] space-y-1.5 p-4">
        {lines.length === 0 && (
          <div className="text-muted-foreground">booting worker…</div>
        )}
        {lines.map((l, idx) => (
          <div
            key={idx}
            className="flex gap-2"
            style={{
              opacity: 0.5 + (idx / Math.max(lines.length - 1, 1)) * 0.5,
            }}
          >
            <span className="text-muted-foreground">›</span>
            <span className="text-foreground/80">{l}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Data ─────────────────────────────────────────────────────────────────────

const TICKER = [
  "Autonomous Agents",
  "Tasks",
  "Routines",
  "Goals",
  "Projects",
  "Approvals",
  "Inbox",
  "Activity",
  "Costs",
  "Search",
  "Environments",
  "Plugins",
  "Adapters",
  "Human Team",
];

const STATS = [
  { to: 60, suffix: "s", l: "task dispatch interval" },
  { to: 35, suffix: "+", l: "agent types, 24/7" },
  { to: 9, suffix: "", l: "adapter integrations" },
  { to: 0, suffix: "", l: "standups required" },
];

const MODULES = [
  {
    icon: Bot,
    k: "Autonomous Agents",
    d: "Agents that plan, code, test, and ship. Give them a goal and get out of the way. Full execution logs, per-task workspaces, and approval gates when you want them.",
  },
  {
    icon: CheckSquare,
    k: "Tasks & Issues",
    d: "Full project management wired to your agents. Subtasks, priorities, assignees, timelines. Agents create and close tickets themselves — no manual triaging.",
  },
  {
    icon: Zap,
    k: "Routines",
    d: "Scheduled agents that never sleep. Set the cadence, define the job, and watch the queue drain itself every minute. No cron, no babysitting.",
  },
  {
    icon: Target,
    k: "Goals & Projects",
    d: "Top-down alignment, bottom-up execution. Goals break into projects, projects into tasks, tasks into agent runs. Strategy meets autonomy.",
  },
  {
    icon: Users,
    k: "Human Team",
    d: "AI and human work in one surface. Assign tasks to people or agents. Approval gates, comment threads, and activity feeds keep everyone in the loop.",
  },
  {
    icon: BarChart3,
    k: "Activity & Costs",
    d: "Full observability over every agent run. Duration, token cost, tool calls, outcomes. Know what shipped, what it cost, and what to optimize next.",
  },
];

const SURFACES = [
  "Tasks",
  "Issues",
  "Goals",
  "Projects",
  "Agents",
  "Routines",
  "Approvals",
  "Inbox",
  "Dashboard",
  "Activity",
  "Costs",
  "Search",
  "Workspaces",
  "Documents",
  "Company",
  "Human Team",
  "Adapters",
  "Plugins",
  "Environments",
  "Secrets",
  "Instance",
  "Tokens",
  "Webhooks",
  "Settings",
];

const LOOP = [
  { icon: Zap, t: "Dispatch", d: "Tasks hit the queue. Agents pick up and plan." },
  { icon: Network, t: "Execute", d: "Code written, tests run, PRs opened." },
  { icon: PenTool, t: "Review", d: "Auto-review on CI green. Human gate when needed." },
  { icon: Gauge, t: "Observe", d: "Costs, outcomes, and logs — always visible." },
];

const FAQS = [
  {
    q: "Do agents really run unsupervised?",
    a: "Yes. Routines fire on schedule — draining queues, planning tasks, writing code, running tests. You set the goal; they do the reps. Approval gates give you control at exactly the checkpoints you care about.",
  },
  {
    q: "Is this just another project management tool?",
    a: "No. Other tools track work. Paperclip does work. The agents are the workers — your issue tracker is also your execution engine.",
  },
  {
    q: "How do agents get access to my codebase?",
    a: "Connect an adapter — Claude Code, Cursor, or any supported AI coding environment. Agents get isolated workspaces per task. No shared state, no collisions.",
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
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`mx-auto max-w-6xl px-6 ${className}`}>{children}</section>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-3 flex items-center gap-2 font-mono text-[12px] uppercase tracking-[0.18em] text-[#86c277]">
      <span className="h-px w-6 bg-[#86c277]/50" />
      {children}
    </p>
  );
}

function Faq({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      onClick={() => setOpen((v) => !v)}
      className="w-full border-b border-border py-5 text-left"
    >
      <div className="flex items-center justify-between gap-4">
        <span className="text-[16px] font-semibold text-foreground">{q}</span>
        {open ? (
          <Minus className="size-4 shrink-0 text-[#86c277]" />
        ) : (
          <Plus className="size-4 shrink-0 text-muted-foreground" />
        )}
      </div>
      {open && (
        <p className="mt-3 max-w-2xl text-[14px] leading-relaxed text-muted-foreground">
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

  // Only check session in authenticated mode — local_trusted has an implicit
  // session that would cause an immediate redirect, hiding the landing page.
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

  // suppress unused warning — queryClient used in LoginCard via closure
  void queryClient;

  const isLoading =
    healthQuery.isLoading || (isAuthMode && isSessionLoading);

  if (isLoading) {
    return (
      <div className="dark fixed inset-0 flex items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return (
    <div className="dark min-h-screen bg-background text-foreground antialiased" style={{ overflowX: "clip" }}>
      <style>{`
        @keyframes agnb-marquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }
        .agnb-marquee { animation: agnb-marquee 28s linear infinite; }
      `}</style>

      {/* Background glow */}
      <div
        className="pointer-events-none fixed inset-0 opacity-80"
        style={{
          background:
            "radial-gradient(50% 38% at 50% -5%, rgba(134,194,119,0.12) 0%, transparent 72%)",
        }}
      />
      {/* Speed grid */}
      <div
        className="pointer-events-none fixed inset-0 opacity-[0.03]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,.6) 1px, transparent 1px)",
          backgroundSize: "100% 64px",
        }}
      />

      <div className="relative">
        {/* ── Nav ── */}
        <header className="sticky top-0 z-50 border-b border-border/60 bg-background/80 backdrop-blur">
          <Section className="flex items-center justify-between py-4">
            <div className="flex items-center gap-2.5">
              <span className="text-xl">🔥</span>
              <div className="text-sm font-bold tracking-tight">All Gas No Brakes</div>
            </div>
            <div className="flex items-center gap-4">
              <span className="hidden items-center gap-1.5 rounded-full border border-border px-3 py-1 font-mono text-[11px] uppercase tracking-[0.1em] text-[#86c277] sm:inline-flex">
                <Sparkles className="size-3" /> Powered by Paperclip
              </span>
              <a
                href="#signin"
                className="rounded-md border border-border px-4 py-1.5 text-[13px] font-semibold text-foreground transition hover:border-[#86c277]"
              >
                Sign in
              </a>
            </div>
          </Section>
        </header>

        {/* ── Hero ── */}
        <Section className="grid grid-cols-1 items-center gap-12 pb-14 pt-12 lg:grid-cols-[1.1fr_0.9fr] lg:pt-20">
          <div>
            <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-[#86c277]/30 bg-[#86c277]/5 px-3 py-1 font-mono text-[12px] uppercase tracking-wider text-[#86c277]">
              <Activity className="size-3.5" /> Redline since day one
            </p>
            <h1 className="text-[clamp(46px,7.5vw,88px)] font-bold leading-[0.95] tracking-[-0.04em]">
              All gas,
              <br />
              <span className="text-[#86c277]">no brakes.</span>
            </h1>
            <p className="mt-6 max-w-xl text-[17px] leading-relaxed text-muted-foreground">
              Your engineers ship. Your agents never stop. Paperclip is the autonomous
              AI work platform that plans, codes, and closes tickets while you sleep —
              one cockpit for the whole engine.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <a
                href="#signin"
                className="group inline-flex items-center gap-2 rounded-md bg-[#86c277] px-6 py-3 text-sm font-semibold text-[#0A0A0A] transition hover:bg-[#a3d98f]"
              >
                Floor it{" "}
                <ArrowRight className="size-4 transition group-hover:translate-x-0.5" />
              </a>
              <a
                href="#how"
                className="inline-flex items-center gap-2 rounded-md border border-border px-6 py-3 text-sm font-semibold text-foreground transition hover:border-muted-foreground"
              >
                Watch it run
              </a>
            </div>
          </div>
          <div className="flex flex-col items-center gap-3 lg:items-end">
            <LoginCard nextPath={nextPath} />
            {isLocalTrusted && (
              <button
                onClick={() => navigate(nextPath, { replace: true })}
                className="text-[13px] text-muted-foreground transition hover:text-foreground"
              >
                Skip — enter without signing in →
              </button>
            )}
          </div>
        </Section>

        {/* ── Ticker ── */}
        <div className="border-y border-border bg-card/60 py-3">
          <div className="flex whitespace-nowrap">
            <div className="agnb-marquee flex shrink-0">
              {[...TICKER, ...TICKER].map((t, i) => (
                <span
                  key={i}
                  className="mx-6 inline-flex items-center gap-3 font-mono text-[12px] uppercase tracking-[0.14em] text-muted-foreground"
                >
                  {t} <span className="text-[#86c277]/60">/</span>
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* ── Stats ── */}
        <Section className="grid grid-cols-2 gap-px py-14 sm:grid-cols-4">
          {STATS.map((s) => (
            <div key={s.l} className="px-2 text-center">
              <div className="text-[clamp(34px,4.4vw,52px)] font-bold tracking-tight text-[#86c277]">
                <CountUp to={s.to} suffix={s.suffix} />
              </div>
              <div className="mt-1 text-[12.5px] leading-snug text-muted-foreground">
                {s.l}
              </div>
            </div>
          ))}
        </Section>

        {/* ── Problem ── */}
        <Section className="py-16">
          <h2 className="max-w-3xl text-[clamp(28px,3.6vw,44px)] font-bold leading-[1.08] tracking-[-0.025em]">
            AI tooling is fragmented, opaque, and slow.{" "}
            <span className="text-muted-foreground">
              You hired engineers to ship, not to babysit models.
            </span>
          </h2>
          <p className="mt-5 max-w-2xl text-[16px] leading-relaxed text-muted-foreground">
            Brakes are for people who second-guess. Paperclip strips the busywork,
            wires every agent into one surface, and hands the execution to workers
            that never clock out. You set the goal. They floor it.
          </p>
        </Section>

        {/* ── Modules ── */}
        <Section className="pb-8">
          <Eyebrow>The cockpit</Eyebrow>
          <h2 className="mb-10 text-[clamp(26px,3.2vw,38px)] font-bold tracking-[-0.02em]">
            Six engines. One throttle.
          </h2>
          <div className="grid grid-cols-1 gap-px overflow-hidden rounded-2xl border border-border bg-border md:grid-cols-2 lg:grid-cols-3">
            {MODULES.map((m) => (
              <div key={m.k} className="group bg-background p-7 transition hover:bg-card">
                <div className="mb-4 flex size-10 items-center justify-center rounded-lg border border-border bg-card text-[#86c277] transition group-hover:border-[#86c277]/40">
                  <m.icon className="size-5" />
                </div>
                <h3 className="mb-2 text-[17px] font-semibold text-foreground">{m.k}</h3>
                <p className="text-[13.5px] leading-relaxed text-muted-foreground">{m.d}</p>
              </div>
            ))}
          </div>
        </Section>

        {/* ── Live console ── */}
        <Section className="py-20">
          <div
            id="how"
            className="grid grid-cols-1 items-center gap-10 rounded-3xl border border-border bg-card/40 p-8 sm:p-12 lg:grid-cols-2"
          >
            <div>
              <Eyebrow>
                <span className="inline-flex items-center gap-1.5">
                  <GitBranch className="size-3.5" /> It runs while you sleep
                </span>
              </Eyebrow>
              <h2 className="max-w-md text-[clamp(24px,3vw,36px)] font-bold tracking-[-0.02em]">
                The pipeline never goes cold.
              </h2>
              <p className="mt-4 max-w-md text-[15px] leading-relaxed text-muted-foreground">
                Agents fire on schedule or on demand. Watch the real loop — dispatch,
                execute, review, observe — running nonstop.
              </p>
              <div className="mt-8 grid grid-cols-2 gap-5">
                {LOOP.map((s, i) => (
                  <div key={s.t}>
                    <div className="mb-2 flex items-center gap-2">
                      <span className="flex size-7 items-center justify-center rounded-md bg-[#86c277]/10 text-[#86c277]">
                        <s.icon className="size-4" />
                      </span>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        0{i + 1}
                      </span>
                    </div>
                    <h4 className="text-[14px] font-semibold text-foreground">{s.t}</h4>
                    <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground">
                      {s.d}
                    </p>
                  </div>
                ))}
              </div>
            </div>
            <LiveConsole />
          </div>
        </Section>

        {/* ── Capability breadth ── */}
        <Section className="py-12">
          <Eyebrow>Everything in the cockpit</Eyebrow>
          <h2 className="mb-8 max-w-2xl text-[clamp(24px,3vw,36px)] font-bold tracking-[-0.02em]">
            One login. Every surface.{" "}
            <span className="text-muted-foreground">Zero tab-hopping.</span>
          </h2>
          <div className="flex flex-wrap gap-2.5">
            {SURFACES.map((s) => (
              <span
                key={s}
                className="rounded-md border border-border bg-card px-3 py-1.5 font-mono text-[12px] text-muted-foreground transition hover:border-[#86c277]/40 hover:text-foreground"
              >
                {s}
              </span>
            ))}
            <span className="rounded-md border border-[#86c277]/30 bg-[#86c277]/5 px-3 py-1.5 font-mono text-[12px] text-[#86c277]">
              + more
            </span>
          </div>
        </Section>

        {/* ── Comparison ── */}
        <Section className="py-16">
          <div className="grid grid-cols-1 gap-px overflow-hidden rounded-2xl border border-border bg-border md:grid-cols-2">
            <div className="bg-background p-8">
              <p className="mb-4 font-mono text-[12px] uppercase tracking-wider text-muted-foreground">
                The old way
              </p>
              <ul className="space-y-3 text-[14px] text-muted-foreground">
                {[
                  "Jira + Slack + GitHub = 3 logins, context lost",
                  "Manual task assignment at standup",
                  "Wondering what the agent did overnight",
                  "PR reviews sitting for days",
                  "No idea what AI costs this sprint",
                ].map((x) => (
                  <li key={x} className="flex gap-2 line-through decoration-border">
                    <span className="text-border">—</span>
                    {x}
                  </li>
                ))}
              </ul>
            </div>
            <div className="bg-card/50 p-8">
              <p className="mb-4 font-mono text-[12px] uppercase tracking-wider text-[#86c277]">
                All gas
              </p>
              <ul className="space-y-3 text-[14px] text-foreground">
                {[
                  "Tasks, agents, code — one cockpit, one login",
                  "Agents self-assign and execute, 24/7",
                  "Full execution logs, always",
                  "Auto-review, human gate when needed",
                  "Cost tracked per agent, per task",
                ].map((x) => (
                  <li key={x} className="flex gap-2">
                    <ChevronRight className="mt-0.5 size-4 shrink-0 text-[#86c277]" />
                    {x}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Section>

        {/* ── Manifesto ── */}
        <Section className="py-16">
          <div className="grid grid-cols-1 gap-8 md:grid-cols-[auto_1fr] md:items-center">
            <Gauge className="size-10 text-[#86c277]" />
            <blockquote className="text-[clamp(22px,3vw,34px)] font-semibold leading-[1.2] tracking-[-0.02em] text-foreground">
              &ldquo;Deploy fast, approve what matters, automate the rest.
              <span className="text-muted-foreground">
                {" "}
                Your competition is still writing the Jira ticket.&rdquo;
              </span>
            </blockquote>
          </div>
        </Section>

        {/* ── FAQ ── */}
        <Section className="py-12">
          <Eyebrow>Questions</Eyebrow>
          <div className="mt-2">
            {FAQS.map((f) => (
              <Faq key={f.q} {...f} />
            ))}
          </div>
        </Section>

        {/* ── CTA ── */}
        <Section className="py-20">
          <div className="flex flex-col items-center rounded-3xl border border-[#86c277]/20 bg-[#86c277]/[0.04] px-6 py-14 text-center">
            <p className="font-mono text-[12px] uppercase tracking-[0.16em] text-[#86c277]">
              Your instance. Your agents.
            </p>
            <h2 className="mt-3 max-w-xl text-[clamp(28px,3.6vw,46px)] font-bold tracking-[-0.025em]">
              Get in and floor it.
            </h2>
            <p className="mt-4 max-w-md text-[15px] text-muted-foreground">
              Sign in to your Paperclip instance and let the agents do the work.
            </p>
            <div className="mt-8">
              <a
                href="#signin"
                className="group inline-flex items-center gap-2 rounded-md bg-[#86c277] px-7 py-3 text-sm font-semibold text-[#0A0A0A] transition hover:bg-[#a3d98f]"
              >
                Floor it{" "}
                <ArrowRight className="size-4 transition group-hover:translate-x-0.5" />
              </a>
            </div>
          </div>
        </Section>

        {/* ── Footer ── */}
        <footer className="border-t border-border">
          <Section className="flex flex-col items-center justify-between gap-3 py-8 sm:flex-row">
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <span>🔥</span> All Gas No Brakes · Paperclip
            </div>
            <div className="font-mono text-[12px] text-muted-foreground">
              © 2026 · built in stealth
            </div>
          </Section>
        </footer>
      </div>
    </div>
  );
}
