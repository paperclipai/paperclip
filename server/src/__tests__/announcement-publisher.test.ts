import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareAnnouncementPublish, announcementUploadArgs } from "../../../scripts/publish-announcements.js";

const dirs: string[] = [];
async function fixture() { const dir = await mkdtemp(path.join(os.tmpdir(), "announcement-publish-")); dirs.push(dir); return dir; }
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
describe("announcement publishing", () => {
  it("uploads content-addressed assets before the five-minute manifest", async () => {
    const dir = await fixture();
    const bytes = Buffer.from("test-image");
    const imagePath = `assets/${createHash("sha256").update(bytes).digest("hex")}.png`;
    await mkdir(path.join(dir, "assets"));
    await writeFile(path.join(dir, imagePath), bytes);
    await writeFile(path.join(dir, "current.json"), JSON.stringify({ schemaVersion: 1, announcement: { id: "test", title: "Test", eyebrow: "New", description: "Example", image: { path: imagePath, alt: "" }, primaryAction: { kind: "route", label: "Open", path: "/projects" } } }));
    const { files } = await prepareAnnouncementPublish(dir);
    expect(files.map((file) => file.key)).toEqual([`announcements/v1/${imagePath}`, "announcements/v1/current.json"]);
    expect(files[0].cacheControl).toContain("immutable");
    expect(announcementUploadArgs("bucket", files[1])).toContain("public,max-age=300");
    await writeFile(path.join(dir, imagePath), "changed");
    await expect(prepareAnnouncementPublish(dir)).rejects.toThrow("SHA-256");
  });
  it("supports withdrawal and rejects symlinks and unsupported schemas", async () => {
    const dir = await fixture();
    await writeFile(path.join(dir, "current.json"), JSON.stringify({ schemaVersion: 1, announcement: null }));
    expect((await prepareAnnouncementPublish(dir)).files).toHaveLength(1);
    const link = path.join(dir, "link"); await symlink(dir, link);
    await expect(prepareAnnouncementPublish(link)).rejects.toThrow("real directory");
    await writeFile(path.join(dir, "current.json"), JSON.stringify({ schemaVersion: 2, announcement: null }));
    await expect(prepareAnnouncementPublish(dir)).rejects.toThrow();
  });
});
