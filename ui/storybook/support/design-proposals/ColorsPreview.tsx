import { useLayoutEffect, useState } from "react";
import { useTheme } from "@/context/ThemeContext";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { TaskList } from "@/components/TaskList";
import { readTask, unreadTask } from "./task-list-data";

export type ColorsPreviewProps = { section: "tokens" | "surfaces" | "interaction" };

const source = "https://app.paper.design/file/01KZ5QQTS4TG2VADP7ZVGJNQY4/p-L-0/3LXU-2";
const colors = [
  { name: "foreground", usage: "Headings, header labels, emphasized text and unread task titles." },
  { name: "background", usage: "Center and right panes; lowest card surface; popovers and menus." },
  { name: "background-alt", usage: "Text inputs and search fields." },
  { name: "muted", usage: "Left sidebar and highest card surface." },
  { name: "muted-highlight", usage: "Hover backgrounds; existing selected and sorted states keep their documented behavior." },
  { name: "muted-alt", usage: "Middle card surface." },
  { name: "muted-foreground", usage: "Default text, secondary labels, metadata and read task titles." },
  { name: "border", usage: "Shared pane dividers, field outlines and card borders. Uses the active production light border or the translucent Paper dark border." },
  { name: "ring", usage: "Production ring in light mode; foreground in dark mode. Pane resize controls retain their own highlight." },
  { name: "focus-ring-halo", usage: "Soft outer focus halo: active ring at 20% opacity, surrounding the focus edge." },
] as const;

function TokenReference() {
  const { theme } = useTheme();
  const [values, setValues] = useState<Record<string, string>>({});
  useLayoutEffect(() => {
    const styles = getComputedStyle(document.documentElement);
    setValues(Object.fromEntries(colors.map(({ name }) => [name, styles.getPropertyValue(`--${name}`).trim()])));
  }, [theme]);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-2xl text-left text-sm">
        <caption className="pb-6 text-left text-muted-foreground">Values come directly from the active CSS token layer. Switch Light / Dark in the Storybook toolbar to compare.</caption>
        <thead className="border-b border-border text-foreground"><tr>
          {["Swatch", "Code token", "CSS value", "Use"].map(label => <th key={label} scope="col" className="px-3 py-3 font-semibold">{label}</th>)}
        </tr></thead>
        <tbody>{colors.map(({ name, usage }) => <tr key={name} data-token={name} className="border-b border-border align-top">
          <td className="px-3 py-4"><div aria-hidden className="h-12 w-16 overflow-hidden rounded-md border border-border bg-background"><div className="h-full w-full" style={{ backgroundColor: `var(--${name})` }} /></div></td>
          <th scope="row" className="px-3 py-4 font-normal"><code className="block whitespace-nowrap text-foreground">--{name}</code><span className="mt-1 block whitespace-nowrap text-xs text-muted-foreground">{theme === "light" ? "Production light palette" : name === "ring" || name === "focus-ring-halo" ? "Derived from dark-color-foreground" : `Paper reference: dark-color-${name}`}</span></th>
          <td className="whitespace-nowrap px-3 py-4"><code data-token-value>{values[name] ?? "…"}</code></td>
          <td className="px-3 py-4 leading-relaxed">{usage}</td>
        </tr>)}</tbody>
      </table>
    </div>
  );
}

function Surfaces() {
  return (
    <div className="flex flex-col gap-10">
      <section className="flex flex-col gap-4" aria-labelledby="pane-surfaces">
        <h2 id="pane-surfaces" className="text-lg font-semibold text-foreground">Pane surfaces</h2>
        <div className="grid gap-4 md:grid-cols-3">
          {[
            { label: "Left sidebar", token: "design-sidebar-surface" },
            { label: "Center pane", token: "background" },
            { label: "Right sidebar", token: "background" },
          ].map(({ label, token }) => <div key={label} className="flex min-h-32 flex-col justify-end gap-2 rounded-lg border border-border p-6" data-pane={label} style={{ backgroundColor: `var(--${token})` }}>
            <h3 className="text-sm font-semibold text-foreground">{label}</h3><code className="text-xs">--{token}</code>
          </div>)}
        </div>
      </section>
      <section className="flex flex-col gap-4" aria-labelledby="card-surfaces">
        <h2 id="card-surfaces" className="text-lg font-semibold text-foreground">Card elevation</h2>
        <p className="text-sm leading-relaxed">These use the existing Card component and one shared border. Dark mode has three distinct fills; light mode maps middle and high to the same production neutral surface.</p>
        <div className="grid gap-4 md:grid-cols-3">
          {[
            { elevation: "low", label: "Lowest", token: "background", example: "Task summary" },
            { elevation: "middle", label: "Middle", token: "muted-alt", example: "Review details" },
            { elevation: "high", label: "Highest", token: "muted", example: "Related work" },
          ].map(({ elevation, label, token, example }) => <Card key={elevation} elevation={elevation as "low" | "middle" | "high"}>
            <CardHeader><CardTitle className="text-sm">{label} · {example}</CardTitle><CardDescription><code>--{token}</code></CardDescription></CardHeader>
            <CardContent className="text-sm leading-relaxed">Content uses the active card foreground. Each card uses <code>--border</code>.</CardContent>
          </Card>)}
        </div>
      </section>
      <section className="flex flex-col gap-4" aria-labelledby="input-surfaces">
        <h2 id="input-surfaces" className="text-lg font-semibold text-foreground">Text inputs & search</h2>
        <p className="text-sm">Both use <code>--background-alt</code> and the shared border.</p>
        <div className="grid max-w-3xl gap-6 md:grid-cols-2">
          <label className="flex flex-col gap-2 text-sm">Task name<Input defaultValue="Improve connector reliability" /></label>
          <label className="flex flex-col gap-2 text-sm">Search tasks<Input type="search" placeholder="Search tasks…" /></label>
        </div>
      </section>
    </div>
  );
}

function TextAndInteraction() {
  return (
    <div className="flex flex-col gap-10">
      <section className="flex flex-col gap-3" aria-labelledby="text-hierarchy">
        <h2 id="text-hierarchy" className="text-lg font-semibold text-foreground">Default and emphasized text</h2>
        <p className="text-sm leading-relaxed">Most text uses muted foreground. <strong className="font-semibold text-foreground">Headings, header labels and emphasized text use foreground.</strong></p>
        <p className="text-sm leading-relaxed">Read task titles are regular and muted; unread titles are semibold and foreground. Hover makes either title foreground while preserving its weight.</p>
      </section>
      <section className="flex flex-col gap-4" aria-labelledby="interaction-example">
        <h2 id="interaction-example" className="text-lg font-semibold text-foreground">Shared task list & Columns menu</h2>
        <p className="text-sm leading-relaxed">Hover a row to see muted-highlight. Open Columns to inspect the same colors in a portaled menu. Keyboard focus keeps its visible indicator.</p>
        <TaskList initialColumns={["task", "taskId"]} items={[{ issue: readTask }, { issue: unreadTask, unread: true }]} />
      </section>
    </div>
  );
}

/** Documentation composes real primitives; all swatches and samples use CSS tokens. */
export function ColorsPreview({ section }: ColorsPreviewProps) {
  return (
    <main className="min-h-screen bg-background px-6 py-10 text-muted-foreground sm:px-10" data-testid="color-foundations-preview">
      <div className="mx-auto flex max-w-6xl flex-col gap-10">
        <header className="flex flex-col gap-3">
          <p className="text-xs">Design proposals · Foundations</p>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Colors</h1>
          <p className="max-w-3xl text-sm leading-relaxed">Light mode uses the production palette. Dark mode uses the Paper proposal palette. Both share semantic tokens, so components, menus and conversation states follow the selected theme.</p>
          <a className="w-fit text-sm underline underline-offset-4 hover:text-foreground" href={source} target="_blank" rel="noreferrer">View the Paper color reference</a>
        </header>
        {section === "tokens" ? <TokenReference /> : section === "surfaces" ? <Surfaces /> : <TextAndInteraction />}
      </div>
    </main>
  );
}
