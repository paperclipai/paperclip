import type { SurfaceData } from "../../kit";
import { MotionSpecimen } from "./MotionSpecimen";

export function LandingBody({ items }: SurfaceData["landing"]) {
  return (
    <ul data-lab-stub="d1-focus-landing" className="grid list-none grid-cols-(--focus-grid) gap-4 p-0">
      {items.map((item) => (
        <li key={item.id} className="min-w-0">
          <MotionSpecimen item={item} />
        </li>
      ))}
    </ul>
  );
}
