import { unprocessable } from "../errors.js";
import type { SecretProviderModule } from "./types.js";

function unavailableProvider(
  id: "aws_secrets_manager" | "gcp_secret_manager",
  label: string,
): SecretProviderModule {
  return {
    id,
    descriptor: {
      id,
      label,
      requiresExternalRef: true,
    },
    async createVersion() {
      throw unprocessable(`${id} provider is not configured in this deployment`);
    },
    async resolveVersion() {
      throw unprocessable(`${id} provider is not configured in this deployment`);
    },
  };
}

export const awsSecretsManagerProvider = unavailableProvider(
  "aws_secrets_manager",
  "AWS Secrets Manager",
);
export const gcpSecretManagerProvider = unavailableProvider(
  "gcp_secret_manager",
  "GCP Secret Manager",
);
