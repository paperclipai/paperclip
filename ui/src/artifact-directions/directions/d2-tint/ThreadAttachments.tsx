import { useState } from "react";
import { cn } from "@/lib/utils";
import type { LabArtifact } from "../../kit";
import { FileName } from "./FileName";
import { KindGlyph } from "./KindGlyph";
import { FoldedPreview, KindWell } from "./Lead";
import { MetaLine } from "./MetaLine";
import { FOCUS_RING, MOTION } from "./UnitAction";
import { glyphLabel, metaParts } from "./kinds";

/**
 * THREAD — the attachments block under an agent message.
 *
 * One even grid instead of today's "Images" grid plus a clipped "Files"
 * strip, so nothing runs off the right edge:
 *
 *   picture   a cell two rows tall — a 144×96 folded preview (fold md, tab,
 *             play mark on a video) with the filename and meta line beside it
 *   file      a 50px slab — the xs glyph, mono filename, meta line
 *
 * Pictures lead, as the product's Images block does, and the label keeps its
 * two counts ("1 image · 4 files"). Past twelve attachments the block shows
 * eleven and a "Show all N" slab. The whole cell opens the attachment (one
 * stretched anchor per cell); hover is the kind wash, as on a thread row.
 */

const CELL = `group/unit relative flex min-w-0 items-center rounded-lg bg-(--tint-slab) hover:bg-(--kind-wash) active:bg-(--kind-wash-pressed) ${MOTION}`;
const CAP = 12;
// 144×96: two 50px rows and the gap between them, less the cell's inset.
const PICTURE_BOX = "h-24 w-36 shrink-0";

function Words({ artifact, tall }: { artifact: LabArtifact; tall: boolean }) {
  const name = artifact.filename ?? artifact.title;
  const mono = artifact.filename ? "font-mono tracking-tight" : undefined;
  return (
    <div className="min-w-0 flex-1">
      {/* A filename is a machine value: monospace. On a file slab the stem truncates and the extension never does; beside a picture it has two lines. */}
      <p className="min-w-0 text-xs font-medium leading-4 text-foreground">
        {tall ? <span className={cn("line-clamp-2 wrap-anywhere", mono)}>{name}</span> : <FileName name={name} mono={Boolean(artifact.filename)} className={artifact.filename ? "tracking-tight" : undefined} />}
      </p>
      <MetaLine wrap={tall} parts={metaParts(artifact, { address: false })} className="mt-0.5" />
    </div>
  );
}

function Cell({ artifact }: { artifact: LabArtifact }) {
  const [failed, setFailed] = useState(false);
  const name = artifact.filename ?? artifact.title;
  const picture = Boolean(artifact.thumbnailUrl);
  return (
    <li data-kind={artifact.kind} data-unit="thread-attachment" data-cell={picture ? "picture" : "file"} className={`${CELL} ${picture ? "row-span-2 gap-3 p-1.5 pr-3" : "gap-2.5 p-1.5 pr-3"}`}>
      {!picture ? (
        <KindGlyph kind={artifact.kind} label={glyphLabel(artifact)} size="xs" />
      ) : failed ? (
        <KindWell artifact={artifact} size="md" className={PICTURE_BOX} />
      ) : (
        <FoldedPreview artifact={artifact} fold="md" className={PICTURE_BOX} onError={() => setFailed(true)} />
      )}
      <Words artifact={artifact} tall={picture} />
      <a href={`#attachment-${artifact.id}`} aria-label={`Open ${name}`} title={name} className={`absolute inset-0 rounded-lg ${FOCUS_RING}`} />
    </li>
  );
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

export function ThreadAttachments({ artifacts }: { artifacts: LabArtifact[] }) {
  const [all, setAll] = useState(false);
  if (artifacts.length === 0) return null;
  // Pictures first, as the product's Images block leads its Files block.
  const pictures = artifacts.filter((a) => a.thumbnailUrl);
  const files = artifacts.filter((a) => !a.thumbnailUrl);
  const ordered = [...pictures, ...files];
  const capped = !all && ordered.length > CAP;
  const shown = capped ? ordered.slice(0, CAP - 1) : ordered;
  return (
    <section aria-label={`Attachments, ${artifacts.length}`} className="@container flex w-full flex-col gap-2 pb-1 pt-0.5">
      <p className="text-xs leading-4 text-(--tint-ink-2)">
        Attachments · <span className="font-mono text-(length:--text-micro)">{artifacts.length}</span>
        {pictures.length > 0 && files.length > 0 ? (
          <span className="ml-2 font-mono text-(length:--text-micro)">
            {count(pictures.length, "image")}
            <span className="mx-(--tint-meta-gap)">·</span>
            {count(files.length, "file")}
          </span>
        ) : null}
      </p>
      {/* Even columns: one in a sliver, two beside the open pane, three in the full column. Files fill in around the taller pictures. */}
      <ul className="grid grid-flow-row-dense grid-cols-1 gap-2 @md:grid-cols-2 @3xl:grid-cols-3">
        {shown.map((artifact) => (
          <Cell key={artifact.id} artifact={artifact} />
        ))}
        {capped ? (
          <li className="flex min-h-12.5 min-w-0">
            <button
              type="button"
              data-show-all
              onClick={() => setAll(true)}
              className={`flex min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-(--tint-slab) px-3 text-xs font-medium text-foreground hover:bg-(--tint-slab-raised) active:bg-(--tint-button) ${MOTION} ${FOCUS_RING}`}
            >
              Show all <span className="font-mono text-(length:--text-micro)">{ordered.length}</span>
            </button>
          </li>
        ) : null}
      </ul>
    </section>
  );
}
