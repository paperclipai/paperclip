/** Public contract for the credential-free manual evidence authorization script. */
export function manualEvidenceRouting(env: Record<string, string | undefined>): {
  retention: "recurring" | "actions" | "private"; executionIds: string[];
};
export function authorizeManualCellRoute(retention: string | undefined, executionId: string, privateIds: string): "actions" | "private";
