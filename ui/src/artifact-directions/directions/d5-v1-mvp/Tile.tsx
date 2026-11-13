import type { ReactNode } from "react";
import type { LabArtifact, LabGroup } from "../../kit";
import { Front } from "./Front";
import { StackComposition } from "./Stack";
import { countLabel, updatedLabel } from "./when";

/**
 * One cell of the grid: a 254px frame holding the artifact or stack, then the
 * caption — title, the task's identifier in a pill, and a line of facts.
 * Measured from the mock: 20px side margins, 20px between frame and caption,
 * 12px between the title and the pill row (the mock's 8 plus 4, on request).
 * The pill is Paper Mono regular with
 * 12px of side padding (the mock's 8px plus 4, on request); its fills are the
 * `.v1-pill` rule in tokens.css, which darkens it a step while the tile is
 * hovered in light mode. The artwork stands on the frame's
 * bottom edge, so the space from artwork to title is the same in every cell.
 * The cell is a fixed 370px tall whether the title takes one line or two (its
 * most before truncating), so the hover fill (node 2144:135716, 12px radius)
 * is the same size in every cell; a one-line caption leaves the extra room
 * at the bottom.
 */

function Caption({ title, identifier, facts }: { title: string; identifier: string; facts: string[] }) {
  return (
    <div className="flex w-full flex-col items-center gap-3">
      <p className="line-clamp-2 w-full break-words text-center text-base font-medium leading-5 text-foreground" title={title}>
        {title}
      </p>
      <div className="flex items-center justify-center gap-2">
        <span data-pill className="v1-pill rounded-full px-3 py-1 text-xs font-normal leading-4 transition-colors">
          {identifier}
        </span>
        <span className="flex items-center gap-1 text-xs leading-4 text-muted-foreground">
          {facts.map((fact, i) => (
            <span key={fact} className="whitespace-nowrap">
              {i > 0 ? <span className="mr-1">·</span> : null}
              {fact}
            </span>
          ))}
        </span>
      </div>
    </div>
  );
}

function Tile({ label, children, caption }: { label: string; children: ReactNode; caption: ReactNode }) {
  return (
    <li className="min-w-0">
      <button
        type="button"
        aria-label={label}
        // text-left: a button centres its text by default, which would centre the title set on the sheet.
        className="flex h-(--v1-tile-h) w-full flex-col items-center gap-5 rounded-(--v1-tile-radius) px-5 text-left outline-none transition-colors hover:bg-(--v1-tile-hover) focus-visible:bg-(--v1-tile-hover) focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex h-(--v1-frame-h) w-full shrink-0 items-end justify-center">{children}</div>
        {caption}
      </button>
    </li>
  );
}

/** A task with several artifacts: its newest one on top of a stack, the task's title underneath. Every stack stands on the frame's bottom edge so their tops align. */
export function StackTile({ group }: { group: LabGroup }) {
  const front = group.artifacts[0];
  return (
    <Tile label={`Open ${group.taskIdentifier} ${group.title}, ${countLabel(group.count)}`} caption={<Caption title={group.title} identifier={group.taskIdentifier} facts={[countLabel(group.count), `Updated ${updatedLabel(front.updatedAt)}`]} />}>
      <StackComposition front={front} />
    </Tile>
  );
}

/** One artifact on its own: its file name underneath. */
export function SingleTile({ artifact }: { artifact: LabArtifact }) {
  const name = artifact.filename ?? artifact.title;
  return (
    <Tile label={`Open ${name}`} caption={<Caption title={name} identifier={artifact.taskIdentifier} facts={[`Updated ${updatedLabel(artifact.updatedAt)}`]} />}>
      <Front artifact={artifact} />
    </Tile>
  );
}
