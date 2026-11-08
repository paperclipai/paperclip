import { useState } from "react";
import { ArrowLeft, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { LabArtifact, LabGroup } from "../../kit";
import { mediaKindOf, type MediaKind } from "./kinds";
import { SingleTile, StackTile } from "./Tile";

/**
 * The Artifacts page under its top bar: toolbar, the opened stack's header
 * row, and the grid.
 *
 * Filters: "Tasks" (the default) shows one tile per task — a stack when the
 * task has several artifacts, the artifact itself when it has one. "All files"
 * is every artifact, flat, newest first. The type filters are the same flat
 * list narrowed to one of the product's media kinds.
 */

type Filter = "tasks" | "all" | MediaKind;

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "tasks", label: "Tasks" },
  { id: "all", label: "All files" },
  { id: "image", label: "Images" },
  { id: "video", label: "Videos" },
  { id: "document", label: "Documents" },
  { id: "text", label: "Text" },
  { id: "file", label: "Files" },
];

const newestFirst = (a: LabArtifact, b: LabArtifact) => b.updatedAt.localeCompare(a.updatedAt);

function everyArtifact(groups: LabGroup[]): LabArtifact[] {
  return groups.flatMap((group) => group.artifacts).sort(newestFirst);
}

function Toolbar({ filter, onFilter }: { filter: Filter; onFilter: (filter: Filter) => void }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="relative w-full sm:max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input readOnly className="h-9 pl-9 pr-9 text-sm" placeholder="Search artifacts..." aria-label="Search artifacts" />
      </div>
      <div role="tablist" aria-label="Show artifacts by task or by type" className="flex flex-wrap items-center gap-1.5">
        {FILTERS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={id === filter}
            onClick={() => onFilter(id)}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              id === filter ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function StackHeader({ group }: { group: LabGroup }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" />
        All stacks
      </span>
      <span className="truncate text-muted-foreground">
        <span className="text-foreground/80">{group.taskIdentifier}</span> {group.title}
      </span>
    </div>
  );
}

export function Grid({ children, empty }: { children: React.ReactNode[]; empty: string }) {
  if (children.length === 0) return <p className="py-16 text-center text-sm font-medium text-foreground">{empty}</p>;
  // Cells 28px apart in both directions.
  return (
    <ul data-surface="gallery" className="grid gap-7 grid-cols-(--v1-grid)">
      {children}
    </ul>
  );
}

/** The "Tasks" view: one tile per task. */
export function TaskTiles({ groups }: { groups: LabGroup[] }) {
  return <Grid empty="No artifact stacks yet.">{groups.map((group) => (group.count > 1 ? <StackTile key={group.id} group={group} /> : <SingleTile key={group.id} artifact={group.artifacts[0]} />))}</Grid>;
}

export function FileTiles({ artifacts, empty = "No artifacts yet." }: { artifacts: LabArtifact[]; empty?: string }) {
  return (
    <Grid empty={empty}>
      {artifacts.map((artifact) => (
        <SingleTile key={artifact.id} artifact={artifact} />
      ))}
    </Grid>
  );
}

export function GalleryView({ groups, open }: { groups: LabGroup[]; open: LabGroup | null }) {
  const [filter, setFilter] = useState<Filter>("tasks");
  const byKind = (artifacts: LabArtifact[]) => (filter === "tasks" || filter === "all" ? artifacts : artifacts.filter((artifact) => mediaKindOf(artifact) === filter));
  // 24px from the toolbar to the first row of cells (gap-6).
  return (
    <div className="flex flex-col gap-6">
      <Toolbar filter={filter} onFilter={setFilter} />
      {open ? (
        <>
          <StackHeader group={open} />
          <FileTiles artifacts={byKind([...open.artifacts].sort(newestFirst))} empty="Nothing in this stack for the current filters." />
        </>
      ) : filter === "tasks" ? (
        <TaskTiles groups={groups} />
      ) : (
        <FileTiles artifacts={byKind(everyArtifact(groups))} empty="No artifacts of this type yet." />
      )}
    </div>
  );
}
