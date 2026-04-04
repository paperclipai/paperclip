import * as p from "@clack/prompts";
import { t } from "../i18n/index.js";
import type { StorageConfig } from "../config/schema.js";
import { resolveDefaultStorageDir, resolvePaperclipInstanceId } from "../config/home.js";

function defaultStorageBaseDir(): string {
  return resolveDefaultStorageDir(resolvePaperclipInstanceId());
}

export function defaultStorageConfig(): StorageConfig {
  return {
    provider: "local_disk",
    localDisk: {
      baseDir: defaultStorageBaseDir(),
    },
    s3: {
      bucket: "paperclip",
      region: "us-east-1",
      endpoint: undefined,
      prefix: "",
      forcePathStyle: false,
    },
  };
}

export async function promptStorage(current?: StorageConfig): Promise<StorageConfig> {
  const base = current ?? defaultStorageConfig();

  const provider = await p.select({
    message: t("storage.provider_message"),
    options: [
      {
        value: "local_disk" as const,
        label: t("storage.local_disk_label"),
        hint: t("storage.local_disk_hint"),
      },
      {
        value: "s3" as const,
        label: t("storage.s3_label"),
        hint: t("storage.s3_hint"),
      },
    ],
    initialValue: base.provider,
  });

  if (p.isCancel(provider)) {
    p.cancel(t("storage.setup_cancelled"));
    process.exit(0);
  }

  if (provider === "local_disk") {
    const baseDir = await p.text({
      message: t("storage.base_dir_message"),
      defaultValue: base.localDisk.baseDir || defaultStorageBaseDir(),
      placeholder: defaultStorageBaseDir(),
      validate: (value) => {
        if (!value || value.trim().length === 0) return t("storage.base_dir_required");
      },
    });

    if (p.isCancel(baseDir)) {
      p.cancel(t("storage.setup_cancelled"));
      process.exit(0);
    }

    return {
      provider: "local_disk",
      localDisk: {
        baseDir: baseDir.trim(),
      },
      s3: base.s3,
    };
  }

  const bucket = await p.text({
    message: t("storage.bucket_message"),
    defaultValue: base.s3.bucket || "paperclip",
    placeholder: "paperclip",
    validate: (value) => {
      if (!value || value.trim().length === 0) return t("storage.bucket_required");
    },
  });

  if (p.isCancel(bucket)) {
    p.cancel(t("storage.setup_cancelled"));
    process.exit(0);
  }

  const region = await p.text({
    message: t("storage.region_message"),
    defaultValue: base.s3.region || "us-east-1",
    placeholder: "us-east-1",
    validate: (value) => {
      if (!value || value.trim().length === 0) return t("storage.region_required");
    },
  });

  if (p.isCancel(region)) {
    p.cancel(t("storage.setup_cancelled"));
    process.exit(0);
  }

  const endpoint = await p.text({
    message: t("storage.endpoint_message"),
    defaultValue: base.s3.endpoint ?? "",
    placeholder: "https://s3.amazonaws.com",
  });

  if (p.isCancel(endpoint)) {
    p.cancel(t("storage.setup_cancelled"));
    process.exit(0);
  }

  const prefix = await p.text({
    message: t("storage.prefix_message"),
    defaultValue: base.s3.prefix ?? "",
    placeholder: "paperclip/",
  });

  if (p.isCancel(prefix)) {
    p.cancel(t("storage.setup_cancelled"));
    process.exit(0);
  }

  const forcePathStyle = await p.confirm({
    message: t("storage.path_style_message"),
    initialValue: base.s3.forcePathStyle ?? false,
  });

  if (p.isCancel(forcePathStyle)) {
    p.cancel(t("storage.setup_cancelled"));
    process.exit(0);
  }

  return {
    provider: "s3",
    localDisk: base.localDisk,
    s3: {
      bucket: bucket.trim(),
      region: region.trim(),
      endpoint: endpoint.trim() || undefined,
      prefix: prefix.trim(),
      forcePathStyle,
    },
  };
}
