import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkForUpdateNotice, isUpdateNoticeEnabled } from "../update-notice.js";
let root: string; let previous: string | undefined;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-notice-")); previous = process.env.PAPERCLIP_UPDATE_CHECK; delete process.env.PAPERCLIP_UPDATE_CHECK; });
afterEach(() => { if (previous === undefined) delete process.env.PAPERCLIP_UPDATE_CHECK; else process.env.PAPERCLIP_UPDATE_CHECK = previous; fs.rmSync(root, { recursive: true, force: true }); });
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
});
