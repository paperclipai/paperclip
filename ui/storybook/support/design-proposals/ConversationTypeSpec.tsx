import { useLayoutEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import DesignSandboxTaskThread from "@/components/design-sandbox/DesignSandboxTaskThread";
import { THREAD_PREVIEW_CASES } from "@/components/design-sandbox/task-thread-fixtures";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { storybookAgents } from "../../fixtures/paperclipData";
import { measureConversationType, type ConversationTypeInventory, type ConversationTypeRole } from "./conversation-type-inventory";

const agent = { ...storybookAgents[0]!, name: "Connector engineer" };
const empty: ConversationTypeInventory = { roles: [], states: [], capturedAt: "" };
const familyName = (family: string) => family.includes("Paper Mono") ? "Paper Mono" : family.includes("Inter") ? "Inter Variable" : family;
function Metrics({ role }: { role: ConversationTypeRole }) {
  return <div className="flex flex-col gap-1 text-xs leading-relaxed" data-conversation-type-metrics>
    <p className="font-mono text-foreground">{role.size} / {role.leading}</p>
    <p>{familyName(role.family)} · weight {role.weight}</p><p>Tracking {role.tracking} · {role.emphasis}</p>
    <p className="break-words font-mono">{role.color} · opacity {role.opacity}</p>
  </div>;
}

export function ConversationTypeSpec() {
  const root = useRef<HTMLDivElement>(null);
  const [inventory, setInventory] = useState(empty);
  const [query, setQuery] = useState("");
  const [area, setArea] = useState("All surfaces");
  const [sharedOnly, setSharedOnly] = useState(false);
  const [expanding, setExpanding] = useState(false);
  const [, setParams] = useSearchParams();
  const measure = () => { if (root.current) setInventory(measureConversationType(root.current)); };
  useLayoutEffect(() => {
    let disposed = false;
    let frame = 0;
    void document.fonts.ready.then(() => { if (!disposed) frame = requestAnimationFrame(measure); });
    return () => { disposed = true; cancelAnimationFrame(frame); };
  }, []);
  const groups = new Map<string, ConversationTypeRole[]>();
  inventory.roles.forEach(role => groups.set(role.metricKey, [...(groups.get(role.metricKey) ?? []), role]));
  const candidates = [...groups.values()].filter(roles => new Set(roles.map(role => role.area)).size > 1);
  const candidateKeys = new Set(candidates.flatMap(roles => roles.map(role => role.key)));
  const roles = inventory.roles.filter(role => (area === "All surfaces" || role.area === area) && (!sharedOnly || candidateKeys.has(role.key)) && `${role.name} ${role.text} ${role.sources.join(" ")} ${role.size} ${role.leading}`.toLowerCase().includes(query.toLowerCase()));
  const sizes = [...new Set(inventory.roles.map(role => role.size))].sort((a, b) => parseFloat(b) - parseFloat(a));
  const families = [...new Set(inventory.roles.map(role => role.family))];
  const weights = [...new Set(inventory.roles.map(role => role.weight))].sort();
  const expandDetails = async () => {
    setExpanding(true);
    // Expand only read-only conversation disclosures. Never click decision,
    // send, stop, feedback or other action controls.
    const selectors = [
      'button[data-testid="task-chat-turn-summary"][aria-expanded="false"]',
      'button[data-testid="task-chat-activity-phase-toggle"][aria-expanded="false"]',
      '[data-activity-item-id] > button[aria-expanded="false"]',
      '[data-testid="task-chat-thinking"] > button[aria-expanded="false"]',
      '[data-testid="task-chat-tool-card"] > button[aria-expanded="false"]',
      '[data-testid="task-chat-system-notice"] button[aria-expanded="false"]',
      '[data-testid="task-chat-collapsible-marker"] button[aria-expanded="false"]',
    ].join(",");
    for (let depth = 0; depth < 6 && root.current; depth++) {
      root.current.querySelectorAll<HTMLDetailsElement>("details:not([open])").forEach(detail => { detail.open = true; });
      const toggles = root.current.querySelectorAll<HTMLButtonElement>(selectors);
      if (!toggles.length) break;
      toggles.forEach(button => button.click());
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    }
    measure();
    setExpanding(false);
  };
  const inspect = (state: string) => {
    setParams(params => { const next = new URLSearchParams(params); next.set("threadPreview", state); return next; }, { replace: true });
    root.current?.scrollIntoView({ block: "start" });
  };

  return <main data-testid="conversation-type-spec" className="min-h-screen bg-background px-6 py-10 font-sans text-muted-foreground sm:px-10">
    <div className="mx-auto flex max-w-6xl flex-col gap-12">
      <header className="flex flex-col gap-4">
        <p className="text-xs">Design proposals · Foundations · Typography</p>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">Conversation type spec</h1>
        <p className="max-w-3xl text-sm leading-relaxed">Inspect the consolidated typography in Conversation styles. This inventory measures text inside the sandbox’s actual conversation composition, across its {THREAD_PREVIEW_CASES.length} synthetic states. Specimens below copy those measured type properties; the interactive shared renderer remains available in context.</p>
        <nav aria-label="Conversation type sections" className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          {[["conversation-sizes", "Size inventory"], ["conversation-families", "Families & weights"], ["conversation-usage", "Usage inventory"], ["conversation-candidates", "Consolidation candidates"], ["conversation-context", "In context"]].map(([id, label]) => <a key={id} href={`#${id}`} className="underline underline-offset-4 hover:text-foreground">{label}</a>)}
        </nav>
        <p role="status" data-testid="conversation-type-census" className="text-xs">{inventory.states.length} states measured · {inventory.roles.length} role/style combinations · {groups.size} type recipes before color differences</p>
      </header>

      <section aria-labelledby="conversation-sizes" className="flex flex-col gap-5">
        <div><h2 id="conversation-sizes" className="text-lg font-semibold text-foreground">Observed text sizes</h2><p className="mt-2 text-sm leading-relaxed">Current browser values, not a proposed replacement ramp. One size can still have several line heights, weights or contrast treatments.</p></div>
        <div className="rounded-lg border border-border">{sizes.map(size => {
          const matches = inventory.roles.filter(role => role.size === size);
          return <div key={size} data-conversation-size={size} className="grid gap-4 border-b border-border px-5 py-5 last:border-b-0 md:grid-cols-3">
            <p style={{ fontSize: size }} className="self-center text-foreground">{size} · Aa</p>
            <div className="text-sm leading-relaxed"><p>{[...new Set(matches.map(role => role.area))].join(" · ")}</p><p className="mt-2 text-xs">{[...new Set(matches.map(role => role.leading))].join(" / ")} leading · {matches.length} role/style combinations</p></div>
            <p className="self-center text-xs leading-relaxed">{matches[0]?.text}</p>
          </div>;
        })}</div>
      </section>

      <section aria-labelledby="conversation-families" className="flex flex-col gap-5">
        <h2 id="conversation-families" className="text-lg font-semibold text-foreground">Families & weights</h2>
        <div className="grid gap-4 md:grid-cols-2">{families.map(family => <article key={family} className="flex min-w-0 flex-col gap-3 rounded-lg border border-border p-5">
          <h3 className="text-sm font-semibold text-foreground">{familyName(family)}</h3>
          <p className="break-words text-base text-foreground" style={{ fontFamily: family }}>The agent checked ui/src/components/ and prepared a reply.</p>
          <code className="break-words text-xs">{family}</code>
          <p className="text-xs leading-relaxed">{[...new Set(inventory.roles.filter(role => role.family === family).map(role => role.area))].join(" · ")}</p>
        </article>)}</div>
        <div className="flex flex-wrap gap-8 rounded-lg border border-border p-5">{weights.map(weight => <p key={weight} data-conversation-weight={weight} className="text-sm text-foreground" style={{ fontWeight: weight }}>Weight {weight} · conversation text</p>)}</div>
      </section>

      <section aria-labelledby="conversation-usage" className="flex flex-col gap-5">
        <div><h2 id="conversation-usage" className="text-lg font-semibold text-foreground">Usage inventory</h2><p className="mt-2 text-sm leading-relaxed">Each row is a surface plus a distinct measured type treatment. Compare samples, line height, weight, color and source recipes. Several rows may share metrics while keeping different semantic colors.</p></div>
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex min-w-0 flex-1 flex-col gap-2 text-xs">Find a conversation text role<Input type="search" placeholder="Search roles, text, sizes or sources…" value={query} onChange={event => setQuery(event.target.value)} /></label>
          <label className="flex flex-col gap-2 text-xs">Surface<NativeSelect value={area} onChange={event => setArea(event.target.value)}><option>All surfaces</option>{[...new Set(inventory.roles.map(role => role.area))].map(value => <option key={value}>{value}</option>)}</NativeSelect></label>
          <label className="flex h-10 items-center gap-2 text-sm"><input type="checkbox" checked={sharedOnly} onChange={event => setSharedOnly(event.target.checked)} />Shared metrics only</label>
        </div>
        <p className="text-xs">{roles.length} of {inventory.roles.length} role/style combinations · captured {inventory.capturedAt || "after fonts load"}</p>
        <div className="border-t border-border">{roles.map(role => <article key={role.key} data-conversation-type-role={role.name} className="grid min-w-0 gap-5 border-b border-border py-6 md:grid-cols-3">
          <div className="min-w-0"><p className="text-xs">{role.area}</p><h3 className="mt-1 text-sm font-semibold text-foreground">{role.name}</h3><p className="mt-2 text-xs">Seen in {role.states.length} states</p>
            <details className="mt-3 text-xs"><summary className="cursor-pointer hover:text-foreground">Source & recipe</summary>{role.sources.map(source => <code key={source} className="mt-2 block break-words leading-relaxed">{source}</code>)}<p className="mt-3">Text element and ancestor classes (nearest first):</p>{role.recipes.map((recipe, index) => <code key={index} className="mt-2 block break-words leading-relaxed">{recipe}</code>)}</details>
            <details className="mt-3 text-xs"><summary className="cursor-pointer hover:text-foreground">Example states</summary><div className="mt-2 flex flex-col items-start gap-2">{role.states.map(state => <button key={state} className="text-left underline underline-offset-4 hover:text-foreground" onClick={() => inspect(state)}>{THREAD_PREVIEW_CASES.find(example => example.id === state)?.label ?? state}</button>)}</div></details>
          </div>
          <p className="min-w-0 self-center break-words" style={role.sampleStyle} data-conversation-type-sample>{role.text}</p>
          <div className="self-center"><Metrics role={role} /></div>
        </article>)}{roles.length === 0 ? <p className="py-8 text-sm">{inventory.roles.length ? "No roles match these filters." : "Measuring the shared conversation preview…"}</p> : null}</div>
      </section>

      <section aria-labelledby="conversation-candidates" className="flex flex-col gap-5">
        <div><h2 id="conversation-candidates" className="text-lg font-semibold text-foreground">Consolidation candidates</h2><p className="mt-2 text-sm leading-relaxed">These surfaces share family, size, leading, weight, tracking and italic treatment after consolidation. They may be candidates for a shared type role. Color, decoration and opacity stay separate review decisions; matching metrics alone do not mean two roles should merge.</p></div>
        <div className="grid gap-4 md:grid-cols-2">{candidates.map(matches => <article key={matches[0].metricKey} data-conversation-candidate className="flex min-w-0 flex-col gap-3 rounded-lg border border-border p-5">
          <h3 className="text-sm font-semibold text-foreground">{familyName(matches[0].family)} · {matches[0].size} / {matches[0].leading} · {matches[0].weight}</h3>
          <p className="text-xs leading-relaxed">{[...new Set(matches.map(role => role.area))].join(" · ")}</p>
          <p className="text-xs">{new Set(matches.map(role => `${role.color}:${role.opacity}`)).size} contrast treatments across {matches.length} role/style combinations</p>
        </article>)}</div>
        <div className="rounded-lg border border-border p-5 text-sm leading-relaxed"><h3 className="font-semibold text-foreground">Review the consolidated spec</h3><ul className="mt-3 list-disc space-y-2 pl-5"><li>Body text, authored code, commentary and reasoning now share 14px/20px. Review long replies and narrow layouts for readability.</li><li>Metadata, activity labels, diagnostic output and timestamps use 12px/16px. Review which distinctions still need separate roles.</li><li>Which color and opacity differences communicate useful hierarchy, status or contrast?</li><li>Keep code and paths in Paper Mono while deciding whether their sizes and rhythm can be shared.</li></ul><p className="mt-3 text-xs">The shared proposal conversation recipes are applied in Conversation styles and the opt-in sandbox. Future changes belong in those shared tokens/renderers; this inventory measures their current output.</p></div>
      </section>

      <section aria-labelledby="conversation-context" className="flex flex-col gap-4">
        <h2 id="conversation-context" className="text-lg font-semibold text-foreground">In context · shared conversation</h2>
        <p className="text-sm leading-relaxed">Starts with all {THREAD_PREVIEW_CASES.length} states. Use the real preview controls and expand disclosures to reveal more text, then refresh the inventory. “Expand details & measure” opens read-only activity, reasoning and notice disclosures for the selected states. Only currently rendered text is measured; closed disclosures, empty inputs, placeholders and absent Markdown structures are not counted. This is a fixture inventory, not every possible production style.</p>
        <div className="flex flex-wrap items-center gap-3"><Button variant="outline" size="sm" onClick={measure}>Refresh type inventory</Button><Button variant="outline" size="sm" onClick={() => void expandDetails()} disabled={expanding}>{expanding ? "Expanding details…" : "Expand details & measure"}</Button><Button variant="ghost" size="sm" onClick={() => inspect("all")}>Show all states</Button><p className="text-xs">Refreshing replaces the inventory with the current preview selection.</p></div>
        <div ref={root} id="conversation-renderer" className="flex h-screen min-h-0 scroll-mt-6 flex-col overflow-hidden rounded-lg border border-border p-4" data-testid="conversation-spec-shared-preview">
          <DesignSandboxTaskThread header={null} agentName={agent.name} agent={agent} defaultConversation><p className="py-4 text-sm">Choose a synthetic state to inspect typography. Saved backend conversations are available in the sandbox.</p></DesignSandboxTaskThread>
        </div>
      </section>
    </div>
  </main>;
}
