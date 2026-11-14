import { cn } from "@/lib/utils";
import { KindGlyph } from "./KindGlyph";
import { Picture } from "./Lead";
import { PaperSheet } from "./PaperSheet";
import type { StackFace as Face } from "./gallery-model";
import { glyphLabel } from "./kinds";

/**
 * GALLERY — one thing standing in a folder, by the lead rule (Lead.tsx):
 *
 *   picture  the real picture with its corner label top-left (no fold)
 *   sheet    the paper sheet — the artifact's own first lines typeset on
 *            white paper, corner label top-left, dog-ear top-right — standing
 *            straight, its foot behind the pocket
 *   glyph    the tuck glyph (the one object that keeps its curl), for a kind
 *            with nothing to show; it stands a little lower than content does,
 *            so full colour is the smaller part of what a folder shows
 *
 * Every face fills its column to the pocket, so its bottom edge is always
 * behind it: that clip is all "tucked in" needs. On hover the faces rise out
 * of the folder one after another — each starts `--hy-stagger` after the one
 * before — and settle back the same way; under reduced motion they stay put.
 */

const SPAN: Record<number, string> = { 3: "col-span-3", 4: "col-span-4", 5: "col-span-5", 6: "col-span-6" };
// Each face stands at its own height, like files that were not squared up.
const STAGGER = ["translate-y-0", "translate-y-1.5", "translate-y-0.5", "translate-y-2"];
const RISE =
  "size-full translate-y-3 transition-transform duration-(--motion-duration-fast) ease-(--motion-ease-standard) motion-safe:group-hover/unit:translate-y-0 motion-safe:group-focus-within/unit:translate-y-0 motion-reduce:transition-none";

export function StackFace({ face, index, onFail }: { face: Face; index: number; onFail: (id: string) => void }) {
  const { artifact, kind, span } = face;
  return (
    <div data-kind={artifact.kind} data-face={kind} className={cn("min-h-0 min-w-0", SPAN[span], STAGGER[index % STAGGER.length], kind === "glyph" ? "pt-4" : null)}>
      <div className={RISE} style={{ transitionDelay: `calc(${index} * var(--hy-stagger))` }}>
        {kind === "picture" ? (
          <Picture artifact={artifact} label="md" className="size-full rounded-b-none" onError={() => onFail(artifact.id)} />
        ) : kind === "sheet" ? (
          <PaperSheet artifact={artifact} size="tuck" className="h-full aspect-auto" />
        ) : (
          <KindGlyph kind={artifact.kind} label={glyphLabel(artifact)} size="tuck" className="h-auto w-full" />
        )}
      </div>
    </div>
  );
}
