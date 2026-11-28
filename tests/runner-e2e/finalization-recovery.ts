import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RunnerTaskFixture } from "./types.js";
import type { FinalizationCrashBinding } from "./finalization-crash-boundary.js";

export const FINALIZATION_PAYLOAD_BYTES = 64 * 1024 * 1024;
export const finalizationFiles = (nonce: string) => ({ data: `retained-data-${nonce}.bin`, proof: `retained-proof-${nonce}.json` });
export const finalizationRecoveryTask: RunnerTaskFixture = {
  id: "preserve-result-on-restart", label: "Recover workspace finalization without repeating provider work",
  groups: [], flow: "finalization_recovery", workMode: "standard", expectedRunCount: 1, automaticRetryPolicy: "single_attempt",
  attemptTimeoutMs: { local: 15 * 60_000, daytona: 20 * 60_000 }, turnTimeoutMs: 5 * 60_000,
  expectedTerminalState: { issue: "done", run: "succeeded" },
  buildTitle: nonce => `Retain a generated data sample ${nonce}`,
  buildVisibleMarker: nonce => finalizationFiles(nonce).proof,
  buildPrompt(nonce) {
    const files = finalizationFiles(nonce);
    return [
      `Generate exactly ${FINALIZATION_PAYLOAD_BYTES} unpredictable bytes from the operating system random source in ${files.data}. Keep this binary file in the configured workspace; do not register or upload the binary as a deliverable.`,
      "Generate a fresh 32-byte hexadecimal reference. Compute the SHA-256 of the complete binary file.",
      `Write ${files.proof} as JSON with exactly three fields: reference (the fresh reference), byteSize (the binary file's exact byte count), and sha256 (the full lowercase file hash).`,
      `Register ${files.proof} as a downloadable artifact work product with that exact title and deliver its accessible link in this task. Retain both original files. Finish after verifying the proof. Do not create other tasks or agents.`,
    ].join("\n");
  }, buildMatchers: () => [],
};

export function parseFinalizationProof(value: unknown) {
  const proof = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (Object.keys(proof).sort().join(",") !== "byteSize,reference,sha256" || proof.byteSize !== FINALIZATION_PAYLOAD_BYTES ||
      typeof proof.reference !== "string" || !/^[a-f0-9]{64}$/.test(proof.reference) ||
      typeof proof.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(proof.sha256))
    throw new Error("Original proof does not match the requested file contract");
  return { reference: proof.reference, byteSize: proof.byteSize as number, sha256: proof.sha256 };
}

export function finalizationResultDigest(value: unknown): string {
  const ordered = (input: any): any => Array.isArray(input) ? input.map(ordered) : input && typeof input === "object"
    ? Object.fromEntries(Object.keys(input).sort().map(key => [key, ordered(input[key])])) : input;
  return createHash("sha256").update(JSON.stringify(ordered(value))).digest("hex");
}

export interface FinalizationRecoveryObservation {
  binding: FinalizationCrashBinding;
  before: { resultDigest: string; acceptedResults: number; providerTurns: number; operationIds: string[]; artifactId: string; artifactSha256: string } | null;
  crash: (FinalizationCrashBinding & { nativePhase: string; observedAt: string }) | null;
  final: { runIds: string[]; committed: boolean; issueDone: boolean; resultDigest: string; acceptedResults: number; providerTurns: number;
    resumedOperations: Array<{ resumedFromOperationId: string; startedAt: string }>;
    artifactId: string; artifactSha256: string; byteSize: number; actualSha256: string; expectedSha256: string;
    proofReference: string; finalDeliveryCount: number; deliveryReceiptMatches: boolean; visibleDelivery: boolean; pendingInteractions: number } | null;
}

export function gradeFinalizationRecovery(value: FinalizationRecoveryObservation) {
  const before = value.before, final = value.final, crash = value.crash;
  const check = (id: string, passed: unknown, detail: string) => ({ id, passed: Boolean(passed), detail });
  return [
    check("exercised-finalization-crash", !!before && before.acceptedResults === 1 && before.providerTurns >= 1 && before.operationIds.length > 0 &&
      crash?.companyId === value.binding.companyId && crash?.issueId === value.binding.issueId && crash?.runId === value.binding.runId &&
      crash?.nativePhase === "workspace_finalizing" && Number.isFinite(Date.parse(crash.observedAt)) &&
      final?.resumedOperations.some(operation => before.operationIds.includes(operation.resumedFromOperationId) && Date.parse(operation.startedAt) >= Date.parse(crash.observedAt)),
      "A saved result must be interrupted before commit and its unfinished workspace operation resumed after the crash observation."),
    check("preserved-provider-result", before && final?.committed && final.issueDone && final.runIds.length === 1 && final.runIds[0] === value.binding.runId &&
      /^[a-f0-9]{64}$/.test(before.resultDigest) && final.resultDigest === before.resultDigest &&
      final.acceptedResults === before.acceptedResults && final.providerTurns === before.providerTurns,
      "The original run must commit the unchanged accepted result without a new provider turn or admission."),
    check("preserved-workspace-and-artifact", before && final && before.artifactId === final.artifactId && before.artifactSha256 === final.artifactSha256 &&
      /^[a-f0-9]{64}$/.test(final.proofReference) && final.byteSize === FINALIZATION_PAYLOAD_BYTES &&
      /^[a-f0-9]{64}$/.test(final.expectedSha256) && final.actualSha256 === final.expectedSha256,
      "The original registered proof and independently hashed restored binary must survive byte for byte."),
    check("one-accessible-final-delivery", final?.finalDeliveryCount === 1 && final.deliveryReceiptMatches && final.visibleDelivery && final.pendingInteractions === 0,
      "Exactly one final reply must match its delivery receipt and expose the original downloadable proof."),
  ];
}

export function finalizationRecoveryDigest() {
  const hash = createHash("sha256");
  for (const file of ["finalization-recovery.ts", "finalization-recovery-flow.ts", "run-delivery.ts", "finalization-crash-boundary.ts", "server.ts", "server-stop.ts", "registered-artifact.ts", "runner.spec.ts", "stock-harness.ts"])
    hash.update(file).update(readFileSync(new URL(file, import.meta.url)));
  return hash.digest("hex");
}
