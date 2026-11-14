import { cn } from "@/lib/utils";
import type { LabArtifact, LabKind } from "../../../kit";
import { reposeOf } from "../kind";
import { StateFlag, StateNub } from "../StateFlag";
import { LedgerSheet, SlideSheet } from "./Formats";
import type { ObjectSize } from "./Paper";
import { Print } from "./Print";
import { CodeSheet, DocumentSheet } from "./Sheets";
import { ArchiveBox, LinkCard, LinkCardWide } from "./Things";

/**
 * The one entry point: an artifact as the object it is, at a size, lying at a
 * slight angle.
 *
 *   document  typeset sheet, dog-eared         image    photo print
 *   pdf       sheet, red spine + PDF tab       video    print with film strip + play disc
 *   slides    16:9 title slide, orange tab     archive  kraft box, labelled
 *   sheet     punched ledger paper, green      code     blueprint-blue sheet, mono
 *   file      blank dog-eared sheet            link     pale blue address card
 *
 * The object lifts when an ancestor carrying `group/object` is hovered or has
 * focus within, and is pressed back down while that ancestor is active; under
 * reduced motion it stays put and only the shadow changes.
 */

const TILT = ["rotate-(--tac-tilt-a)", "rotate-(--tac-tilt-b)", "rotate-(--tac-tilt-c)", "rotate-(--tac-tilt-d)"] as const;
/** Across a whole pane the same few px of skew is a much smaller angle. */
const TILT_WIDE = ["rotate-(--tac-tilt-wide-a)", "rotate-(--tac-tilt-wide-b)"] as const;

const LIFT =
  "transition-(--tac-tp-lift) duration-(--motion-duration-fast) ease-(--motion-ease-out-expo) motion-safe:group-hover/object:translate-y-(--tac-lift) motion-safe:group-focus-within/object:translate-y-(--tac-lift) motion-safe:group-active/object:translate-y-0";

/**
 * Where a worded flag stands on the top edge, and how much of it is stuck to the face. The usual place is a fifth
 * along; a slide's index tab is already there, and a ledger's column heads sit right at its top edge, so its flag
 * only nips it.
 */
const TOP_FLAG_DEFAULT = "left-1/5 -mb-(--tac-flag-tuck)";
const TOP_FLAG_AT: Partial<Record<LabKind, string>> = {
  slides: "left-2/7 -mb-(--tac-flag-tuck)",
  sheet: "left-1/5 -mb-(--tac-flag-nip)",
};

/** Where the unlabelled flag stands: past a slide's index tab; over a ledger's punched margin, clear of its column heads. */
const NUB_AT: Partial<Record<LabKind, string>> = { slides: "left-3/5", sheet: "left-0" };

/** Objects taller than wide; a surface may let these stand proud of what they rest on. */
export const isPortraitKind = (kind: LabKind) => kind === "document" || kind === "pdf" || kind === "code" || kind === "file";

/** PANEL — what has a picture to show lies across the desk (`pw`) instead of in a slot: images, video, a link with a preview. */
export const liesAcross = (a: LabArtifact) => a.kind === "image" || a.kind === "video" || (a.kind === "link" && Boolean(a.thumbnailUrl));

function objectFor(artifact: LabArtifact, size: ObjectSize, player: boolean) {
  switch (artifact.kind) {
    case "image":
    case "video":
      return <Print artifact={artifact} size={size} player={player} />;
    case "slides":
      return <SlideSheet artifact={artifact} size={size} />;
    case "sheet":
      return <LedgerSheet artifact={artifact} size={size} />;
    case "code":
      return <CodeSheet artifact={artifact} size={size} />;
    case "archive":
      return <ArchiveBox artifact={artifact} size={size} />;
    case "link":
      return size === "pw" ? <LinkCardWide artifact={artifact} /> : <LinkCard artifact={artifact} size={size} />;
    default:
      return <DocumentSheet artifact={artifact} size={size} />;
  }
}

export function ArtifactObject({
  artifact,
  size,
  flag = "nub",
  repose,
  player = false,
  className,
}: {
  artifact: LabArtifact;
  size: ObjectSize;
  /**
   * How the review state is marked on the object: end-on on the top edge (`nub`: thread attachments, folder
   * contents), with its word standing in the same place (`top`: panel, opened stack, a stack of one), or not here
   * (`none`: the thread row, whose tray carries the flag).
   */
  flag?: "nub" | "top" | "none";
  /** 0-3: which of the four resting angles. Defaults to one derived from the id. */
  repose?: 0 | 1 | 2 | 3;
  /** PANEL — a video is the playable thing, with its own controls, and is not hidden from assistive technology. */
  player?: boolean;
  className?: string;
}) {
  const review = artifact.review ?? null;
  const angle = repose ?? reposeOf(artifact.id);
  const wide = size === "pw";
  const live = player && artifact.kind === "video" && Boolean(artifact.videoUrl);
  return (
    <span className={cn("relative shrink-0", wide ? "flex w-full" : "inline-flex", wide ? TILT_WIDE[angle % 2] : TILT[angle], LIFT, className)} data-tac-object={artifact.kind}>
      <span aria-hidden={live ? undefined : true} className={cn("block", wide && "w-full")}>
        {objectFor(artifact, size, player)}
      </span>
      {review && flag === "nub" ? <StateNub review={review} className={NUB_AT[artifact.kind]} /> : null}
      {/* The same place as the nub, with the word: stuck by its lower edge, the rest standing proud of the top. */}
      {review && flag === "top" ? <StateFlag review={review} className={cn("absolute bottom-full", TOP_FLAG_AT[artifact.kind] ?? TOP_FLAG_DEFAULT)} /> : null}
    </span>
  );
}
