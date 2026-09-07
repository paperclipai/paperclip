import { secretsApi } from "../api/secrets";

export const PROVIDER_ENV_KEYS: Record<string, string> = {
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
  xai: "XAI_API_KEY",
  groq: "GROQ_API_KEY",
  opencode: "OPENCODE_API_KEY",
};

/** Store only through the secret API; agent configs and revisions get references. */
export async function storeProviderApiKey(
  companyId: string,
  envKey: string,
  value: string,
) {
  let entries = await secretsApi.listMyUserSecrets(companyId);
  let existing = entries.find((entry) => entry.definition.key === envKey);
  let definitionId = existing?.definition.id;
  if (!definitionId) {
    try {
      definitionId = (
        await secretsApi.createUserSecretDefinition(companyId, {
          key: envKey,
          name: envKey,
          description: "Model provider credential.",
        })
      ).id;
    } catch (error) {
      // Another setup tab may have created the same definition in the meantime.
      entries = await secretsApi.listMyUserSecrets(companyId);
      existing = entries.find((entry) => entry.definition.key === envKey);
      definitionId = existing?.definition.id;
      if (!definitionId) throw error;
    }
  }
  if (existing?.secret)
    await secretsApi.rotateMyUserSecret(companyId, existing.secret.id, {
      value: value.trim(),
    });
  else
    await secretsApi.createMyUserSecret(companyId, {
      definitionId,
      definitionKey: envKey,
      value: value.trim(),
    });
  return {
    type: "user_secret_ref" as const,
    key: envKey,
    version: "latest" as const,
  };
}
