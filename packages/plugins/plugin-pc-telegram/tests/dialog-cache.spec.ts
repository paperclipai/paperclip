import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDialogCache, preferCachedPhoto } from "../src/dialog-cache.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "10001";
const PEER = "20002";

function photo(size: number, tag: string): string {
  return `data:image/jpeg;base64,${tag}${"A".repeat(size)}`;
}

describe("dialog cache", () => {
  it("keeps a stored image when the next download is empty or smaller", () => {
    const full = photo(400, "full");
    const thumb = photo(80, "thumb");
    expect(preferCachedPhoto(full, null, "1", "1")).toBe(full);
    expect(preferCachedPhoto(full, thumb, "1", "1")).toBe(full);
    expect(preferCachedPhoto(thumb, full, "1", "1")).toBe(full);
    expect(preferCachedPhoto(full, thumb, "1", "2")).toBe(thumb);
    expect(preferCachedPhoto(null, "javascript:alert(1)")).toBeNull();
  });

  it("paints dialogs and avatars from disk and ignores a null write", async () => {
    const root = await mkdtemp(join(tmpdir(), "tg-cache-"));
    try {
      const cache = createDialogCache({ root, allowedMaxBytes: [300, 800] });
      await cache.saveSettings(COMPANY, { enabled: true, maxBytes: 800 });
      const name = "Cache Probe";
      await cache.writeDialogs(COMPANY, ACCOUNT, [{
        id: PEER,
        name,
        preview: "hello",
        unread: 2,
        photoId: "9",
        presence: { code: "recently" },
        activityAt: "2026-11-15T00:00:00.000Z",
      }]);
      const full = photo(220, "full");
      await cache.writeAvatar(COMPANY, ACCOUNT, PEER, { photoId: "9", dataUrl: full });
      await cache.writeAvatar(COMPANY, ACCOUNT, PEER, { photoId: "9", dataUrl: photo(40, "tiny") });
      await cache.writeHistory(COMPANY, ACCOUNT, PEER, [{
        id: "7",
        direction: "in",
        text: "hello",
        at: "2026-11-15T00:00:00.000Z",
        forward: null,
      }]);

      const dialogs = await cache.readDialogs(COMPANY, ACCOUNT);
      expect(dialogs).toHaveLength(1);
      expect(dialogs?.[0]?.name).toBe(name);
      expect((await cache.readAvatar(COMPANY, ACCOUNT, PEER))?.dataUrl).toBe(full);
      expect((await cache.readHistory(COMPANY, ACCOUNT, PEER))?.[0]?.text).toBe("hello");

      const status = await cache.status(COMPANY);
      expect(status.dialogs).toBe(1);
      expect(status.avatars).toBe(1);
      expect(status.enabled).toBe(true);
      expect(JSON.stringify(status).includes(name)).toBe(false);
      expect(JSON.stringify(status).includes(PEER)).toBe(false);

      const mode = await stat(join(root, COMPANY, ACCOUNT, "dialogs.json"));
      expect(mode.mode & 0o077).toBe(0);

      await cache.saveSettings(COMPANY, { enabled: false });
      expect(await cache.readDialogs(COMPANY, ACCOUNT)).toBeNull();
      await cache.writeDialogs(COMPANY, ACCOUNT, [{
        id: PEER,
        name: "Other",
        preview: "",
        unread: 0,
        photoId: "",
        presence: null,
        activityAt: "",
      }]);
      await cache.saveSettings(COMPANY, { enabled: true });
      expect((await cache.readDialogs(COMPANY, ACCOUNT))?.[0]?.name).toBe(name);

      await cache.clear(COMPANY, "avatars");
      expect(await cache.readAvatar(COMPANY, ACCOUNT, PEER)).toBeNull();
      expect(await cache.readDialogs(COMPANY, ACCOUNT)).toHaveLength(1);
      await cache.clear(COMPANY, "dialogs");
      expect(await cache.readDialogs(COMPANY, ACCOUNT)).toBeNull();
      expect(await cache.readHistory(COMPANY, ACCOUNT, PEER)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("drops the oldest avatar at the size cap and keeps the dialog index", async () => {
    const root = await mkdtemp(join(tmpdir(), "tg-cache-"));
    try {
      const cache = createDialogCache({ root, allowedMaxBytes: [360] });
      await cache.saveSettings(COMPANY, { maxBytes: 360 });
      await cache.writeDialogs(COMPANY, ACCOUNT, [
        { id: "11", name: "One", preview: "", unread: 0, photoId: "1", presence: null, activityAt: "" },
        { id: "12", name: "Two", preview: "", unread: 0, photoId: "2", presence: null, activityAt: "" },
      ]);
      await cache.writeAvatar(COMPANY, ACCOUNT, "11", { photoId: "1", dataUrl: photo(180, "old") });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await cache.writeAvatar(COMPANY, ACCOUNT, "12", { photoId: "2", dataUrl: photo(180, "new") });
      const status = await cache.status(COMPANY);
      expect(status.avatars).toBe(1);
      expect(status.dialogs).toBe(2);
      expect(await cache.readAvatar(COMPANY, ACCOUNT, "11")).toBeNull();
      expect(await cache.readAvatar(COMPANY, ACCOUNT, "12")).toBeTruthy();
      expect(await cache.readDialogs(COMPANY, ACCOUNT)).toHaveLength(2);
      expect(await cache.readDialogs(COMPANY, `../${ACCOUNT}`)).toBeNull();
      await cache.writeDialogs("not-a-company", ACCOUNT, [{
        id: "11",
        name: "One",
        preview: "",
        unread: 0,
        photoId: "",
        presence: null,
        activityAt: "",
      }]);
      expect(await cache.readDialogs("not-a-company", ACCOUNT)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shrinks an idle cache when the saved byte cap is lowered", async () => {
    const root = await mkdtemp(join(tmpdir(), "tg-cache-"));
    try {
      const cache = createDialogCache({ root, allowedMaxBytes: [360, 800] });
      await cache.saveSettings(COMPANY, { maxBytes: 800 });
      await cache.writeAvatar(COMPANY, ACCOUNT, "11", { photoId: "1", dataUrl: photo(180, "old") });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await cache.writeAvatar(COMPANY, ACCOUNT, "12", { photoId: "2", dataUrl: photo(180, "new") });
      await cache.writeHistory(COMPANY, ACCOUNT, PEER, [{
        id: "7",
        direction: "in",
        text: "Photo",
        at: "2026-11-15T00:00:00.000Z",
        forward: null,
        placeholder: true,
      }]);
      expect((await cache.readHistory(COMPANY, ACCOUNT, PEER))?.[0]?.placeholder).toBe(true);
      const high = await cache.status(COMPANY);
      expect(high.bytes).toBeGreaterThan(360);
      await cache.saveSettings(COMPANY, { maxBytes: 360 });
      const low = await cache.status(COMPANY);
      expect(low.maxBytes).toBe(360);
      expect(low.bytes).toBeLessThanOrEqual(360);
      await cache.writeHistory(COMPANY, ACCOUNT, PEER, []);
      expect(await cache.readHistory(COMPANY, ACCOUNT, PEER)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
