import { useState } from "react";
import inventory from "virtual:paperclip-button-usage";
import { Input } from "@/components/ui/input";
import type { ButtonPlaygroundSettings } from "./ButtonSamples";

export function ButtonUsage({ settings }: { settings: ButtonPlaygroundSettings }) {
  const [filter, setFilter] = useState("");
  const [matchSpecimen, setMatchSpecimen] = useState(false);
  const scoped = inventory.entries;
  const matches = scoped.filter(entry => (!matchSpecimen || entry.variant === settings.variant && entry.size === settings.size)
    && `${entry.file} ${entry.variant} ${entry.size}`.toLowerCase().includes(filter.toLowerCase()));
  const files = new Set(scoped.map(entry => entry.file));
  const dynamic = scoped.filter(entry => entry.variant.startsWith("dynamic") || entry.size.startsWith("dynamic"));
  const locations = new Map<string, typeof matches>();
  for (const entry of matches) locations.set(entry.file, [...(locations.get(entry.file) ?? []), entry]);
  return <section className="space-y-4 rounded-lg border border-border p-6" aria-label="Button usage inventory">
    <div className="space-y-2">
      <h2 className="text-xl font-semibold">Where it is used</h2>
      <p className="text-sm text-muted-foreground">Direct references to the shared Button in production-source directory <code>ui/src</code>, scanned from this checkout when Storybook builds. Counts describe source locations; loops, wrappers, feature gates and legacy routes affect rendered totals.</p>
    </div>
    <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4" data-testid="button-usage-stats">
      <div><dt className="text-muted-foreground">Button call sites</dt><dd className="text-2xl font-semibold">{scoped.length}</dd></div>
      <div><dt className="text-muted-foreground">Source files</dt><dd className="text-2xl font-semibold">{files.size}</dd></div>
      <div><dt className="text-muted-foreground">Dynamic props / spreads</dt><dd className="text-2xl font-semibold">{dynamic.length}</dd></div>
      <div><dt className="text-muted-foreground">Selected style + size</dt><dd className="text-2xl font-semibold">{scoped.filter(entry => entry.variant === settings.variant && entry.size === settings.size).length}</dd></div>
    </dl>
    <div className="flex flex-wrap items-center gap-4">
      <Input className="max-w-sm" aria-label="Find button usage" placeholder="Find a page, component, style or size…" value={filter} onChange={event => setFilter(event.target.value)} />
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={matchSpecimen} onChange={event => setMatchSpecimen(event.target.checked)} />Match selected style and size</label>
    </div>
    <p className="text-xs text-muted-foreground" role="status">{matches.length} matching call sites in {locations.size} files. Dynamic values are listed separately and cannot be assigned to a specific style or size.</p>
    <details>
      <summary className="cursor-pointer text-sm font-normal">Browse source locations</summary>
      <div className="mt-4 max-h-96 space-y-4 overflow-auto text-xs">
        {[...locations].map(([file, entries]) => <div key={file} className="space-y-1">
          <code className="break-all text-foreground">{file}</code>
          <p className="break-words text-muted-foreground">{entries.map(entry => `L${entry.line}: ${entry.variant} / ${entry.size}`).join(" · ")}</p>
        </div>)}
        {!matches.length && <p className="text-muted-foreground">No direct references match these filters.</p>}
      </div>
    </details>
    <p className="text-xs text-muted-foreground">App source includes staged components and alternate production implementations. Tests, Storybook files, native HTML buttons and indirect uses through wrapper components are excluded. These counts measure adoption in code, not usage analytics.</p>
  </section>;
}
