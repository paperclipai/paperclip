export default (ctx) => `import type { FC } from "react";
import { registry } from "./registry";

export type DirectionId = (typeof registry.directions)[number]["id"];
export type SurfaceId = (typeof registry.surfaces)[number]["id"];

export interface LabRecord {
  id: string;
  title: string;
  author: string;
  updatedAt: string;
  updatedLabel: string;
}

export interface SurfaceData extends Record<SurfaceId, unknown> {
${ctx.surfaces.map((surface) => `  ${JSON.stringify(surface.id)}: { items: LabRecord[] };`).join("\n")}
}

export interface DirectionKit {
  id: DirectionId;
  name: string;
  tagline: string;
  flags?: Record<string, boolean>;
${ctx.surfaces.map((surface) => `  ${surface.body}: FC<SurfaceData["${surface.id}"]>;`).join("\n")}
}

export const DIRECTION_IDS: readonly DirectionId[] = registry.directions.map((direction) => direction.id);
export const SURFACE_IDS: readonly SurfaceId[] = registry.surfaces.map((surface) => surface.id);

export const KIT_KEYS = Object.fromEntries(registry.directions.map((direction) => [direction.id, direction.key])) as Record<DirectionId, string>;
export const KIT_META = Object.fromEntries(registry.directions.map((direction) => [direction.id, { name: direction.name, tagline: direction.tagline }])) as Record<
  DirectionId,
  { name: string; tagline: string }
>;

export function surfaceOf(id: SurfaceId) {
  const surface = registry.surfaces.find((entry) => entry.id === id);
  if (!surface) throw new Error(\`No surface \${id} in the ${ctx.slug} registry\`);
  return surface;
}

const KIT_LOADERS = import.meta.glob<{ kit: DirectionKit }>("./directions/*/index.tsx");

export function loadKit(id: DirectionId): Promise<DirectionKit> {
  const load = KIT_LOADERS[\`./directions/\${id}/index.tsx\`];
  if (!load) return Promise.reject(new Error(\`No kit at directions/\${id}/index.tsx\`));
  return load().then((module) => module.kit);
}
`;
