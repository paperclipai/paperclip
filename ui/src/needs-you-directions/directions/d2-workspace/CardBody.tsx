import type { SurfaceData } from "../../kit";
import { MotionSpecimen } from "./MotionSpecimen";

export function CardBody({ items }: SurfaceData["card"]) {
  return (
    <ul data-lab-stub="d2-workspace-card" className="grid list-none grid-cols-(--workspace-grid) gap-4 p-0">
      {items.map((item) => (
        <li key={item.id} className="min-w-0">
          <MotionSpecimen item={item} />
        </li>
      ))}
    </ul>
  );
}
