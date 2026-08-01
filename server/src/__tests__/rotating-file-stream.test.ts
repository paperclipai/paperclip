import { gunzipSync } from "node:zlib";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import { RotatingFileStream } from "../middleware/rotating-file-stream.js";

async function write(stream: RotatingFileStream, value: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(value, (error) => error ? reject(error) : resolve());
  });
}

describe("RotatingFileStream", () => {
  it("compresses an oversized live log and keeps writing through the original path", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "paperclip-log-rotation-"));
    const filePath = path.join(directory, "server.log");
    const stream = new RotatingFileStream({
      filePath,
      maxBytes: 10,
      maxArchives: 5,
      now: () => new Date("2026-08-01T08:44:54Z"),
    });

    await write(stream, "12345678");
    await write(stream, "next");
    stream.end();
    await finished(stream);
    await stream.waitForMaintenance();

    expect(await readFile(filePath, "utf8")).toBe("next");
    const archivePath = path.join(directory, "server.log.20260801T084454Z.gz");
    expect(gunzipSync(await readFile(archivePath)).toString("utf8")).toBe("12345678");
  });

  it("rotates an already-oversized log on the first new write", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "paperclip-log-recovery-"));
    const filePath = path.join(directory, "server.log");
    await writeFile(filePath, "oversized-existing-log");
    const stream = new RotatingFileStream({ filePath, maxBytes: 5, maxArchives: 5 });

    await write(stream, "live");
    stream.end();
    await finished(stream);
    await stream.waitForMaintenance();

    expect(await readFile(filePath, "utf8")).toBe("live");
    const archives = (await readdir(directory)).filter((name) => name.endsWith(".gz"));
    expect(archives).toHaveLength(1);
    expect(gunzipSync(await readFile(path.join(directory, archives[0]!))).toString("utf8"))
      .toBe("oversized-existing-log");
  });

  it("recovers interrupted archives and retains only the configured archive count", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "paperclip-log-retention-"));
    const filePath = path.join(directory, "server.log");
    await writeFile(`${filePath}.20260731T000000Z`, "interrupted");
    const stream = new RotatingFileStream({
      filePath,
      maxBytes: 4,
      maxArchives: 2,
      now: () => new Date("2026-08-01T08:44:54Z"),
    });

    await write(stream, "aaaa");
    await write(stream, "bbbb");
    await write(stream, "cccc");
    await write(stream, "dddd");
    stream.end();
    await finished(stream);
    await stream.waitForMaintenance();

    const names = await readdir(directory);
    expect(names.filter((name) => name.endsWith(".gz")).sort()).toEqual([
      "server.log.20260801T084454Z.1.gz",
      "server.log.20260801T084454Z.2.gz",
    ]);
    expect(names).not.toContain("server.log.20260731T000000Z");
    expect(await readFile(filePath, "utf8")).toBe("dddd");
  });
});
