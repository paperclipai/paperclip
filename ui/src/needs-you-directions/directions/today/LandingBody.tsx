import { CoordinatorNeedsYou } from "@/components/coordinator/CoordinatorNeedsYou";
import type { SurfaceData } from "../../kit";

export function LandingBody(_props: SurfaceData["landing"]) {
  return (
    <div className="coordinator-workspace">
      <CoordinatorNeedsYou />
    </div>
  );
}
