import { isDeepStrictEqual } from "node:util";
import type { AiConnectionBinding } from "@paperclipai/shared";

type ConfigRevision = {
  id: string;
  changedKeys: string[];
  createdAt: Date;
  beforeConfig: Record<string, unknown>;
  afterConfig: Record<string, unknown>;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function managedAiSessionIdentityCompatible(
  stored: unknown,
  sessionIdentity: string,
  credentialIdentity: string,
): boolean {
  // Legacy token identities can migrate only before any manual replacement.
  // Replacing even the same credential bytes increments the epoch.
  return stored === sessionIdentity || (sessionIdentity.endsWith(":0") && stored === credentialIdentity);
}

export function aiConnectionOnlyConfigRevision(revision: ConfigRevision): boolean {
  const withoutBinding = (snapshot: Record<string, unknown>) => {
    const runtimeConfig = { ...record(snapshot.runtimeConfig) };
    delete runtimeConfig.aiConnection;
    return { ...snapshot, runtimeConfig };
  };
  return !isDeepStrictEqual(record(revision.beforeConfig.runtimeConfig).aiConnection, record(revision.afterConfig.runtimeConfig).aiConnection)
    && isDeepStrictEqual(withoutBinding(revision.beforeConfig), withoutBinding(revision.afterConfig));
}

export function aiConnectionRevisionMetadata(revision: ConfigRevision | undefined) {
  return revision ? { id: revision.id, changedKeys: revision.changedKeys, configRevisionAt: revision.createdAt.toISOString() } : null;
}

/** Exact alternative fingerprints, never a category-level exemption. The caller
 * has already authorized the selected account and prepared its credential. */
export function aiConnectionSessionCompatibilityInputs(input: {
  effectiveAdapterConfig: Record<string, unknown>;
  agentRuntimeConfig: unknown;
  agentConfigRevision: unknown;
  issueOverrides: unknown;
  originalIssueOverrides: unknown;
  binding: AiConnectionBinding;
  router: boolean;
  storedIdentity: unknown;
  sessionIdentity: string;
  credentialIdentity: string;
  revisions: readonly ConfigRevision[];
}) {
  if (!managedAiSessionIdentityCompatible(input.storedIdentity, input.sessionIdentity, input.credentialIdentity)) return [];
  const configs = [input.effectiveAdapterConfig];
  if (input.storedIdentity === input.credentialIdentity && input.sessionIdentity.endsWith(":0")) {
    const managed = { ...record(input.effectiveAdapterConfig.managedAiConnection) };
    delete managed.sessionIdentity;
    managed.identity = input.credentialIdentity;
    configs.push({ ...input.effectiveAdapterConfig, managedAiConnection: managed });
  }
  const variants = [{ agentRuntimeConfig: input.agentRuntimeConfig, agentConfigRevision: input.agentConfigRevision }];
  if (input.router) {
    // Also support bindings saved before revision history was introduced, and
    // responsible-user defaults that resolve to this same authorized grant.
    const bindings = [input.binding, ...("grantId" in input.binding ? [
      { ...input.binding, mode: "shared" }, { ...input.binding, mode: "delegated" },
    ] : []), ...(["subscription", "api_key"] as const).map(method => ({ mode: "responsible_user", provider: input.binding.provider, method }))];
    for (const binding of bindings) {
      variants.push({ agentRuntimeConfig: { ...record(input.agentRuntimeConfig), aiConnection: binding }, agentConfigRevision: input.agentConfigRevision });
    }
    let expectedRuntimeConfig = record(input.agentRuntimeConfig);
    for (let index = 0; index < Math.min(20, input.revisions.length); index++) {
      const revision = input.revisions[index]!;
      if (index === 0 && revision.id !== record(input.agentConfigRevision).id) break;
      if (!isDeepStrictEqual(record(revision.afterConfig.runtimeConfig), expectedRuntimeConfig)) break;
      if (!aiConnectionOnlyConfigRevision(revision)) break;
      // An incomplete bounded history is not sufficient to waive a revision.
      const previous = input.revisions[index + 1];
      if (!previous && input.revisions.length >= 21) break;
      variants.push({ agentRuntimeConfig: record(revision.beforeConfig.runtimeConfig), agentConfigRevision: aiConnectionRevisionMetadata(previous) });
      expectedRuntimeConfig = record(revision.beforeConfig.runtimeConfig);
    }
  }
  const overrides = input.router && !isDeepStrictEqual(input.issueOverrides, input.originalIssueOverrides)
    ? [input.issueOverrides, input.originalIssueOverrides] : [input.issueOverrides];
  return variants.flatMap(variant => {
    const previousMode = record(record(variant.agentRuntimeConfig).aiConnection).mode;
    const modes = input.router
      ? ["responsible_user", "shared", "delegated"].includes(String(previousMode))
        ? [previousMode] : ["responsible_user", "shared", "delegated"]
      : [record(input.effectiveAdapterConfig.managedAiConnection).mode];
    return configs.flatMap(config => modes.flatMap(mode => overrides.map(issueOverrides => ({
      ...variant,
      // Binding mode is also recorded in the managed account attribution.
      // Keep grant, user, credential epoch, and every other setting unchanged.
      effectiveAdapterConfig: { ...config, managedAiConnection: { ...record(config.managedAiConnection), mode } },
      issueOverrides,
    }))));
  });
}
