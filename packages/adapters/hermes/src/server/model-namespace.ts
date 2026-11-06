/**
 * Model id namespace validation for the Hermes adapter.
 *
 * A model id such as "openrouter/gpt-4.1-mini" states the provider
 * explicitly. Pairing it with a different provider (or with another vendor's
 * base URL) sends the request to the wrong endpoint and fails as an opaque
 * provider error at run time, so the mismatch is rejected when the agent
 * config is saved.
 */

import { MODEL_NAMESPACE_PROVIDER_HINTS } from "../shared/constants.js";

export interface HermesModelNamespaceHint {
  namespace: string;
  providers: string[];
  hostTokens: string[];
}

export interface HermesModelNamespaceValidation {
  ok: boolean;
  /** Human readable reason, present only when ok is false. */
  reason?: string;
}

/**
 * Extract the namespace (first path segment) of a model id.
 * Returns null for a bare model name ("gpt-4.1-mini").
 */
export function modelNamespaceOf(model: string): string | null {
  const trimmed = model.trim().toLowerCase();
  const slash = trimmed.indexOf("/");
  if (slash <= 0) return null;
  const namespace = trimmed.slice(0, slash);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(namespace)) return null;
  return namespace;
}

/**
 * Find the exclusive provider hint for a model id namespace.
 * Returns null when the namespace is unknown or ambiguous.
 */
export function findModelNamespaceHint(model: string): HermesModelNamespaceHint | null {
  const namespace = modelNamespaceOf(model);
  if (!namespace) return null;
  const hint = MODEL_NAMESPACE_PROVIDER_HINTS.find((entry) => entry.namespace === namespace);
  return hint ? { ...hint } : null;
}

/**
 * Validate that a model id agrees with the configured provider and base URL.
 *
 * - A concrete provider that is not the namespace's provider is rejected.
 * - Provider "auto" is not a conflict: it means "not decided yet".
 * - A base URL that belongs to another vendor is rejected.
 */
export function validateHermesModelProviderAlignment(input: {
  model?: string | null;
  provider?: string | null;
  baseUrl?: string | null;
}): HermesModelNamespaceValidation {
  const model = (input.model ?? "").trim();
  if (!model) return { ok: true };

  const hint = findModelNamespaceHint(model);
  if (!hint) return { ok: true };

  const provider = (input.provider ?? "").trim().toLowerCase();
  if (provider && provider !== "auto" && !hint.providers.includes(provider)) {
    return {
      ok: false,
      reason:
        `Model "${model}" names the "${hint.namespace}" provider namespace, but `
        + `adapterConfig.provider is "${provider}". Use provider `
        + `"${hint.providers[0]}" or remove the provider so Paperclip resolves it `
        + `from the model id.`,
    };
  }

  const baseUrl = (input.baseUrl ?? "").trim();
  if (baseUrl) {
    let hostname = "";
    try {
      hostname = new URL(baseUrl).hostname.toLowerCase();
    } catch {
      hostname = "";
    }
    if (hostname && !hint.hostTokens.some((token) => hostname.includes(token))) {
      return {
        ok: false,
        reason:
          `Model "${model}" names the "${hint.namespace}" provider namespace, but `
          + `the configured base URL "${baseUrl}" points at another provider. `
          + `Use a "${hint.namespace}" base URL or change the model.`,
      };
    }
  }

  return { ok: true };
}
