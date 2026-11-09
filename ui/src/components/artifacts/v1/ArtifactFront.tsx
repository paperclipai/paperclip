import type { CSSProperties, SyntheticEvent } from "react";
import { ArtifactPrint, type PrintSize } from "./ArtifactPrint";
import { IconSheet, PreviewSheet } from "./ArtifactSheet";
import { treatmentOf, type ArtifactSubject } from "./kinds";

/**
 * The artifact's own representation: one of the mock's four treatments. A
 * print is sized by the caller (a stack fits it to its own box); on its own
 * it fits the single-artifact box. The root carries data-artifact-front so
 * a hovered tile can lift it (index.css).
 */
export function ArtifactFront({
  subject,
  print,
  onMediaLoad,
  style,
}: {
  subject: ArtifactSubject;
  print?: PrintSize;
  onMediaLoad?: (event: SyntheticEvent<HTMLImageElement | HTMLVideoElement>) => void;
  style?: CSSProperties;
}) {
  switch (treatmentOf(subject)) {
    case "preview":
      return (
        <div data-artifact-front className="shrink-0" style={style}>
          <PreviewSheet subject={subject} />
        </div>
      );
    case "media":
      return <ArtifactPrint subject={subject} size={print} onMediaLoad={onMediaLoad} style={style} />;
    case "media-fallback":
      return (
        <div data-artifact-front className="shrink-0" style={style}>
          <IconSheet subject={subject} play />
        </div>
      );
    default:
      return (
        <div data-artifact-front className="shrink-0" style={style}>
          <IconSheet subject={subject} />
        </div>
      );
  }
}
