/**
 * One declarative agent-harness ("adapter") entry. The same shape is used for
 * local self-hosting and our operator/cloud: it governs both availability (the
 * picker) and, when the run is sandboxed on Kubernetes, the runtime wiring.
 *
 * Replace semantics: when a registry is supplied it is the COMPLETE declared
 * set. Adopt (built-in defaults) = no registry at all. Remove = omit the entry.
 * Add = include a new entry. Override = redefine an existing adapterType.
 */
export interface AdapterRegistryEntry {
  /** The harness, e.g. "opencode_local". */
  adapterType: string;
  /** Availability (both local + k8s). Default true. */
  enabled?: boolean;
  /** k8s-sandbox-only: container image the Job/Sandbox runs. */
  runtimeImage?: string;
  /** k8s-sandbox-only: process-env keys forwarded into the Job (e.g. ANTHROPIC_API_KEY). */
  envKeys?: string[];
  /** k8s-sandbox-only: egress FQDN allow-list for the agent pod. */
  allowFqdns?: string[];
  /** k8s-sandbox-only: liveness/probe command. */
  probeCommand?: string[];
  /**
   * Non-secret env injected into the Job/Sandbox as the BASE; the process-env
   * values (the secret API key, via envKeys) override it. Carries e.g.
   * ANTHROPIC_BASE_URL pointing at the in-cluster Bifrost gateway. NEVER put
   * secrets here.
   */
  defaultEnv?: Record<string, string>;
}
