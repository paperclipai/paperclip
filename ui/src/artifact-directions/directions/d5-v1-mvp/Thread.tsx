import type { LabArtifact } from "../../kit";
import { ArtifactRow } from "./PanelRow";

/**
 * The thread's artifacts (node 2096:86523) are the side panel's rows. A
 * work product between turns is one full-width row, 12px under its "Worked"
 * row. The artifacts a message produced sit inline under its footer, 8px
 * apart at equal widths: the mock shows two (473px each) and three (313px
 * each) across its 955px column.
 *
 * Past three the mock stops, so this is my call: a row needs at least 280px
 * and the group wraps, which gives three per line in the 960px column and
 * two beside an open pane (≈600px); a last line with fewer rows shares its
 * width the same way.
 */
const MIN_ROW_WIDTH = 280;

export function ThreadWorkProduct({ artifact }: { artifact: LabArtifact }) {
  return <ArtifactRow artifact={artifact} />;
}

export function ThreadAttachments({ artifacts }: { artifacts: LabArtifact[] }) {
  if (artifacts.length === 0) return null;
  if (artifacts.length === 1) return <ArtifactRow artifact={artifacts[0]} />;
  return (
    <div data-surface="thread" className="flex w-full flex-wrap gap-2">
      {artifacts.map((artifact) => (
        <ArtifactRow key={artifact.id} artifact={artifact} className="min-w-px" style={{ flex: `1 0 ${MIN_ROW_WIDTH}px` }} />
      ))}
    </div>
  );
}
