import { SECRET_PROVIDERS, type SecretProvider } from "@valadrien-os/shared";

export function getConfiguredSecretProvider(): SecretProvider {
  const configuredProvider = process.env.VALADRIEN_OS_SECRETS_PROVIDER;
  return configuredProvider && SECRET_PROVIDERS.includes(configuredProvider as SecretProvider)
    ? configuredProvider as SecretProvider
    : "local_encrypted";
}
