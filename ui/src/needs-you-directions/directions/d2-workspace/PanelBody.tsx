import type { SurfaceData } from "../../kit";
import { MotionSpecimen } from "./MotionSpecimen";

export function PanelBody({ items }: SurfaceData["panel"]) {
  return (
    <ul data-lab-stub="d2-workspace-panel" className="grid list-none grid-cols-(--workspace-grid) gap-4 p-0">
      {items.map((item) => (
        <li key={item.id} className="min-w-0">
          <MotionSpecimen item={item} />
        </li>
      ))}
    </ul>
  );
}
