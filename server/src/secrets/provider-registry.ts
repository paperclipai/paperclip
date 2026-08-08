import type { SecretProvider, SecretProviderDescriptor } from "@paperclipai/shared";
import { awsSecretsManagerProvider } from "./aws-secrets-manager-provider.js";
import { localEncryptedProvider } from "./local-encrypted-provider.js";
import {
  gcpSecretManagerProvider,
  vaultProvider,
} from "./external-stub-providers.js";
import type { SecretProviderHealthCheck, SecretProviderModule } from "./types.js";
import { unprocessable } from "../errors.js";

const providers: SecretProviderModule[] = [
  localEncryptedProvider,
  awsSecretsManagerProvider,
  gcpSecretManagerProvider,
  vaultProvider,
];

const providerById = new Map<SecretProvider, SecretProviderModule>(
  providers.map((provider) => [provider.id, provider]),
);

export function getSecretProvider(id: SecretProvider): SecretProviderModule {
  const provider = providerById.get(id);
  if (!provider) throw unprocessable(`Unsupported secret provider: ${id}`);
  return provider;
}

export function listSecretProviders(): SecretProviderDescriptor[] {
  return providers.map((provider) => provider.descriptor());
}

export async function checkSecretProviders(): Promise<SecretProviderHealthCheck[]> {
  return Promise.all(providers.map((provider) => provider.healthCheck()));
}
