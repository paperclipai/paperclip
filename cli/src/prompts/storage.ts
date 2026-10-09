import * as p from "@clack/prompts";
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
    message: "Storage provider",
    options: [
      {
        value: "local_disk" as const,
        label: "Local disk (recommended)",
        hint: "best for single-user local deployments",
      },
      {
        value: "s3" as const,
        label: "S3 compatible",
        hint: "for cloud/object storage backends",
      },
    ],
    initialValue: base.provider,
  });

  if (p.isCancel(provider)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  if (provider === "local_disk") {
    const baseDirDefault = base.localDisk.baseDir || defaultStorageBaseDir();
    const baseDir = await p.text({
      message: "Local storage base directory",
      defaultValue: baseDirDefault,
      placeholder: defaultStorageBaseDir(),
      validate: (value) => {
        // Clack validates the raw input before applying defaultValue —
        // validate the value that will actually be submitted.
        if ((value || baseDirDefault).trim().length === 0) return "Storage base directory is required";
      },
    });

    if (p.isCancel(baseDir)) {
      p.cancel("Setup cancelled.");
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

  const bucketDefault = base.s3.bucket || "paperclip";
  const regionDefault = base.s3.region || "us-east-1";
  const bucket = await p.text({
    message: "S3 bucket",
    defaultValue: bucketDefault,
    placeholder: "paperclip",
    validate: (value) => {
      if ((value || bucketDefault).trim().length === 0) return "Bucket is required";
    },
  });

  if (p.isCancel(bucket)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const region = await p.text({
    message: "S3 region",
    defaultValue: regionDefault,
    placeholder: "us-east-1",
    validate: (value) => {
      if ((value || regionDefault).trim().length === 0) return "Region is required";
    },
  });

  if (p.isCancel(region)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const endpoint = await p.text({
    message: "S3 endpoint (optional for compatible backends)",
    defaultValue: base.s3.endpoint ?? "",
    placeholder: "https://s3.amazonaws.com",
  });

  if (p.isCancel(endpoint)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const prefix = await p.text({
    message: "Object key prefix (optional)",
    defaultValue: base.s3.prefix ?? "",
    placeholder: "paperclip/",
  });

  if (p.isCancel(prefix)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const forcePathStyle = await p.confirm({
    message: "Use S3 path-style URLs?",
    initialValue: base.s3.forcePathStyle ?? false,
  });

  if (p.isCancel(forcePathStyle)) {
    p.cancel("Setup cancelled.");
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

