import { useEffect, useRef, useState, useMemo } from "react";
import { useNavigate, useSearchParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authApi } from "@/api/auth";
import { healthApi } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";
import { getRememberedInvitePath } from "@/lib/invite-memory";
import { cn } from "@/lib/utils";
import { useTheme } from "@/context/ThemeContext";
import { SiteNav } from "@/components/SiteNav";
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

// ─── Auth mode ───────────────────────────────────────────────────────────────

type AuthMode = "sign_in" | "sign_up";

export function LoginCard({ nextPath }: { nextPath: string }) {
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
    "rounded-lg border border-black/[0.1] dark:border-white/10 bg-[#FAF8F4] dark:bg-[#2f271f]/60 px-4 py-3 text-[15px] text-gray-900 dark:text-neutral-100 placeholder:text-gray-400 dark:placeholder:text-neutral-500 focus:border-[#f97316] focus:bg-white dark:focus:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-[#f97316]/20 transition";

  return (
    <div
      id="signin"
      className="w-full max-w-md rounded-2xl border border-black/[0.08] dark:border-white/[0.08] bg-white dark:bg-[#261f19] p-7 shadow-[0_8px_40px_rgba(0,0,0,0.06)] sm:p-8"
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
          className="group mt-1 inline-flex items-center justify-center gap-2 rounded-lg bg-[#f97316] px-6 py-3 text-sm font-semibold text-white transition hover:bg-[#ea6a0c] disabled:cursor-not-allowed"
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

// ─── Browser-chrome product shot ──────────────────────────────────────────────

function Shot({
  src,
  alt,
  url = "app.allgasnobrakes.online",
  className = "",
  eager = false,
}: {
  src: string;
  alt: string;
  url?: string;
  className?: string;
  eager?: boolean;
}) {
  return (
    <div className={cn("overflow-hidden rounded-xl border border-black/[0.1] bg-[#15110d] shadow-[0_30px_80px_-24px_rgba(0,0,0,0.5)] dark:border-white/10", className)}>
      <div className="flex items-center gap-2 border-b border-white/10 bg-[#1e1813] px-3.5 py-2.5">
        <span className="size-2.5 rounded-full bg-red-500/70" />
        <span className="size-2.5 rounded-full bg-yellow-500/70" />
        <span className="size-2.5 rounded-full bg-green-500/70" />
        <div className="ml-2 flex-1">
          <div className="mx-auto w-fit max-w-full rounded-md bg-white/[0.06] px-3 py-1 font-mono text-[10.5px] text-neutral-400">
            {url}
          </div>
        </div>
      </div>
      <img
        src={src}
        alt={alt}
        className="block w-full"
        loading={eager ? "eager" : "lazy"}
        // @ts-expect-error fetchpriority is valid HTML, not yet in React types
        fetchpriority={eager ? "high" : undefined}
      />
    </div>
  );
}

function FeatureRow({
  eyebrow,
  title,
  body,
  bullets,
  src,
  alt,
  flip = false,
}: {
  eyebrow: string;
  title: React.ReactNode;
  body: string;
  bullets: string[];
  src: string;
  alt: string;
  flip?: boolean;
}) {
  return (
    <div className={cn("relative grid grid-cols-1 items-center gap-10 lg:grid-cols-2 lg:gap-16", flip && "lg:[&>*:first-child]:order-2")}>
      {/* rail node — center spine */}
      <span className="absolute left-1/2 top-1/2 z-10 hidden size-3.5 -translate-x-1/2 -translate-y-1/2 items-center justify-center lg:flex">
        <span className="agnb-pulse-ring absolute inset-0 rounded-full bg-[#f97316]/40" />
        <span className="relative size-3.5 rounded-full border-2 border-white bg-[#f97316] dark:border-neutral-950" />
      </span>
      <div>
        <Eyebrow>{eyebrow}</Eyebrow>
        <h3 className="max-w-md text-[clamp(24px,2.8vw,34px)] font-bold leading-[1.1] tracking-[-0.02em] text-gray-900 dark:text-neutral-100">
          {title}
        </h3>
        <p className="mt-4 max-w-md text-[16px] leading-relaxed text-gray-500 dark:text-neutral-400">{body}</p>
        <ul className="mt-6 space-y-2.5">
          {bullets.map((b) => (
            <li key={b} className="flex items-start gap-2.5 text-[14px] text-gray-700 dark:text-neutral-300">
              <ChevronRight className="mt-0.5 size-4 shrink-0 text-[#f97316]" />
              {b}
            </li>
          ))}
        </ul>
      </div>
      <div className="relative">
        <div
          className="pointer-events-none absolute -inset-6 -z-10 opacity-60"
          style={{ background: "radial-gradient(50% 50% at 50% 50%, rgba(249,115,22,0.16) 0%, transparent 70%)" }}
        />
        <Shot src={src} alt={alt} />
      </div>
    </div>
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
    <div className="overflow-hidden rounded-2xl border border-black/10 bg-[#15110d] font-mono text-[12.5px] shadow-[0_24px_70px_-20px_rgba(0,0,0,0.45)]">
      <div className="flex items-center gap-2 border-b border-white/10 bg-[#1e1813] px-4 py-3">
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

// ─── Diagrams (custom, AGNB data) ─────────────────────────────────────────────

const cardCls = "rounded-2xl border border-black/[0.07] bg-white p-6 shadow-sm dark:border-white/[0.08] dark:bg-[#261f19]";

export function OrgChart() {
  const node = (role: string, agent: string, accent = false) => (
    <div className={cn(
      "rounded-xl border px-3.5 py-2.5 text-center",
      accent ? "border-[#f97316]/30 bg-[#f97316]/[0.06]" : "border-black/[0.08] bg-[#FAF8F4] dark:border-white/10 dark:bg-[#2f271f]/50",
    )}>
      <div className="text-[12.5px] font-semibold text-gray-900 dark:text-neutral-100">{role}</div>
      <div className="font-mono text-[10.5px] text-gray-400 dark:text-neutral-500">{agent}</div>
    </div>
  );
  const line = "h-5 w-px bg-black/10 dark:bg-white/15";
  return (
    <div className={cardCls}>
      <p className="mb-1 font-mono text-[10.5px] uppercase tracking-[0.16em] text-[#f97316]">Mission</p>
      <p className="mb-5 text-[13px] font-medium text-gray-700 dark:text-neutral-300">
        Grow pipeline, content, and revenue — autonomously.
      </p>
      <div className="flex flex-col items-center">
        {node("CEO", "claude", true)}
        <div className={line} />
        <div className="flex w-full items-start justify-center gap-8">
          <div className="flex flex-col items-center">
            {node("CMO", "claude")}
            <div className={line} />
            <div className="flex gap-2">
              {node("Blog Writer", "claude")}
              {node("SEO Analyst", "gemini")}
            </div>
          </div>
          <div className="flex flex-col items-center">
            {node("CFO", "claude")}
            <div className={line} />
            <div className="flex gap-2">
              {node("Sales-Ops", "claude")}
              {node("Reviews", "serpapi")}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const HEARTBEAT = [
  { job: "inbox-sync", every: "30m", n: 48 },
  { job: "negative-signal-watch", every: "1h", n: 24 },
  { job: "backlink-health", every: "6h", n: 4 },
  { job: "reviews-sync", every: "1d", n: 1 },
  { job: "daily-brief", every: "1d", n: 1 },
];

export function Heartbeat() {
  return (
    <div className={cardCls}>
      <div className="mb-4 flex items-center justify-between">
        <p className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-[#f97316]">Heartbeat · 24h</p>
        <span className="font-mono text-[10.5px] text-gray-400 dark:text-neutral-500">scheduler on · 35 jobs</span>
      </div>
      <div className="space-y-3.5">
        {HEARTBEAT.map((h) => (
          <div key={h.job} className="flex items-center gap-3">
            <div className="w-40 shrink-0">
              <div className="font-mono text-[11px] text-gray-700 dark:text-neutral-300">{h.job}</div>
              <div className="font-mono text-[9.5px] text-gray-400 dark:text-neutral-500">every {h.every}</div>
            </div>
            <div className="relative h-5 flex-1 rounded-md bg-[#FAF8F4] dark:bg-[#2f271f]/60">
              {Array.from({ length: Math.min(h.n, 48) }).map((_, i) => (
                <span
                  key={i}
                  className="absolute top-1/2 size-1.5 -translate-y-1/2 rounded-full bg-[#f97316]"
                  style={{ left: `${(i / Math.max(Math.min(h.n, 48) - 1, 1)) * 96 + 2}%`, opacity: h.n > 24 ? 0.55 : 1 }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex justify-between font-mono text-[9.5px] text-gray-400 dark:text-neutral-500">
        <span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>24h</span>
      </div>
    </div>
  );
}

const BUDGET = [
  { agent: "CEO", budget: 50 },
  { agent: "CMO", budget: 40 },
  { agent: "CFO", budget: 40 },
  { agent: "Blog Writer", budget: 30 },
  { agent: "Sales-Ops Analyst", budget: 30 },
  { agent: "SEO Analyst", budget: 30 },
];

export function BudgetTable() {
  const total = BUDGET.reduce((a, b) => a + b.budget, 0);
  return (
    <div className={cardCls}>
      <p className="mb-4 font-mono text-[10.5px] uppercase tracking-[0.16em] text-[#f97316]">Cost control · CFO</p>
      <table className="w-full text-[12.5px]">
        <thead>
          <tr className="text-left font-mono text-[10px] uppercase tracking-wider text-gray-400 dark:text-neutral-500">
            <th className="pb-2 font-medium">Agent</th>
            <th className="pb-2 text-right font-medium">Budget</th>
            <th className="pb-2 text-right font-medium">Used</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-black/[0.06] dark:divide-white/[0.06]">
          {BUDGET.map((b) => (
            <tr key={b.agent}>
              <td className="py-2 text-gray-800 dark:text-neutral-200">{b.agent}</td>
              <td className="py-2 text-right font-mono text-gray-500 dark:text-neutral-400">${b.budget}</td>
              <td className="py-2 text-right font-mono text-[#22c55e]">$0.00</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-black/10 dark:border-white/15">
            <td className="pt-2.5 font-semibold text-gray-900 dark:text-neutral-100">Total</td>
            <td className="pt-2.5 text-right font-mono font-semibold text-gray-900 dark:text-neutral-100">${total}/mo</td>
            <td className="pt-2.5 text-right font-mono font-semibold text-[#22c55e]">$0.00</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export function GoalTrace() {
  const rows: { sym: string; label: string; text: string; indent: number }[] = [
    { sym: "◎", label: "Mission", text: "Own the AI-voice category", indent: 0 },
    { sym: "◉", label: "Project", text: "Rank #1 for “AI call center”", indent: 1 },
    { sym: "○", label: "Agent", text: "SEO Analyst", indent: 2 },
    { sym: "•", label: "Task", text: "Draft BoFu page — IVR replacement", indent: 3 },
  ];
  return (
    <div className={cardCls}>
      <p className="mb-4 font-mono text-[10.5px] uppercase tracking-[0.16em] text-[#f97316]">Goal alignment · every task traces up</p>
      <div className="space-y-2.5">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center gap-2.5" style={{ paddingLeft: `${r.indent * 22}px` }}>
            <span className="font-mono text-[13px] text-[#f97316]">{r.sym}</span>
            <span className="w-14 shrink-0 font-mono text-[10px] uppercase tracking-wider text-gray-400 dark:text-neutral-500">{r.label}</span>
            <span className="text-[12.5px] text-gray-800 dark:text-neutral-200">{r.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Orbit (the "after" — one core, every channel) ────────────────────────────

const ORBIT_ENGINES = ["Outbound", "Inbound", "Content", "Revenue", "Agents", "Work OS"];

export function Orbit() {
  const R = 42; // radius %
  return (
    <div className="relative mx-auto aspect-square w-full max-w-[380px]">
      {/* dashed rings */}
      <div className="agnb-spin absolute inset-[6%] rounded-full border border-dashed border-[#f97316]/25" />
      <div className="agnb-spin-rev absolute inset-[22%] rounded-full border border-dashed border-[#f97316]/15" />
      {/* connector lines */}
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" fill="none" aria-hidden>
        {ORBIT_ENGINES.map((_, i) => {
          const a = (i / ORBIT_ENGINES.length) * 2 * Math.PI - Math.PI / 2;
          return <line key={i} x1="50" y1="50" x2={50 + R * Math.cos(a)} y2={50 + R * Math.sin(a)} stroke="#f97316" strokeOpacity="0.18" strokeWidth="0.4" />;
        })}
      </svg>
      {/* center core */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <span className="agnb-pulse-ring absolute inset-0 rounded-full bg-[#f97316]/40" />
        <div className="relative flex size-16 items-center justify-center rounded-full border border-[#f97316]/30 bg-white shadow-[0_8px_30px_rgba(249,115,22,0.35)] dark:bg-[#261f19]">
          <img src="/favicon.svg" alt="" className="size-8" />
        </div>
      </div>
      {/* engine nodes — placed on the ring via left/top % */}
      {ORBIT_ENGINES.map((e, i) => {
        const a = (i / ORBIT_ENGINES.length) * 2 * Math.PI - Math.PI / 2;
        const left = 50 + R * Math.cos(a);
        const top = 50 + R * Math.sin(a);
        return (
          <div
            key={e}
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${left}%`, top: `${top}%` }}
          >
            <span className="whitespace-nowrap rounded-full border border-black/[0.08] bg-white px-3 py-1.5 text-[11.5px] font-semibold text-gray-800 shadow-sm dark:border-white/10 dark:bg-[#2f271f] dark:text-neutral-100">
              {e}
            </span>
          </div>
        );
      })}
    </div>
  );
}

const MESSY_TOOLS = ["CRM", "GSC", "Jira", "Slack", "Sheets", "Rocket", "Notion", "Calendar", "Email", "Analytics", "Docs", "Ads"];

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
    span: "lg:col-span-2",
  },
  {
    icon: Network,
    k: "Outbound",
    d: "Campaigns ranked by reply rate, multi-sender across email + LinkedIn, AI reply drafts, sequence control. Stop guessing which campaign works — we rank them.",
    span: "lg:col-span-2",
  },
  {
    icon: Activity,
    k: "Inbound",
    d: "Every mention, demo, and deal — captured, attributed, scored. Share-of-voice across LLMs, pipeline + funnel sync, review monitoring.",
    span: "lg:col-span-1",
  },
  {
    icon: PenTool,
    k: "Content Studio",
    d: "Idea → published, on rails. Mine trends, auto-draft blog & LinkedIn, schedule, track GSC rank. The flywheel runs itself.",
    span: "lg:col-span-1",
  },
  {
    icon: BarChart3,
    k: "Revenue",
    d: "Attribution that isn't a guess. Forecast, renewals, invoicing, win/loss — before churn hits.",
    span: "lg:col-span-1",
  },
  {
    icon: CheckSquare,
    k: "Work OS",
    d: "Issues, routines, goals, approvals — humans and agents in one orchestration layer.",
    span: "lg:col-span-1",
  },
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

function StatCallout({ pill, stat, body }: { pill: string; stat: string; body: string }) {
  return (
    <div className="relative flex flex-col items-center py-6 text-center">
      {/* glow node */}
      <span className="relative mb-5 flex size-3.5 items-center justify-center">
        <span className="agnb-pulse-ring absolute inset-0 rounded-full bg-[#f97316]/50" />
        <span className="relative size-3.5 rounded-full bg-[#f97316]" />
      </span>
      <span className="mb-4 inline-flex items-center gap-1.5 rounded-full border border-black/[0.08] bg-white px-3 py-1 font-mono text-[11px] uppercase tracking-[0.14em] text-gray-500 dark:border-white/10 dark:bg-[#261f19] dark:text-neutral-400">
        {pill}
      </span>
      <p className="text-[clamp(40px,6vw,72px)] font-extrabold leading-none tracking-[-0.03em] text-[#f97316]">
        {stat}
      </p>
      <p className="mt-4 max-w-md text-[16px] leading-relaxed text-gray-500 dark:text-neutral-400">{body}</p>
    </div>
  );
}


// ─── Footer ───────────────────────────────────────────────────────────────────

export const FOOTER_COLS: { title: string; links: { label: string; href: string; external?: boolean; dot?: string }[] }[] = [
  {
    title: "Product",
    links: [
      { label: "Get started", href: "/get-started" },
      { label: "Quickstart", href: "/quickstart" },
    ],
  },
  {
    title: "Platform",
    links: [
      { label: "Agents", href: "/platform/agents" },
      { label: "Governance", href: "/platform/governance" },
      { label: "Integrations", href: "/platform/integrations" },
    ],
  },
  {
    title: "Developers",
    links: [
      { label: "Documentation", href: "/docs" },
      { label: "API reference", href: "/api" },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Blog", href: "/blog" },
      { label: "Changelog", href: "/changelog" },
    ],
  },
];

const SOCIALS: { label: string; href: string; icon: React.ReactNode }[] = [
  {
    label: "X",
    href: "https://x.com/hire_finn",
    icon: (
      <svg viewBox="0 0 24 24" className="size-4" fill="currentColor" aria-hidden="true">
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
      </svg>
    ),
  },
  {
    label: "LinkedIn",
    href: "https://www.linkedin.com/company/finn-voice",
    icon: (
      <svg viewBox="0 0 24 24" className="size-4" fill="currentColor" aria-hidden="true">
        <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
      </svg>
    ),
  },
  {
    label: "YouTube",
    href: "https://www.youtube.com/@hire_finn",
    icon: (
      <svg viewBox="0 0 24 24" className="size-4" fill="currentColor" aria-hidden="true">
        <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
      </svg>
    ),
  },
];

export function LandingFooter() {
  const { theme, toggleTheme } = useTheme();
  return (
    <footer className="border-t border-black/[0.07] bg-[#FAF8F4] dark:border-white/[0.08] dark:bg-[#1b1410]">
      {/* Top: brand rail + link grid */}
      <Section className="py-14">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-12 lg:gap-10">
          {/* Brand rail */}
          <div className="lg:col-span-4">
            <img src="/logo-full-light.svg" alt="All Gas No Brakes" className="h-10 w-auto dark:hidden" />
            <img src="/logo-full-dark.svg" alt="All Gas No Brakes" className="hidden h-10 w-auto dark:block" />
            <p className="mt-5 max-w-xs text-[14px] leading-relaxed text-gray-500 dark:text-neutral-400">
              Your entire growth engine — outbound, inbound, content, and revenue —
              run by autonomous agents in one cockpit.
            </p>
            <div className="mt-6 flex items-center gap-1.5">
              {SOCIALS.map((s) => (
                <a
                  key={s.label}
                  href={s.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={s.label}
                  className="inline-flex size-8 items-center justify-center rounded-md text-gray-500 transition hover:bg-black/[0.05] hover:text-gray-900 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-neutral-100"
                >
                  {s.icon}
                </a>
              ))}
            </div>
          </div>

          {/* Link grid */}
          <div className="lg:col-span-8">
            <div className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-4">
              {FOOTER_COLS.map((col) => (
                <nav key={col.title}>
                  <h3 className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-400 dark:text-neutral-500">
                    {col.title}
                  </h3>
                  <ul className="mt-3 space-y-2">
                    {col.links.map((l) => (
                      <li key={l.label}>
                        <a
                          href={l.href}
                          {...(l.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                          className="inline-flex items-center gap-1.5 text-[14px] text-gray-700 transition-colors hover:text-[#f97316] dark:text-neutral-300 dark:hover:text-[#f97316]"
                        >
                          {l.label}
                          {l.dot && (
                            <span className="relative inline-flex size-1.5" aria-hidden="true">
                              <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75" style={{ backgroundColor: l.dot }} />
                              <span className="relative inline-flex size-1.5 rounded-full" style={{ backgroundColor: l.dot }} />
                            </span>
                          )}
                        </a>
                      </li>
                    ))}
                  </ul>
                </nav>
              ))}
            </div>
          </div>
        </div>
      </Section>

      {/* Stats strip */}
      <div className="w-full border-t border-black/[0.07] bg-white dark:border-white/[0.08] dark:bg-[#261f19]">
        <div className="mx-auto grid max-w-6xl grid-cols-2 border-l border-black/[0.07] px-6 dark:border-white/[0.08] lg:grid-cols-4">
          {STATS.map((s) => (
            <div key={s.l} className="flex flex-col border-r border-black/[0.07] px-6 py-7 dark:border-white/[0.08]">
              <p className="text-[clamp(24px,2.5vw,36px)] font-extrabold leading-none tracking-[-0.03em] text-gray-900 dark:text-neutral-100">
                {s.to}{s.suffix}
              </p>
              <p className="mt-2 text-[13px] leading-snug text-gray-500 dark:text-neutral-400">{s.l}</p>
              <span className="mt-3 block h-[2px] w-8 bg-[#f97316]" aria-hidden="true" />
            </div>
          ))}
        </div>
      </div>

      {/* Bottom bar */}
      <div className="border-t border-black/[0.07] dark:border-white/[0.08]">
        <Section className="flex items-center justify-between py-5">
          <p className="text-[13px] text-gray-500 dark:text-neutral-400">
            © 2026 All Gas No Brakes · <span className="hidden sm:inline">built in stealth.</span>
          </p>
          <div className="flex items-center gap-4">
            <a href="/privacy" className="text-[13px] text-gray-500 transition hover:text-gray-900 dark:text-neutral-400 dark:hover:text-neutral-100">Privacy</a>
            <a href="/terms" className="text-[13px] text-gray-500 transition hover:text-gray-900 dark:text-neutral-400 dark:hover:text-neutral-100">Terms</a>
            <span className="h-4 w-px bg-black/10 dark:bg-white/15" aria-hidden />
            <button
              onClick={toggleTheme}
              aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              className="inline-flex size-8 items-center justify-center rounded-md text-gray-500 transition hover:bg-black/[0.05] hover:text-gray-900 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-neutral-100"
            >
              {theme === "dark" ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}
            </button>
          </div>
        </Section>
      </div>
    </footer>
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
      <div className="fixed inset-0 flex items-center justify-center bg-[#F6F3EC] dark:bg-[#1b1410]">
        <p className="text-sm text-gray-500 dark:text-neutral-400">Loading…</p>
      </div>
    );
  }

  return (
    <div
      className="agnb-scroll h-screen overflow-y-auto bg-[#F6F3EC] dark:bg-[#1b1410] text-gray-900 dark:text-neutral-100 antialiased"
      style={{ overflowX: "clip" }}
      id="top"
    >
      <style>{`
        @keyframes agnb-marquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }
        .agnb-marquee { animation: agnb-marquee 30s linear infinite; }
        @keyframes agnb-rev { 0%,100% { transform: scaleY(0.35) } 50% { transform: scaleY(1) } }
        .agnb-rev-bar { display:block; width:2px; height:13px; border-radius:9999px; background:currentColor; transform-origin:bottom; animation: agnb-rev 0.9s ease-in-out infinite; }
        @keyframes agnb-spin { to { transform: rotate(360deg) } }
        @keyframes agnb-spin-rev { to { transform: rotate(-360deg) } }
        .agnb-spin { animation: agnb-spin 40s linear infinite; }
        .agnb-spin-rev { animation: agnb-spin-rev 55s linear infinite; }
        @keyframes agnb-pulse-ring { 0% { transform: scale(0.9); opacity: 0.6 } 70%,100% { transform: scale(1.6); opacity: 0 } }
        .agnb-pulse-ring { animation: agnb-pulse-ring 2.8s ease-out infinite; }
      `}</style>

      <SiteNav />

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
          className="mb-7 inline-flex items-center gap-3 rounded-full border border-black/[0.08] dark:border-white/[0.08] bg-white dark:bg-[#261f19] px-1.5 py-1.5 pr-5 text-[14px] text-gray-800 dark:text-neutral-200 shadow-sm transition hover:shadow"
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
        <h1 className="mx-auto max-w-[18ch] text-[clamp(44px,6.6vw,76px)] font-extrabold leading-[1.02] tracking-[-0.04em] text-gray-900 dark:text-neutral-100">
          Your growth team,
          <br />
          <span className="bg-gradient-to-r from-amber-400 via-orange-500 to-red-600 bg-clip-text text-transparent">
            now autonomous.
          </span>
        </h1>

        {/* Subtitle */}
        <p className="mx-auto mb-8 mt-6 max-w-[600px] text-[19px] leading-[1.55] text-gray-500 dark:text-neutral-400">
          Outbound, inbound, content, and revenue — run by autonomous agents in
          one cockpit, while you sleep. Twelve dashboards become one.
        </p>

        {/* CTAs */}
        <div className="inline-flex flex-wrap items-center justify-center gap-3">
          <a
            href="#signin"
            className="group inline-flex items-center gap-2 rounded-lg bg-[#f97316] px-7 py-3.5 text-sm font-semibold text-white shadow-[0_8px_24px_-6px_rgba(249,115,22,0.5)] transition hover:bg-[#ea6a0c]"
          >
            Floor it <ArrowRight className="size-4 transition group-hover:translate-x-0.5" />
          </a>
          <a
            href="#how"
            className="inline-flex items-center gap-2 rounded-lg border border-black/[0.12] bg-white px-7 py-3.5 text-sm font-semibold text-gray-900 transition hover:bg-[#FAF8F4] dark:border-white/15 dark:bg-[#261f19] dark:text-neutral-100 dark:hover:bg-[#2f271f]"
          >
            Watch it run
          </a>
        </div>
        <p className="mt-4 text-[12.5px] text-gray-400 dark:text-neutral-500">
          Invite-only beta · No credit card needed · Setup in under 2 minutes
        </p>

        {/* Product shot — real dashboard */}
        <div className="relative mx-auto mt-14 max-w-5xl">
          <div
            className="pointer-events-none absolute -inset-x-10 -top-10 bottom-0 -z-10"
            style={{ background: "radial-gradient(50% 45% at 50% 20%, rgba(249,115,22,0.18) 0%, transparent 70%)" }}
          />
          <Shot src="/shots/dashboard.png" alt="All Gas No Brakes dashboard" eager />
        </div>
      </Section>

      {/* ── Trusted by (real Finn customer logos) ── */}
      <Section className="py-12">
        <p className="mb-8 text-center font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-400 dark:text-neutral-500">
          From the team behind <span className="text-gray-700 dark:text-neutral-300">Finn</span> — trusted in production by
        </p>
        <div className="flex flex-wrap items-center justify-center gap-x-12 gap-y-7 opacity-50 grayscale transition hover:opacity-100 hover:grayscale-0 sm:gap-x-16 dark:opacity-60 dark:invert dark:hover:invert-0">
          {TRUSTED_LOGOS.map((l) => (
            <img key={l.name} src={l.file} alt={l.name} className={cn(l.h, "w-auto object-contain")} />
          ))}
        </div>
      </Section>

      {/* ── Problem ── */}
      <Section className="py-20">
        <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-[1.4fr_1fr]">
          <div>
            <h2 className="text-[clamp(30px,3.8vw,46px)] font-bold leading-[1.08] tracking-[-0.025em] text-gray-900 dark:text-neutral-100">
              Growth tooling is bloated, siloed, and slow.{" "}
              <span className="text-gray-400 dark:text-neutral-500">You weren't hired to babysit twelve dashboards.</span>
            </h2>
            <p className="mt-6 max-w-xl text-[17px] leading-relaxed text-gray-500 dark:text-neutral-400">
              Brakes are for people who second-guess. We strip the busywork, wire
              every channel and your dev work into one surface, and hand the grind to
              agents that never clock out. You set the goal. They floor it.
            </p>
          </div>
          {/* 12 -> 1 visual */}
          <div className="flex items-center justify-center gap-5 sm:gap-8">
            <div className="text-center">
              <div className="text-[clamp(56px,9vw,96px)] font-extrabold leading-none tracking-tight text-gray-300 line-through decoration-gray-300/60 decoration-4 dark:text-neutral-700 dark:decoration-neutral-700/60">
                12
              </div>
              <div className="mt-2 font-mono text-[11px] uppercase tracking-[0.16em] text-gray-400 dark:text-neutral-500">dashboards</div>
            </div>
            <ArrowRight className="size-7 shrink-0 text-[#f97316]" />
            <div className="text-center">
              <div className="text-[clamp(56px,9vw,96px)] font-extrabold leading-none tracking-tight text-[#f97316]">1</div>
              <div className="mt-2 font-mono text-[11px] uppercase tracking-[0.16em] text-gray-500 dark:text-neutral-400">cockpit</div>
            </div>
          </div>
        </div>
      </Section>

      {/* ── Before / After (visual) ── */}
      <Section className="py-16">
        <div className="mb-10 text-center">
          <Eyebrow><span className="mx-auto">Twelve dashboards become one</span></Eyebrow>
          <h2 className="text-[clamp(26px,3.2vw,40px)] font-bold tracking-[-0.02em] text-gray-900 dark:text-neutral-100">
            From tab chaos to one orbit.
          </h2>
        </div>
        <div className="grid grid-cols-1 items-stretch gap-5 md:grid-cols-2">
          {/* Before — messy */}
          <div className="relative overflow-hidden rounded-2xl border border-black/[0.07] bg-white p-8 dark:border-white/[0.08] dark:bg-[#261f19]">
            <p className="mb-1 font-mono text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-neutral-500">Before</p>
            <p className="mb-2 text-[15px] font-semibold text-gray-700 dark:text-neutral-300">12 tabs. Zero momentum.</p>
            <div className="relative h-[300px]">
              {MESSY_TOOLS.map((t, i) => {
                const seed = (i * 977) % 100;
                const top = 8 + ((i * 53) % 78);
                const left = 4 + ((i * 71) % 80);
                const rot = (seed % 40) - 20;
                return (
                  <span
                    key={t}
                    className="absolute rounded-lg border border-black/[0.08] bg-[#FAF8F4] px-2.5 py-1.5 font-mono text-[11px] text-gray-400 grayscale dark:border-white/10 dark:bg-[#2f271f]/70 dark:text-neutral-500"
                    style={{ top: `${top}%`, left: `${left}%`, transform: `rotate(${rot}deg)`, opacity: 0.55 + (seed % 30) / 100 }}
                  >
                    {t}
                  </span>
                );
              })}
            </div>
          </div>
          {/* After — orbit */}
          <div className="relative overflow-hidden rounded-2xl border border-[#f97316]/20 bg-[#f97316]/[0.04] p-8">
            <p className="mb-1 font-mono text-[11px] font-semibold uppercase tracking-wider text-[#f97316]">After</p>
            <p className="mb-2 text-[15px] font-semibold text-gray-800 dark:text-neutral-200">One cockpit. Every channel.</p>
            <div className="flex h-[300px] items-center justify-center">
              <Orbit />
            </div>
          </div>
        </div>
      </Section>

      {/* ── Stat callout ── */}
      <Section className="py-8">
        <StatCallout
          pill="Did you know?"
          stat="24/7"
          body="Your growth engine never clocks out — 35 jobs fire around the clock, draining queues, syncing CRMs, drafting content, and ranking campaigns while you sleep."
        />
      </Section>

      {/* ── Modules ── */}
      <Section className="scroll-mt-20 py-12" id="cockpit">
        <Eyebrow>The cockpit</Eyebrow>
        <h2 className="mb-10 text-[clamp(28px,3.4vw,42px)] font-bold tracking-[-0.02em] text-gray-900 dark:text-neutral-100">
          Six engines. One throttle.
        </h2>
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-4">
          {MODULES.map((m) => (
            <div key={m.k} className={cn("group rounded-2xl border border-black/[0.07] bg-white p-7 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md dark:border-white/[0.08] dark:bg-[#261f19]", m.span)}>
              <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-orange-600 text-white shadow-[0_6px_20px_rgba(249,115,22,0.4)]">
                <m.icon className="size-[22px]" />
              </div>
              <h3 className="mb-2 text-[18px] font-semibold text-gray-900 dark:text-neutral-100">{m.k}</h3>
              <p className="text-[14px] leading-relaxed text-gray-500 dark:text-neutral-400">{m.d}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* ── Feature showcase (real screenshots) — center-spine rail ── */}
      <Section className="relative space-y-24 py-16 sm:py-20">
        <div
          className="pointer-events-none absolute inset-y-10 left-1/2 hidden w-px -translate-x-1/2 lg:block"
          style={{ backgroundImage: "repeating-linear-gradient(to bottom, rgba(249,115,22,0.4) 0 5px, transparent 5px 12px)" }}
          aria-hidden
        />
        <FeatureRow
          eyebrow="One north star"
          title={<>Every KPI that matters, <span className="text-gray-400 dark:text-neutral-500">on one screen.</span></>}
          body="Pipeline, share of voice, review rating, mentions, backlinks, content gaps — the whole funnel rolled into one live scoreboard the agents steer by."
          bullets={[
            "Live pipeline value + open deals from HubSpot",
            "Share-of-voice + review rating tracked daily",
            "Content-gap backlog feeding the writers",
          ]}
          src="/shots/northstar.png"
          alt="North Star KPI dashboard"
        />
        <FeatureRow
          flip
          eyebrow="Outbound"
          title={<>Campaigns ranked by <span className="text-gray-400 dark:text-neutral-500">what actually replies.</span></>}
          body="Multi-sender across email + LinkedIn, AI-drafted replies, sequence control. Stop guessing which campaign works — every one is ranked by reply rate."
          bullets={[
            "26 campaigns, 13 senders, one view",
            "Reply + meeting rates per campaign",
            "AI reply drafts queued for approval",
          ]}
          src="/shots/campaigns.png"
          alt="Campaigns dashboard"
        />
        <FeatureRow
          eyebrow="Revenue"
          title={<>A pipeline that <span className="text-gray-400 dark:text-neutral-500">updates itself.</span></>}
          body="Deals synced from HubSpot, attributed and forecast automatically. Know what's driving revenue — and what's about to churn — before it does."
          bullets={[
            "HubSpot deals mirrored + attributed",
            "Forecast, renewals, win/loss in one place",
            "No manual CRM hygiene at 11pm",
          ]}
          src="/shots/pipeline.png"
          alt="Pipeline board"
        />
      </Section>

      {/* ── Inside the agent company (diagrams) ── */}
      <Section className="py-16">
        <div className="mb-10 text-center">
          <Eyebrow>
            <span className="mx-auto">Inside the agent company</span>
          </Eyebrow>
          <h2 className="text-[clamp(26px,3.2vw,40px)] font-bold tracking-[-0.02em] text-gray-900 dark:text-neutral-100">
            A real company. Just staffed by agents.
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-[15px] leading-relaxed text-gray-500 dark:text-neutral-400">
            An org chart, a heartbeat, a budget, and goals that trace top to bottom —
            the same scaffolding you'd give a human team.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <OrgChart />
          <Heartbeat />
          <BudgetTable />
          <GoalTrace />
        </div>
      </Section>

      {/* ── Testimonials ── */}
      <Section className="py-12">
        <Eyebrow>From the crew</Eyebrow>
        <h2 className="mb-10 text-[clamp(26px,3.2vw,40px)] font-bold tracking-[-0.02em] text-gray-900 dark:text-neutral-100">
          Real teams. Real momentum.
        </h2>
        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
          {TESTIMONIALS.map((t) => (
            <div key={t.name} className="flex flex-col justify-between rounded-2xl border border-black/[0.07] dark:border-white/[0.08] bg-white dark:bg-[#261f19] p-6 shadow-sm">
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

      {/* ── Integrations ── */}
      <Section className="scroll-mt-20 py-16" id="integrations">
        <Eyebrow>Works with your stack</Eyebrow>
        <h2 className="mb-8 text-[clamp(24px,3vw,38px)] font-bold tracking-[-0.02em] text-gray-900 dark:text-neutral-100">
          Drop it in. Nothing breaks.
        </h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {INTEGRATIONS.map((i) => (
            <div key={i.name} className="group flex flex-col items-start gap-3 rounded-2xl border border-black/[0.07] bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-[#f97316]/40 hover:shadow-md dark:border-white/[0.08] dark:bg-[#261f19]">
              <span className="flex size-11 items-center justify-center rounded-xl bg-[#f97316]/10 font-mono text-[13px] font-bold text-[#f97316] transition group-hover:bg-[#f97316] group-hover:text-white">
                {i.abbr}
              </span>
              <span className="text-[14px] font-semibold text-gray-800 dark:text-neutral-200">{i.name}</span>
            </div>
          ))}
        </div>
        <p className="mt-6 text-[13px] text-gray-500 dark:text-neutral-400">
          + HubSpot webhooks, GSC property, PostHog events, Slack alerts, LinkedIn API, and more out of the box.
        </p>
      </Section>

      {/* ── Bring your own agent ── */}
      <Section className="py-16">
        <div className="rounded-3xl border border-black/[0.07] dark:border-white/[0.08] bg-white dark:bg-[#261f19] p-8 sm:p-12">
          <div className="flex flex-col items-center text-center">
            <Eyebrow>Bring your own agent</Eyebrow>
            <h2 className="max-w-2xl text-[clamp(24px,3vw,38px)] font-bold tracking-[-0.02em] text-gray-900 dark:text-neutral-100">
              Runs on the models you already trust.
            </h2>
            <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-gray-500 dark:text-neutral-400">
              Point each agent at Claude, Gemini, OpenAI, or a local runtime. Swap
              providers per-agent — no lock-in, no rewrites.
            </p>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-x-12 gap-y-8 sm:gap-x-16">
              {/* Claude (text mark — primary) */}
              <span className="font-serif text-[22px] font-semibold tracking-tight text-gray-800 dark:text-neutral-200" style={{ fontFamily: "Georgia, serif" }}>
                Claude
              </span>
              {/* Gemini (multicolor, theme-agnostic) */}
              <img src="/providers/google-gemini.svg" alt="Google Gemini" className="h-7 w-auto" />
              {/* OpenAI — theme-swapped */}
              <img src="/providers/OpenAI-black-monoblossom.svg" alt="OpenAI" className="h-8 w-auto dark:hidden" />
              <img src="/providers/OpenAI-white-monoblossom.svg" alt="OpenAI" className="hidden h-8 w-auto dark:block" />
              {/* opencode — theme-swapped */}
              <img src="/providers/opencode-logo-light.svg" alt="opencode" className="h-8 w-auto dark:hidden" />
              <img src="/providers/opencode-logo-dark.svg" alt="opencode" className="hidden h-8 w-auto dark:block" />
            </div>
            <p className="mt-7 font-mono text-[11px] uppercase tracking-[0.16em] text-gray-400 dark:text-neutral-500">
              + Cursor · Codex · Grok · local adapters
            </p>
          </div>
        </div>
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
        <div className="grid grid-cols-1 items-center gap-12 rounded-3xl border border-black/[0.07] dark:border-white/[0.08] bg-white dark:bg-[#261f19] p-8 shadow-sm sm:p-12 lg:grid-cols-2">
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
      <LandingFooter />
    </div>
  );
}
