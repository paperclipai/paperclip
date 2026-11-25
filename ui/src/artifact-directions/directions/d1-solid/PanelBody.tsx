import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { LabArtifact } from "../../kit";
import { Counts } from "./Counts";
import { plural } from "./kinds";
import { META_TEXT } from "./MetaLine";
import { PanelCard } from "./PanelCard";
import { panelSections, shortStamp, type PanelSection } from "./panel-model";

/**
 * PANEL — the scroll body of the task's Artifacts tab (434px pane, 402px of
 * content).
 *
 *   21 artifacts  ● 9 to review                          ← the shelf, counted
 *
 *   Task documents                                       ← a section: who or what
 *   7 documents
 *   [card] [card] …
 *
 *   Brand and Presentation Designer
 *   5 artifacts  ● 5 to review         Sep 28, 10:52 AM  ← counts · run start (mono)
 *   [card] [card] …
 *
 * Sections and their order are the product's — one per producing run, task
 * documents on their own, as listed (panel-model.ts). The mono count label is
 * the thread attachments label again: the count in foreground, the breakdown
 * after it, a state dot where a state is counted.
 *
 * One column in the docked pane. A maximized pane sets the cards in 22rem
 * columns, filled row by row so the listed order still reads across.
 */

function Section({ section, children }: { section: PanelSection; children: ReactNode }) {
  const headingId = `solid-panel-section-${section.id}`;
  return (
    <section data-solid="panel-section" aria-labelledby={headingId} className="flex flex-col gap-2">
      <header className="flex flex-col px-1">
        <h3 id={headingId} className="truncate text-xs font-medium text-foreground">
          {section.title}
        </h3>
        <p className={cn(META_TEXT, "flex flex-wrap items-baseline justify-between gap-x-3 text-muted-foreground")}>
          <Counts lead={plural(section.items.length, section.noun)} of={section.items} />
          {section.startedLabel ? (
            <time dateTime={section.startedAt} title={section.startedLabel} className="shrink-0">
              {shortStamp(section.startedLabel)}
            </time>
          ) : null}
        </p>
      </header>
      {children}
    </section>
  );
}

export function PanelBody({ artifacts }: { artifacts: LabArtifact[] }) {
  if (artifacts.length === 0) {
    return <p className="px-1 py-6 text-sm text-muted-foreground">No artifacts yet. Work products, documents, and agent-produced files will appear here.</p>;
  }
  return (
    <div data-solid="panel-body" className="flex flex-col gap-5">
      <p className={cn(META_TEXT, "px-1 text-muted-foreground")}>
        <Counts lead={plural(artifacts.length, "artifact")} of={artifacts} />
      </p>
      {panelSections(artifacts).map((section) => (
        <Section key={section.id} section={section}>
          <ul className="grid grid-cols-(--solid-panel-cols) items-start gap-2">
            {section.items.map((artifact) => (
              <li key={artifact.id} className="min-w-0">
                <PanelCard artifact={artifact} section={section} />
              </li>
            ))}
          </ul>
        </Section>
      ))}
    </div>
  );
}
