import { cn } from "@/lib/utils";
import type { LabArtifact } from "../../kit";
import { KindGlyph } from "./KindGlyph";
import { kindNoun, kindNounInline, tallyKinds } from "./panel-model";

/**
 * What is in a pile, as a CAPTION: one entry per kind present, in the
 * vocabulary's order — the mini glyph and a mono count. Never a control: it
 * has no fill and no button shape (the panel's index, which filters, is built
 * from buttons — PanelIndex.tsx).
 *
 * `named` spells each kind out ("10 documents"), where there is a line to
 * itself — the caption of an opened stack.
 */
export function KindTally({ artifacts, named = false, className }: { artifacts: LabArtifact[]; named?: boolean; className?: string }) {
  const kinds = tallyKinds(artifacts);
  if (kinds.length === 0) return null;
  return (
    <ul data-tally-kinds aria-label="Contents by kind" className={cn("flex min-w-0 flex-wrap items-center gap-y-1", named ? "gap-x-3.5" : "gap-x-2.5", className)}>
      {kinds.map(({ kind, count }) => (
        <li key={kind} data-kind={kind} className="flex shrink-0 items-center gap-1">
          <KindGlyph kind={kind} size="mini" />
          <span className="font-mono text-(length:--text-micro) leading-none text-(--tint-ink-2)">
            {count}
            {named ? <span className="font-sans text-xs leading-none"> {kindNounInline(kind, count)}</span> : <span className="sr-only"> {kindNoun(kind, count)}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}
