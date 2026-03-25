import * as p from "@clack/prompts";
import type { SecretProvider } from "@paperclipai/shared";
import type { SecretsConfig } from "../config/schema.js";
import { resolveDefaultSecretsKeyFilePath, resolvePaperclipInstanceId } from "../config/home.js";

function defaultKeyFilePath(): string {
  return resolveDefaultSecretsKeyFilePath(resolvePaperclipInstanceId());
}

export function defaultSecretsConfig(): SecretsConfig {
  const keyFilePath = defaultKeyFilePath();
  return {
    provider: "local_encrypted",
    strictMode: false,
    localEncrypted: {
      keyFilePath,
    },
  };
}

export async function promptSecrets(current?: SecretsConfig): Promise<SecretsConfig> {
  const base = current ?? defaultSecretsConfig();

  const provider = await p.select({
    message: "Secrets provider",
    options: [
      {
        value: "local_encrypted" as const,
        label: "Local encrypted (recommended)",
        hint: "best for single-developer installs",
      },
      {
        value: "aws_secrets_manager" as const,
        label: "AWS Secrets Manager",
        hint: "requires external adapter integration",
      },
      {
        value: "gcp_secret_manager" as const,
        label: "GCP Secret Manager",
        hint: "requires external adapter integration",
      },
      {
        value: "vault" as const,
        label: "HashiCorp Vault",
        hint: "requires external adapter integration",
      },
    ],
    initialValue: base.provider,
  });

  if (p.isCancel(provider)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const strictMode = await p.confirm({
    message: "Require secret refs for sensitive env vars?",
    initialValue: base.strictMode,
  });

  if (p.isCancel(strictMode)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const fallbackDefault = defaultKeyFilePath();
  let keyFilePath = base.localEncrypted.keyFilePath || fallbackDefault;
  if (provider === "local_encrypted") {
    const keyPath = await p.text({
      message: "Local encrypted key file path",
      defaultValue: keyFilePath,
      placeholder: fallbackDefault,
      validate: (value) => {
        if (!value || value.trim().length === 0) return "Key file path is required";
      },
    });

    if (p.isCancel(keyPath)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }
    keyFilePath = keyPath.trim();
  }

  if (provider !== "local_encrypted") {
    p.note(
      `${provider} is not fully wired in this build yet. Keep local_encrypted unless you are actively implementing that adapter.`,
      "Heads up",
    );
  }

  return {
    provider: provider as SecretProvider,
    strictMode,
    localEncrypted: {
      keyFilePath,
    },
  };
}
