import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { SiteNav } from "@/components/SiteNav";
import { LandingFooter, LoginCard, OrgChart, Heartbeat, BudgetTable, GoalTrace } from "./Landing";
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
    <div className="agnb-scroll h-screen overflow-y-auto bg-[#F6F3EC] text-gray-900 antialiased dark:bg-[#1b1410] dark:text-neutral-100">
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

const card = "rounded-2xl border border-black/[0.07] bg-white p-7 shadow-sm dark:border-white/[0.08] dark:bg-[#261f19]";

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
    <pre className="overflow-x-auto rounded-xl border border-white/10 bg-[#15110d] p-4 font-mono text-[12.5px] leading-relaxed text-neutral-200">
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
      <a href="/contact" className="inline-flex items-center gap-2 rounded-lg border border-black/[0.12] bg-white px-7 py-3.5 text-sm font-semibold text-gray-900 transition hover:bg-[#FAF8F4] dark:border-white/15 dark:bg-[#261f19] dark:text-neutral-100 dark:hover:bg-[#2f271f]">
        Contact Sales
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

// ─── Legal (Privacy + Terms) ──────────────────────────────────────────────────

const isNumHeading = (l: string) => /^\d+\.\s/.test(l);
const isSubHeading = (l: string) => /^[A-Z]\.\s/.test(l);

function LegalShell({ title, updated, lines }: { title: string; updated: string; lines: string[] }) {
  useEffect(() => {
    const t = (() => { try { return localStorage.getItem("paperclip.theme"); } catch { return null; } })();
    if (t) document.documentElement.classList.toggle("dark", t === "dark");
  }, []);
  return (
    <div className="agnb-scroll h-screen overflow-y-auto bg-[#F6F3EC] text-gray-900 antialiased dark:bg-[#1b1410] dark:text-neutral-100">
      <SiteNav />
      <article className="mx-auto max-w-3xl px-6 py-16">
        <p className="mb-3 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-[#f97316]">Legal</p>
        <h1 className="text-[clamp(32px,4.5vw,48px)] font-extrabold tracking-[-0.03em]">{title}</h1>
        <p className="mt-3 text-[13px] text-gray-500 dark:text-neutral-400">Last updated: {updated}</p>
        <div className="mt-10">
          {lines.map((l, i) =>
            isNumHeading(l) ? (
              <h2 key={i} className="mb-3 mt-10 text-[22px] font-bold tracking-[-0.02em] text-gray-900 dark:text-neutral-100">{l}</h2>
            ) : isSubHeading(l) ? (
              <h3 key={i} className="mb-2 mt-6 text-[15px] font-semibold text-gray-800 dark:text-neutral-200">{l}</h3>
            ) : (
              <p key={i} className="mb-4 text-[15px] leading-relaxed text-gray-600 dark:text-neutral-400">{l}</p>
            ),
          )}
        </div>
        <div className="mt-12 border-t border-black/[0.08] pt-6 dark:border-white/[0.08]">
          <a href="/auth" className="inline-flex items-center gap-2 text-[13px] font-medium text-gray-500 transition hover:text-gray-900 dark:text-neutral-400 dark:hover:text-neutral-100">
            <ArrowLeft className="size-4" /> Back to home
          </a>
        </div>
      </article>
      <LandingFooter />
    </div>
  );
}

const PRIVACY_LINES = [
  `This Privacy Policy explains how AIforge Tech Private Limited ("All Gas No Brakes", "AGNB", "we", "us", "our") processes personal and business data. We provide an autonomous AI agent platform for growth operations ("Software" or "Platform"), accessible via allgasnobrakes.online.`,
  "We comply with applicable global data protection frameworks, including the Digital Personal Data Protection Act, 2023 (DPDP, India), the General Data Protection Regulation (GDPR, EU/UK), and the California Consumer Privacy Act (CCPA, USA).",
  "1. Our Role: Controller vs. Processor",
  "To clarify our legal responsibilities, AGNB operates in two distinct capacities:",
  `Data Controller: We act as the Controller for the personal data of our direct customers ("Users") who register for an account, manage billing, and interact with our Website.`,
  `Data Processor: We act as a Processor for the data our Users connect to the Platform and that the agents process on their behalf — including CRM records, prospect and campaign data, and content. The User is the Controller of that data and is responsible for obtaining any necessary consent.`,
  "2. What Data We Collect",
  "A. Account and Billing Data (User Data)",
  "To register for our services, we collect your first and last name, email address, and company name. If you choose a paid plan, we also collect payment details. Purpose: to fulfill our SaaS contract, manage subscriptions, and provide support.",
  "B. Operational Data (Connected Data)",
  "When you connect integrations (for example HubSpot, Google Search Console, PostHog, or LinkedIn), the Platform processes the records, metrics, and content needed to run your growth operations — deals, campaigns, mentions, rankings, and drafts. Keys and tokens are stored as encrypted secrets and are never exposed to agents in the clear. Purpose: to execute the core functionality of the agents on your behalf.",
  "C. Website Log Data",
  `When you visit our Website, we automatically collect limited "log data" stored temporarily to ensure stability and security: IP address, browser and operating system information, referral URL, and time of access. The legal basis is our legitimate interest in the proper operation of the Website.`,
  "D. Cookies",
  "Our Website uses session and persistent cookies to improve functionality and analyze usage. You can manage or revoke consent at any time via your browser settings or our cookie banner.",
  "E. Contact Requests",
  "When you contact us, we collect your name and email solely to respond to your query.",
  "3. How We Use Data for AI Model Improvement",
  "To improve the Platform, AGNB may use aggregated and anonymized data. We do not use Personally Identifiable Information (PII) to train foundational models. Agents run on third-party or local model providers you select; your prompts and data are subject to those providers' terms. Users retain ownership of their data, granting AGNB a license solely to provide and improve the service.",
  "4. Security and Compliance",
  "We implement robust technical and organizational safeguards, including encryption in transit and at rest and role-based access controls. Our infrastructure is aligned with SOC 2 standards (certification in progress). For Users processing sensitive data, specific obligations are governed by our separate Data Processing Agreement (DPA).",
  "5. Data Retention and Deletion",
  "We retain User account data for the duration of the active subscription and as required by law. Operational data is retained according to your configuration or until you request deletion. If an account remains entirely inactive for twelve (12) months, associated operational data may be automatically and permanently deleted.",
  "6. Your Data Protection Rights",
  "Depending on your jurisdiction, you have the right to access, rectify, erase, restrict or object to processing, port your data, and withdraw consent at any time. To exercise these rights, contact us at the address below.",
  "7. International Data Transfers",
  "If we transfer personal data outside its originating jurisdiction, we ensure appropriate legal safeguards are in place, such as Standard Contractual Clauses (SCCs).",
  "8. Contact Information",
  "For data protection inquiries or to request our standard Data Processing Agreement (DPA), please contact: AIforge Tech Private Limited, D-253, Kardhani Govindpura, Kalwar Road, Jaipur, Rajasthan – 302012, India. Email: hello@hirefinn.ai.",
];

const TERMS_LINES = [
  "1. Scope",
  `AIforge Tech Private Limited, registered under CIN U62099RJ2025PTC099494, with its registered address at D-253, Kardhani Govindpura, Kalwar Road, Jaipur, Rajasthan – 302012, India ("AGNB"), operates a platform that enables customers ("Users") to deploy autonomous AI agents ("Agents") to automate growth operations ("Software"), offered as a subscription. These general terms ("GTC") govern the relationship between AGNB and the User. AGNB provides its services exclusively to business entities, not individual consumers.`,
  "2. Object of the Agreement",
  "AGNB provides the Software as software-as-a-service (SaaS), operated by AGNB in a managed cloud-hosted environment and accessed via allgasnobrakes.online. To access the Software, the User creates an account by registering with an email address and password. By registering, the User agrees to these GTC.",
  "3. Subscriptions and Fees",
  "Subscriptions operate on base tiers with usage limits, billed per the Plan. Plans and fees on the Website are an invitation to offer; the User submits a binding offer by selecting a Plan and providing billing details. The User agrees to pay subscription fees and any usage-based overages. All fees exclude taxes. Any billing dispute must be submitted in writing within 7 days of the invoice date; failure to do so constitutes acceptance of the charges.",
  "4. License",
  "AGNB grants the User a non-exclusive, non-transferable, non-sublicensable license to use the Software as specified in the Plan. The User is responsible for all actions taken by their authorized users, and may not remove any of AGNB's copyright, trademark, or proprietary notices.",
  "5. Input, Output, and AI Liability",
  `"Input" is all data, content, or materials provided by the User or connected by integrations. "Output" is all data or materials generated by the Software. The User is responsible for the legality of and rights to Input.`,
  "The User acknowledges that AI models can be unpredictable. The User assumes full and sole liability for all actions and communications executed by their Agents; all Agent outputs are deemed communications made directly by the User. AGNB is not liable for inaccurate information or unauthorized advice generated by an Agent. The User indemnifies AGNB against claims arising from Input or Output, except for AGNB's gross negligence.",
  "6. Obligations and Compliance of the User",
  "The User must comply with all applicable regulations regarding data privacy and electronic communications, including anti-spam laws (e.g., CAN-SPAM, GDPR, DPDP) for any outbound the Agents perform. The User is prohibited from unauthorized sharing, infringing content, malware, security interference, reverse engineering, and from using the Software for fraud, harassment, or unauthorized medical, legal, or financial advice. The User is responsible for resolving third-party complaints and for protecting account credentials (including using MFA).",
  "7. Warranty",
  "AGNB warrants the Software's functionalities as specified in the Plan; all other warranties are disclaimed to the fullest extent permitted by law. AGNB aims for high availability, excluding planned downtime and force-majeure events, and may introduce updates and new features to improve the Software.",
  "8. Third-Party Applications and Model Providers",
  "The Software integrates with third-party products and model providers (for example HubSpot, Google, PostHog, and Claude, Gemini, or OpenAI). Where the User supplies their own keys, the applicable third-party terms apply directly to the User. In conflicts, these GTC prevail. AGNB does not warrant non-listed third-party applications.",
  "9. Intellectual Property",
  "AGNB retains all rights in the Software, services, and documentation. Unless agreed otherwise, Users own their Input and Output. The User grants AGNB a non-exclusive right to use Input to provide and improve the service. Feedback may be freely used by AGNB without compensation.",
  "10. Confidentiality",
  "Each party uses the other's Confidential Information only to perform the Agreement, discloses it to third parties only under confidentiality obligations, and deletes it upon termination except as legally required. Obligations survive for three years post-termination.",
  "11. Data Protection",
  "Processing of personal data is governed by a separate Data Processing Agreement, available upon request.",
  "12. Limitation of Liability",
  "AGNB is liable only for intent or gross negligence. AGNB's total liability is capped at the subscription fees paid by the User in the three (3) months preceding the claim. All other liability is excluded except mandatory statutory liability.",
  "13. Term and Termination",
  "The Agreement's initial term is as specified in the Plan and renews automatically. Either party may terminate with notice as set out in the Plan. Termination for cause is possible for uncured material breaches or immediately for insolvency. AGNB may suspend or terminate for breaches threatening Software security or data protection.",
  "14. Amendments",
  "AGNB may amend these GTC for legal, security, or product-development reasons. Users receive reasonable notice and may object within the notice period; silence equals acceptance.",
  "15. Final Provisions",
  "Neither party may assign the Agreement without the other's consent. The Agreement is governed by the laws of India, excluding conflict-of-law rules. Exclusive jurisdiction for disputes is Jaipur. Legal inquiries can be directed to hello@hirefinn.ai.",
];

export function PrivacyPage() {
  return <LegalShell title="Privacy Policy" updated="7 June 2026" lines={PRIVACY_LINES} />;
}

export function TermsPage() {
  return <LegalShell title="Terms of Service" updated="7 June 2026" lines={TERMS_LINES} />;
}

// ─── Contact Sales ────────────────────────────────────────────────────────────

const CONTACT_BENEFITS = [
  { t: "Priority onboarding", d: "We connect your stack, hire your first agents, and get the loop running with you." },
  { t: "Premium support", d: "A direct line to our team via a private Slack channel — humans, not tickets." },
  { t: "Data security", d: "Encryption in transit and at rest, role-based access, and a DPA on request. SOC 2 in progress." },
  { t: "Scale & budgets", d: "Per-agent budgets, higher limits, and dedicated capacity as your agent company grows." },
];

const TEAM_SIZES = ["1–10", "11–50", "51–200", "201–1000", "1000+"];

export function ContactPage() {
  useEffect(() => {
    const t = (() => { try { return localStorage.getItem("paperclip.theme"); } catch { return null; } })();
    if (t) document.documentElement.classList.toggle("dark", t === "dark");
  }, []);
  const [sent, setSent] = useState(false);

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const name = String(f.get("name") ?? "").trim();
    const email = String(f.get("email") ?? "").trim();
    const company = String(f.get("company") ?? "").trim();
    const size = String(f.get("size") ?? "").trim();
    const msg = String(f.get("message") ?? "").trim();
    const body = `Name: ${name}%0D%0AWork email: ${email}%0D%0ACompany: ${company}%0D%0ATeam size: ${size}%0D%0A%0D%0A${msg}`;
    window.location.href = `mailto:hq@hirefinn.ai?subject=AGNB%20—%20Contact%20Sales%20(${encodeURIComponent(company || name)})&body=${body}`;
    setSent(true);
  };

  const input = "w-full rounded-lg border border-black/[0.1] bg-[#FAF8F4] px-4 py-3 text-[15px] text-gray-900 placeholder:text-gray-400 focus:border-[#f97316] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#f97316]/20 dark:border-white/10 dark:bg-[#2f271f]/60 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:bg-[#2f271f]";
  const label = "mb-1.5 block text-[13px] font-medium text-gray-700 dark:text-neutral-300";

  return (
    <div className="agnb-scroll h-screen overflow-y-auto bg-[#F6F3EC] text-gray-900 antialiased dark:bg-[#1b1410] dark:text-neutral-100">
      <SiteNav />
      <div className="mx-auto flex max-w-6xl flex-col gap-12 px-6 py-16 lg:flex-row lg:gap-20 lg:py-20">
        {/* Left rail */}
        <div className="flex-1">
          <p className="mb-3 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-[#f97316]">Contact Sales</p>
          <h1 className="text-[clamp(34px,4.5vw,52px)] font-extrabold leading-[1.05] tracking-[-0.03em]">Talk to the team.</h1>
          <p className="mt-4 max-w-md text-[17px] leading-[1.55] text-gray-500 dark:text-neutral-400">
            See how an autonomous agent company runs your growth — and get set up with priority onboarding.
          </p>
          <div className="mt-8 divide-y divide-black/[0.08] border-y border-black/[0.08] dark:divide-white/[0.08] dark:border-white/[0.08]">
            {CONTACT_BENEFITS.map((b) => (
              <div key={b.t} className="flex items-start gap-3 py-4">
                <ShieldCheck className="mt-0.5 size-5 shrink-0 text-[#f97316]" />
                <p className="text-[14px] leading-relaxed">
                  <span className="font-semibold text-gray-900 dark:text-neutral-100">{b.t} </span>
                  <span className="text-gray-500 dark:text-neutral-400">— {b.d}</span>
                </p>
              </div>
            ))}
          </div>
          <p className="mt-6 text-[13px] text-gray-500 dark:text-neutral-400">
            Prefer email? Reach us at <a href="mailto:hq@hirefinn.ai" className="font-medium text-[#f97316] hover:underline">hq@hirefinn.ai</a>.
          </p>
        </div>

        {/* Form */}
        <div className="w-full lg:max-w-md">
          <div className="rounded-2xl border border-black/[0.07] bg-white p-7 shadow-[0_8px_40px_rgba(0,0,0,0.06)] dark:border-white/[0.08] dark:bg-[#261f19] sm:p-8">
            {sent ? (
              <div className="flex flex-col items-center gap-3 py-10 text-center">
                <Check className="size-9 text-[#f97316]" />
                <h2 className="text-[18px] font-bold text-gray-900 dark:text-neutral-100">Thanks — your email is ready.</h2>
                <p className="text-[14px] text-gray-500 dark:text-neutral-400">Send the pre-filled message and we'll be in touch shortly.</p>
              </div>
            ) : (
              <form onSubmit={onSubmit} className="space-y-5">
                <div>
                  <label htmlFor="name" className={label}>Full name</label>
                  <input id="name" name="name" required placeholder="Jane Doe" className={input} />
                </div>
                <div>
                  <label htmlFor="email" className={label}>Work email</label>
                  <input id="email" name="email" type="email" required placeholder="jane@company.com" className={input} />
                </div>
                <div>
                  <label htmlFor="company" className={label}>Company</label>
                  <input id="company" name="company" placeholder="company.com" className={input} />
                </div>
                <div>
                  <label htmlFor="size" className={label}>Team size</label>
                  <select id="size" name="size" className={input} defaultValue="">
                    <option value="" disabled>Select</option>
                    {TEAM_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor="message" className={label}>What do you want to automate?</label>
                  <textarea id="message" name="message" rows={3} placeholder="Outbound, content, pipeline, dev work…" className={input} />
                </div>
                <button type="submit" className="group inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#f97316] px-6 py-3 text-sm font-semibold text-white transition hover:bg-[#ea6a0c]">
                  Contact Sales <ArrowRight className="size-4 transition group-hover:translate-x-0.5" />
                </button>
              </form>
            )}
          </div>
        </div>
      </div>
      <LandingFooter />
    </div>
  );
}

// ─── Sign in ──────────────────────────────────────────────────────────────────

export function SignInPage() {
  useEffect(() => {
    const t = (() => { try { return localStorage.getItem("paperclip.theme"); } catch { return null; } })();
    if (t) document.documentElement.classList.toggle("dark", t === "dark");
  }, []);
  return (
    <div className="agnb-scroll relative flex h-screen flex-col overflow-y-auto bg-[#F6F3EC] text-gray-900 antialiased dark:bg-[#1b1410] dark:text-neutral-100">
      <SiteNav />
      <div className="relative flex flex-1 items-center justify-center px-6 py-16">
        <div className="pointer-events-none absolute inset-0 -z-10" style={{ background: "radial-gradient(50% 40% at 50% 30%, rgba(249,115,22,0.12) 0%, transparent 70%)" }} />
        <div className="w-full max-w-md">
          <div className="mb-6 text-center">
            <h1 className="text-[clamp(28px,4vw,38px)] font-extrabold tracking-[-0.03em]">Welcome back.</h1>
            <p className="mt-2 text-[15px] text-gray-500 dark:text-neutral-400">Sign in and let the agents do the work.</p>
          </div>
          <LoginCard nextPath="/" />
          <p className="mt-6 text-center text-[13px] text-gray-500 dark:text-neutral-400">
            Need access? <a href="/contact" className="font-medium text-[#f97316] hover:underline">Contact Sales</a>
          </p>
        </div>
      </div>
      <LandingFooter />
    </div>
  );
}

// ─── Pricing (wallet + AI-credit model) ───────────────────────────────────────

type Plan = {
  name: string;
  rate?: string; rateUsd?: string;
  min?: string; minUsd?: string;
  credits?: string;
  highlight?: boolean;
  custom?: boolean;
  cta: string; ctaHref: string;
  perks: string[];
  note?: string;
};

const PLANS: Plan[] = [
  {
    name: "Starter",
    rate: "₹10", rateUsd: "$0.12", min: "₹2,000", minUsd: "$24", credits: "200",
    cta: "Start free", ctaHref: "/signin",
    note: "50 free credits on signup",
    perks: ["1 company", "All six engines", "Bring your own model", "Community support"],
  },
  {
    name: "Pro",
    rate: "₹7", rateUsd: "$0.08", min: "₹10,000", minUsd: "$160", credits: "1,400",
    highlight: true,
    cta: "Top up", ctaHref: "/signin",
    perks: ["Everything in Starter", "Unlimited agents", "All 35 scheduled jobs", "Every integration", "Approval gates + per-agent budgets", "Priority support"],
  },
  {
    name: "Scale",
    rate: "₹6", rateUsd: "$0.06", min: "₹50,000", minUsd: "$600", credits: "8,300",
    cta: "Top up", ctaHref: "/signin",
    perks: ["Everything in Pro", "Higher concurrency", "Dedicated capacity", "Custom budgets", "Private Slack support"],
  },
  {
    name: "Enterprise",
    custom: true,
    cta: "Contact Sales", ctaHref: "/contact",
    perks: ["Everything in Scale", "SSO + SAML", "DPA + SOC 2", "Dedicated infrastructure", "Solutions engineer"],
  },
];

const PRICING_FAQ = [
  { q: "What is an AI credit?", a: "A unit of agent work. Credits are deducted as agents run — drafting, syncing, ranking, planning. Your plan sets the per-credit rate; the cheaper the plan, the more work each top-up buys." },
  { q: "Is there a subscription?", a: "No. You top up a wallet and credits are deducted as the agents work. No monthly lock-in, no setup fees. Switch plans any time." },
  { q: "Do credits expire?", a: "Never. Top up once, run agents until the wallet is empty, top up again when you need more." },
  { q: "How do budgets work?", a: "The CFO meters spend per agent. Set a monthly cap; agents warn at 80% and stop cleanly at 100%, so a runaway agent can't drain your wallet." },
];

export function PricingPage() {
  return (
    <Shell eyebrow="Pricing" title="Top up once. The agents run on credits." sub="No subscription. Fund a wallet, and AI credits are deducted as the agents work — at your plan's rate. Switch plans any time. Credits never expire.">
      {/* Plan cards */}
      <Block>
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-4">
          {PLANS.map((p) => (
            <div
              key={p.name}
              className={cn(
                "flex flex-col rounded-2xl border p-6 shadow-sm",
                p.highlight
                  ? "border-[#f97316]/40 bg-white ring-2 ring-[#f97316]/30 dark:bg-[#261f19]"
                  : "border-black/[0.07] bg-white dark:border-white/[0.08] dark:bg-[#261f19]",
              )}
            >
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-[17px] font-bold text-gray-900 dark:text-neutral-100">{p.name}</h3>
                {p.highlight && <span className="rounded-full bg-[#f97316] px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-white">Popular</span>}
              </div>

              {p.custom ? (
                <div className="mb-5">
                  <p className="text-[28px] font-extrabold tracking-tight text-gray-900 dark:text-neutral-100">Custom</p>
                  <p className="mt-1 text-[12.5px] text-gray-500 dark:text-neutral-400">Volume rates + dedicated capacity.</p>
                </div>
              ) : (
                <div className="mb-5">
                  <p className="flex items-baseline gap-1.5">
                    <span className="text-[28px] font-extrabold tracking-tight text-gray-900 dark:text-neutral-100">{p.rate}</span>
                    <span className="text-[13px] text-gray-500 dark:text-neutral-400">/ credit</span>
                  </p>
                  <p className="mt-1 text-[12.5px] text-gray-500 dark:text-neutral-400">{p.rateUsd} · top up from {p.min} ({p.minUsd})</p>
                  <p className="mt-2 inline-flex rounded-md bg-[#f97316]/10 px-2.5 py-1 font-mono text-[11px] font-medium text-[#f97316]">≈ {p.credits} credits</p>
                </div>
              )}

              <a
                href={p.ctaHref}
                className={cn(
                  "mb-5 inline-flex items-center justify-center gap-2 rounded-lg px-5 py-2.5 text-[13px] font-semibold transition",
                  p.highlight || p.custom
                    ? "bg-[#f97316] text-white hover:bg-[#ea6a0c]"
                    : "border border-black/[0.12] bg-white text-gray-900 hover:bg-[#FAF8F4] dark:border-white/15 dark:bg-[#2f271f] dark:text-neutral-100 dark:hover:bg-[#3a3027]",
                )}
              >
                {p.cta}
              </a>

              <ul className="space-y-2.5">
                {p.perks.map((perk) => (
                  <li key={perk} className="flex items-start gap-2 text-[13px] text-gray-600 dark:text-neutral-300">
                    <Check className="mt-0.5 size-4 shrink-0 text-[#f97316]" />{perk}
                  </li>
                ))}
                {p.note && (
                  <li className="flex items-start gap-2 text-[13px] font-medium text-[#f97316]">
                    <Check className="mt-0.5 size-4 shrink-0" />{p.note}
                  </li>
                )}
              </ul>
            </div>
          ))}
        </div>
        <p className="mt-6 text-center text-[13px] text-gray-500 dark:text-neutral-400">
          All plans include every integration, governance, and bring-your-own-model. Plans only set the per-credit rate.
        </p>
      </Block>

      {/* Wallet explainer */}
      <Block title="How the wallet works">
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
          {[
            { t: "1 · Top up", d: "Fund your wallet once. No subscription, no setup fee." },
            { t: "2 · Agents work", d: "Credits are deducted as agents run — drafting, syncing, ranking, planning." },
            { t: "3 · Stay in control", d: "Per-agent budgets cap spend; agents stop cleanly at 100%. Top up again when you're ready." },
          ].map((s) => (
            <div key={s.t} className={card}>
              <h3 className="mb-2 text-[15.5px] font-semibold text-gray-900 dark:text-neutral-100">{s.t}</h3>
              <p className="text-[13.5px] leading-relaxed text-gray-500 dark:text-neutral-400">{s.d}</p>
            </div>
          ))}
        </div>
      </Block>

      <Faqs items={PRICING_FAQ} />
      <CtaRow />
    </Shell>
  );
}
