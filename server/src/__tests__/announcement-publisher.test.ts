import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareAnnouncementPublish, announcementUploadArgs, parseAnnouncementPublishArgs, announcementPublishPrefix } from "../../../scripts/publish-announcements.js";

const dirs: string[] = [];
async function fixture() { const dir = await mkdtemp(path.join(os.tmpdir(), "announcement-publish-")); dirs.push(dir); return dir; }
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
describe("announcement publishing", () => {
  it("keeps named staging feeds separate from production and defaults to dry-run", async () => {
    const dir = await fixture();
    await writeFile(path.join(dir, "current.json"), JSON.stringify({ schemaVersion: 1, announcement: null }));
    const result = await prepareAnnouncementPublish(dir, "preview-projects");
    expect(result.files.map((file) => file.key)).toEqual(["announcements/staging/preview-projects/v1/current.json"]);
    expect(parseAnnouncementPublishArgs(["--staging", "preview-projects"])).toEqual({
      sourceDirectory: "announcements/examples/staging", staging: "preview-projects", publish: false,
    });
    expect(parseAnnouncementPublishArgs([dir, "--staging", "preview-projects", "--publish"]).publish).toBe(true);
    expect(announcementPublishPrefix()).toBe("announcements/v1");
    expect((await prepareAnnouncementPublish(dir, "preview-projects", "storybook/branches/codex-announcements")).files[0].key)
      .toBe("storybook/branches/codex-announcements/announcements/staging/preview-projects/v1/current.json");
    for (const prefix of ["../outside", "/leading", "trailing/", "bad//path", "", "https://example.com"]) {
      expect(() => announcementPublishPrefix("preview-projects", prefix)).toThrow();
    }
    for (const name of ["../v1", "", "/production", "preview/nested"]) {
      expect(() => announcementPublishPrefix(name)).toThrow();
    }
    for (const args of [["--staging"], ["--publish", "--dry-run"], ["one", "two"], ["--unknown"]]) {
      expect(() => parseAnnouncementPublishArgs(args)).toThrow();
    }
  });

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
  it("validates HTML animation fixtures and uploads both assets before the manifest", async () => {
    const result = await prepareAnnouncementPublish(path.resolve(import.meta.dirname, "../../../announcements/examples/animated"), "animated-preview");
    expect(result.files.map((file) => file.contentType)).toEqual(["image/png", "text/html", "application/json"]);
    const dir = await fixture();
    await mkdir(path.join(dir, "assets"));
    const html = "<meta http-equiv='refresh' content='0;url=https://evil.test'>";
    const asset = `assets/${createHash("sha256").update(html).digest("hex")}.html`;
    const image = result.files[0];
    const imagePath = result.manifest.announcement!.image!.path;
    await writeFile(path.join(dir, imagePath), await import("node:fs/promises").then((fs) => fs.readFile(image.file)));
    await writeFile(path.join(dir, asset), html);
    await writeFile(path.join(dir, "current.json"), JSON.stringify({ ...result.manifest, announcement: { ...result.manifest.announcement, animation: { path: asset, alt: "Unsafe" } } }));
    await expect(prepareAnnouncementPublish(dir)).rejects.toThrow("only visual HTML/CSS");
  });
  it("supports withdrawal and rejects symlinks and unsupported schemas", async () => {
    const dir = await fixture();
    await writeFile(path.join(dir, "current.json"), JSON.stringify({ schemaVersion: 1, announcement: null }));
    expect((await prepareAnnouncementPublish(dir)).files).toHaveLength(1);
    const link = path.join(dir, "link"); await symlink(dir, link);
    await expect(prepareAnnouncementPublish(link)).rejects.toThrow("real directory");
    await writeFile(path.join(dir, "current.json"), JSON.stringify({ schemaVersion: 2, announcement: null }));
    await expect(prepareAnnouncementPublish(dir)).rejects.toThrow();
    await writeFile(path.join(dir, "current.json"), JSON.stringify({ schemaVersion: 1, announcement: null, announcements: [] }));
    await expect(prepareAnnouncementPublish(dir)).rejects.toThrow();
  });
});
