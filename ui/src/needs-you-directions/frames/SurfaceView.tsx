import type { FC } from "react";
import type { DirectionKit, SurfaceId } from "../kit";
import { LandingFrame } from "./LandingFrame";
import { CardFrame } from "./CardFrame";
import { PanelFrame } from "./PanelFrame";

const FRAMES: Record<SurfaceId, FC<{ kit: DirectionKit }>> = {
  "landing": LandingFrame,
  "card": CardFrame,
  "panel": PanelFrame,
};

export function SurfaceView({ kit, surface }: { kit: DirectionKit; surface: SurfaceId }) {
  const Frame = FRAMES[surface];
  return <Frame kit={kit} />;
}
