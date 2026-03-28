import fs from "node:fs";
import type { PaperclipConfig } from "../config/schema.js";
import type { CheckResult } from "./index.js";
import { resolveRuntimeLikePath } from "./path-resolver.js";

export function storageCheck(config: PaperclipConfig, configPath?: string): CheckResult {
  if (config.storage.provider === "local_disk") {
    const baseDir = resolveRuntimeLikePath(config.storage.localDisk.baseDir, configPath);
    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true });
    }

    try {
      fs.accessSync(baseDir, fs.constants.W_OK);
      return {
        name: "Storage",
        status: "pass",
        message: `Local disk storage is writable: ${baseDir}`,
      };
    } catch {
      return {
        name: "Storage",
        status: "fail",
        message: `Local storage directory is not writable: ${baseDir}`,
        canRepair: false,
        repairHint: "Check file permissions for storage.localDisk.baseDir",
      };
    }
  }

  if (config.storage.provider === "vercel_blob") {
    const token =
      config.storage.vercelBlob?.token?.trim() ||
      process.env.PAPERCLIP_STORAGE_VERCEL_BLOB_TOKEN?.trim() ||
      "";
    if (!token) {
      return {
        name: "Storage",
        status: "fail",
        message: "Vercel Blob storage requires storage.vercelBlob.token or PAPERCLIP_STORAGE_VERCEL_BLOB_TOKEN",
        canRepair: false,
        repairHint: "Set storage.vercelBlob.token in config or PAPERCLIP_STORAGE_VERCEL_BLOB_TOKEN in .env",
      };
    }

    return {
      name: "Storage",
      status: "warn",
      message: "Vercel Blob configured (token present). Reachability check is skipped in doctor.",
      canRepair: false,
      repairHint: "Verify storage.vercelBlob.token or PAPERCLIP_STORAGE_VERCEL_BLOB_TOKEN in the deployment environment",
    };
  }

  const bucket = config.storage.s3.bucket.trim();
  const region = config.storage.s3.region.trim();
  if (!bucket || !region) {
    return {
      name: "Storage",
      status: "fail",
      message: "S3 storage requires non-empty bucket and region",
      canRepair: false,
      repairHint: "Run `paperclipai configure --section storage`",
    };
  }

  return {
    name: "Storage",
    status: "warn",
    message: `S3 storage configured (bucket=${bucket}, region=${region}). Reachability check is skipped in doctor.`,
    canRepair: false,
    repairHint: "Verify credentials and endpoint in deployment environment",
  };
}
