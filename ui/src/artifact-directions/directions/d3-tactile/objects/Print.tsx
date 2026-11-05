import { useState } from "react";
import { ImageOff } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LabArtifact } from "../../../kit";
import { OBJECT_SHADOW, type ObjectSize } from "./Paper";

/**
 * A photo print: the real thumbnail inside a white border, corners barely
 * rounded. Not scaled like the sheets — it takes its long side from
 * `--tac-print-ws` (landscape) or `--tac-print-hs` (portrait) and its shape
 * from the image. At `pw` (the panel) the long side is the holder's width.
 *
 * A video is the same print with film cues: a sprocket strip down the left
 * edge of the frame, a play disc, and (from `sm` up, except tucked in a
 * folder) a duration tab. `player` swaps the still for the playable video
 * itself, its own controls in place of the play disc — the caller must not
 * hide that print from assistive technology.
 *
 * A missing or failed thumbnail leaves an undeveloped print: grey emulsion
 * with a struck-through picture mark.
 */

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const SPROCKETS = [0, 1, 2, 3, 4];
const SQUARE = 1.15;

function FilmStrip() {
  return (
    <span aria-hidden className="flex w-(--tac-film-w) shrink-0 flex-col items-center justify-evenly bg-(--tac-film)">
      {SPROCKETS.map((hole) => (
        <span key={hole} className="block aspect-4/5 w-1/2 rounded-(--tac-print-r) bg-(--tac-film-ink)" />
      ))}
    </span>
  );
}

export function Print({ artifact, size, player = false }: { artifact: LabArtifact; size: ObjectSize; /** PANEL — a video plays in place. */ player?: boolean }) {
  const [failed, setFailed] = useState(false);
  const aspect = clamp(artifact.aspect ?? 4 / 3, 0.75, 1.9);
  const video = artifact.kind === "video";
  const blank = failed || !artifact.thumbnailUrl;
  const plays = player && video && Boolean(artifact.videoUrl);
  // A square print is sized by its height too: by its width it would stand taller than a sheet.
  const tall = aspect < SQUARE;
  return (
    <span
      data-tac-size={size}
      className={cn(
        "relative block shrink-0 select-none rounded-(--tac-print-r) bg-(--tac-print) bg-(image:--tac-grain) p-(--tac-print-edge)",
        tall ? "h-(--tac-print-hs)" : "w-(--tac-print-ws)",
        OBJECT_SHADOW,
      )}
      style={{ aspectRatio: aspect }}
    >
      <span className="relative flex size-full overflow-hidden bg-(--tac-emulsion)">
        {video ? <FilmStrip /> : null}
        <span className="relative block min-w-0 flex-1">
          {plays ? (
            <video
              src={artifact.videoUrl}
              poster={artifact.thumbnailUrl}
              controls
              playsInline
              preload="metadata"
              aria-label={`Video: ${artifact.title}`}
              className="absolute inset-0 block size-full bg-(--tac-film) object-cover"
            />
          ) : blank ? (
            <span className="flex size-full items-center justify-center text-(--tac-emulsion-ink)" data-tac-blank>
              <ImageOff className="h-2/5 max-h-7 w-auto" strokeWidth={1.5} aria-hidden />
            </span>
          ) : (
            <img src={artifact.thumbnailUrl} alt="" draggable={false} className="absolute inset-0 block size-full object-cover" onError={() => setFailed(true)} />
          )}
          {video && !plays ? (
            <>
              <span className="absolute inset-0 flex items-center justify-center">
                <span className="flex size-(--tac-play) items-center justify-center rounded-full bg-(--tac-film-ink) text-(--tac-film) shadow-(--tac-tab-shadow)">
                  <svg viewBox="0 0 10 10" className="size-2/5 translate-x-px" fill="currentColor">
                    <path d="M2.2 1 8.8 5 2.2 9z" />
                  </svg>
                </span>
              </span>
              {/* Not in a folder: the pocket would cut it in half. */}
              {size !== "xs" && size !== "fd" && artifact.durationLabel ? (
                <span className="absolute bottom-1 right-1 block rounded-(--tac-print-r) bg-(--tac-film) px-1 py-0.5 font-mono text-(length:--text-nano) leading-none text-(--tac-film-ink)">
                  {artifact.durationLabel}
                </span>
              ) : null}
            </>
          ) : null}
        </span>
        <span aria-hidden className="pointer-events-none absolute inset-0 block shadow-(--tac-emulsion-edge)" />
      </span>
    </span>
  );
}
