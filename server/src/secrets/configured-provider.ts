import { SECRET_PROVIDERS, type SecretProvider } from "@odysseus/shared";

export function getConfiguredSecretProvider(): SecretProvider {
  const configuredProvider = process.env.ODYSSEUS_SECRETS_PROVIDER;
  return configuredProvider && SECRET_PROVIDERS.includes(configuredProvider as SecretProvider)
    ? configuredProvider as SecretProvider
    : "local_encrypted";
}
