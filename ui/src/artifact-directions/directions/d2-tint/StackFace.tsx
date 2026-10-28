import { cn } from "@/lib/utils";
import { CodeLines, ProseExcerpt } from "./Content";
import { KindGlyph } from "./KindGlyph";
import { FoldedPreview, FoldedSheet } from "./Lead";
import type { StackFace as Face } from "./gallery-model";
import { glyphLabel } from "./kinds";

/**
 * GALLERY — one thing standing in a folder, by the one rule (Lead.tsx):
 *
 *   picture  the real picture with its kind-hue folded corner (no tab: the
 *            edge it sits on is behind the pocket)
 *   sheet    a neutral sheet with the artifact's first lines — prose for a
 *            document, monospace for a sheet or code — the folded corner, and
 *            the extension tab moved to the TOP edge, where it can be seen
 *   glyph    the tuck glyph, for a kind with nothing to show; it stands a
 *            little lower than content does, so full colour is the smaller
 *            part of what a folder shows
 *
 * Every face is taller than the folder's mouth, so its bottom edge is always
 * behind the pocket: that clip is all "tucked in" needs.
 */

const SPAN: Record<number, string> = { 3: "col-span-3", 4: "col-span-4", 5: "col-span-5", 6: "col-span-6" };
// Each face stands at its own height, like files that were not squared up.
const STAGGER = ["translate-y-0", "translate-y-1.5", "translate-y-0.5", "translate-y-2"];
const TEXT = "text-(length:--text-nano) leading-3.5";

export function StackFace({ face, index, onFail }: { face: Face; index: number; onFail: (id: string) => void }) {
  const { artifact, kind, span } = face;
  return (
    <div data-kind={artifact.kind} data-face={kind} className={cn("min-h-0 min-w-0", SPAN[span], STAGGER[index % STAGGER.length], kind === "glyph" ? "pt-4" : null)}>
      {kind === "picture" ? (
        <FoldedPreview artifact={artifact} fold="md" tab="none" className="size-full rounded-b-none" onError={() => onFail(artifact.id)} />
      ) : kind === "sheet" ? (
        <FoldedSheet artifact={artifact} fold="sm" tab="top" className="h-full rounded-b-none">
          {artifact.kind === "document" ? <ProseExcerpt artifact={artifact} maxChars={260} className={TEXT} /> : <CodeLines artifact={artifact} lines={10} className={TEXT} />}
        </FoldedSheet>
      ) : (
        <KindGlyph kind={artifact.kind} label={glyphLabel(artifact)} size="tuck" className="h-auto w-full" />
      )}
    </div>
  );
}
