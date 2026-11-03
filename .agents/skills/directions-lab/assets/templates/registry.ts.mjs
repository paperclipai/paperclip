const quote = (value) => JSON.stringify(value);

export const directionEntry = (direction) =>
  `    { id: ${quote(direction.id)}, key: ${quote(direction.key)}, name: ${quote(direction.name)}, tagline: ${quote(direction.tagline)}${direction.baseline ? ", baseline: true" : ""}, stage: ${quote(direction.stage)} },`;

export const surfaceEntry = (surface) => `    { id: ${quote(surface.id)}, label: ${quote(surface.label)}, width: ${surface.width}, nav: ${quote(surface.nav)} },`;

export default (ctx) => `import { defineLab } from "./define-lab";

export const registry = defineLab({
  slug: ${quote(ctx.slug)},
  title: ${quote(ctx.title)},
  storyId: ${quote(ctx.storyId)},
  group: ${quote(ctx.group)},
  capabilities: [${ctx.capabilities.map(quote).join(", ")}],
  publicUrl: ${quote(ctx.publicUrl)},
  surfaces: [
${ctx.surfaces.map(surfaceEntry).join("\n")}
  ],
  directions: [
${ctx.kits.map(directionEntry).join("\n")}
  ],
  baselinePosition: "last",
  landing: { direction: ${quote(ctx.landing.direction)}, view: ${quote(ctx.landing.view)} },
  today: { flags: {} },
  shell: {
    company: { id: ${quote(ctx.company.id)}, name: ${quote(ctx.company.name)}, issuePrefix: ${quote(ctx.company.issuePrefix)} },
    tasks: [
${ctx.tasks.map((task) => `      { identifier: ${quote(task.identifier)}, title: ${quote(task.title)} },`).join("\n")}
    ],
  },
  provenance: { runtimeCommit: ${quote(ctx.provenance.runtimeCommit)}, skillVersion: ${quote(ctx.provenance.skillVersion)}, createdAt: ${quote(ctx.provenance.createdAt)} },
${ctx.forceCount ? "  allowMore: true,\n" : ""}  allow: [],
});
`;
