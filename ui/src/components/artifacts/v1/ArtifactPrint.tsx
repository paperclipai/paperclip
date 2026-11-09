import { Play } from "lucide-react";
import { useCallback, useState, type CSSProperties, type SyntheticEvent } from "react";
import { DEFAULT_ASPECT, PRINT_PLAY, SINGLE_BOX, type FitBox } from "./geometry";
import type { ArtifactSubject } from "./kinds";

/**
 * A photo print: the picture inside a white border with a 6px radius and a
 * soft shadow (`.artifact-print`, index.css). A print is sized to fit a box
 * while keeping the picture's ratio, so a leading picture never grows past
 * the stack it stands in. The ratio comes with the subject when known and
 * from the loaded picture otherwise; until then the print is 4:3.
 */
export interface PrintSize {
  width: number;
  height: number;
  border: number;
}

/** The largest print with the picture's ratio that fits the box, border included. */
export function fitPrint(aspect: number | null | undefined, box: FitBox): PrintSize {
  const ratio = aspect && aspect > 0 ? aspect : DEFAULT_ASPECT;
  const scale = Math.min(box.maxWidth / ratio, box.maxHeight);
  return { width: Math.round(scale * ratio * 100) / 100, height: Math.round(scale * 100) / 100, border: box.border };
}

/** The picture's ratio: the known one, else the loaded picture's. */
export function useImageAspect(known: number | null | undefined): [number | null, (event: SyntheticEvent<HTMLImageElement | HTMLVideoElement>) => void] {
  const [loaded, setLoaded] = useState<number | null>(null);
  const onLoad = useCallback((event: SyntheticEvent<HTMLImageElement | HTMLVideoElement>) => {
    const el = event.currentTarget;
    const width = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth;
    const height = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight;
    if (width > 0 && height > 0) setLoaded(width / height);
  }, []);
  return [known && known > 0 ? known : loaded, onLoad];
}

export function ArtifactPrint({
  subject,
  size,
  onMediaLoad,
  style,
}: {
  subject: ArtifactSubject;
  /** Sized by the caller (a stack fits it to its own box); on its own it fits the single box. */
  size?: PrintSize;
  onMediaLoad?: (event: SyntheticEvent<HTMLImageElement | HTMLVideoElement>) => void;
  style?: CSSProperties;
}) {
  const [ownAspect, onOwnLoad] = useImageAspect(subject.aspect);
  const print = size ?? fitPrint(ownAspect, SINGLE_BOX);
  return (
    <div
      data-artifact-print
      className="artifact-print relative shrink-0 overflow-hidden"
      style={{ width: print.width, height: print.height, borderWidth: print.border, ...style }}
    >
      {subject.kind === "video" && !subject.thumbnailUrl ? (
        // No poster: the print shows the video's own first frame, as the shipped video card does.
        <video
          src={subject.videoUrl ?? undefined}
          className="absolute inset-0 h-full w-full object-cover"
          muted
          playsInline
          preload="metadata"
          onLoadedMetadata={(event) => {
            onOwnLoad(event);
            onMediaLoad?.(event);
          }}
        />
      ) : (
        <img
          src={subject.thumbnailUrl ?? undefined}
          alt=""
          draggable={false}
          className="absolute inset-0 h-full w-full object-cover"
          onLoad={(event) => {
            onOwnLoad(event);
            onMediaLoad?.(event);
          }}
        />
      )}
      {subject.kind === "video" ? (
        <span
          aria-hidden
          className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full"
          style={{ width: PRINT_PLAY.size, height: PRINT_PLAY.size, background: "var(--artifact-paper)", color: "var(--artifact-ink)", opacity: 0.9 }}
        >
          <Play className="ml-0.5" style={{ width: PRINT_PLAY.icon, height: PRINT_PLAY.icon }} fill="currentColor" strokeWidth={0} />
        </span>
      ) : null}
    </div>
  );
}
