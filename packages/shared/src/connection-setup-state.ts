import {
  connectionMethodAcceptsCustomerOAuthClient,
  connectionMethodRequiresConfiguration,
  connectionMethodSupportsAutomaticOAuth,
  getAvailableConnectionMethods,
  getRecommendedConnectionMethod,
} from "./app-definitions.js";
import type { AppDefinition, ConnectionMethodDef } from "./types/app-definition.js";

/**
 * The four states every connect screen lands in (PAP-659, "one shell, four
 * states").
 *
 * The point of naming them here rather than in the wizard is that two surfaces
 * have to agree: the gallery card decides its verb from the state, and the
 * connect screen decides its body from the same state. When each re-derived it
 * from raw method flags they drifted — a card offering "Connect" for something
 * that then demanded a pasted URL is exactly the inconsistency the ticket is
 * about.
 *
 * - `instant`   nothing to supply: connect resolves entirely from the catalog.
 * - `authorize` one click, then the provider's own consent screen.
 * - `paste`     one thing the operator has to bring: a key, a URL, a tenant.
 * - `register`  the provider cannot issue a client, so one must be registered
 *               in its console first. A recovery state, never a normal step.
 */
export type ConnectionSetupState = "instant" | "authorize" | "paste" | "register";

/**
 * True when the catalog already knows the endpoint. A `serverUrlTemplate` does
 * not count: its placeholders are the operator's to fill, which is a paste.
 */
function hasResolvedEndpoint(method: ConnectionMethodDef): boolean {
  if (method.transport !== "mcp_remote") return true;
  if (method.defaults?.serverUrlTemplate) return false;
  return Boolean(method.defaults?.serverUrl);
}

export function connectionSetupStateForMethod(
  method: ConnectionMethodDef | null | undefined,
): ConnectionSetupState | null {
  if (!method) return null;
  if (method.auth === "oauth") {
    // An AI subscription signs in through the adapter's own device/OAuth flow.
    // No client is ever registered, so `register` would be a false detour.
    if (method.transport === "runtime_auth") return "authorize";
    if (connectionMethodSupportsAutomaticOAuth(method)) return "authorize";
    // A customer-owned client is only a *register* state when the provider
    // offers nothing better. Live discovery can still overrule the catalog at
    // connect time, which is why the flow re-resolves rather than trusting this.
    if (connectionMethodAcceptsCustomerOAuthClient(method)) return "register";
    return "authorize";
  }
  if (method.auth === "none") {
    return connectionMethodRequiresConfiguration(method) || !hasResolvedEndpoint(method)
      ? "paste"
      : "instant";
  }
  return "paste";
}

/**
 * The default tool method for an app, or null.
 *
 * Gallery rows are not guaranteed to carry a method list: the display entry is
 * assembled from several sources, and a row can stand for a connection whose
 * catalog entry has since been withdrawn. Resolving that to null — rather than
 * throwing inside a card render — is the difference between a missing verb and
 * a blank connectors page.
 */
function defaultToolMethod(
  app: AppDefinition | null | undefined,
  methodKey?: string | null,
): ConnectionMethodDef | null {
  if (!app || !Array.isArray(app.methods)) return null;
  const methods = getAvailableConnectionMethods(app).filter(
    (method) => (method.purpose ?? "tool") !== "channel",
  );
  return methodKey
    ? methods.find((candidate) => candidate.key === methodKey) ?? null
    : getRecommendedConnectionMethod(methods);
}

export function connectionSetupStateForApp(
  app: AppDefinition | null | undefined,
  methodKey?: string | null,
): ConnectionSetupState | null {
  return connectionSetupStateForMethod(defaultToolMethod(app, methodKey));
}

/**
 * The gallery card's verb (PAP-659 C4).
 *
 * Only a method that genuinely wants a secret says so. "Add key" on a connector
 * that actually wants a pasted URL would be worse than the generic verb, so a
 * paste state without credential fields keeps "Connect" — the operator still
 * lands on one screen with one field, which the verb does not need to restate.
 */
export function connectionSetupVerbForMethod(
  method: ConnectionMethodDef | null | undefined,
): "Connect" | "Add key" {
  if (!method) return "Connect";
  const wantsSecret = (method.credentialFields?.length ?? 0) > 0;
  return connectionSetupStateForMethod(method) === "paste" && wantsSecret ? "Add key" : "Connect";
}

export function connectionSetupVerbForApp(
  app: AppDefinition | null | undefined,
  methodKey?: string | null,
): "Connect" | "Add key" {
  return connectionSetupVerbForMethod(defaultToolMethod(app, methodKey));
}
