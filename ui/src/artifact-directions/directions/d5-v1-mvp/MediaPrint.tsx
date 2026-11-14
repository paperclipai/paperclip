import { Play } from "lucide-react";
import type { CSSProperties } from "react";
import type { LabArtifact } from "../../kit";

/**
 * A photo print: the picture inside a white border with a 6px radius and a
 * soft shadow. A print is sized to fit a box while keeping the picture's
 * aspect ratio, so a leading image never grows past the stack it stands in:
 * the mock's 4:3 landscape fits the stack box at 245×183 and its 3:4 portrait
 * at 165×220, which is where those numbers come from.
 */
export interface PrintSize {
  width: number;
  height: number;
  border: number;
}

export interface FitBox {
  maxWidth: number;
  maxHeight: number;
  border: number;
}

/** On its own in the 254px frame (mock: 240×180 and 180×240). */
export const SINGLE_BOX: FitBox = { maxWidth: 240, maxHeight: 240, border: 4 };
/** As the first page of a stack (mock: 245×183 and 167×220, borders ≈3.3 and 3.0). */
export const STACK_BOX: FitBox = { maxWidth: 245, maxHeight: 220, border: 3.3 };

const DEFAULT_ASPECT = 4 / 3;

/** The largest print with the picture's aspect ratio that fits the box, border included. */
export function fitPrint(artifact: Pick<LabArtifact, "aspect">, box: FitBox): PrintSize {
  const aspect = artifact.aspect && artifact.aspect > 0 ? artifact.aspect : DEFAULT_ASPECT;
  const scale = Math.min(box.maxWidth / aspect, box.maxHeight);
  return { width: Math.round(scale * aspect * 100) / 100, height: Math.round(scale * 100) / 100, border: box.border };
}

export function MediaPrint({ artifact, size, style, front }: { artifact: LabArtifact; size: PrintSize; style?: CSSProperties; front?: boolean }) {
  return (
    <div
      data-front={front ? "" : undefined}
      className="v1-print relative shrink-0 overflow-hidden"
      style={{ width: size.width, height: size.height, borderWidth: size.border, ...style }}
    >
      <img src={artifact.thumbnailUrl} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" />
      {artifact.kind === "video" ? (
        <span
          aria-hidden
          className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full"
          style={{ width: 44, height: 44, background: "rgba(250, 250, 250, 0.9)", color: "var(--v1-ink)" }}
        >
          <Play className="ml-0.5" style={{ width: 20, height: 20 }} fill="currentColor" strokeWidth={0} />
        </span>
      ) : null}
    </div>
  );
}
