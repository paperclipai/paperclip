export default (ctx) => `import type { FC } from "react";
import type { DirectionKit, SurfaceId } from "../kit";
${ctx.surfaces.map((surface) => `import { ${surface.frame} } from "./${surface.frame}";`).join("\n")}

const FRAMES: Record<SurfaceId, FC<{ kit: DirectionKit }>> = {
${ctx.surfaces.map((surface) => `  ${JSON.stringify(surface.id)}: ${surface.frame},`).join("\n")}
};

export function SurfaceView({ kit, surface }: { kit: DirectionKit; surface: SurfaceId }) {
  const Frame = FRAMES[surface];
  return <Frame kit={kit} />;
}
`;
