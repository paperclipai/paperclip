import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/context/ThemeContext";
import { LandingFooter } from "./Landing";
import {
  ArrowRight,
  ArrowLeft,
  Bot,
  Check,
  ChevronRight,
  Gauge,
  Moon,
  ShieldCheck,
  Sun,
  Terminal,
} from "lucide-react";

// ─── Shared primitives ────────────────────────────────────────────────────────

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-3 flex items-center gap-2 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-[#f97316]">
      <span className="h-px w-6 bg-[#f97316]/50" />
      {children}
    </p>
  );
}

function MarketingNav() {
  const { theme, toggleTheme } = useTheme();
  return (
    <header className="sticky top-0 z-50 w-full border-b border-black/[0.06] bg-[#F6F3EC]/80 backdrop-blur-xl dark:border-white/[0.06] dark:bg-neutral-950/80">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <a href="/auth" className="flex items-center">
          <img src="/logo-full-light.svg" alt="All Gas No Brakes" className="h-10 w-auto dark:hidden" />
          <img src="/logo-full-dark.svg" alt="All Gas No Brakes" className="hidden h-10 w-auto dark:block" />
        </a>
        <nav className="hidden items-center gap-1 lg:flex">
          {[
            { label: "Agents", href: "/platform/agents" },
            { label: "Governance", href: "/platform/governance" },
            { label: "Integrations", href: "/platform/integrations" },
            { label: "Docs", href: "/docs" },
            { label: "Changelog", href: "/changelog" },
          ].map((l) => (
            <a key={l.href} href={l.href} className="rounded-md px-3 py-2 text-[13.5px] font-medium text-gray-500 transition hover:text-gray-900 dark:text-neutral-400 dark:hover:text-neutral-100">
              {l.label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-2.5">
          <button
            onClick={toggleTheme}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            className="inline-flex size-9 items-center justify-center rounded-md text-gray-500 transition hover:bg-black/[0.04] hover:text-gray-900 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-neutral-100"
          >
            {theme === "dark" ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}
          </button>
          <a href="/auth" className="rounded-md bg-[#f97316] px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-[#ea6a0c]">
            Sign in
          </a>
        </div>
      </div>
    </header>
  );
}

function Shell({ eyebrow, title, sub, children }: { eyebrow: string; title: string; sub: string; children: React.ReactNode }) {
  // sync the wrapper's dark class with stored theme on mount (these are standalone routes)
  useEffect(() => {
    const t = (() => { try { return localStorage.getItem("paperclip.theme"); } catch { return null; } })();
    if (t) document.documentElement.classList.toggle("dark", t === "dark");
  }, []);
  return (
    <div className="min-h-screen bg-[#F6F3EC] text-gray-900 antialiased dark:bg-neutral-950 dark:text-neutral-100">
      <MarketingNav />
      {/* hero */}
      <section className="relative mx-auto max-w-6xl px-6 pb-12 pt-16 text-center sm:pt-20">
        <div
          className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[340px]"
          style={{ background: "radial-gradient(55% 55% at 50% 0%, rgba(249,115,22,0.10) 0%, transparent 70%)" }}
        />
        <p className="mb-4 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-[#f97316]">{eyebrow}</p>
        <h1 className="mx-auto max-w-3xl text-[clamp(38px,5.5vw,60px)] font-extrabold leading-[1.05] tracking-[-0.035em]">{title}</h1>
        <p className="mx-auto mt-5 max-w-xl text-[18px] leading-[1.55] text-gray-500 dark:text-neutral-400">{sub}</p>
      </section>
      <main className="mx-auto max-w-6xl px-6 pb-24">{children}</main>
      <LandingFooter />
    </div>
  );
}

const card = "rounded-2xl border border-black/[0.07] bg-white p-7 shadow-sm dark:border-white/[0.08] dark:bg-neutral-900";

function Steps({ items }: { items: { t: string; d: string }[] }) {
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      {items.map((s, i) => (
        <div key={s.t} className={cn(card, "flex gap-5")}>
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-orange-600 font-mono text-[13px] font-bold text-white shadow-[0_4px_14px_rgba(249,115,22,0.4)]">
            {i + 1}
          </span>
          <div>
            <h3 className="text-[16px] font-semibold text-gray-900 dark:text-neutral-100">{s.t}</h3>
            <p className="mt-1 text-[14.5px] leading-relaxed text-gray-500 dark:text-neutral-400">{s.d}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-xl border border-white/10 bg-[#0d0d10] p-4 font-mono text-[12.5px] leading-relaxed text-neutral-200">
      <code>{children}</code>
    </pre>
  );
}

function FeatureGrid({ items }: { items: { t: string; d: string }[] }) {
  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((f) => (
        <div key={f.t} className={card}>
          <h3 className="mb-2 flex items-center gap-2 text-[16px] font-semibold text-gray-900 dark:text-neutral-100">
            <ChevronRight className="size-4 text-[#f97316]" />{f.t}
          </h3>
          <p className="text-[14px] leading-relaxed text-gray-500 dark:text-neutral-400">{f.d}</p>
        </div>
      ))}
    </div>
  );
}

function CtaRow() {
  return (
    <div className="mt-12 flex flex-wrap items-center justify-center gap-3">
      <a href="/auth" className="group inline-flex items-center gap-2 rounded-lg bg-[#f97316] px-7 py-3.5 text-sm font-semibold text-white transition hover:bg-[#ea6a0c]">
        Floor it <ArrowRight className="size-4 transition group-hover:translate-x-0.5" />
      </a>
      <a href="mailto:diggi@hirefinn.ai?subject=AGNB%20Access%20Request" className="inline-flex items-center gap-2 rounded-lg border border-black/[0.12] bg-white px-7 py-3.5 text-sm font-semibold text-gray-900 transition hover:bg-[#FAF8F4] dark:border-white/15 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800">
        Request access
      </a>
    </div>
  );
}

// ─── Pages ────────────────────────────────────────────────────────────────────

export function GetStartedPage() {
  return (
    <Shell eyebrow="Get started" title="From invite to a running agent company." sub="All Gas No Brakes is invite-only while in beta. Here's how to get in and put the agents to work.">
      <Steps
        items={[
          { t: "Request access", d: "Email us for an invite. We'll send a one-click link scoped to your workspace — no credit card, no sales call." },
          { t: "Sign in & set your password", d: "Open the invite link, create your account, and you're in the cockpit. Email confirmation isn't required in beta." },
          { t: "Connect a data source", d: "Point AGNB at HubSpot, Google Search Console, or your CRM. Keys are stored as encrypted secrets and the sync jobs activate the moment a key is present." },
          { t: "Hire your first agent", d: "Spin up a producer (Blog Writer, Sales-Ops, SEO Analyst) under a project, give it a goal, and let the heartbeat run it. Approval gates stay on until you trust it." },
        ]}
      />
      <CtaRow />
    </Shell>
  );
}

export function QuickstartPage() {
  return (
    <Shell eyebrow="Quickstart" title="Up and running in minutes." sub="The fastest path from sign-in to agents working your growth stack around the clock.">
      <Steps
        items={[
          { t: "Sign in", d: "Use the email + password from your invite. You land directly in the dashboard." },
          { t: "Connect your stack", d: "Add your integration keys under Secrets. Each connector self-activates when its key is set." },
          { t: "Enable the jobs", d: "35 scheduled jobs ship disabled-by-default for anything with external side-effects. Toggle on the ones you want." },
          { t: "Watch the loop", d: "Drain, sync, draft, observe — the worker fires on schedule. Check the Jobs and North Star pages to see it work." },
        ]}
      />
      <div className="mx-auto mt-10 max-w-2xl space-y-4">
        <p className="text-[13px] font-medium text-gray-500 dark:text-neutral-400">Connectors activate on key presence — for example:</p>
        <Code>{`# Set as encrypted secrets in the cockpit
HUBSPOT_TOKEN=...        # pipeline + CRM sync
GSC_PROPERTY=sc-domain:yourdomain.com
SERPAPI_KEY=...          # reviews + SERP rank
GEMINI_API_KEY=...       # drafting + analysis

# Then enable a job:
POST /api/agnb/jobs/reviews-sync/toggle?enabled=true`}</Code>
      </div>
      <CtaRow />
    </Shell>
  );
}

export function AgentsPage() {
  return (
    <Shell eyebrow="Platform · Agents" title="A company staffed by agents." sub="Not one chatbot — an org of specialised agents with roles, goals, budgets, and a heartbeat. You set direction; they do the reps.">
      <div className={cn(card, "mb-10 flex flex-col items-center gap-4 text-center")}>
        <Bot className="size-9 text-[#f97316]" />
        <p className="max-w-2xl text-[16px] leading-relaxed text-gray-600 dark:text-neutral-300">
          A CEO sets the mission. A CMO and CFO run marketing and money. Producer
          agents — Blog Writer, Sales-Ops, SEO Analyst, Reviews Monitor — do the
          channel work. Every agent traces its tasks back up to a single goal.
        </p>
      </div>
      <FeatureGrid
        items={[
          { t: "Roles, not prompts", d: "Each agent has a job description, a goal, and the tools for its lane — like onboarding a hire, not tuning a prompt." },
          { t: "Bring your own model", d: "Point each agent at Claude, Gemini, OpenAI, or a local runtime. Swap per-agent, no lock-in." },
          { t: "Heartbeat", d: "Agents wake on a schedule (or on demand) and pick up where they left off — outbound, content, syncs, PRs." },
          { t: "Goal alignment", d: "Mission → Project → Agent → Task. Every unit of work traces up, so nothing drifts off-strategy." },
          { t: "Approval gates", d: "Anything irreversible waits for a human. Promote an agent to act-with-approval once it earns trust." },
          { t: "Full audit", d: "Every run, decision, and tool call is logged. Pause, resume, override, reassign, or terminate any agent." },
        ]}
      />
      <CtaRow />
    </Shell>
  );
}

export function GovernancePage() {
  return (
    <Shell eyebrow="Platform · Governance" title="Autonomous, but you stay in control." sub="Speed without the blast radius. Budgets, approvals, and a full audit trail keep the agents on a leash you control.">
      <div className={cn(card, "mb-10 flex flex-col items-center gap-4 text-center")}>
        <ShieldCheck className="size-9 text-[#f97316]" />
        <p className="max-w-2xl text-[16px] leading-relaxed text-gray-600 dark:text-neutral-300">
          Every external send, publish, or spend is gated by default. The CFO
          tracks budget per agent. You can stop the whole company with one switch.
        </p>
      </div>
      <FeatureGrid
        items={[
          { t: "Approval queue", d: "Drafts — outreach, replies, posts — land in a queue. Nothing leaves the building without a human yes." },
          { t: "Per-agent budgets", d: "Set a monthly cap per agent. The CFO meters spend; agents stop cleanly when the budget is gone." },
          { t: "Default-off side effects", d: "Jobs that send, post, or spend ship disabled. Enable them deliberately, per instance." },
          { t: "Pause · Resume · Override", d: "Take manual control of any agent or the whole fleet at any time. Reassign or terminate on demand." },
          { t: "Audit log", d: "Every run, tool call, and decision is recorded and traceable back to the goal that triggered it." },
          { t: "Scoped access", d: "Invite-based access with per-member roles and grants. Secrets are encrypted, never exposed to agents in the clear." },
        ]}
      />
      <CtaRow />
    </Shell>
  );
}

const INTEGRATIONS = [
  { abbr: "HS", name: "HubSpot", d: "Two-way deal + CRM sync, pipeline board, hygiene scans." },
  { abbr: "GSC", name: "Google Search Console", d: "Keyword rank tracking + content-gap signals." },
  { abbr: "PH", name: "PostHog", d: "Product analytics, signup funnel, traffic sources." },
  { abbr: "SERP", name: "SerpAPI", d: "Review ratings + SERP share-of-voice." },
  { abbr: "SLK", name: "Slack", d: "Alerts + the HQ notification feed." },
  { abbr: "LI", name: "LinkedIn", d: "Multi-sender outbound + post scheduling." },
  { abbr: "GEM", name: "Gemini", d: "Drafting, analysis, and agent reasoning." },
  { abbr: "CLX", name: "Claude", d: "Primary agent runtime via adapters." },
];

export function IntegrationsPage() {
  return (
    <Shell eyebrow="Platform · Integrations" title="Works with the stack you already run." sub="Drop AGNB in alongside your tools. Each connector self-activates the moment its key is set — nothing to rebuild.">
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {INTEGRATIONS.map((i) => (
          <div key={i.name} className={cn(card, "transition hover:-translate-y-0.5 hover:border-[#f97316]/40 hover:shadow-md")}>
            <span className="mb-3 flex size-11 items-center justify-center rounded-xl bg-[#f97316]/10 font-mono text-[13px] font-bold text-[#f97316]">
              {i.abbr}
            </span>
            <h3 className="text-[16px] font-semibold text-gray-900 dark:text-neutral-100">{i.name}</h3>
            <p className="mt-1 text-[14px] leading-relaxed text-gray-500 dark:text-neutral-400">{i.d}</p>
          </div>
        ))}
      </div>
      <p className="mt-8 text-center text-[13px] text-gray-500 dark:text-neutral-400">
        + HubSpot webhooks, GSC property, PostHog events, RocketSDR, and local adapters (Codex, Grok, OpenCode).
      </p>
      <CtaRow />
    </Shell>
  );
}

const DOC_CARDS = [
  { t: "Agents", d: "Roles, adapters, and how the heartbeat schedules work.", href: "/platform/agents" },
  { t: "Governance", d: "Approvals, budgets, audit, and the default-off model.", href: "/platform/governance" },
  { t: "Integrations", d: "Connectors and the key-presence activation model.", href: "/platform/integrations" },
  { t: "Quickstart", d: "Sign in, connect a source, enable jobs, hire an agent.", href: "/quickstart" },
  { t: "API reference", d: "The /api/agnb endpoints that back the cockpit.", href: "/api" },
  { t: "Changelog", d: "What shipped, and when.", href: "/changelog" },
];

export function DocsPage() {
  return (
    <Shell eyebrow="Developers · Documentation" title="Documentation." sub="Concepts, setup, and the moving parts behind the cockpit. Full reference docs are expanding — start here.">
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {DOC_CARDS.map((c) => (
          <a key={c.t} href={c.href} className={cn(card, "group transition hover:-translate-y-0.5 hover:border-[#f97316]/40 hover:shadow-md")}>
            <h3 className="mb-2 flex items-center justify-between text-[16px] font-semibold text-gray-900 dark:text-neutral-100">
              {c.t}
              <ArrowRight className="size-4 text-[#f97316] transition group-hover:translate-x-0.5" />
            </h3>
            <p className="text-[14px] leading-relaxed text-gray-500 dark:text-neutral-400">{c.d}</p>
          </a>
        ))}
      </div>
    </Shell>
  );
}

const ENDPOINTS = [
  { m: "GET", p: "/api/agnb/north-star", d: "Headline KPIs across the funnel." },
  { m: "GET", p: "/api/agnb/jobs", d: "Scheduler state for all 35 jobs." },
  { m: "POST", p: "/api/agnb/jobs/:key/run", d: "Run a job on demand." },
  { m: "POST", p: "/api/agnb/jobs/:key/toggle", d: "Enable or disable a job." },
  { m: "GET", p: "/api/agnb/pipeline/board", d: "HubSpot deals grouped by stage." },
  { m: "GET", p: "/api/agnb/idea-inbox", d: "Captured content ideas." },
  { m: "GET", p: "/api/agnb/mentions", d: "Community mentions + sentiment." },
  { m: "GET", p: "/api/agnb/reviews", d: "Review platforms + ratings." },
];

export function ApiPage() {
  return (
    <Shell eyebrow="Developers · API reference" title="One API behind the cockpit." sub="Everything in AGNB is backed by the /api/agnb surface. Authenticated agents and the board org can call it directly.">
      <div className={cn(card, "overflow-hidden p-0")}>
        <div className="flex items-center gap-2 border-b border-black/[0.07] bg-[#FAF8F4] px-5 py-3 dark:border-white/[0.08] dark:bg-neutral-800/50">
          <Terminal className="size-4 text-[#f97316]" />
          <span className="font-mono text-[12px] text-gray-500 dark:text-neutral-400">Bearer auth · JSON</span>
        </div>
        <ul className="divide-y divide-black/[0.06] dark:divide-white/[0.06]">
          {ENDPOINTS.map((e) => (
            <li key={e.p} className="flex flex-col gap-1 px-5 py-3.5 sm:flex-row sm:items-center sm:gap-4">
              <span className={cn("inline-flex w-fit shrink-0 rounded px-2 py-0.5 font-mono text-[11px] font-bold", e.m === "GET" ? "bg-[#22c55e]/10 text-[#16a34a]" : "bg-[#f97316]/10 text-[#f97316]")}>
                {e.m}
              </span>
              <code className="font-mono text-[13px] text-gray-800 dark:text-neutral-200">{e.p}</code>
              <span className="text-[13px] text-gray-500 dark:text-neutral-400 sm:ml-auto sm:text-right">{e.d}</span>
            </li>
          ))}
        </ul>
      </div>
      <p className="mt-6 text-center text-[13px] text-gray-500 dark:text-neutral-400">
        Agents authenticate with a signed JWT; board members with a session. Full reference is expanding.
      </p>
    </Shell>
  );
}

export function BlogPage() {
  return (
    <Shell eyebrow="Resources · Blog" title="Notes from the redline." sub="How we're building an autonomous growth company — in public, soon.">
      <div className={cn(card, "mx-auto flex max-w-xl flex-col items-center gap-4 text-center")}>
        <Gauge className="size-9 text-[#f97316]" />
        <h3 className="text-[18px] font-semibold text-gray-900 dark:text-neutral-100">First posts are on the way.</h3>
        <p className="text-[14.5px] leading-relaxed text-gray-500 dark:text-neutral-400">
          We're documenting how the agent company runs — the wins, the misfires,
          and the playbooks. Want it in your inbox? Ask for an invite and you'll
          be first to know.
        </p>
        <a href="mailto:diggi@hirefinn.ai?subject=AGNB%20Blog" className="mt-2 inline-flex items-center gap-2 rounded-lg bg-[#f97316] px-6 py-3 text-sm font-semibold text-white transition hover:bg-[#ea6a0c]">
          Notify me <ArrowRight className="size-4" />
        </a>
      </div>
    </Shell>
  );
}

const CHANGELOG = [
  {
    date: "Jun 2026",
    items: [
      "New marketing site — premium light/dark, real product screenshots, orbit visual, agent-company diagrams.",
      "Bring-your-own-agent: Claude, Gemini, OpenAI, and local adapters per agent.",
      "Central account provisioning + invite-only access (public sign-up disabled in beta).",
    ],
  },
  {
    date: "May 2026",
    items: [
      "Exec daily loop — CEO reviews the north star and proposes the day's work.",
      "Cross-channel repurpose — one content gap → blog idea + LinkedIn hook + YouTube title.",
      "Outcome feedback — slipping BoFu pages auto-brief a refresh.",
      "North Star dashboard — pipeline, share-of-voice, reviews, mentions, backlinks in one view.",
      "Reviews-sync via SerpAPI, HubSpot deals mirror, negative-signal watch.",
    ],
  },
];

export function ChangelogPage() {
  return (
    <Shell eyebrow="Resources · Changelog" title="What shipped." sub="The agent company is built in public. Here's what's new.">
      <div className="mx-auto max-w-2xl space-y-10">
        {CHANGELOG.map((rel) => (
          <div key={rel.date}>
            <p className="mb-4 font-mono text-[12px] font-semibold uppercase tracking-[0.16em] text-[#f97316]">{rel.date}</p>
            <ul className="space-y-3">
              {rel.items.map((it) => (
                <li key={it} className={cn(card, "flex items-start gap-3 p-4")}>
                  <Check className="mt-0.5 size-4 shrink-0 text-[#f97316]" />
                  <span className="text-[14.5px] leading-relaxed text-gray-700 dark:text-neutral-300">{it}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="mt-12 text-center">
        <a href="/auth" className="inline-flex items-center gap-2 text-[13px] font-medium text-gray-500 transition hover:text-gray-900 dark:text-neutral-400 dark:hover:text-neutral-100">
          <ArrowLeft className="size-4" /> Back to home
        </a>
      </div>
    </Shell>
  );
}
