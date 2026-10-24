export default (ctx, direction, surface) => `import type { SurfaceData } from "../../kit";
import { MotionSpecimen } from "./MotionSpecimen";

export function ${surface.body}({ items }: SurfaceData["${surface.id}"]) {
  return (
    <ul data-lab-stub="${direction.id}-${surface.id}" className="grid list-none grid-cols-(--${direction.prefix}-grid) gap-4 p-0">
      {items.map((item) => (
        <li key={item.id} className="min-w-0">
          <MotionSpecimen item={item} />
        </li>
      ))}
    </ul>
  );
}
`;
