import { useEffect, useMemo, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import catalog from "../../generated/catalog.json";
import featureIndex from "../../generated/feature-index.json";

type Entry = Omit<(typeof catalog.entries)[number], "capabilities" | "home"> & { capabilities: string[]; home?: string };
const entries: Entry[] = catalog.entries;
type IndexEntry = { id: string; type: string; importPath: string };
type Capability = {
  id: string;
  label: string;
  description: string;
  verification?: { scope: string; storybook: string; production: string; sources: string };
};
type Feature = { id: string; title: string; description: string; capabilities: Capability[] };
const recipeRoot = "https://github.com/paperclipai/paperclip/blob/master/maps/feature-map/";
const allFeatures: Feature[] = featureIndex.sections.flatMap(section => section.features);
const examples = entries.filter(entry => entry.implementation !== "guide");
const featureHref = (id: string) => `./?path=/story/feature-map-${id}--overview`;

function useStoryLinks() {
  const [links, setLinks] = useState<Record<string, string>>({});
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(new URL("index.json", window.location.href), { signal: controller.signal })
      .then(response => {
        if (!response.ok) throw new Error("Story index unavailable");
        return response.json() as Promise<{ entries: Record<string, IndexEntry> }>;
      })
      .then(index => {
        const next: Record<string, string> = {};
        for (const entry of Object.values(index.entries)) {
          if (entry.type !== "story") continue;
          const file = `ui/${entry.importPath.replace(/^\.\//, "")}`;
          next[file] ??= `./?path=/story/${entry.id}`;
        }
        setLinks(next);
      })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, []);
  return { links, error };
}

function SuiteLink({ entry, links }: { entry: Entry; links: Record<string, string> }) {
  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-center gap-2">
        {links[entry.file]
          ? <a className="font-medium underline underline-offset-4" href={links[entry.file]} target="_top">{entry.purpose}</a>
          : <span className="font-medium">{entry.purpose}</span>}
        <Badge variant="outline">{entry.status}</Badge>
        <Badge variant="outline">{entry.implementation}</Badge>
        <Badge variant="outline">{entry.boundary}</Badge>
      </div>
      <p className="text-sm text-muted-foreground">{entry.notes}</p>
    </li>
  );
}

export function FeatureMapIndex() {
  const [query, setQuery] = useState("");
  const { links, error } = useStoryLinks();
  const search = query.trim().toLowerCase();
  const sections = useMemo(() => featureIndex.sections.map(section => ({
    ...section,
    features: section.features.filter(feature => {
      const related = entries.filter(entry => entry.capabilities.some(ref => ref.startsWith(`${feature.id}/`)));
      return [section.title, feature.title, feature.id, feature.description,
        ...feature.capabilities.flatMap(capability => [capability.id, capability.label, capability.description]),
        ...related.flatMap(entry => [entry.file, entry.purpose, entry.status, entry.implementation]),
      ].join(" ").toLowerCase().includes(search);
    }),
  })).filter(section => section.features.length), [search]);
  const foundations = examples.filter(entry => (entry.home === "foundations" || !entry.capabilities.length)
    && ["Shared foundations", entry.file, entry.purpose, entry.status, entry.implementation, entry.boundary].join(" ").toLowerCase().includes(search));
  return (
    <main className="paperclip-story__inner space-y-6 p-6">
      <header className="space-y-3">
        <h1 className="text-2xl font-semibold">Paperclip feature map</h1>
        <p className="text-sm text-muted-foreground">The same product index as the feature map, with Storybook examples alongside each capability.</p>
        <p className="text-sm text-muted-foreground">{allFeatures.length} feature families · {allFeatures.reduce((count, feature) => count + feature.capabilities.length, 0)} capabilities. Examples are fixtures and references, not proof of production behavior.</p>
        <a className="text-sm underline underline-offset-4" href={`${recipeRoot}README.md`} target="_blank" rel="noreferrer">Read the feature-map index</a>
        <Input aria-label="Find a feature or capability" placeholder="Find a feature, capability, or example…" value={query} onChange={event => setQuery(event.target.value)} />
      </header>
      {sections.length === 0 && foundations.length === 0 ? <p>No matching features or examples.</p> : null}
      {sections.map(section => (
        <section key={section.title} className="space-y-3">
          <h2 className="text-lg font-semibold">{section.title}</h2>
          <ul className="divide-y divide-border">
            {section.features.map(feature => {
              const suites = examples.filter(entry => entry.capabilities.some(ref => ref.startsWith(`${feature.id}/`)));
              return (
                <li key={feature.id} className="space-y-2 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <a className="font-medium underline underline-offset-4" href={featureHref(feature.id)} target="_top">{feature.title}</a>
                    <span className="text-sm text-muted-foreground">{suites.length ? `${suites.length} related example ${suites.length === 1 ? "suite" : "suites"}` : "No cataloged examples yet"}</span>
                  </div>
                  <p className="text-sm text-muted-foreground">{feature.description}</p>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {foundations.length ? (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Shared foundations</h2>
          <p className="text-sm text-muted-foreground">Shared UI components sit outside the product feature index.</p>
          {error ? <p role="alert">Example links could not load. Reload to try again.</p> : null}
          <ul className="divide-y divide-border">{foundations.map(entry => <SuiteLink key={entry.file} entry={entry} links={links} />)}</ul>
        </section>
      ) : null}
    </main>
  );
}

export function FeatureOverview({ area }: { area: string }) {
  const feature = allFeatures.find(item => item.id === area);
  const { links, error } = useStoryLinks();
  if (!feature) return <p role="alert">This feature is not in the feature-map index.</p>;
  const guides = entries.filter(entry => entry.implementation === "guide" && entry.capabilities.some(ref => ref.startsWith(`${area}/`)));
  return (
    <main className="paperclip-story__inner space-y-6 p-6">
      <header className="space-y-3">
        <a className="text-sm underline underline-offset-4" href="./?path=/story/overview-storybook-guide--coverage-guide" target="_top">All features</a>
        <h1 className="text-2xl font-semibold">{feature.title}</h1>
        <p className="text-muted-foreground">{feature.description}</p>
        <a className="text-sm underline underline-offset-4" href={`${recipeRoot}${area}.md`} target="_blank" rel="noreferrer">Feature recipe and verification steps</a>
        <a className="ml-3 text-sm underline underline-offset-4" href={`${recipeRoot}../agent-access-map/${area}.md`} target="_blank" rel="noreferrer">Agent access contract</a>
        <p className="text-sm text-muted-foreground">Capabilities follow the feature recipe in the same order. Related suites may live under another feature. A suite link does not establish that every behavior has an example or passed a test.</p>
        {error ? <p role="alert">Example links could not load. Reload to try again.</p> : null}
      </header>
      <nav aria-label="Capabilities" className="flex flex-wrap gap-3">
        {feature.capabilities.map(capability => <a key={capability.id} className="text-sm underline underline-offset-4" href={`#${capability.id.split("/")[1]}`}>{capability.label}</a>)}
      </nav>
      {feature.capabilities.map(capability => {
        const suites = examples.filter(entry => entry.capabilities.includes(capability.id));
        return (
          <section key={capability.id} id={capability.id.split("/")[1]} className="space-y-3">
            <h2 className="text-lg font-semibold">{capability.label}</h2>
            <code className="text-xs text-muted-foreground">{capability.id}</code>
            <div className="text-sm text-muted-foreground"><ReactMarkdown>{capability.description}</ReactMarkdown></div>
            {suites.length
              ? <ul className="divide-y divide-border">{suites.map(entry => <SuiteLink key={entry.file} entry={entry} links={links} />)}</ul>
              : <p className="text-sm">No cataloged example yet. Use the feature recipe for entry points, verification steps, and known limits.</p>}
            {capability.verification ? <details className="space-y-3 text-sm">
              <summary className="cursor-pointer">Verification scope</summary>
              <p>{capability.verification.storybook}</p>
              <p><strong>Production verification: </strong>{capability.verification.production}</p>
              <ReactMarkdown urlTransform={url => defaultUrlTransform(new URL(url, `${recipeRoot}${area}.md`).href)}>{capability.verification.sources}</ReactMarkdown>
            </details> : null}
          </section>
        );
      })}
      {guides.length ? <section className="space-y-3"><h2 className="text-lg font-semibold">Related guides</h2><ul className="divide-y divide-border">{guides.map(entry => <SuiteLink key={entry.file} entry={entry} links={links} />)}</ul></section> : null}
    </main>
  );
}
