import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { driveMarkerTtl } from "../services/routine-checks/checks/drive-marker-ttl.js";

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };
const fsStub = {} as unknown as typeof import("node:fs/promises");

describe("drive-marker-ttl", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drive-ttl-"));
    process.env.PAPERCLIP_CREATIVE_ROOT = tmp;
  });
  afterEach(async () => {
    delete process.env.PAPERCLIP_CREATIVE_ROOT;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("returns ok with 0 findings when no markers exist", async () => {
    const r = await driveMarkerTtl.run({ db: {} as any, fs: fsStub, logger: noopLogger, now: () => new Date() });
    expect(r.status).toBe("ok");
    expect(r.findings).toBe(0);
    expect((r.payload as any).removed).toEqual([]);
  });

  it("removes markers older than 60min", async () => {
    const projectDir = path.join(tmp, "project1");
    await fs.mkdir(projectDir, { recursive: true });
    const oldMarker = path.join(projectDir, ".drive-approved-20260430-0900");
    const newMarker = path.join(projectDir, ".drive-approved-20260430-1000");
    await fs.writeFile(oldMarker, "");
    await fs.writeFile(newMarker, "");
    const oldTime = new Date(Date.now() - 90 * 60 * 1000);
    await fs.utimes(oldMarker, oldTime, oldTime);

    const r = await driveMarkerTtl.run({ db: {} as any, fs: fsStub, logger: noopLogger, now: () => new Date() });
    expect((r.payload as any).removed).toContain(oldMarker);
    expect((r.payload as any).removed).not.toContain(newMarker);
    expect(r.findings).toBe(1);

    expect(await fs.access(newMarker).then(() => true).catch(() => false)).toBe(true);
    expect(await fs.access(oldMarker).then(() => true).catch(() => false)).toBe(false);
  });

  it("recurses into nested project directories", async () => {
    const nested = path.join(tmp, "p1/assets/k1");
    await fs.mkdir(nested, { recursive: true });
    const marker = path.join(nested, ".drive-approved-deep");
    await fs.writeFile(marker, "");
    await fs.utimes(marker, new Date(Date.now() - 90 * 60 * 1000), new Date(Date.now() - 90 * 60 * 1000));

    const r = await driveMarkerTtl.run({ db: {} as any, fs: fsStub, logger: noopLogger, now: () => new Date() });
    expect((r.payload as any).removed).toContain(marker);
  });

  it("ignores non-marker files", async () => {
    const projectDir = path.join(tmp, "p1");
    await fs.mkdir(projectDir, { recursive: true });
    const normal = path.join(projectDir, "README.md");
    await fs.writeFile(normal, "x");
    await fs.utimes(normal, new Date(Date.now() - 90 * 60 * 1000), new Date(Date.now() - 90 * 60 * 1000));

    const r = await driveMarkerTtl.run({ db: {} as any, fs: fsStub, logger: noopLogger, now: () => new Date() });
    expect(r.findings).toBe(0);
    expect(await fs.access(normal).then(() => true).catch(() => false)).toBe(true);
  });

  it("returns ok with empty payload when root does not exist", async () => {
    process.env.PAPERCLIP_CREATIVE_ROOT = "/nonexistent/path/should/not/exist";
    const r = await driveMarkerTtl.run({ db: {} as any, fs: fsStub, logger: noopLogger, now: () => new Date() });
    expect(r.status).toBe("ok");
    expect(r.findings).toBe(0);
  });

  it("skips symlinks (does not follow them)", async () => {
    const projectDir = path.join(tmp, "p1");
    await fs.mkdir(projectDir, { recursive: true });
    // Create a symlink loop: tmp/loop → tmp/p1
    const loopLink = path.join(tmp, "loop");
    await fs.symlink(projectDir, loopLink);
    // Create a marker only inside p1 — if walker follows the symlink it would re-enter, no infinite loop because of basename matching, but we want to assert it doesn't double-count
    const marker = path.join(projectDir, ".drive-approved-x");
    await fs.writeFile(marker, "");
    await fs.utimes(marker, new Date(Date.now() - 90 * 60 * 1000), new Date(Date.now() - 90 * 60 * 1000));
    const r = await driveMarkerTtl.run({ db: {} as any, fs: fsStub, logger: noopLogger, now: () => new Date() });
    expect((r.payload as any).removed).toEqual([marker]);
  });

  it("ignores directory entries named .drive-approved-* (only files)", async () => {
    const projectDir = path.join(tmp, "p1");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(path.join(projectDir, ".drive-approved-dir-shaped")); // edge case: dir with marker name
    const marker = path.join(projectDir, ".drive-approved-real");
    await fs.writeFile(marker, "");
    await fs.utimes(marker, new Date(Date.now() - 90 * 60 * 1000), new Date(Date.now() - 90 * 60 * 1000));
    const r = await driveMarkerTtl.run({ db: {} as any, fs: fsStub, logger: noopLogger, now: () => new Date() });
    expect((r.payload as any).removed).toEqual([marker]);
  });
});
