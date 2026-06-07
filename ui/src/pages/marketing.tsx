import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { SiteNav } from "@/components/SiteNav";
import { LandingFooter, OrgChart, Heartbeat, BudgetTable, GoalTrace } from "./Landing";
import {
  ArrowRight,
  ArrowLeft,
  Bot,
  Check,
  ChevronRight,
  Gauge,
  Minus,
  Plus,
  ShieldCheck,
  Terminal,
} from "lucide-react";

// ─── Shared primitives ────────────────────────────────────────────────────────

function Shell({ eyebrow, title, sub, children }: { eyebrow: string; title: string; sub: string; children: React.ReactNode }) {
  useEffect(() => {
    const t = (() => { try { return localStorage.getItem("paperclip.theme"); } catch { return null; } })();
    if (t) document.documentElement.classList.toggle("dark", t === "dark");
  }, []);
  return (
    <div className="agnb-scroll h-screen overflow-y-auto bg-[#F6F3EC] text-gray-900 antialiased dark:bg-neutral-950 dark:text-neutral-100">
      <SiteNav />
      <section className="relative mx-auto max-w-6xl px-6 pb-10 pt-16 text-center sm:pt-20">
        <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[340px]" style={{ background: "radial-gradient(55% 55% at 50% 0%, rgba(249,115,22,0.10) 0%, transparent 70%)" }} />
        <p className="mb-4 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-[#f97316]">{eyebrow}</p>
        <h1 className="mx-auto max-w-3xl text-[clamp(38px,5.5vw,60px)] font-extrabold leading-[1.05] tracking-[-0.035em]">{title}</h1>
        <p className="mx-auto mt-5 max-w-2xl text-[18px] leading-[1.55] text-gray-500 dark:text-neutral-400">{sub}</p>
      </section>
      <main className="mx-auto max-w-6xl px-6 pb-24">{children}</main>
      <LandingFooter />
    </div>
  );
}

const card = "rounded-2xl border border-black/[0.07] bg-white p-7 shadow-sm dark:border-white/[0.08] dark:bg-neutral-900";

function Block({ title, intro, children, className = "" }: { title?: string; intro?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("py-12", className)}>
      {title && <h2 className="text-[clamp(24px,3vw,34px)] font-bold tracking-[-0.02em] text-gray-900 dark:text-neutral-100">{title}</h2>}
      {intro && <p className="mt-3 max-w-2xl text-[16px] leading-relaxed text-gray-500 dark:text-neutral-400">{intro}</p>}
      <div className={cn(title && "mt-8")}>{children}</div>
    </section>
  );
}

function Steps({ items }: { items: { t: string; d: string }[] }) {
  return (
    <div className="space-y-4">
      {items.map((s, i) => (
        <div key={s.t} className={cn(card, "flex gap-5")}>
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-orange-600 font-mono text-[13px] font-bold text-white shadow-[0_4px_14px_rgba(249,115,22,0.4)]">{i + 1}</span>
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

function Grid({ items }: { items: { t: string; d: string }[] }) {
  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((f) => (
        <div key={f.t} className={card}>
          <h3 className="mb-2 flex items-center gap-2 text-[15.5px] font-semibold text-gray-900 dark:text-neutral-100">
            <ChevronRight className="size-4 shrink-0 text-[#f97316]" />{f.t}
          </h3>
          <p className="text-[13.5px] leading-relaxed text-gray-500 dark:text-neutral-400">{f.d}</p>
        </div>
      ))}
    </div>
  );
}

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button onClick={() => setOpen((v) => !v)} className="w-full border-b border-black/[0.08] py-5 text-left dark:border-white/[0.08]">
      <div className="flex items-center justify-between gap-4">
        <span className="text-[16px] font-semibold text-gray-900 dark:text-neutral-100">{q}</span>
        {open ? <Minus className="size-4 shrink-0 text-[#f97316]" /> : <Plus className="size-4 shrink-0 text-gray-400" />}
      </div>
      {open && <p className="mt-3 max-w-2xl text-[14.5px] leading-relaxed text-gray-500 dark:text-neutral-400">{a}</p>}
    </button>
  );
}

function Faqs({ items }: { items: { q: string; a: string }[] }) {
  return (
    <Block title="FAQ">
      <div>{items.map((f) => <FaqItem key={f.q} {...f} />)}</div>
    </Block>
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

// ─── Get started ──────────────────────────────────────────────────────────────

export function GetStartedPage() {
  return (
    <Shell eyebrow="Get started" title="From invite to a running agent company." sub="All Gas No Brakes is invite-only while in beta. Here's everything you need to get in and put the agents to work.">
      <Block title="What you get" intro="One cockpit that replaces a dozen growth tools — plus the autonomous layer that actually runs them.">
        <Grid items={[
          { t: "The cockpit", d: "Outbound, inbound, content, pipeline, and revenue in a single login. No tab-hopping, no context loss." },
          { t: "An agent company", d: "A CEO, CMO, and CFO managing producer agents (Blog Writer, Sales-Ops, SEO Analyst, Reviews Monitor) under shared goals." },
          { t: "35 scheduled jobs", d: "Draining queues, syncing CRMs, drafting content, ranking campaigns, reconciling attribution — around the clock." },
          { t: "Bring your own model", d: "Point each agent at Claude, Gemini, OpenAI, or a local runtime. Swap per-agent, no lock-in." },
          { t: "Governance built in", d: "Per-agent budgets, approval gates, and a full audit log. Nothing irreversible happens without you." },
          { t: "Your data, connected", d: "HubSpot, Google Search Console, PostHog, SerpAPI, Slack, LinkedIn — each activates the moment its key is set." },
        ]} />
      </Block>

      <Block title="Four steps to live" intro="No credit card, no sales call. Most teams are running agents the same day.">
        <Steps items={[
          { t: "Request access", d: "Email us for an invite. We send a one-click link scoped to your workspace." },
          { t: "Sign in & set your password", d: "Open the invite link, create your account, and you're in the cockpit. Email confirmation isn't required in beta." },
          { t: "Connect a data source", d: "Point AGNB at HubSpot, GSC, or your CRM. Keys are stored as encrypted secrets; sync jobs activate automatically on key presence." },
          { t: "Hire your first agent", d: "Spin up a producer under a project, give it a goal, and let the heartbeat run it. Approval gates stay on until it earns your trust." },
        ]} />
      </Block>

      <Block title="What happens next" intro="Once you're in, the loop takes over.">
        <Grid items={[
          { t: "It starts syncing", d: "Connectors pull your CRM, search, and review data on schedule — the North Star fills in within the first cycle." },
          { t: "Agents pick up goals", d: "Give the CMO a target and it briefs the producers. Work flows from mission to task automatically." },
          { t: "You review, not grind", d: "Drafts and proposed actions land in an approval queue. You make the calls; the agents do the reps." },
        ]} />
      </Block>

      <Faqs items={[
        { q: "Do I need to self-host?", a: "No. AGNB runs as a managed instance for you. The underlying platform is open source if you ever want to run your own." },
        { q: "Is there a free trial?", a: "Beta access is invite-only and free while we're in stealth. No credit card required." },
        { q: "How long does setup take?", a: "Signing in takes a minute. Connecting your first data source and enabling jobs takes a few more. Most teams see the North Star populate the same day." },
        { q: "Can I turn the agents off?", a: "Any time. Everything with an external side-effect is disabled by default, and you can pause a single agent or the whole company with one switch." },
      ]} />
      <CtaRow />
    </Shell>
  );
}

// ─── Quickstart ───────────────────────────────────────────────────────────────

export function QuickstartPage() {
  return (
    <Shell eyebrow="Quickstart" title="Up and running in minutes." sub="The fastest path from sign-in to agents working your growth stack around the clock.">
      <Block title="Before you begin">
        <Grid items={[
          { t: "An invite", d: "AGNB is invite-only in beta. Email us and we'll send a scoped link." },
          { t: "Your integration keys", d: "Have a HubSpot token, GSC property, or other keys handy — you'll paste them as encrypted secrets." },
          { t: "A model key (optional)", d: "A Gemini, Claude, or OpenAI key lets agents draft and reason. Local runtimes work too." },
        ]} />
      </Block>

      <Block title="Four steps">
        <Steps items={[
          { t: "Sign in", d: "Use the email + password from your invite. You land directly in the dashboard." },
          { t: "Connect your stack", d: "Add your integration keys under Secrets. Each connector self-activates when its key is present — no rebuild." },
          { t: "Enable the jobs", d: "35 scheduled jobs ship disabled-by-default for anything with external side-effects. Toggle on the ones you want." },
          { t: "Hire an agent & watch the loop", d: "Create a producer under a project, give it a goal, and the heartbeat runs it. Watch Jobs and North Star to see work land." },
        ]} />
      </Block>

      <Block title="Connectors activate on key presence" intro="Set keys as encrypted secrets in the cockpit; the matching jobs come alive automatically.">
        <Code>{`# Secrets — set in the cockpit (never exposed to agents in the clear)
HUBSPOT_TOKEN=...           # pipeline + CRM sync, hygiene scans
GSC_PROPERTY=sc-domain:yourdomain.com   # keyword rank + content gaps
SERPAPI_KEY=...             # review ratings + SERP share-of-voice
POSTHOG_PROJECT_ID=...      # signup funnel + traffic
GEMINI_API_KEY=...          # drafting, analysis, agent reasoning

# Enable a job on demand:
POST /api/agnb/jobs/reviews-sync/toggle?enabled=true

# Run one now:
POST /api/agnb/jobs/reviews-sync/run`}</Code>
      </Block>

      <Block title="Where to go next">
        <Grid items={[
          { t: "Agents →", d: "Understand roles, the org chart, and the heartbeat. /platform/agents" },
          { t: "Governance →", d: "Budgets, approvals, and the default-off model. /platform/governance" },
          { t: "API reference →", d: "Drive everything from /api/agnb. /api" },
        ]} />
      </Block>
      <CtaRow />
    </Shell>
  );
}

// ─── Agents ───────────────────────────────────────────────────────────────────

export function AgentsPage() {
  return (
    <Shell eyebrow="Platform · Agents" title="A company staffed by agents." sub="Not one chatbot — an org of specialised agents with roles, goals, budgets, and a heartbeat. You set direction; they do the reps.">
      <Block>
        <div className={cn(card, "flex flex-col items-center gap-4 text-center")}>
          <Bot className="size-9 text-[#f97316]" />
          <p className="max-w-2xl text-[16px] leading-relaxed text-gray-600 dark:text-neutral-300">
            A CEO sets the mission. A CMO and CFO run marketing and money. Producer
            agents — Blog Writer, Sales-Ops, SEO Analyst, Reviews Monitor — do the
            channel work. Every agent traces its tasks back up to a single goal.
          </p>
        </div>
      </Block>

      <Block title="The org chart" intro="Agents report into managers, managers into the CEO — the same structure you'd give a human team.">
        <div className="mx-auto max-w-2xl"><OrgChart /></div>
      </Block>

      <Block title="How agents work">
        <Grid items={[
          { t: "Roles, not prompts", d: "Each agent has a job description, a goal, and the tools for its lane — like onboarding a hire, not tuning a prompt." },
          { t: "Bring your own model", d: "Point each agent at Claude, Gemini, OpenAI, Codex, Grok, or OpenCode. Swap per-agent; no lock-in." },
          { t: "Heartbeat", d: "Agents wake on a schedule or on demand and resume where they left off — outbound, content, syncs, PRs." },
          { t: "Goal alignment", d: "Mission → Project → Agent → Task. Every unit of work traces up, so nothing drifts off-strategy." },
          { t: "Approval gates", d: "Anything irreversible waits for a human. Promote an agent to act-with-approval once it earns trust." },
          { t: "Full lifecycle control", d: "Pause, resume, override, reassign, or terminate any agent at any time — individually or the whole fleet." },
        ]} />
      </Block>

      <Block title="The heartbeat" intro="Producers fire on their own cadence. The scheduler keeps 35 jobs draining, syncing, drafting, and observing around the clock.">
        <Heartbeat />
      </Block>

      <Block title="Every task traces up" intro="No agent freelances. Each task is anchored to an agent goal, a project goal, and ultimately the company mission.">
        <GoalTrace />
      </Block>

      <Faqs items={[
        { q: "What models can agents run on?", a: "Claude, Gemini, and OpenAI via API, plus local runtimes like Codex, Grok, and OpenCode. You pick per agent and can swap any time." },
        { q: "Do agents act without me?", a: "Only within the lanes you allow. Anything irreversible — sending email, publishing, spending — is gated by an approval queue and off by default." },
        { q: "How do agents stay on-strategy?", a: "Goal alignment. Every task references an agent goal that rolls up to a project goal and the mission, so work can't drift." },
        { q: "What if an agent misbehaves?", a: "Pause or terminate it instantly, review its full run log, and reassign its work. Nothing it did is hidden." },
      ]} />
      <CtaRow />
    </Shell>
  );
}

// ─── Governance ───────────────────────────────────────────────────────────────

export function GovernancePage() {
  return (
    <Shell eyebrow="Platform · Governance" title="Autonomous, but you stay in control." sub="Speed without the blast radius. Budgets, approvals, and a full audit trail keep the agents on a leash you control.">
      <Block>
        <div className={cn(card, "flex flex-col items-center gap-4 text-center")}>
          <ShieldCheck className="size-9 text-[#f97316]" />
          <p className="max-w-2xl text-[16px] leading-relaxed text-gray-600 dark:text-neutral-300">
            Every external send, publish, or spend is gated by default. The CFO
            tracks budget per agent. You can stop the whole company with one switch.
          </p>
        </div>
      </Block>

      <Block title="Per-agent budgets" intro="The CFO meters spend. Set a monthly cap per agent; they warn at 80% and stop cleanly at 100%.">
        <BudgetTable />
      </Block>

      <Block title="The controls">
        <Grid items={[
          { t: "Approval queue", d: "Drafts — outreach, replies, posts — land in a queue. Nothing leaves the building without a human yes." },
          { t: "Default-off side effects", d: "Jobs that send, post, or spend ship disabled. Enable them deliberately, per instance." },
          { t: "Pause · Resume · Override", d: "Take manual control of any agent or the whole fleet at any time." },
          { t: "Reassign · Terminate", d: "Move work between agents or shut one down — its history and tasks are preserved." },
          { t: "Audit log", d: "Every run, tool call, and decision is recorded and traceable back to the goal that triggered it." },
          { t: "Scoped access & secrets", d: "Invite-based access with per-member roles. Secrets are encrypted, never exposed to agents in the clear." },
        ]} />
      </Block>

      <Faqs items={[
        { q: "Can an agent spend money on its own?", a: "No. Budgets are hard caps enforced by the CFO, and anything that actually spends is gated. Agents stop at 100% utilization automatically." },
        { q: "Will agents email my customers without approval?", a: "Not unless you explicitly enable it. Outreach and replies are drafted into an approval queue; external send is off by default and flag-gated." },
        { q: "How do I audit what happened?", a: "Every agent run, tool call, and decision is logged and linked to the issue and goal that triggered it. Nothing is hidden." },
        { q: "Can I stop everything at once?", a: "Yes. Pause the whole company with a single switch; resume when you're ready." },
      ]} />
      <CtaRow />
    </Shell>
  );
}

// ─── Integrations ─────────────────────────────────────────────────────────────

const INTEGRATIONS = [
  { abbr: "HS", name: "HubSpot", cat: "CRM", d: "Two-way deal + CRM sync, pipeline board grouped by stage, automated hygiene scans, webhooks." },
  { abbr: "GSC", name: "Google Search Console", cat: "SEO", d: "Keyword rank tracking, content-gap signals, BoFu page monitoring." },
  { abbr: "PH", name: "PostHog", cat: "Analytics", d: "Signup funnel, traffic sources, product analytics feeding attribution." },
  { abbr: "SERP", name: "SerpAPI", cat: "SEO", d: "Review ratings across platforms + SERP share-of-voice." },
  { abbr: "SLK", name: "Slack", cat: "Comms", d: "Alerts and the HQ notification feed for anything that needs a human." },
  { abbr: "LI", name: "LinkedIn", cat: "Outbound", d: "Multi-sender outbound, post scheduling, hook library." },
  { abbr: "RKT", name: "RocketSDR", cat: "Outbound", d: "Lead sourcing, inbox sync, persona + product enrichment." },
  { abbr: "GEM", name: "Gemini", cat: "Model", d: "Drafting, analysis, and agent reasoning." },
  { abbr: "CLX", name: "Claude", cat: "Model", d: "Primary agent runtime via adapters." },
];

export function IntegrationsPage() {
  return (
    <Shell eyebrow="Platform · Integrations" title="Works with the stack you already run." sub="Drop AGNB in alongside your tools. Each connector self-activates the moment its key is set — nothing to rebuild.">
      <Block title="How activation works" intro="No setup wizard per tool. Paste a key as an encrypted secret and the matching jobs come alive on their next cycle.">
        <Code>{`HUBSPOT_TOKEN=...        ->  pipeline-sync, hubspot-deals-sync, crm-hygiene-scan
GSC_PROPERTY=...         ->  gsc-rank-tracker, content-gap signals
SERPAPI_KEY=...          ->  reviews-sync, share-of-voice
POSTHOG_PROJECT_ID=...   ->  posthog-sync (funnel + traffic)`}</Code>
      </Block>

      <Block title="Connectors">
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {INTEGRATIONS.map((i) => (
            <div key={i.name} className={cn(card, "transition hover:-translate-y-0.5 hover:border-[#f97316]/40 hover:shadow-md")}>
              <div className="mb-3 flex items-center justify-between">
                <span className="flex size-11 items-center justify-center rounded-xl bg-[#f97316]/10 font-mono text-[13px] font-bold text-[#f97316]">{i.abbr}</span>
                <span className="rounded-full border border-black/[0.08] px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-gray-400 dark:border-white/10 dark:text-neutral-500">{i.cat}</span>
              </div>
              <h3 className="text-[16px] font-semibold text-gray-900 dark:text-neutral-100">{i.name}</h3>
              <p className="mt-1 text-[13.5px] leading-relaxed text-gray-500 dark:text-neutral-400">{i.d}</p>
            </div>
          ))}
        </div>
      </Block>

      <Block title="Local agent runtimes" intro="Beyond hosted models, agents can run on local adapters — no data leaves your environment.">
        <Grid items={[
          { t: "Codex", d: "Local OpenAI Codex runtime for code-capable agents." },
          { t: "Grok", d: "Local Grok adapter for fast reasoning." },
          { t: "OpenCode", d: "Open-source coding agent runtime." },
        ]} />
      </Block>

      <Block>
        <div className={cn(card, "flex flex-col items-center gap-3 text-center")}>
          <h3 className="text-[18px] font-semibold text-gray-900 dark:text-neutral-100">Need a connector we don't list?</h3>
          <p className="max-w-xl text-[14.5px] leading-relaxed text-gray-500 dark:text-neutral-400">Most tools expose an API or webhook — tell us what you run and we'll wire it.</p>
          <a href="mailto:diggi@hirefinn.ai?subject=AGNB%20Integration%20Request" className="mt-2 inline-flex items-center gap-2 rounded-lg bg-[#f97316] px-6 py-3 text-sm font-semibold text-white transition hover:bg-[#ea6a0c]">Request an integration <ArrowRight className="size-4" /></a>
        </div>
      </Block>
      <CtaRow />
    </Shell>
  );
}

// ─── Docs ─────────────────────────────────────────────────────────────────────

const DOC_CARDS = [
  { t: "Get started", d: "Invite to running agents — the full path.", href: "/get-started" },
  { t: "Quickstart", d: "Sign in, connect a source, enable jobs, hire an agent.", href: "/quickstart" },
  { t: "Agents", d: "Roles, adapters, the org chart, and the heartbeat.", href: "/platform/agents" },
  { t: "Governance", d: "Approvals, budgets, audit, and the default-off model.", href: "/platform/governance" },
  { t: "Integrations", d: "Connectors and the key-presence activation model.", href: "/platform/integrations" },
  { t: "API reference", d: "The /api/agnb endpoints that back the cockpit.", href: "/api" },
];

export function DocsPage() {
  return (
    <Shell eyebrow="Developers · Documentation" title="Documentation." sub="Concepts, setup, and the moving parts behind the cockpit.">
      <Block title="Start here">
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {DOC_CARDS.map((c) => (
            <a key={c.t} href={c.href} className={cn(card, "group transition hover:-translate-y-0.5 hover:border-[#f97316]/40 hover:shadow-md")}>
              <h3 className="mb-2 flex items-center justify-between text-[16px] font-semibold text-gray-900 dark:text-neutral-100">
                {c.t}<ArrowRight className="size-4 text-[#f97316] transition group-hover:translate-x-0.5" />
              </h3>
              <p className="text-[14px] leading-relaxed text-gray-500 dark:text-neutral-400">{c.d}</p>
            </a>
          ))}
        </div>
      </Block>

      <Block title="How it fits together" intro="AGNB is a growth cockpit fused with an agent-orchestration layer — and they cross-pollinate.">
        <div className="space-y-4">
          {[
            ["The cockpit", "Campaigns, pipeline, content, mentions, and revenue — every growth surface in one login, backed by the /api/agnb API."],
            ["The agent layer", "Goals, projects, issues, routines, and approvals. Agents are hired into projects and driven by routines (cron) and a heartbeat."],
            ["The jobs", "35 scheduled workers handle the deterministic grind — syncing, draining, drafting, ranking, reconciling — and feed the cockpit."],
            ["The crossover", "An agent can run a campaign; a routine can ship a PR. The growth stack and the orchestration layer share one surface."],
          ].map(([t, d]) => (
            <div key={t} className={cn(card, "flex gap-4")}>
              <ChevronRight className="mt-0.5 size-5 shrink-0 text-[#f97316]" />
              <div><h3 className="text-[15.5px] font-semibold text-gray-900 dark:text-neutral-100">{t}</h3><p className="mt-1 text-[14px] leading-relaxed text-gray-500 dark:text-neutral-400">{d}</p></div>
            </div>
          ))}
        </div>
      </Block>
    </Shell>
  );
}

// ─── API reference ────────────────────────────────────────────────────────────

const API_GROUPS: { group: string; rows: { m: string; p: string; d: string }[] }[] = [
  { group: "Overview", rows: [
    { m: "GET", p: "/api/agnb/north-star", d: "Headline KPIs across the funnel." },
    { m: "GET", p: "/api/health", d: "Instance + deployment status." },
  ]},
  { group: "Jobs", rows: [
    { m: "GET", p: "/api/agnb/jobs", d: "Scheduler state for all 35 jobs." },
    { m: "POST", p: "/api/agnb/jobs/:key/run", d: "Run a job on demand." },
    { m: "POST", p: "/api/agnb/jobs/:key/toggle", d: "Enable or disable a job (?enabled=true)." },
  ]},
  { group: "Revenue & pipeline", rows: [
    { m: "GET", p: "/api/agnb/pipeline/board", d: "HubSpot deals grouped by stage." },
    { m: "POST", p: "/api/agnb/pipeline/deals", d: "Upsert a deal." },
  ]},
  { group: "Content & research", rows: [
    { m: "GET", p: "/api/agnb/idea-inbox", d: "Captured content ideas." },
    { m: "PATCH", p: "/api/agnb/idea-inbox?id=", d: "Promote, trash, or edit an idea." },
    { m: "POST", p: "/api/agnb/content-gaps", d: "Ingest competitor content gaps." },
  ]},
  { group: "Reputation", rows: [
    { m: "GET", p: "/api/agnb/mentions", d: "Community mentions + sentiment." },
    { m: "GET", p: "/api/agnb/reviews", d: "Review platforms + ratings." },
    { m: "POST", p: "/api/agnb/sov/results", d: "Ingest share-of-voice runs." },
  ]},
];

export function ApiPage() {
  return (
    <Shell eyebrow="Developers · API reference" title="One API behind the cockpit." sub="Everything in AGNB is backed by the /api/agnb surface. Authenticated agents and the board org can call it directly.">
      <Block title="Authentication" intro="Two principals can call the API.">
        <Grid items={[
          { t: "Agents", d: "Authenticate with a signed JWT (PAPERCLIP_AGENT_JWT). Scoped to their company and tasks." },
          { t: "Board members", d: "Authenticate with a session cookie from sign-in. Full instance access." },
          { t: "Conventions", d: "JSON in, JSON out. Idempotent ingest endpoints (NOT EXISTS / ON CONFLICT). Errors return { ok: false, error }." },
        ]} />
      </Block>

      <Block title="Endpoints">
        <div className="space-y-6">
          {API_GROUPS.map((g) => (
            <div key={g.group}>
              <p className="mb-2 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-400 dark:text-neutral-500">{g.group}</p>
              <div className={cn(card, "overflow-hidden p-0")}>
                <ul className="divide-y divide-black/[0.06] dark:divide-white/[0.06]">
                  {g.rows.map((e) => (
                    <li key={e.p} className="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:items-center sm:gap-4">
                      <span className={cn("inline-flex w-fit shrink-0 rounded px-2 py-0.5 font-mono text-[11px] font-bold", e.m === "GET" ? "bg-[#22c55e]/10 text-[#16a34a]" : "bg-[#f97316]/10 text-[#f97316]")}>{e.m}</span>
                      <code className="font-mono text-[13px] text-gray-800 dark:text-neutral-200">{e.p}</code>
                      <span className="text-[13px] text-gray-500 dark:text-neutral-400 sm:ml-auto sm:text-right">{e.d}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ))}
        </div>
      </Block>

      <Block title="Example">
        <Code>{`curl https://app.allgasnobrakes.online/api/agnb/north-star \\
  -H "Authorization: Bearer $AGNB_TOKEN"

{
  "ok": true,
  "pipeline": { "open_deals": 4, "open_value_usd": 1000 },
  "sov": { "mention_rate": 1, "runs": 482 },
  "reviews": { "avg_rating": 4.47, "total_reviews": 10543, "platforms": 4 },
  "mentions": { "total_30d": 136, "positive": 12, "negative": 1 }
}`}</Code>
      </Block>
    </Shell>
  );
}

// ─── Blog ─────────────────────────────────────────────────────────────────────

export function BlogPage() {
  return (
    <Shell eyebrow="Resources · Blog" title="Notes from the redline." sub="How we're building an autonomous growth company — in public, soon.">
      <Block title="What we'll write about">
        <Grid items={[
          { t: "Agent playbooks", d: "The exact goals, prompts, and guardrails behind each producer agent." },
          { t: "What worked (and didn't)", d: "Real numbers from running outbound, content, and pipeline on autopilot." },
          { t: "Building the company", d: "Org design for agents: roles, budgets, heartbeats, and approval gates." },
          { t: "Growth experiments", d: "Share-of-voice, content gaps, review monitoring — what moved the needle." },
          { t: "Under the hood", d: "How the 35-job scheduler, adapters, and goal alignment actually work." },
          { t: "Founder notes", d: "Lessons from handing the grind to agents and keeping a human in the loop." },
        ]} />
      </Block>
      <Block>
        <div className={cn(card, "mx-auto flex max-w-xl flex-col items-center gap-4 text-center")}>
          <Gauge className="size-9 text-[#f97316]" />
          <h3 className="text-[18px] font-semibold text-gray-900 dark:text-neutral-100">First posts are on the way.</h3>
          <p className="text-[14.5px] leading-relaxed text-gray-500 dark:text-neutral-400">Want it in your inbox? Ask for an invite and you'll be first to know.</p>
          <a href="mailto:diggi@hirefinn.ai?subject=AGNB%20Blog" className="mt-2 inline-flex items-center gap-2 rounded-lg bg-[#f97316] px-6 py-3 text-sm font-semibold text-white transition hover:bg-[#ea6a0c]">Notify me <ArrowRight className="size-4" /></a>
        </div>
      </Block>
    </Shell>
  );
}

// ─── Changelog ────────────────────────────────────────────────────────────────

const CHANGELOG = [
  { date: "Jun 2026", items: [
    "New marketing site — premium light/dark, real product screenshots, orbit visual, agent-company diagrams.",
    "Public Platform + Developer pages: Agents, Governance, Integrations, Docs, API reference.",
    "Bring-your-own-agent: Claude, Gemini, OpenAI, and local adapters (Codex, Grok, OpenCode) per agent.",
    "Central account provisioning + invite-only access (public sign-up disabled in beta).",
    "Light/dark theme across the marketing surface.",
  ]},
  { date: "May 2026", items: [
    "Exec daily loop — CEO reviews the north star and proposes the day's work.",
    "Cross-channel repurpose — one content gap → blog idea + LinkedIn hook + YouTube title.",
    "Outcome feedback — slipping BoFu pages auto-brief a refresh.",
    "Act-with-approval — human-approved ideas advance into the writing pipeline.",
    "North Star dashboard — pipeline, share-of-voice, reviews, mentions, backlinks in one view.",
    "Reviews-sync via SerpAPI, HubSpot deals mirror, negative-signal watch, SoV watch.",
    "Backlink outreach drafter, gap-to-idea, content-gap promotion.",
  ]},
  { date: "Apr 2026", items: [
    "Producer agents wired to Routines (cron) + durable instruction bundles.",
    "Manager layer — CEO, CMO, CFO with per-agent budgets.",
    "Agent-auth fix: /api/agnb accepts authenticated agent JWTs.",
    "35-job scheduler ported in; external side-effects default-off.",
  ]},
];

export function ChangelogPage() {
  return (
    <Shell eyebrow="Resources · Changelog" title="What shipped." sub="The agent company is built in public. Here's what's new.">
      <div className="mx-auto max-w-2xl space-y-10 py-6">
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
      <div className="mt-8 text-center">
        <a href="/auth" className="inline-flex items-center gap-2 text-[13px] font-medium text-gray-500 transition hover:text-gray-900 dark:text-neutral-400 dark:hover:text-neutral-100">
          <ArrowLeft className="size-4" /> Back to home
        </a>
      </div>
    </Shell>
  );
}
