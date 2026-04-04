import * as p from "@clack/prompts";
import { t } from "../i18n/index.js";
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
    message: t("secrets.provider_message"),
    options: [
      {
        value: "local_encrypted" as const,
        label: t("secrets.local_encrypted_label"),
        hint: t("secrets.local_encrypted_hint"),
      },
      {
        value: "aws_secrets_manager" as const,
        label: t("secrets.aws_label"),
        hint: t("secrets.aws_hint"),
      },
      {
        value: "gcp_secret_manager" as const,
        label: t("secrets.gcp_label"),
        hint: t("secrets.gcp_hint"),
      },
      {
        value: "vault" as const,
        label: t("secrets.vault_label"),
        hint: t("secrets.vault_hint"),
      },
    ],
    initialValue: base.provider,
  });

  if (p.isCancel(provider)) {
    p.cancel(t("secrets.setup_cancelled"));
    process.exit(0);
  }

  const strictMode = await p.confirm({
    message: t("secrets.strict_mode_message"),
    initialValue: base.strictMode,
  });

  if (p.isCancel(strictMode)) {
    p.cancel(t("secrets.setup_cancelled"));
    process.exit(0);
  }

  const fallbackDefault = defaultKeyFilePath();
  let keyFilePath = base.localEncrypted.keyFilePath || fallbackDefault;
  if (provider === "local_encrypted") {
    const keyPath = await p.text({
      message: t("secrets.key_file_message"),
      defaultValue: keyFilePath,
      placeholder: fallbackDefault,
      validate: (value) => {
        if (!value || value.trim().length === 0) return t("secrets.key_file_required");
      },
    });

    if (p.isCancel(keyPath)) {
      p.cancel(t("secrets.setup_cancelled"));
      process.exit(0);
    }
    keyFilePath = keyPath.trim();
  }

  if (provider !== "local_encrypted") {
    p.note(
      t("secrets.provider_not_wired", { provider }),
      t("secrets.heads_up"),
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
