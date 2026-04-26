import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PaperclipConfig } from "../config/schema.js";
import { storageCheck } from "./storage-check.js";

function makeLocalDiskConfig(baseDir: string): PaperclipConfig {
  return {
    storage: {
      provider: "local_disk",
      localDisk: { baseDir },
    },
  } as unknown as PaperclipConfig;
}

function makeS3Config(bucket: string, region: string): PaperclipConfig {
  return {
    storage: {
      provider: "s3",
      s3: { bucket, region },
    },
  } as unknown as PaperclipConfig;
}

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-check-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

// ============================================================================
// storageCheck — local_disk, writable directory
// ============================================================================

describe("storageCheck — local_disk writable", () => {
  it("returns pass when the storage directory is writable", () => {
    const baseDir = makeTempDir();
    const result = storageCheck(makeLocalDiskConfig(baseDir));
    expect(result.status).toBe("pass");
  });

  it("sets name to 'Storage'", () => {
    const baseDir = makeTempDir();
    const result = storageCheck(makeLocalDiskConfig(baseDir));
    expect(result.name).toBe("Storage");
  });

  it("includes the directory in the pass message", () => {
    const baseDir = makeTempDir();
    const result = storageCheck(makeLocalDiskConfig(baseDir));
    expect(result.message).toContain(baseDir);
  });
});

// ============================================================================
// storageCheck — local_disk, non-existent directory (created by check)
// ============================================================================

describe("storageCheck — local_disk creates missing directory", () => {
  it("creates the directory if it does not exist", () => {
    const parent = makeTempDir();
    const baseDir = path.join(parent, "new-storage");
    storageCheck(makeLocalDiskConfig(baseDir));
    expect(fs.existsSync(baseDir)).toBe(true);
  });

  it("returns pass after creating the directory", () => {
    const parent = makeTempDir();
    const baseDir = path.join(parent, "new-storage-2");
    const result = storageCheck(makeLocalDiskConfig(baseDir));
    expect(result.status).toBe("pass");
  });
});

// ============================================================================
// storageCheck — local_disk, non-writable directory
// ============================================================================

describe("storageCheck — local_disk non-writable", () => {
  it("returns fail when the directory is not writable", () => {
    const parent = makeTempDir();
    const baseDir = path.join(parent, "readonly-storage");
    fs.mkdirSync(baseDir);
    fs.chmodSync(baseDir, 0o555);

    let result;
    try {
      result = storageCheck(makeLocalDiskConfig(baseDir));
    } finally {
      fs.chmodSync(baseDir, 0o755);
    }

    expect(result.status).toBe("fail");
  });

  it("fail message includes the directory path", () => {
    const parent = makeTempDir();
    const baseDir = path.join(parent, "readonly-storage-2");
    fs.mkdirSync(baseDir);
    fs.chmodSync(baseDir, 0o555);

    let result;
    try {
      result = storageCheck(makeLocalDiskConfig(baseDir));
    } finally {
      fs.chmodSync(baseDir, 0o755);
    }

    expect(result.message).toContain(baseDir);
  });

  it("sets canRepair to false on fail", () => {
    const parent = makeTempDir();
    const baseDir = path.join(parent, "readonly-storage-3");
    fs.mkdirSync(baseDir);
    fs.chmodSync(baseDir, 0o555);

    let result;
    try {
      result = storageCheck(makeLocalDiskConfig(baseDir));
    } finally {
      fs.chmodSync(baseDir, 0o755);
    }

    expect(result.canRepair).toBe(false);
  });
});

// ============================================================================
// storageCheck — S3 configuration
// ============================================================================

describe("storageCheck — S3 provider", () => {
  it("returns warn with bucket and region info when S3 is configured", () => {
    const result = storageCheck(makeS3Config("my-bucket", "us-east-1"));
    expect(result.status).toBe("warn");
    expect(result.message).toContain("my-bucket");
    expect(result.message).toContain("us-east-1");
  });

  it("returns fail when S3 bucket is empty", () => {
    const result = storageCheck(makeS3Config("", "us-east-1"));
    expect(result.status).toBe("fail");
    expect(result.message).toContain("bucket");
  });

  it("returns fail when S3 region is empty", () => {
    const result = storageCheck(makeS3Config("my-bucket", ""));
    expect(result.status).toBe("fail");
    expect(result.message).toContain("region");
  });

  it("sets name to 'Storage' for S3 checks", () => {
    const result = storageCheck(makeS3Config("b", "r"));
    expect(result.name).toBe("Storage");
  });
});
