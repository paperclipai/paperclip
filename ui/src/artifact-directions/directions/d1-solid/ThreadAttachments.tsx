import { cn } from "@/lib/utils";
import type { LabArtifact } from "../../kit";
import { Counts } from "./Counts";
import { fileName, hasThumbnail, plural } from "./kinds";
import { KindBlock } from "./KindBlock";
import { META_TEXT, MetaLine } from "./MetaLine";
import { STATE, StateMarker } from "./StateMarker";
import { FOCUS, SLAB, SLAB_HOVER } from "./slab";

/**
 * THREAD — the attachments block under an agent message.
 *
 * Today this is two unrelated blocks (an "Images · 1" thumbnail grid and a
 * scrolling "Files · 4" strip of square-cornered tiles). Here it is one grid
 * under one mono label that keeps both counts and says what waits:
 *
 *   5 attachments · 1 image · 4 files  ● 5 to review
 *   ┌ picture 128×96 ┐ contact-sheet.png  [PPTX] name.pptx           [PDF] name.pdf
 *   │                │ Image · 422.9 KB          Slides · 90.1 KB ● Review   …
 *   │                │                    [MD]   deck-guide.md       [ZIP] editing-source.zip
 *   └────────────────┘ ● Review                  Markdown · 5.9 KB ● Review  …
 *
 * A file is a 52px slab: kind block, filename, mono meta, state. Anything with
 * a picture takes two rows (112px) so the picture is shown at a size it can be
 * read at, with nothing laid over it. The grid wraps, so no file is ever
 * scrolled out of sight.
 */

function AttachmentSlab({ artifact }: { artifact: LabArtifact }) {
  const name = fileName(artifact);
  const picture = hasThumbnail(artifact);
  const opensGallery = artifact.kind === "image" || artifact.kind === "video";
  const shared = {
    // The name replaces the slab's content for assistive tech, so the state is part of it.
    "aria-label": [`Open ${name}`, artifact.review ? STATE[artifact.review].label : null].filter(Boolean).join(", "),
    title: [name, artifact.title === name ? null : artifact.title].filter(Boolean).join(" — "),
    className: cn(
      "group/slab flex size-full min-w-0 cursor-pointer gap-2.5 p-2 pr-3 text-left focus-visible:bg-(--solid-slab-hover)",
      picture ? "items-stretch" : "items-center",
      SLAB,
      SLAB_HOVER,
      FOCUS,
    ),
  };
  const face = picture ? (
    <>
      <KindBlock artifact={artifact} size="lg" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5">
        <span className="line-clamp-2 shrink-0 text-xs font-medium wrap-anywhere text-foreground">{name}</span>
        <MetaLine artifact={artifact} max={2} wrap className="line-clamp-2 shrink-0" />
        {/* The one place a state label may take two lines: the column beside a picture is narrow. */}
        <StateMarker review={artifact.review} className="mt-auto items-baseline leading-4 whitespace-normal" />
      </span>
    </>
  ) : (
    <>
      <KindBlock artifact={artifact} size="xs" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-foreground">{name}</span>
        <span className="flex min-w-0 items-center gap-2">
          {/* A long state takes the size's place; the kind always stays. */}
          <MetaLine artifact={artifact} max={artifact.review === "changes_requested" ? 1 : 2} className="min-w-0 flex-1 truncate" />
          <StateMarker review={artifact.review} />
        </span>
      </span>
    </>
  );
  return opensGallery ? (
    <button type="button" {...shared}>
      {face}
    </button>
  ) : (
    <a href={artifact.kind === "link" ? (artifact.url ?? "#") : `#attachment-${artifact.id}`} {...(artifact.kind === "link" ? { target: "_blank", rel: "noreferrer" } : null)} {...shared}>
      {face}
    </a>
  );
}

export function ThreadAttachments({ artifacts }: { artifacts: LabArtifact[] }) {
  if (artifacts.length === 0) return null;
  const images = artifacts.filter((a) => a.kind === "image");
  const files = artifacts.filter((a) => a.kind !== "image");
  const counts = [images.length > 0 ? plural(images.length, "image") : null, files.length > 0 ? plural(files.length, "file") : null].filter(
    (count): count is string => Boolean(count),
  );
  // Whatever has a picture goes first, so the two-row slabs start the grid and the files pack beside them.
  const ordered = [...artifacts.filter(hasThumbnail), ...artifacts.filter((a) => !hasThumbnail(a))];
  return (
    <section data-solid="thread-attachments" aria-label="Attachments" className="flex w-full flex-col gap-2 py-1">
      <p className={cn(META_TEXT, "px-1 text-muted-foreground")}>
        <Counts lead={plural(artifacts.length, "attachment")} parts={counts} of={artifacts} />
      </p>
      <ul className="grid grid-flow-row-dense auto-rows-(--solid-attach-row) grid-cols-(--solid-attach-cols) gap-2">
        {ordered.map((artifact) => (
          <li key={artifact.id} className={cn("min-w-0", hasThumbnail(artifact) ? "row-span-2" : null)}>
            <AttachmentSlab artifact={artifact} />
          </li>
        ))}
      </ul>
    </section>
  );
}
