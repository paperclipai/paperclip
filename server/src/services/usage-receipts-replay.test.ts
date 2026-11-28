import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../middleware/logger.js";
import { replayUsageReceipts } from "./usage-receipts.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function spoolDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "usage-receipt-replay-"));
  directories.push(directory);
  return directory;
}

describe("replayUsageReceipts", () => {
  it("ignores an entry removed after the directory scan", async () => {
    const directory = await spoolDirectory();
    const file = path.join(directory, "receipt.json");
    await fs.writeFile(file, "{}", "utf8");
    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => {});
    vi.spyOn(fs, "lstat").mockImplementationOnce(async target => {
      await fs.rm(target, { force: true });
      return fs.lstat(target);
    });

    await expect(replayUsageReceipts(undefined as unknown as Db, directory)).resolves.toEqual({ replayed: 0, failed: 0 });
    expect(await fs.readdir(directory)).toEqual([]);
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("keeps rotating entries that fail for reasons other than disappearance", async () => {
    const directory = await spoolDirectory();
    await fs.writeFile(path.join(directory, "receipt.json"), "{", "utf8");
    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => {});

    await expect(replayUsageReceipts(undefined as unknown as Db, directory)).resolves.toEqual({ replayed: 0, failed: 1 });
    expect(await fs.readdir(directory)).toEqual(expect.arrayContaining([expect.stringMatching(/^retry-.*\.json$/)]));
    expect(errorLog).toHaveBeenCalledTimes(1);
  });
});
