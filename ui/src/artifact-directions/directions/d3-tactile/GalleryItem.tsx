import type { CSSProperties } from "react";
import { Download, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LabArtifact } from "../../kit";
import { timeOf } from "./gallery-model";
import { REVIEW_LABEL, RING, RING_AFTER, RING_ON, galleryActions, taskHref } from "./kind";
import { LEDGE, STAND, STAND_CLIP } from "./ledge";
import { ArtifactObject } from "./objects/ArtifactObject";

/**
 * GALLERY — one artifact in an opened stack: the object, large, standing on
 * the row's ledge with its foot behind the lip, and its caption under the
 * ledge — the title (two lines reserved, so the lines under it align along a
 * row) with Open and Download at the end of its first line, then when and
 * who, the author whole. The kind is the object's own shape and marking, so
 * the caption does not repeat it.
 *
 * The title is the link to the artifact in its task. Its hit area and its
 * focus ring cover the object and the caption — not the empty space above a
 * short object: the item tells CSS how tall its own object is (`--tac-obj-h`).
 * Open and Download are separate targets, always visible, never inside the
 * link.
 *
 * Two grid rows per item, shared with the row through subgrid: objects stand
 * on one ledge however tall they are, and captions start on one line.
 */

const ICON_ACTION = cn(
  "relative z-10 inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-(--tac-meta) transition-colors hover:bg-(--tac-tray-press) hover:text-foreground",
  RING,
  RING_ON.ground,
);

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** The shape an object is cut from, and so which of the size's footprints is its height. */
function footprint(a: LabArtifact): { box?: string; height: string } {
  switch (a.kind) {
    case "image":
    case "video": {
      const aspect = clamp(a.aspect ?? 4 / 3, 0.75, 1.9);
      return { height: aspect < 1.15 ? "var(--tac-print-hs)" : `calc(var(--tac-print-ws) / ${aspect})` };
    }
    case "slides":
      return { box: "slide", height: "var(--tac-slide-h)" };
    case "sheet":
      return { box: "ledger", height: "var(--tac-ledger-h)" };
    case "archive":
      return { box: "box", height: "var(--tac-box-h)" };
    case "link":
      return { box: "card", height: "var(--tac-card-h)" };
    default:
      return { box: "page", height: "var(--tac-page-h)" };
  }
}

export function GalleryItem({ artifact }: { artifact: LabArtifact }) {
  const actions = galleryActions(artifact);
  const edited = `Last edited ${artifact.updatedLabel}`;
  const { box, height } = footprint(artifact);
  return (
    // The size attributes are the object's own, so the item resolves the same footprint the object does.
    <li
      data-tac-item={artifact.kind}
      data-tac-size="gl"
      data-tac-box={box}
      style={{ "--tac-obj-h": height } as CSSProperties}
      className="group/object row-span-2 grid min-w-0 grid-rows-subgrid gap-y-0"
    >
      <span className={cn("flex min-w-0 items-end", LEDGE)}>
        <span className="flex" style={STAND_CLIP}>
          <span className={cn("flex", STAND)}>
            <ArtifactObject artifact={artifact} size="gl" flag="top" />
          </span>
        </span>
      </span>
      <div className="relative flex min-w-0 max-w-(--tac-gl-cap) flex-col gap-0.5 pt-(--tac-gl-gap)">
        <div className="flex items-start gap-1">
          <h4 className="min-h-10 min-w-0 flex-1 text-sm font-medium leading-5 text-foreground">
            <a
              href={taskHref(artifact)}
              title={`${artifact.title}\n${edited} · ${artifact.author}`}
              className={cn(
                "line-clamp-2 wrap-anywhere decoration-(--tac-meta) underline-offset-4 after:absolute after:-inset-x-(--tac-gl-ring) after:-bottom-(--tac-gl-ring) after:top-(--tac-gl-reach) after:rounded-lg hover:underline focus-visible:after:ring-offset-(--tac-ground)",
                RING_AFTER,
              )}
            >
              {artifact.title}
              {artifact.review ? <span className="sr-only"> — {REVIEW_LABEL[artifact.review]}</span> : null}
            </a>
          </h4>
          {actions.length > 0 ? (
            <span className="-mr-1 -mt-0.5 flex shrink-0 items-center">
              {actions.map((action) => (
                <a key={action.label} href={action.href} aria-label={`${action.label}: ${artifact.title}`} title={action.label} className={ICON_ACTION}>
                  {action.icon === "download" ? <Download className="size-3.5" aria-hidden /> : <ExternalLink className="size-3.5" aria-hidden />}
                </a>
              ))}
            </span>
          ) : null}
        </div>
        {/* When and who, across the whole caption; a long name wraps rather than hides. */}
        <p className="wrap-anywhere text-(length:--text-micro) leading-4 text-(--tac-meta)">
          <time dateTime={artifact.updatedAt} className="whitespace-nowrap font-mono">
            <span className="sr-only">Last edited {artifact.dayLabel}, </span>
            {timeOf(artifact)}
          </time>
          <span aria-hidden className="px-1 opacity-70">
            ·
          </span>
          {artifact.author}
        </p>
      </div>
    </li>
  );
}
