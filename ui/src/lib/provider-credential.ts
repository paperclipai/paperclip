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

/** Store an isolated setup credential. Never rotate a key used by other agents,
 * including when a later connection test fails or the user leaves the wizard. */
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
  await secretsApi.createMyUserSecret(companyId, {
    definitionId: definition.id,
    definitionKey: key,
    value: value.trim(),
  });
  return {
    type: "user_secret_ref" as const,
    key,
    version: "latest" as const,
  };
}
