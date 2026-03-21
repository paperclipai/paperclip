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
    message: "密钥管理提供商",
    options: [
      {
        value: "local_encrypted" as const,
        label: "本地加密（推荐）",
        hint: "适合单开发者安装",
      },
      {
        value: "aws_secrets_manager" as const,
        label: "AWS Secrets Manager",
        hint: "需要外部适配器集成",
      },
      {
        value: "gcp_secret_manager" as const,
        label: "GCP Secret Manager",
        hint: "需要外部适配器集成",
      },
      {
        value: "vault" as const,
        label: "HashiCorp Vault",
        hint: "需要外部适配器集成",
      },
    ],
    initialValue: base.provider,
  });

  if (p.isCancel(provider)) {
    p.cancel("设置已取消。");
    process.exit(0);
  }

  const strictMode = await p.confirm({
    message: "是否要求敏感环境变量使用密钥引用？",
    initialValue: base.strictMode,
  });

  if (p.isCancel(strictMode)) {
    p.cancel("设置已取消。");
    process.exit(0);
  }

  const fallbackDefault = defaultKeyFilePath();
  let keyFilePath = base.localEncrypted.keyFilePath || fallbackDefault;
  if (provider === "local_encrypted") {
    const keyPath = await p.text({
      message: "本地加密密钥文件路径",
      defaultValue: keyFilePath,
      placeholder: fallbackDefault,
      validate: (value) => {
        if (!value || value.trim().length === 0) return "密钥文件路径为必填项";
      },
    });

    if (p.isCancel(keyPath)) {
      p.cancel("设置已取消。");
      process.exit(0);
    }
    keyFilePath = keyPath.trim();
  }

  if (provider !== "local_encrypted") {
    p.note(
      `${provider} 在当前版本中尚未完全集成。除非你正在实现该适配器，否则请继续使用 local_encrypted。`,
      "注意",
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
