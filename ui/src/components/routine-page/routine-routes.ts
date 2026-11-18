/** The routine page lives at `/routines/:id`. Version history and the audit log are its only sub-views. */
export type RoutineView = "routine" | "history" | "activity";

export function routinePath(routineId: string, view: RoutineView = "routine"): string {
  return view === "routine" ? `/routines/${routineId}` : `/routines/${routineId}/${view}`;
}

/**
 * Where an address for the routine page should lead. Old section links
 * (`/overview`, `/triggers`, `/runs`, …, and the legacy `?tab=`) all land on the
 * single page; `/history` and `/activity` keep their views. Returns `null` when
 * the address is already canonical.
 */
export function resolveRoutineAddress(input: {
  routineId: string;
  section?: string | null;
  legacyTab?: string | null;
}): { view: RoutineView; redirectTo: string | null } {
  const requested = input.legacyTab ?? input.section ?? null;
  const view: RoutineView = requested === "history" ? "history" : requested === "activity" ? "activity" : "routine";
  const canonical = routinePath(input.routineId, view);
  const current = input.section ? `/routines/${input.routineId}/${input.section}` : `/routines/${input.routineId}`;
  return { view, redirectTo: input.legacyTab || current !== canonical ? canonical : null };
}
