import type { CSSProperties } from "react";
import type { LabArtifact } from "../../kit";
import { treatmentOf } from "./kinds";
import { fitPrint, MediaPrint, SINGLE_BOX, type PrintSize } from "./MediaPrint";
import { IconSheet, PreviewSheet } from "./Sheet";

/**
 * The artifact's own representation: one of the mock's four treatments. A
 * print is sized by the caller (a stack fits it to its own box); on its own
 * it fits the single-artifact box. The root carries data-front so the lab's
 * animation toggle can lift it on hover (tokens.css).
 */
export function Front({ artifact, print, style }: { artifact: LabArtifact; print?: PrintSize; style?: CSSProperties }) {
  switch (treatmentOf(artifact)) {
    case "preview":
      return (
        <div data-front className="shrink-0" style={style}>
          <PreviewSheet artifact={artifact} />
        </div>
      );
    case "media":
      return <MediaPrint artifact={artifact} size={print ?? fitPrint(artifact, SINGLE_BOX)} style={style} front />;
    case "media-fallback":
      return (
        <div data-front className="shrink-0" style={style}>
          <IconSheet artifact={artifact} play />
        </div>
      );
    default:
      return (
        <div data-front className="shrink-0" style={style}>
          <IconSheet artifact={artifact} />
        </div>
      );
  }
}
