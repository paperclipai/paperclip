import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { LabArtifact, LabKind } from "../../kit";
import { KindGlyph } from "./KindGlyph";
import { StateDot } from "./StateMark";
import { FOCUS_RING, MOTION } from "./UnitAction";
import { countReview, kindNoun, tallyKinds, type KindTally, type PanelFilter } from "./panel-model";

/**
 * PANEL — the shelf's index: a FILTER, and built to look like one. A row of
 * buttons — All, then what is waiting for review (the ring the cards use),
 * then the kinds that hold two or more artifacts (mini glyph + count), then
 * one "+N" button that opens the rest. Held to one row at the pane's width,
 * pressed or not; in a pane dragged narrow every kind folds into the "+N".
 *
 * One button is pressed at a time, and pressed is unmistakable without hue:
 * the foreground inversion the primary button uses, with the kind's name
 * spelled out ("Images 3"). The only colour in the row is the glyphs.
 *
 * (The same mini glyph and count, without the button, is a CAPTION on the
 * Artifacts page — KindTally.tsx.)
 */

const CHIP = cn("inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs font-medium leading-none", MOTION, FOCUS_RING);
const REST = "bg-(--tint-slab) text-(--tint-ink-2) hover:bg-(--tint-slab-raised) hover:text-foreground active:bg-(--tint-button)";
const PRESSED = "bg-foreground text-background active:bg-foreground/85";

function Chip({ pressed, onPress, name, kind, className, children }: { pressed?: boolean; onPress: () => void; name: string; kind?: LabKind; className?: string; children: ReactNode }) {
  return (
    // The accessible name starts with the words on the button, so speech input can find it.
    <button type="button" aria-pressed={pressed} aria-label={name} data-kind={kind} data-chip onClick={onPress} className={cn(CHIP, pressed ? PRESSED : REST, className)}>
      {children}
    </button>
  );
}

// What one row holds at the pane's 434px: five kind chips at rest, three while one of them is spelled out.
const FRONT = 5;
const FRONT_PRESSED = 3;

/**
 * The kinds that get a chip in the row. Kinds with two or more lead; singles
 * wait behind "+N", and so does the tail of the row while a pressed chip needs
 * the room for its name. The pressed kind is always in the row.
 */
function frontKinds(kinds: KindTally[], filter: PanelFilter, open: boolean): KindTally[] {
  if (open) return kinds;
  const pressed = kinds.find((t) => t.kind === filter);
  const room = pressed ? FRONT_PRESSED : FRONT;
  const lead = kinds.filter((t) => t.count > 1 && t !== pressed).slice(0, pressed ? room - 1 : room);
  return kinds.filter((t) => t === pressed || lead.includes(t));
}

const Count = ({ value }: { value: number }) => <span className="font-mono text-(length:--text-micro) leading-none">{value}</span>;

export function PanelIndex({ artifacts, filter, onFilter }: { artifacts: LabArtifact[]; filter: PanelFilter; onFilter: (filter: PanelFilter) => void }) {
  const [open, setOpen] = useState(false);
  const review = countReview(artifacts);
  const kinds = tallyKinds(artifacts);
  if (kinds.length < 2 && review === 0) return null;
  const toggle = (next: PanelFilter) => onFilter(filter === next ? "all" : next);
  const shown = frontKinds(kinds, filter, open);
  const behind = kinds.length - shown.length;
  return (
    <div role="group" aria-label="Filter artifacts" data-index className="flex flex-wrap items-center gap-1">
      <Chip pressed={filter === "all"} onPress={() => onFilter("all")} name={`All ${artifacts.length} artifacts`}>
        All <Count value={artifacts.length} />
      </Chip>
      {review > 0 ? (
        <Chip pressed={filter === "review"} onPress={() => toggle("review")} name={`Review ${review} waiting`}>
          <StateDot review="needs_review" />
          Review <Count value={review} />
        </Chip>
      ) : null}
      {shown.map(({ kind, count }) => {
        const pressed = filter === kind;
        return (
          // In a narrow pane only the pressed kind and an opened row keep their chips.
          <Chip key={kind} kind={kind} pressed={pressed} onPress={() => toggle(kind)} name={`${kindNoun(kind, count)} ${count}`} className={cn("gap-1 px-1.5", pressed || open ? null : "@max-xs/panel:hidden")}>
            <KindGlyph kind={kind} size="mini" />
            {pressed ? kindNoun(kind, count) : null} <Count value={count} />
          </Chip>
        );
      })}
      {open ? null : (
        <>
          {behind > 0 ? (
            <Chip onPress={() => setOpen(true)} name={`+${behind} more kinds`} className="@max-xs/panel:hidden">
              +{behind}
            </Chip>
          ) : null}
          <Chip onPress={() => setOpen(true)} name={`+${kinds.length} kinds`} className="hidden @max-xs/panel:inline-flex">
            +{kinds.length} kinds
          </Chip>
        </>
      )}
    </div>
  );
}
