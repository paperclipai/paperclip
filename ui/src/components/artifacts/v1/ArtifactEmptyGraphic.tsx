import { IconSheet } from "./ArtifactSheet";
import { ArtifactStack } from "./ArtifactStack";
import type { ArtifactKind, ArtifactSubject } from "./kinds";
import brandPreview from "./assets/empty-brand.svg";

/** Reuses the full-size artifact artwork and its hover fan for empty collections. */
export function ArtifactEmptyGraphic({ kind = "file", stack = false }: { kind?: ArtifactKind; stack?: boolean }) {
  const subject: ArtifactSubject = stack
    ? { kind: "image", title: "", thumbnailUrl: brandPreview, aspect: 1.5 }
    : { kind, title: "", ...(kind === "document" ? { ext: "md" } : {}) };
  return stack ? <ArtifactStack front={subject} /> : <IconSheet subject={subject} showLabel={false} />;
}
