export default () => `import type { ReactNode } from "react";
import type { DirectionKit } from "../kit";

export function Slot({ kit, className, children }: { kit: DirectionKit; className?: string; children: ReactNode }) {
  return (
    <div data-direction={kit.id} className={className}>
      {children}
    </div>
  );
}
`;
