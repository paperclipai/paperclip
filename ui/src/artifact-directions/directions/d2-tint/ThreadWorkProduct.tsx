import type { LabArtifact } from "../../kit";
import { Lead } from "./Lead";
import { MetaLine } from "./MetaLine";
import { StateMark } from "./StateMark";
import { MOTION, PrimaryAction, SecondaryAction } from "./UnitAction";
import { downloadAction, threadAction } from "./actions";
import { linkLabel, metaParts } from "./kinds";

/**
 * THREAD — one work product between turns.
 *
 * A single-row slab, 62px, the same for every kind:
 *
 *   [ lead 72×46 ]  Title                                  ○ Review   Action ↗
 *                   kind · size · rev │ summary
 *
 * The lead is one box for every row (Lead.tsx), so titles share one edge down
 * the conversation; the action sits in a fixed slot, so state marks share one
 * edge too. A link's address and the summary each truncate on their own, so
 * nothing can run under the action.
 *
 * Below a 32rem row the slab becomes three lines instead of losing its words:
 * the state mark drops to the right end of the meta line and the summary takes
 * up to two lines of its own, as the shipped row does.
 *
 * Hover is the row's one extra use of its hue: the slab takes the kind wash
 * (and one step more while pressed).
 */
export function ThreadWorkProduct({ artifact }: { artifact: LabArtifact }) {
  const action = threadAction(artifact);
  // A text-like file opens in the side panel; Download stays a separate target, as it does today.
  const secondary = action.intent === "tab" ? downloadAction(artifact) : null;
  const address = artifact.kind === "link" ? linkLabel(artifact.url) : undefined;
  const { summary } = artifact;
  return (
    <article
      data-kind={artifact.kind}
      data-unit="thread-row"
      className={`group/unit @container relative flex min-w-0 items-center gap-3 rounded-lg bg-(--tint-slab) p-2 pr-3.5 hover:bg-(--kind-wash) active:bg-(--kind-wash-pressed) ${MOTION}`}
    >
      <Lead artifact={artifact} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium leading-5 text-foreground">{artifact.title}</p>
        <div className="mt-0.5 flex min-w-0 items-center gap-2">
          {/* The kind word never gives way to an address; in a narrow row the rest of the line may. */}
          <MetaLine parts={metaParts(artifact, { address: false })} className={address ? "shrink-0" : "max-w-full @lg:shrink-0"} />
          {address ? (
            // The address truncates on its own, and sits above the stretched link so it can be selected and copied.
            <span data-address className="relative z-10 -ml-2 min-w-0 cursor-text select-text truncate font-mono text-(length:--text-micro) leading-4 text-(--tint-ink-2) @lg:max-w-1/2">
              <span className="mx-(--tint-meta-gap)">·</span>
              {address}
            </span>
          ) : null}
          {summary ? (
            <>
              <span aria-hidden className="hidden h-2.5 w-px shrink-0 bg-(--tint-ink-2)/35 @lg:block" />
              <span data-summary className="hidden min-w-8 flex-1 truncate text-xs leading-4 text-(--tint-ink-2) @lg:block">
                {summary}
              </span>
            </>
          ) : null}
          <StateMark review={artifact.review} className="ml-auto @lg:hidden" />
        </div>
        {summary ? (
          <p data-summary className="mt-1 line-clamp-2 wrap-anywhere text-xs leading-4 text-(--tint-ink-2) @lg:hidden">
            {summary}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <StateMark review={artifact.review} className="hidden @lg:inline-flex" />
        {/* One slot for every action, so the state marks beside it line up down the thread. */}
        <div className="flex items-center justify-end gap-3 @lg:w-30">
          <PrimaryAction action={action} stretch="after:rounded-lg" title={summary ? `${artifact.title} — ${summary}` : artifact.title} />
          {secondary ? <SecondaryAction action={secondary} className="-mx-1.5" /> : null}
        </div>
      </div>
    </article>
  );
}
