/** Finite authoring contract for the actual remote/runtime scenario consumers.
 * Metadata is private prerequisite context, never proof of a qualified target. */
export const runtimePrivateRequirements = {
  "execution-environments.prepare-image": { provider: "daytona", fields: ["imageDigest", "imageRef", "region", "disposableNamespace", "toolsManifest"], credentials: ["DAYTONA_API_KEY"] },
  "execution-environments.assign-computer": { provider: "daytona", fields: ["imageDigest", "imageRef", "region", "disposableNamespace", "qualifiedHarness"], credentials: ["DAYTONA_API_KEY"] },
  "recovery.workspace-repair": { provider: "daytona", fields: ["imageDigest", "imageRef", "region", "disposableNamespace", "qualifiedHarness"], credentials: ["DAYTONA_API_KEY"] },
  "workspaces.recover-lost-sandbox": { provider: "daytona", fields: ["imageDigest", "imageRef", "region", "disposableNamespace", "qualifiedHarness"], credentials: ["DAYTONA_API_KEY"] },
  "agents.ambiguous-cloud-code": { provider: "daytona", fields: ["imageDigest", "imageRef", "region", "disposableNamespace", "qualifiedHarness"], credentials: ["ANTHROPIC_API_KEY", "DAYTONA_API_KEY"] },
  "execution-environments.add-computer": { provider: "ssh", fields: ["hostname", "port", "login", "hostKeySha256", "knownHosts", "allowedRemoteRoot", "privateKeyEnv", "qualifiedHarness"], credentials: [] },
  "execution-environments.test-computer": { provider: "ssh", fields: ["hostname", "port", "login", "hostKeySha256", "knownHosts", "allowedRemoteRoot", "privateKeyEnv", "qualifiedHarness"], credentials: [] },
  "assistant-connections.connect-external-assistant": { provider: "chatgpt", fields: ["operatorRef", "chatgptAuthorizationRef", "operatorMode"], credentials: [] },
  "agents.existing-grok-bot": { provider: "grok", fields: ["botId", "endpoint", "challengeMethod", "credentialEnvName", "operatorRef", "botAuthorizationRef", "operatorMode"], credentials: [] },
  "agents.hire-claude-code": { provider: "claude", fields: ["targetRef", "harnessExecutable", "model", "accountBindingRef"], credentials: ["ANTHROPIC_API_KEY"] },
  "agents.hire-needs-account": { provider: "claude", fields: ["targetRef", "harnessExecutable", "model", "accountBindingRef"], credentials: ["ANTHROPIC_API_KEY"] },
  "runs-adapters.validate-hire": { provider: "claude", fields: ["targetRef", "harnessExecutable", "model", "accountBindingRef"], credentials: ["ANTHROPIC_API_KEY"] },
  "runs-adapters.upgrade-runner": { provider: "claude", fields: ["targetRef", "harnessExecutable", "model", "accountBindingRef", "legacySettingsRef"], credentials: ["ANTHROPIC_API_KEY"] },
} as const;
export type RuntimePrivateProvider = typeof runtimePrivateRequirements[keyof typeof runtimePrivateRequirements]["provider"];
export const runtimePrivateProviders: readonly string[] = ["daytona", "ssh", "grok", "claude", "chatgpt"];
export function validateRuntimePrivateRequirement(scenarioId: string | undefined, provider: string, fields: readonly string[], credentials: readonly string[]) {
  if (!runtimePrivateProviders.includes(provider)) return false;
  const spec = runtimePrivateRequirements[scenarioId as keyof typeof runtimePrivateRequirements];
  const same = (a: readonly string[], b: readonly string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  if (!spec || spec.provider !== provider || !same(fields, spec.fields) || !same(credentials, spec.credentials))
    throw new Error("Runtime private inputs require the exact selected canonical case, fields and credential names");
  return true;
}
export function runtimePrivateReferenceNames(provider: string): readonly string[] {
  return provider === "ssh" ? ["PAPERCLIP_CHAT_EVAL_SSH_PRIVATE_KEY"] : provider === "grok" ? ["PAPERCLIP_CHAT_EVAL_GROK_BOT_TOKEN"] : [];
}
