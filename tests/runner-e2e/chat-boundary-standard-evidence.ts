/** A browser boundary stops before fixture task setup and chat dispatch, so it has no source
 * task. Every passing attempt still needs the standard pass evidence (final-state.png,
 * snapshots/fixtures.json, snapshots/api-state.json) that the launcher and the trusted
 * private transfer require. These records describe only what the boundary really observed:
 * the resources it reported creating and its own graded observation. Nothing is manufactured. */
export interface BoundaryResourceTrail { companyIds: string[]; agentIds: string[]; runIds: string[] }
export function emptyBoundaryResourceTrail(): BoundaryResourceTrail { return { companyIds: [], agentIds: [], runIds: [] }; }
export function recordBoundaryResources(trail: BoundaryResourceTrail, value: { companyId?: string; agentId?: string; runIds: string[] }) {
  const add = (list: string[], id?: string) => { if (id && !list.includes(id)) list.push(id); };
  add(trail.companyIds, value.companyId); add(trail.agentIds, value.agentId); for (const id of value.runIds) add(trail.runIds, id);
}
export function boundaryStandardSnapshots(input: { scenarioId: string; trail: BoundaryResourceTrail; boundaryObservation: unknown }) {
  if (!input.boundaryObservation || typeof input.boundaryObservation !== "object")
    throw new Error("Passing browser boundary has no graded observation to retain");
  return {
    fixtures: { journeyKind: "browser-boundary" as const, scenarioId: input.scenarioId, manufacturedFixtures: false,
      observedResources: structuredClone(input.trail) },
    apiState: { capturePhase: "boundary-final" as const, journeyKind: "browser-boundary" as const, scenarioId: input.scenarioId,
      boundaryObservation: input.boundaryObservation },
  };
}
