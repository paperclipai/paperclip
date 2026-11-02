export default (ctx, direction) => `import type { DirectionKit } from "../../kit";
${ctx.surfaces.map((surface) => `import { ${surface.body} } from "./${surface.body}";`).join("\n")}
import "./tokens.css";

export const kit: DirectionKit = {
  id: ${JSON.stringify(direction.id)},
  name: ${JSON.stringify(direction.name)},
  tagline: ${JSON.stringify(direction.tagline)},
${ctx.surfaces.map((surface) => `  ${surface.body},`).join("\n")}
};
`;
