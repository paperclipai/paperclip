import type { DirectionKit } from "../kit";
import { GROUPS, OPEN_GROUP, PANEL_ARTIFACTS } from "../fixtures";
import { AppShell } from "./AppShell";
import { GalleryFrame } from "./GalleryFrame";
import { PanelFrame } from "./PanelFrame";
import { ThreadFrame } from "./ThreadFrame";

/** The four product surfaces a kit is judged on, each inside the app shell. */
export type SurfaceId = "thread" | "panel" | "gallery" | "stack";

export const SURFACE_IDS: readonly SurfaceId[] = ["thread", "panel", "gallery", "stack"];

export function SurfaceView({ kit, surface }: { kit: DirectionKit; surface: SurfaceId }) {
  if (surface === "gallery" || surface === "stack") {
    return (
      <AppShell nav="artifacts">
        <GalleryFrame kit={kit} groups={GROUPS} open={surface === "stack" ? OPEN_GROUP : null} />
      </AppShell>
    );
  }
  const panelOpen = surface === "panel";
  return (
    <AppShell nav="tasks">
      {/* Layout.tsx:715-718 — the task-detail row: thread column, then the pane at full height. */}
      <div className="flex flex-1 min-h-0 streamlined-task-detail-surface">
        <ThreadFrame kit={kit} panelOpen={panelOpen} />
        {panelOpen ? <PanelFrame kit={kit} artifacts={PANEL_ARTIFACTS} /> : null}
      </div>
    </AppShell>
  );
}
