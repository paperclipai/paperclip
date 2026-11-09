export default (ctx) => `import type { DirectionKit } from "../../kit";
${ctx.surfaces.map((surface) => `import { ${surface.body} } from "./${surface.body}";`).join("\n")}

export const kit: DirectionKit = {
  id: "today",
  name: ${JSON.stringify(ctx.today.name)},
  tagline: ${JSON.stringify(ctx.today.tagline)},
${ctx.surfaces.map((surface) => `  ${surface.body},`).join("\n")}
};
`;
