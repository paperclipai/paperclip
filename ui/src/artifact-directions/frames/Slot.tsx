import type { ReactNode } from "react";
import type { DirectionKit } from "../kit";

/**
 * The wrapper every kit slot is rendered in. A kit's `tokens.css` scopes its
 * custom properties to `[data-direction="<id>"]`.
 */
export function Slot({ kit, className, children }: { kit: DirectionKit; className?: string; children: ReactNode }) {
  return (
    <div data-direction={kit.id} className={className}>
      {children}
    </div>
  );
}
