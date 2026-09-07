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

/** Store a validated key during agent creation without rotating other agents’
 * credentials. The caller removes this definition if creation fails. */
export async function storeProviderApiKey(
  companyId: string,
  envKey: string,
  value: string,
) {
  const key = `${envKey}.setup.${crypto.randomUUID()}`;
  const definition = await secretsApi.createUserSecretDefinition(companyId, {
    key,
    name: `${envKey} · agent setup`,
    description: "Model provider credential for a new agent setup.",
  });
  const remove = () => secretsApi.removeUserSecretDefinition(companyId, definition.id);
  try {
    await secretsApi.createMyUserSecret(companyId, {
      definitionId: definition.id,
      definitionKey: key,
      value: value.trim(),
    });
  } catch (error) {
    await remove();
    throw error;
  }
  return {
    binding: { type: "user_secret_ref" as const, key, version: "latest" as const },
    remove,
  };
}
