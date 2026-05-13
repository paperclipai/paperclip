/**
 * Per-adapter cloud-runtime defaults.
 *
 * Each entry tells the driver:
 *   - runtimeImage:  Which `agent-runtime-<adapter>` image to run (default
 *                    fallback is `agent-runtime-base`, which has no adapter
 *                    CLI and only succeeds for adapters whose binary is
 *                    already on PATH via the base image).
 *   - envKeys:       Which keys the driver should materialize from the
 *                    per-Job env Secret into the container's environment.
 *                    The Secret itself is populated by the server (from
 *                    company secrets) before driver.run() is called.
 *   - allowFqdns:    DNS names the tenant's NetworkPolicy + optional Cilium
 *                    CNP must permit egress to. Per-tenant policy overrides
 *                    via cluster_tenant_policies.networkJson.additionalAllowFqdns
 *                    are merged on top in ensureTenantNamespace.
 *
 * The image tags are appended downstream by the server's resolveRunContext;
 * this registry only carries the image NAME (no tag).
 */

export interface AdapterDefaults {
  /** Image name without tag, e.g. "ghcr.io/paperclipai/agent-runtime-claude". */
  runtimeImage: string;
  /** Env keys to copy from the per-Job Secret into the container environment. */
  envKeys: string[];
  /** FQDNs the tenant must be permitted egress to for the adapter to function. */
  allowFqdns: string[];
}

const REGISTRY_BASE = "ghcr.io/paperclipai";

export const ADAPTER_DEFAULTS: Record<string, AdapterDefaults> = {
  claude_local: {
    runtimeImage: `${REGISTRY_BASE}/agent-runtime-claude`,
    envKeys: ["ANTHROPIC_API_KEY"],
    allowFqdns: ["api.anthropic.com"],
  },
  codex_local: {
    runtimeImage: `${REGISTRY_BASE}/agent-runtime-codex`,
    envKeys: ["OPENAI_API_KEY"],
    allowFqdns: ["api.openai.com"],
  },
  gemini_local: {
    runtimeImage: `${REGISTRY_BASE}/agent-runtime-gemini`,
    envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    allowFqdns: ["generativelanguage.googleapis.com"],
  },
  acpx_local: {
    runtimeImage: `${REGISTRY_BASE}/agent-runtime-acpx`,
    envKeys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
    allowFqdns: ["api.anthropic.com", "api.openai.com"],
  },
  opencode_local: {
    runtimeImage: `${REGISTRY_BASE}/agent-runtime-opencode`,
    // opencode supports multiple LLM providers (Anthropic, OpenAI, Gemini,
    // xAI). driver.run() filters adapterEnv strictly to defaults.envKeys
    // before writing the per-Job Secret, so a key not listed here is
    // silently dropped — the pod then starts with no provider credentials
    // and fails at the authentication step. Mirror pi_local's broader
    // surface and include the matching FQDNs so the tenant NetworkPolicy
    // permits egress.
    envKeys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "XAI_API_KEY"],
    allowFqdns: [
      "api.anthropic.com",
      "api.openai.com",
      "generativelanguage.googleapis.com",
      "api.x.ai",
    ],
  },
  pi_local: {
    runtimeImage: `${REGISTRY_BASE}/agent-runtime-pi`,
    envKeys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "XAI_API_KEY"],
    allowFqdns: ["api.anthropic.com", "api.openai.com", "api.x.ai"],
  },
  hermes_local: {
    runtimeImage: `${REGISTRY_BASE}/agent-runtime-hermes`,
    // Empty defaults: no upstream npm binary identified yet. See
    // Dockerfile.hermes for the gap and the path forward.
    envKeys: [],
    allowFqdns: [],
  },
};

export function getAdapterDefaults(adapterType: string): AdapterDefaults {
  return (
    ADAPTER_DEFAULTS[adapterType] ?? {
      runtimeImage: `${REGISTRY_BASE}/agent-runtime-base`,
      envKeys: [],
      allowFqdns: [],
    }
  );
}
