import { createHash } from "node:crypto";
import { z } from "zod";
import type { PhotonExternalBinding } from "./external-contract.js";
export type PhotonCoverageAuthority = { binding: PhotonExternalBinding; handoffId: string; subject: string; deliveredThrough: number | null };
/** Explicit closed tuple order: object property insertion order is irrelevant. */
export function photonCoverageFingerprint(entries: readonly PhotonCoverageAuthority[]): string {
  const seen = new Set<string>();
  const tuples = entries.map(({ binding: b, handoffId, subject, deliveredThrough }) => {
    const identity = JSON.stringify([b.instanceId, b.companyId, b.endpointId, b.connectionId]);
    if (seen.has(identity)) throw new Error("Duplicate Photon coverage authority"); seen.add(identity);
    return [b.version, b.instanceId, b.environment, b.companyId, b.endpointId, b.connectionId, b.runtimeGeneration,
      b.projectId, b.lineId, b.phoneNumber, b.allocation, b.credentialFingerprint, b.bindingId, b.intakeAfter, b.maxFrameBytes,
      handoffId, subject, deliveredThrough];
  }).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
  return createHash("sha256").update(JSON.stringify(tuples)).digest("hex");
}
const schema = z.object({ version: z.literal(1), instanceId: z.string().min(1).max(200), generation: z.string().regex(/^[a-f0-9]{64}$/),
  count: z.number().int().positive().max(1000), bindingsFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type PhotonConfiguredCoverage = z.infer<typeof schema>;
export type PhotonCoverageContent = Omit<PhotonConfiguredCoverage, "generation">;
export function parsePhotonConfiguredCoverage(raw: unknown): PhotonConfiguredCoverage { return Object.freeze(schema.parse(raw)); }
