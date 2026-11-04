import { CoordinatorNeedsYou } from "@/components/coordinator/CoordinatorNeedsYou";
import { PropertiesPanel } from "@/components/PropertiesPanel";
import type { SurfaceData } from "../../kit";

/** Docks the panel just under the lab's sticky two-row toolbar. */
const LAB_TOOLBAR_HEIGHT = "calc(var(--spacing) * 22)";
const PANEL_DOCK = { top: LAB_TOOLBAR_HEIGHT, height: `calc(100dvh - ${LAB_TOOLBAR_HEIGHT})` };

export function LandingBody(_props: SurfaceData["landing"]) {
  return (
    // The side panel docks beside the list and stays in view while it scrolls,
    // as it does in the app shell.
    <div className="coordinator-workspace flex items-start gap-4">
      <div className="min-w-0 flex-1">
        <CoordinatorNeedsYou />
      </div>
      <div className="sticky flex shrink-0" style={PANEL_DOCK}>
        <PropertiesPanel taskDetailLayout />
      </div>
    </div>
  );
}
