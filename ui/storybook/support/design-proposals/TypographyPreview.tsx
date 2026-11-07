import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Bot } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MarkdownBody } from "@/components/MarkdownBody";
import { MetricCard } from "@/components/MetricCard";
import { TaskList } from "@/components/TaskList";
import { readTask, unreadTask } from "./task-list-data";
import { typeRamp, typeRoles } from "./typography-specification";

type Metrics = { size: string; leading: string; weight: string; family: string; tracking: string };
const proseRoles = [
  ["p", "Body paragraph"], ["h1", "Markdown H1"], ["h2", "Markdown H2"], ["h3", "Markdown H3"], ["h4", "Markdown H4"],
  ["strong", "Strong emphasis"], ["em", "Italic emphasis"], ["a", "Text link"], ["li", "List item"], ["blockquote p", "Quoted text"], ["li code", "Inline code"], ["pre code", "Code block"],
] as const;

function useTypeMetrics(root: RefObject<HTMLElement | null>, dependency: string) {
  const [metrics, setMetrics] = useState<Record<string, Metrics>>({});
  useLayoutEffect(() => {
    let disposed = false;
    const measure = () => {
      if (disposed || !root.current) return;
      const measured: Record<string, Metrics> = {};
      const read = (element: Element) => {
        const style = getComputedStyle(element);
        return { size: style.fontSize, leading: style.lineHeight, weight: style.fontWeight, family: style.fontFamily, tracking: style.letterSpacing };
      };
      root.current.querySelectorAll<HTMLElement>("[data-type-sample]").forEach(element => {
        measured[element.dataset.typeSample!] = read(element);
      });
      proseRoles.forEach(([selector, label]) => {
        const element = root.current?.querySelector(`[data-markdown-specimen] .paperclip-markdown ${selector}`);
        if (element) measured[label] = read(element);
      });
      setMetrics(measured);
    };
    measure();
    void document.fonts.ready.then(measure);
    window.addEventListener("resize", measure);
    return () => { disposed = true; window.removeEventListener("resize", measure); };
  }, [root, dependency]);
  return metrics;
}

function Measurement({ value, inherited = false }: { value?: Metrics; inherited?: boolean }) {
  return <span className="block text-xs leading-relaxed text-muted-foreground" data-type-metrics>
    {value ? <><span className="font-mono tabular-nums">{value.size} / {value.leading}</span><br />Weight {value.weight}{inherited ? " · leading inherited in this sample" : ""}{value.tracking !== "normal" && value.tracking !== "0px" ? <><br />Tracking {value.tracking}</> : null}</> : "Measuring…"}
  </span>;
}

const markdown = `# First-level heading
## Second-level heading
### Third-level heading
#### Fourth-level heading
This is rendered agent prose with **strong emphasis**, *italic emphasis*, and a [text link](#usage).

- A list uses the same body rhythm.
- Inline code: \`pnpm typecheck\`.

> A quoted note keeps the prose hierarchy.

\`\`\`ts
const status = "in_progress";
\`\`\``;

/** A guide to current recipes. Integrated examples below mount shared components. */
export function TypographyPreview() {
  const root = useRef<HTMLElement>(null);
  const [query, setQuery] = useState("");
  const [area, setArea] = useState("All areas");
  const [reviewOnly, setReviewOnly] = useState(false);
  const roles = typeRoles.filter(role => (area === "All areas" || area === role.area) && (!reviewOnly || role.review) && `${role.name} ${role.use} ${role.recipe} ${role.source} ${role.review ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  const metrics = useTypeMetrics(root, roles.map(role => role.id).join(","));
  const areas = [...new Set(typeRoles.map(role => role.area))];

  return <main ref={root} className="min-h-screen bg-background px-6 py-10 font-sans text-muted-foreground sm:px-10" data-testid="typography-foundations-preview">
    <div className="mx-auto flex max-w-6xl flex-col gap-12">
      <header className="flex flex-col gap-4">
        <p className="text-xs">Design proposals · Foundations · Typography</p>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">Type specification</h1>
        <p className="max-w-3xl text-sm leading-relaxed">A proposed size ramp, with the text roles used by Design Proposals and the design sandbox. Samples read the active tokens. The usage inventory records current source recipes; differences from the proposed guidance remain visible for review.</p>
        <nav aria-label="Typography sections" className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          {[["ramp", "Size ramp"], ["families", "Families & weights"], ["usage", "Usage inventory"], ["examples", "In context"], ["review", "Review items"]].map(([id, label]) => <a key={id} href={`#${id}`} className="underline underline-offset-4 hover:text-foreground">{label}</a>)}
        </nav>
      </header>

      <section aria-labelledby="ramp" className="flex flex-col gap-5">
        <div><h2 id="ramp" className="text-lg font-semibold text-foreground">Text size ramp</h2><p className="mt-2 text-sm leading-relaxed">Your proposed 10–30px scale. Size and default leading below are measured in this browser; custom compact and nano sizes inherit their surrounding line height. Weights and role-specific leading are specified separately.</p></div>
        <div className="rounded-lg border border-border">
          {typeRamp.map(step => <div key={step.token} data-ramp={step.token} className="grid gap-3 border-b border-border px-5 py-5 last:border-b-0 sm:grid-cols-2 sm:gap-6 lg:grid-cols-3">
            <div className="flex min-w-0 flex-col gap-2"><span data-type-sample={`ramp-${step.token}`} className={`${step.className} font-normal text-foreground`}>{step.token} · {step.size}px</span><code className="text-xs">--text-{step.token}</code></div>
            <div className="text-sm leading-relaxed"><p>{step.use}</p><p className="mt-1 text-xs">{step.source}</p></div>
            <div className="sm:col-span-2 lg:col-span-1"><Measurement value={metrics[`ramp-${step.token}`]} inherited={["compact", "nano"].includes(step.token)} /></div>
          </div>)}
        </div>
        <p className="text-xs leading-relaxed">The number beside each step is the proposed default pixel size at a 16px root. The measured value follows the active token and browser settings. Rendered Markdown currently contains additional sizes; see In context.</p>
      </section>

      <section aria-labelledby="families" className="flex flex-col gap-5">
        <h2 id="families" className="text-lg font-semibold text-foreground">Families & weights</h2>
        <div className="grid gap-4 md:grid-cols-2">
          {[
            { id: "sans", name: "Inter Variable", token: "--font-sans", className: "font-sans", sample: "Good UI starts with clear type.", use: "Interface labels, headings, prose and controls. Regular and italic variable font assets are bundled." },
            { id: "paper", name: "Paper Mono", token: "--font-paper-mono", className: "font-(family-name:--font-paper-mono)", sample: "DES-431 · codex/design-system", use: "The single monospace family for task IDs, worktrees, code, run metrics and diagnostics. The shared --font-mono token resolves to this same bundled font." },
          ].map(family => <article key={family.id} className="flex min-w-0 flex-col gap-4 rounded-lg border border-border p-5">
            <div><h3 className="text-sm font-semibold text-foreground">{family.name}</h3><code className="text-xs">{family.token}</code></div>
            <p data-type-sample={`family-${family.id}`} className={`${family.className} break-words text-sm text-foreground`}>{family.sample}</p>
            <p className="text-xs leading-relaxed">{family.use}</p>
            <details className="text-xs"><summary className="cursor-pointer hover:text-foreground">Active font stack</summary><code className="mt-2 block break-words leading-relaxed">{metrics[`family-${family.id}`]?.family ?? "Measuring…"}</code></details>
          </article>)}
        </div>
        <div className="grid grid-cols-2 gap-4 rounded-lg border border-border p-5">
          {[
            ["normal", "font-normal", "Read content / metadata / controls"], ["semibold", "font-semibold", "Headings / unread titles / organization trigger"],
          ].map(([name, className, use]) => <div key={name}><p className={`${className} text-sm text-foreground`} data-type-sample={`weight-${name}`}>{name} · {metrics[`weight-${name}`]?.weight ?? "…"}</p><p className="mt-1 text-xs leading-relaxed">{use}</p><code className="mt-2 block text-xs">--font-weight-{name}</code></div>)}
        </div>
        <div className="grid gap-6 text-sm leading-relaxed md:grid-cols-2">
          <div><h3 className="font-semibold text-foreground">Color & emphasis</h3><p className="mt-2">Default text uses <code>--muted-foreground</code> (Paper: dark-color-muted-foreground). Headings, emphasis and ON/selected states use <code>--foreground</code>. Hover promotes read titles without changing weight. Unread titles are semibold. Status, validation and text on a filled CTA/message surface use their semantic contrast colors.</p></div>
          <div><h3 className="font-semibold text-foreground">Rhythm & overflow</h3><p className="mt-2">Leading belongs to the role: task rows use 14/16, toolbar controls 14/20, navigation 14/21 and the task title 24/36. Density changes row height, not font size. Narrow lists hide metadata columns; they preserve readable title size, truncation and the shared marquee. Reduced motion keeps text readable without animation.</p></div>
        </div>
      </section>

      <section aria-labelledby="usage" className="flex flex-col gap-5">
        <div><h2 id="usage" className="text-lg font-semibold text-foreground">Usage inventory</h2><p className="mt-2 text-sm leading-relaxed">Source-derived roles across the proposal components and sandbox pages. These isolated recipe samples document typography; they are not replacement components. Expand a source to find the owning implementation. Actual shared components appear below.</p></div>
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex min-w-0 flex-1 flex-col gap-2 text-xs">Find a text role<Input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search roles, tokens or sources…" /></label>
          <label className="flex flex-col gap-2 text-xs">Area<select className="h-10 max-w-full rounded-md border border-border bg-background px-3 text-sm text-muted-foreground" value={area} onChange={event => setArea(event.target.value)}><option>All areas</option>{areas.map(value => <option key={value}>{value}</option>)}</select></label>
          <label className="flex h-10 items-center gap-2 text-sm"><input type="checkbox" checked={reviewOnly} onChange={event => setReviewOnly(event.target.checked)} />Review items only</label>
        </div>
        <p role="status" className="text-xs">{roles.length} of {typeRoles.length} text roles</p>
        <div className="border-t border-border">
          {roles.map(role => <article key={role.id} data-type-role={role.id} className="grid min-w-0 gap-5 border-b border-border py-6 md:grid-cols-3">
            <div className="min-w-0"><p className="text-xs">{role.area}</p><h3 className="mt-1 text-sm font-semibold text-foreground">{role.name}</h3><p className="mt-2 text-xs leading-relaxed">{role.use}</p><details className="mt-3 text-xs"><summary className="cursor-pointer hover:text-foreground">Source & recipe</summary><code className="mt-2 block break-words leading-relaxed">{role.source}</code><code className="mt-2 block break-words leading-relaxed">{role.recipe}</code></details></div>
            <div className="min-w-0 self-center break-words"><span data-type-sample={role.id} className={role.className} style={role.style}>{role.sample}</span></div>
            <div className="self-center"><Measurement value={metrics[role.id]} inherited={role.inheritedLeading} />{role.review ? <div className="mt-3 border-l-2 border-border pl-3 text-xs leading-relaxed"><span className="font-normal text-foreground">Review</span><p className="mt-1">{role.review}</p></div> : null}</div>
          </article>)}
          {roles.length === 0 ? <p className="py-8 text-sm">No text roles match these filters.</p> : null}
        </div>
      </section>

      <section aria-labelledby="examples" className="flex flex-col gap-5">
        <div><h2 id="examples" className="text-lg font-semibold text-foreground">In context · shared components</h2><p className="mt-2 text-sm leading-relaxed">These mount the real components with synthetic content. They stay connected to future component and token edits.</p></div>
        <div className="grid gap-5 md:grid-cols-2"><MetricCard appearance="card" icon={Bot} value={24} label="Agents Enabled" description="0 running, 1 paused, 0 errors" /><div className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-5"><Button variant="cta">Continue</Button><Button variant="outline">Cancel</Button><Button size="xs" variant="ghost">Small action</Button><p className="w-full text-xs">Shared Button labels: 14px normal; extra-small 12px.</p></div></div>
        <div className="overflow-x-auto"><TaskList initialColumns={["task", "taskId", "lastUpdated"]} items={[{ issue: readTask }, { issue: unreadTask, unread: true }]} /></div>
        <div className="grid gap-6 rounded-lg border border-border p-5 lg:grid-cols-2">
          <div data-markdown-specimen><MarkdownBody>{markdown}</MarkdownBody></div>
          <div className="flex flex-col gap-4 text-sm leading-relaxed"><h3 className="font-semibold text-foreground">Standalone Markdown has its own scale</h3><p>Outside conversation regions, the shared renderer uses 15px body text at 1.6 leading. Proposed conversations override this to 14px/20px. Its H1–H4 rules resolve to 24, 20, 16.8 and 15.2px at the default root. Strong text is semibold; code uses Paper Mono. These values are outside a strict application of the proposed ramp.</p><p>In proposed conversations, final agent prose uses foreground; commentary and reasoning use muted foreground at 14px/20px. Human bubbles keep white text. Metadata and diagnostic output use 12px/16px. See Conversation type spec for the shared thread inventory.</p><p className="text-xs">Sources: <code>ui/src/components/MarkdownBody.tsx</code> and <code>ui/src/index.css</code> · <code>.paperclip-markdown</code>, <code>.task-chat-reasoning-markdown</code>.</p><div className="divide-y divide-border">{proseRoles.map(([, label]) => <div key={label} data-prose-role={label} className="flex justify-between gap-3 py-2 text-xs"><span>{label}</span><Measurement value={metrics[label]} /></div>)}</div><p className="text-xs">Measurements above come from the rendered shared MarkdownBody at left. This sample does not simulate a live runner.</p></div>
        </div>
      </section>

      <section aria-labelledby="review" className="flex flex-col gap-4 rounded-lg border border-border p-6">
        <h2 id="review" className="text-lg font-semibold text-foreground">Decisions still to make</h2>
        <ul className="list-disc space-y-3 pl-5 text-sm leading-relaxed">
          <li>Keep 14px task-row metadata as a deliberate exception, or introduce a smaller metadata role?</li>
          <li>Keep 14px right-pane values beside 12px labels, or move more of the pane to xs?</li>
          <li>Conversation Markdown is consolidated to 14px; decide separately whether standalone documents should adopt that scale.</li>
          <li>Promote muted dashboard/chart headings to foreground, or explicitly retain their quieter hierarchy?</li>
        </ul>
        <p className="text-xs leading-relaxed">The remaining differences above are still open for review. The shared proposal typography is applied to Storybook and the sandbox. Scope: Design Proposals and the sandbox’s shell, Tasks, dashboard, agent overview and task conversation/detail surfaces. Unrelated product pages and light mode are outside this reference.</p>
      </section>
    </div>
  </main>;
}
