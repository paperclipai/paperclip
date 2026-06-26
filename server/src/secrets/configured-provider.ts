import { SECRET_STORAGE_PROVIDERS, type SecretStorageProvider } from "@paperclipai/shared";

export function getConfiguredSecretProvider(): SecretStorageProvider {
  const configuredProvider = process.env.PAPERCLIP_SECRETS_PROVIDER;
  return configuredProvider && SECRET_STORAGE_PROVIDERS.includes(configuredProvider as SecretStorageProvider)
    ? configuredProvider as SecretStorageProvider
    : "local_encrypted";
}
