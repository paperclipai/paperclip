import { useMemo, useState } from "react";
import type { LabArtifact } from "../../kit";
import { PanelIndex } from "./PanelIndex";
import { PanelSection } from "./PanelSection";
import { buildSections, type PanelFilter } from "./panel-model";

/**
 * PANEL — the whole scroll body of the task pane's Artifacts tab.
 *
 *   index      one row of filter buttons: All · Review · the kinds with two or
 *              more · "+N" (PanelIndex.tsx)
 *   sections   producing runs and the task's documents, in the product's
 *              order — newest first — each saying how many of its items are
 *              waiting for review (panel-model.ts)
 *   cards      one filled slab per artifact (PanelCard.tsx)
 *
 * A card is as tall as what it has to show: 136–208px for a file (the tall
 * ones carry a three-line MIME type), 226–264 for a document, about 435 for a
 * 4:3 picture — against today's 390–500 for every kind. The 21-artifact task
 * is 5,400px of cards against today's 8,300.
 * The filter is local state; in the product the index would stay pinned while
 * the list scrolls.
 */
export function PanelBody({ artifacts }: { artifacts: LabArtifact[] }) {
  const [filter, setFilter] = useState<PanelFilter>("all");
  const sections = useMemo(() => buildSections(artifacts, filter), [artifacts, filter]);

  if (artifacts.length === 0) {
    // The shipped empty state, word for word.
    return <p className="px-1 py-6 text-sm text-(--tint-ink-2)">No artifacts yet. Work products, documents, and agent-produced files will appear here.</p>;
  }

  return (
    <div data-surface="panel" className="@container/panel flex flex-col gap-5">
      <PanelIndex artifacts={artifacts} filter={filter} onFilter={setFilter} />
      {sections.map((section) => (
        <PanelSection key={section.id} section={section} />
      ))}
    </div>
  );
}
