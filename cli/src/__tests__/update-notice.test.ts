import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveInstallStorePaths, writeInstallManifestAtomic } from "../install-store.js";
import { checkForUpdateNotice, isUpdateNoticeEnabled } from "../update-notice.js";
let root: string; let previous: string | undefined; let previousPaperclipHome: string | undefined;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-notice-")); previous = process.env.PAPERCLIP_UPDATE_CHECK; previousPaperclipHome = process.env.PAPERCLIP_HOME; delete process.env.PAPERCLIP_UPDATE_CHECK; process.env.PAPERCLIP_HOME = path.join(root, "paperclip"); });
afterEach(() => { if (previous === undefined) delete process.env.PAPERCLIP_UPDATE_CHECK; else process.env.PAPERCLIP_UPDATE_CHECK = previous; if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousPaperclipHome; fs.rmSync(root, { recursive: true, force: true }); });
describe("update notice", () => {
  it("honors the environment and config kill switches", () => {
    process.env.PAPERCLIP_UPDATE_CHECK = "0"; expect(isUpdateNoticeEnabled(path.join(root, "missing.json"))).toBe(false);
    delete process.env.PAPERCLIP_UPDATE_CHECK; const config = path.join(root, "config.json"); fs.writeFileSync(config, JSON.stringify({ updates: { checkEnabled: false } })); expect(isUpdateNoticeEnabled(config)).toBe(false);
  });
  it("throttles registry checks for 24 hours", async () => {
    const cachePath = path.join(root, "cache.json"); const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ "dist-tags": { latest: "99.0.0" } }), { status: 200 }));
    expect(await checkForUpdateNotice({ cachePath, now: 1000, fetchImpl })).toBe("99.0.0");
    expect(await checkForUpdateNotice({ cachePath, now: 2000, fetchImpl })).toBe("99.0.0");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it.each(["beta", "nightly"] as const)("checks the recorded %s channel", async (channel) => {
    const paths = resolveInstallStorePaths();
    writeInstallManifestAtomic({ schemaVersion: 1, source: "npm", version: `1.0.0-${channel}.0`, channel, payloadPath: path.join(root, "payload"), installedAt: "2026-08-20T00:00:00.000Z", previous: [] }, paths);
    const cachePath = path.join(root, "cache.json");
    const target = `99.0.0-${channel}.1`;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ "dist-tags": { latest: "0.3.1", beta: "99.0.0-beta.1", nightly: "99.0.0-nightly.1" } }), { status: 200 }));
    expect(await checkForUpdateNotice({ cachePath, now: 1000, fetchImpl })).toBe(target);
    expect(JSON.parse(fs.readFileSync(cachePath, "utf8"))).toMatchObject({ latest: target, tag: channel });
  });
});
