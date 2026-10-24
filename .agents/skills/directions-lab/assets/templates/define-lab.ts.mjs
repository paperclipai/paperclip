export default () => `export type ShellNav = "tasks" | "artifacts" | "other";
export type LabStage = "shipped" | "proposed" | "adopted" | "current" | "historical";

export interface LabSurface {
  readonly id: string;
  readonly label: string;
  readonly width: number;
  readonly nav: ShellNav;
}

export interface LabDirection {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly tagline: string;
  readonly baseline?: boolean;
  readonly stage: LabStage;
}

export interface LabTask {
  readonly identifier: string;
  readonly title: string;
}

export interface LabRegistry<D extends LabDirection = LabDirection, S extends LabSurface = LabSurface> {
  readonly slug: string;
  readonly title: string;
  readonly storyId: string;
  readonly group: string;
  readonly capabilities: readonly string[];
  readonly publicUrl: string;
  readonly surfaces: readonly S[];
  readonly directions: readonly D[];
  readonly baselinePosition: "last";
  readonly landing: { readonly direction: D["id"] | "all"; readonly view: S["id"] | "board" };
  readonly today: { readonly flags: Readonly<Record<string, boolean>> };
  readonly shell: {
    readonly company: { readonly id: string; readonly name: string; readonly issuePrefix: string };
    readonly tasks: readonly LabTask[];
  };
  readonly provenance: { readonly runtimeCommit: string; readonly skillVersion: string; readonly createdAt: string };
  readonly allowMore?: boolean;
  readonly allow: readonly string[];
}

function fail(slug: string, message: string): never {
  throw new Error(\`defineLab(\${slug}): \${message}\`);
}

export function defineLab<const D extends LabDirection, const S extends LabSurface>(registry: LabRegistry<D, S>): LabRegistry<D, S> {
  const { slug, directions, surfaces, landing } = registry;
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(slug)) fail(slug, "slug must be kebab-case");
  const ids: string[] = directions.map((direction) => direction.id);
  if (new Set(ids).size !== ids.length) fail(slug, "direction ids must be unique");
  const keys = directions.map((direction) => direction.key);
  if (new Set(keys).size !== keys.length || keys.some((key) => !/^[0-9]$/.test(key))) fail(slug, "direction keys must be unique single digits");
  const baselines = directions.filter((direction) => direction.baseline);
  if (baselines.length !== 1 || baselines[0].id !== "today" || baselines[0].key !== "0") fail(slug, "exactly one baseline, with id today and key 0");
  if (directions[directions.length - 1]?.id !== "today") fail(slug, "the baseline comes last");
  const explorations = directions.filter((direction) => !direction.baseline);
  if (!registry.allowMore && (explorations.length < 2 || explorations.length > 3)) fail(slug, "2 or 3 explorations unless allowMore is set");
  for (const direction of explorations) {
    const match = /^d([1-9])-[a-z0-9]+(-[a-z0-9]+)*$/.exec(direction.id);
    if (!match) fail(slug, \`exploration id \${direction.id} must be d<N>-<name>\`);
    if (match[1] !== direction.key) fail(slug, \`exploration \${direction.id} must have key \${match[1]}\`);
    if (!direction.name.startsWith(\`\${direction.key}.\`)) fail(slug, \`exploration \${direction.id} must be named "\${direction.key}.<Name>"\`);
  }
  if (surfaces.length < 1 || surfaces.length > 6) fail(slug, "1 to 6 surfaces");
  const surfaceIds: string[] = surfaces.map((surface) => surface.id);
  if (new Set(surfaceIds).size !== surfaceIds.length) fail(slug, "surface ids must be unique");
  if (surfaceIds.includes("board")) fail(slug, "board is the overview, not a surface");
  if (surfaces.some((surface) => !(surface.width > 0))) fail(slug, "surface widths must be positive");
  if (landing.direction !== "all" && !ids.includes(landing.direction)) fail(slug, "landing direction must be a direction id or all");
  if (landing.view !== "board" && !surfaceIds.includes(landing.view)) fail(slug, "landing view must be a surface id or board");
  return registry;
}
`;
