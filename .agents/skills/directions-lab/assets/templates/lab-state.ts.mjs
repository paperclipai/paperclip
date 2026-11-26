export default () => `import { DIRECTION_IDS, SURFACE_IDS, type DirectionId, type SurfaceId } from "./kit";
import { registry } from "./registry";

export type LabView = SurfaceId | "board";
export type LabTheme = "dark" | "light";

export const LAB_VIEWS: readonly LabView[] = [...SURFACE_IDS, "board"];
export const FIRST_SURFACE: SurfaceId = SURFACE_IDS[0];

export interface LabState {
  direction: DirectionId | "all";
  view: LabView;
  theme: LabTheme;
  chrome: boolean;
  anim: boolean;
  proposal: boolean;
}

export const isDirection = (value: string | null): value is DirectionId => value !== null && (DIRECTION_IDS as readonly string[]).includes(value);
export const isView = (value: string | null): value is LabView => value !== null && (LAB_VIEWS as readonly string[]).includes(value);

export function readLabState(search: string): LabState {
  const params = new URLSearchParams(search);
  const d = params.get("d");
  const s = params.get("s");
  return {
    direction: d === "all" ? "all" : isDirection(d) ? d : s ? "today" : registry.landing.direction,
    view: isView(s) ? s : d && d !== "all" ? FIRST_SURFACE : registry.landing.view,
    theme: params.get("theme") === "light" ? "light" : "dark",
    chrome: params.get("chrome") !== "0",
    anim: params.get("anim") !== "0",
    proposal: params.get("proposal") === "1",
  };
}

export function labSearch(state: LabState): string {
  const params = new URLSearchParams({ d: state.direction, s: state.view, theme: state.theme });
  if (!state.chrome) params.set("chrome", "0");
  if (!state.anim) params.set("anim", "0");
  if (state.proposal) params.set("proposal", "1");
  return \`?\${params.toString()}\`;
}

export const landingSearch = (): string => labSearch(readLabState(""));

export const kitIdOf = (state: LabState): DirectionId => (state.direction === "all" ? "today" : state.direction);
`;
