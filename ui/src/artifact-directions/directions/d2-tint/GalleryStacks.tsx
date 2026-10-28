import type { LabGroup } from "../../kit";
import { StackFolder } from "./StackFolder";
import { StackSingle } from "./StackSingle";

/**
 * GALLERY — the grid of task stacks under the page toolbar.
 *
 * The page's own grid (1 / 2 / 3 columns, 24px gap). A stack of two or more
 * is a folder; a stack of one is the artifact itself. Every unit in a row
 * takes the row's height, so the pockets and the single tiles end level.
 */
export function GalleryStacks({ groups }: { groups: LabGroup[] }) {
  if (groups.length === 0) {
    // The shipped empty state's copy.
    return <p className="py-16 text-center text-sm font-medium text-foreground">No artifact stacks yet.</p>;
  }
  return (
    <ul data-surface="gallery-stacks" className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
      {groups.map((group) => (group.count > 1 ? <StackFolder key={group.id} group={group} /> : <StackSingle key={group.id} group={group} />))}
    </ul>
  );
}
