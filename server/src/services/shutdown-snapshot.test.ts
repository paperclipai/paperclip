import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseShutdownSnapshot,
  readShutdownSnapshot,
  removeShutdownSnapshot,
  resolveShutdownSnapshotPath,
  writeShutdownSnapshot,
} from "./shutdown-snapshot.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryHome() {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-shutdown-snapshot-"));
  temporaryDirectories.push(homeDir);
  return homeDir;
}

describe("shutdown snapshot", () => {
  it("round-trips the in-flight run ids through an atomic file", async () => {
    const homeDir = await temporaryHome();
    await writeShutdownSnapshot(
      {
        version: 1,
        capturedAt: "2026-10-22T07:42:45.000Z",
        signal: "SIGTERM",
        serverPid: 1234,
        runIds: ["run-b", "run-a", "run-a"],
      },
      homeDir,
    );

    const snapshot = await readShutdownSnapshot(homeDir);
    expect(snapshot).toMatchObject({
      version: 1,
      signal: "SIGTERM",
      serverPid: 1234,
      runIds: ["run-b", "run-a"],
    });
    expect(resolveShutdownSnapshotPath(homeDir)).toBe(
      path.join(homeDir, "instances", process.env.PAPERCLIP_INSTANCE_ID?.trim() || "default", "shutdown-snapshot.json"),
    );

    await removeShutdownSnapshot(homeDir);
    expect(await readShutdownSnapshot(homeDir)).toBeNull();
  });

  it("ignores a corrupt or unsupported file instead of failing startup", async () => {
    const homeDir = await temporaryHome();
    const filePath = resolveShutdownSnapshotPath(homeDir);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "{not json", "utf8");
    expect(await readShutdownSnapshot(homeDir)).toBeNull();

    await fs.writeFile(filePath, JSON.stringify({ version: 2, runIds: ["run"] }), "utf8");
    expect(await readShutdownSnapshot(homeDir)).toBeNull();
  });

  it("rejects a snapshot without the fields needed to finalize a run", () => {
    expect(parseShutdownSnapshot({ version: 1, capturedAt: "not-a-date", signal: "SIGTERM", serverPid: 1, runIds: [] })).toBeNull();
    expect(parseShutdownSnapshot({ version: 1, capturedAt: "2026-10-22T07:42:45.000Z", signal: "SIGHUP", serverPid: 1, runIds: [] })).toBeNull();
    expect(parseShutdownSnapshot({ version: 1, capturedAt: "2026-10-22T07:42:45.000Z", signal: "SIGTERM", serverPid: 0, runIds: [] })).toBeNull();
    expect(parseShutdownSnapshot({ version: 1, capturedAt: "2026-10-22T07:42:45.000Z", signal: "SIGTERM", serverPid: 1, runIds: "run" })).toBeNull();
  });
});
