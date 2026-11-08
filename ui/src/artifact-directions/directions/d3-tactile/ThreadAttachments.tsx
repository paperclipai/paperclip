import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { LabArtifact } from "../../kit";
import { REVIEW_LABEL, RING, RING_ON, kindLabel, metaParts, splitName } from "./kind";
import { LEDGE, STAND, STAND_CLIP } from "./ledge";
import { MetaLine } from "./MetaLine";
import { ArtifactObject } from "./objects/ArtifactObject";
import { StateFlag } from "./StateFlag";

/**
 * THREAD — what an agent attached to a message, stood on one tray: small
 * objects on a ledge, feet behind its lip, each with a caption under the
 * ledge (the filename in mono, whole, then kind and size).
 * Images come first, as little prints; past four, the fourth place is a pile
 * marked "+N".
 *
 * Up to four items the tray hugs them; from five it takes the same measure
 * as a work-product row and lays them on an even grid, wrapping rather than
 * scrolling, so every attachment stays reachable — each row of the grid
 * stands on its own run of the ledge. Each item is one target: images and
 * video open the gallery (button), everything else opens the file (link).
 *
 * Review state: a nub on each object that carries it, and — as on anything
 * that groups — one worded flag with the count on the tray's top edge.
 */

const MAX_PRINTS = 4;
/** From this many places the tray stops hugging its contents and becomes a full-measure grid. */
const FULL_TRAY = 5;
/**
 * A filename is shown whole, on up to three lines, breaking at its hyphens where it has them. About three lines of
 * the caption's mono fit one place on the tray; a longer name loses its middle, never its extension.
 */
const NAME_FITS = 44;

const ITEM = cn("group/object relative flex w-full cursor-pointer flex-col items-center gap-3.5 rounded-md px-0.5 pb-1", RING, RING_ON.ground);

const fitName = (base: string, ext: string) => (base.length + ext.length > NAME_FITS ? `${base.slice(0, NAME_FITS - ext.length - 1)}…${ext}` : `${base}${ext}`);

/** One place on the ledge: the object stands in it, foot behind the lip. */
function Place({ children }: { children: ReactNode }) {
  return (
    <span className={cn("block h-22 w-full", LEDGE)}>
      <span className="flex size-full items-end justify-center" style={STAND_CLIP}>
        <span className={cn("flex", STAND)}>{children}</span>
      </span>
    </span>
  );
}

function DeskItem({ artifact }: { artifact: LabArtifact }) {
  const [base, ext] = splitName(artifact);
  const media = artifact.kind === "image" || artifact.kind === "video";
  const name = `${base}${ext}`;
  // The flag on the object is decorative, so the state is said in the item's name.
  const label = `Open ${name}${artifact.review ? ` — ${REVIEW_LABEL[artifact.review]}` : ""}`;
  const content = (
    <>
      <Place>
        <ArtifactObject artifact={artifact} size="sm" />
      </Place>
      <span className="flex w-full min-w-0 flex-col items-center gap-0.5 text-center">
        <span className="line-clamp-3 max-w-full wrap-anywhere font-mono text-(length:--text-micro) leading-4 tracking-tight text-foreground" title={name}>
          {fitName(base, ext)}
        </span>
        {/* Kind and size only: page counts and durations stay with the row and the panel. */}
        <MetaLine parts={artifact.kind === "link" ? [{ text: kindLabel(artifact) }] : metaParts(artifact).slice(0, 2)} className="max-w-full text-(length:--text-micro) leading-4 text-(--tac-meta)" />
      </span>
    </>
  );
  return media ? (
    <button type="button" aria-label={label} className={ITEM}>
      {content}
    </button>
  ) : (
    <a href={`#attachment-${artifact.id}`} aria-label={label} className={ITEM}>
      {content}
    </a>
  );
}

/** The pile that stands for the prints that did not fit. */
function MorePrints({ count }: { count: number }) {
  return (
    <button type="button" aria-label={`Open ${count} more images`} className={ITEM}>
      <Place>
        <span data-tac-size="sm" className="relative block aspect-4/3 w-(--tac-print-ws) filter-(--tac-filter-rest)">
          <span className="absolute inset-0 block rotate-(--tac-tilt-d) rounded-(--tac-print-r) bg-(--tac-paper-back)" />
          <span className="absolute inset-0 block rotate-(--tac-tilt-a) rounded-(--tac-print-r) bg-(--tac-paper-back)" />
          <span className="absolute inset-0 flex items-center justify-center rounded-(--tac-print-r) bg-(--tac-print) bg-(image:--tac-grain) font-mono text-sm font-semibold text-(--tac-ink)">
            +{count}
          </span>
        </span>
      </Place>
      <span className="text-(length:--text-micro) leading-4 text-(--tac-meta)">more images</span>
    </button>
  );
}

function Count({ label, count }: { label: string; count: number }) {
  return (
    <span>
      {label} · <span className="font-mono">{count}</span>
    </span>
  );
}

export function ThreadAttachments({ artifacts }: { artifacts: LabArtifact[] }) {
  const images = artifacts.filter((a) => a.kind === "image");
  const files = artifacts.filter((a) => a.kind !== "image");
  const prints = images.length > MAX_PRINTS ? images.slice(0, MAX_PRINTS - 1) : images;
  const hidden = images.length - prints.length;
  const toReview = artifacts.filter((a) => a.review === "needs_review").length;
  if (artifacts.length === 0) return null;
  const full = prints.length + (hidden > 0 ? 1 : 0) + files.length >= FULL_TRAY;
  const place = full ? "min-w-0" : "w-(--tac-desk-cell)";
  return (
    // The column, measured: like a row's tray, the full tray keeps 40rem in a wide column and fills a narrow one.
    <div className="@container/col w-full">
      <section aria-label="Attachments" className={cn("relative flex flex-col gap-2 pt-1", full ? "w-full max-w-(--tac-tray-max) @max-3xl/col:max-w-none" : "w-fit max-w-full")}>
        <p className="flex gap-3 px-1 text-xs text-muted-foreground">
          {images.length > 0 ? <Count label="Images" count={images.length} /> : null}
          {files.length > 0 ? <Count label="Files" count={files.length} /> : null}
        </p>
        <div className="relative">
          {/* Clips on the x axis: each place's ledge runs out to the tray's edges. */}
          <ul
            className={cn(
              "items-start gap-x-3 gap-y-5 overflow-x-clip rounded-xl bg-(--tac-tray) bg-(image:--tac-ground-grain) px-3 pb-2.5 pt-5 shadow-(--tac-tray-rim)",
              full ? "grid grid-cols-(--tac-desk-cols)" : "flex flex-wrap",
            )}
          >
            {prints.map((artifact) => (
              <li key={artifact.id} className={place}>
                <DeskItem artifact={artifact} />
              </li>
            ))}
            {hidden > 0 ? (
              <li className={place}>
                <MorePrints count={hidden} />
              </li>
            ) : null}
            {files.map((artifact) => (
              <li key={artifact.id} className={place}>
                <DeskItem artifact={artifact} />
              </li>
            ))}
          </ul>
          {toReview > 0 ? <StateFlag review="needs_review" count={toReview} className="pointer-events-none absolute -top-2 right-4 z-10" /> : null}
        </div>
      </section>
    </div>
  );
}
