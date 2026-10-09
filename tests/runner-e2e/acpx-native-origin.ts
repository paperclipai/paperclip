/** The embedded driver and runtime sidecar are the two production ACPX bridges.
 * Keep provider and native method exact; semantic tools are not native proof.
 */
export function hasAcpxNativeOrigin(origin: unknown, provider: string, method: string): boolean {
  if (origin === null || typeof origin !== "object" || Array.isArray(origin)) return false;
  const value = origin as Record<string, unknown>;
  return (value.adapter === "acpx-runtime" || value.adapter === "acpx-runtime-sidecar")
    && value.provider === provider && value.method === method;
}
