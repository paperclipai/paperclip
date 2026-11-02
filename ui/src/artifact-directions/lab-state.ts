import { DIRECTION_IDS, type DirectionId } from "./kit";
import { SURFACE_IDS, type SurfaceId } from "./frames/SurfaceView";

/**
 * The lab's whole state lives in the URL, so any view can be linked, captured
 * and embedded:
 *
 *   ?d=<DirectionId|all>&s=<thread|panel|gallery|stack|kinds|board>&theme=<dark|light>&chrome=<1|0>&anim=<1|0>
 *
 * `d=all` is the every-kit contact sheet, reachable by URL only since the kit
 * toggle lost its "All" entry (2026-10-21); elsewhere it reads as `today`.
 * `s=kinds`, the vocabulary sheet, is likewise URL-only now.
 * The kits' hover animations are on unless `anim=0` (captures are still either
 * way: nothing moves until a pointer hovers); the state is set on <html> as
 * `data-lab-anim`.
 */

export type LabView = SurfaceId | "kinds" | "board";
export type LabTheme = "dark" | "light";

export const LAB_VIEWS: readonly LabView[] = [...SURFACE_IDS, "kinds", "board"];

export interface LabState {
  direction: DirectionId | "all";
  view: LabView;
  theme: LabTheme;
  chrome: boolean;
  anim: boolean;
}

const isDirection = (value: string | null): value is DirectionId =>
  value !== null && (DIRECTION_IDS as readonly string[]).includes(value);
const isView = (value: string | null): value is LabView => value !== null && (LAB_VIEWS as readonly string[]).includes(value);

export function readLabState(search: string): LabState {
  const params = new URLSearchParams(search);
  const d = params.get("d");
  const s = params.get("s");
  return {
    // A bare URL opens V1 MVP's overview: it is what the shared link should land on.
    direction: d === "all" ? "all" : isDirection(d) ? d : s ? "today" : "d5-v1-mvp",
    view: isView(s) ? s : d && d !== "all" ? "thread" : "board",
    theme: params.get("theme") === "light" ? "light" : "dark",
    chrome: params.get("chrome") !== "0",
    anim: params.get("anim") !== "0",
  };
}

export function labSearch(state: LabState): string {
  const params = new URLSearchParams({ d: state.direction, s: state.view, theme: state.theme });
  if (!state.chrome) params.set("chrome", "0");
  if (!state.anim) params.set("anim", "0");
  return `?${params.toString()}`;
}

/** The kit a non-board view renders. */
export const kitIdOf = (state: LabState): DirectionId => (state.direction === "all" ? "today" : state.direction);
