import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { announcementFeedService, ANNOUNCEMENT_CACHE_MS, ANNOUNCEMENT_FAILURE_MS } from "../services/announcement-feed.js";
import { logger } from "../middleware/logger.js";

const item = { id: "new-projects", eyebrow: "New", title: "Projects", description: "Organize your work.", primaryAction: { kind: "route", label: "Open", path: "/projects" } };
const json = (announcement: unknown = item, etag = '"v1"') => new Response(JSON.stringify({ schemaVersion: 1, announcement }), { headers: { "Content-Type": "application/json", ETag: etag } });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe("announcement feed", () => {
  it("treats a 404 as quiet empty content, drops stale ETags, and recovers after cooldown", async () => {
    let now = 0;
    const warn = vi.spyOn(logger, "warn");
    const fetch = vi.fn().mockImplementationOnce(async () => json())
      .mockImplementationOnce(async () => new Response("Not found", { status: 404 }))
      .mockImplementationOnce(async () => json({ ...item, id: "restored" }));
    const service = announcementFeedService({ version: "1.0.0", now: () => now, fetch });
    expect(await service.current()).toEqual(item);
    now += ANNOUNCEMENT_CACHE_MS;
    expect(await service.current()).toBeNull();
    expect(await service.image(item.id)).toBeNull();
    now += ANNOUNCEMENT_FAILURE_MS - 1;
    expect(await service.current()).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
    now++;
    expect((await service.current())?.id).toBe("restored");
    expect(fetch.mock.calls[2][1].headers).not.toHaveProperty("If-None-Match");
  });

  it("deduplicates requests, caches for an hour, then revalidates with ETag", async () => {
    let now = 0;
    const fetch = vi.fn().mockImplementationOnce(async () => json()).mockResolvedValueOnce(new Response(null, { status: 304 }));
    const service = announcementFeedService({ version: "2026.913.0", now: () => now, fetch });
    expect(await Promise.all([service.current(), service.current()])).toEqual([item, item]);
    expect(fetch).toHaveBeenCalledTimes(1);
    now = ANNOUNCEMENT_CACHE_MS - 1;
    await service.current();
    expect(fetch).toHaveBeenCalledTimes(1);
    now++;
    expect(await service.current()).toEqual(item);
    expect(fetch.mock.calls[1][1]).toMatchObject({ headers: { "If-None-Match": '"v1"' }, credentials: "omit" });
    expect(Object.keys(fetch.mock.calls[0][1].headers)).toEqual(["Accept"]);
  });
  it("withdraws, updates same-ID copy and discovers new IDs after refresh", async () => {
    let now = 0;
    const fetch = vi.fn().mockImplementationOnce(async () => json()).mockImplementationOnce(async () => json({ ...item, title: "Corrected" }, '"v2"')).mockImplementationOnce(async () => json(null)).mockImplementationOnce(async () => json({ ...item, id: "next" }));
    const service = announcementFeedService({ version: "2026.913.0", now: () => now, fetch });
    expect((await service.current())?.id).toBe(item.id);
    now += ANNOUNCEMENT_CACHE_MS;
    expect((await service.current())?.title).toBe("Corrected");
    now += ANNOUNCEMENT_CACHE_MS;
    expect(await service.current()).toBeNull();
    now += ANNOUNCEMENT_CACHE_MS;
    expect((await service.current())?.id).toBe("next");
  });
  it.each([
    () => new Response("bad json", { headers: { "Content-Type": "application/json" } }),
    () => new Response(JSON.stringify({ schemaVersion: 9, announcement: item }), { headers: { "Content-Type": "application/json" } }),
    () => new Response("x".repeat(65537), { headers: { "Content-Type": "application/json" } }),
    () => new Response("", { status: 302, headers: { Location: "http://127.0.0.1" } }),
    () => new Response("<html>error</html>", { status: 503 }),
  ])("suppresses invalid/unavailable feeds and observes failure cooldown", async (response) => {
    let now = 0;
    const fetch = vi.fn().mockImplementationOnce(async () => response()).mockImplementationOnce(async () => json());
    const service = announcementFeedService({ version: "1.0.0", now: () => now, fetch });
    expect(await service.current()).toBeNull();
    now = ANNOUNCEMENT_FAILURE_MS - 1;
    expect(await service.current()).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    now++;
    expect(await service.current()).toEqual(item);
  });
  it("bounds a hung fetch to three seconds", async () => {
    vi.useFakeTimers();
    const service = announcementFeedService({ version: "1.0.0", fetch: () => new Promise(() => {}) });
    const result = service.current();
    await vi.advanceTimersByTimeAsync(3000);
    expect(await result).toBeNull();
  });
  it("does not fetch when disabled or an operator URL is invalid", async () => {
    const fetch = vi.fn();
    for (const options of [{ enabled: false }, { feedUrl: "http://localhost/feed" }, { feedUrl: "https://user:secret@example.com/feed" }]) {
      const service = announcementFeedService({ version: "1.0.0", fetch, ...options });
      expect(await service.current()).toBeNull();
      expect(await service.image(item.id)).toBeNull();
      expect(await service.animation(item.id)).toBeNull();
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("expires a cached announcement and filters version-incompatible content", async () => {
    let now = 0;
    const service = announcementFeedService({ version: "1.0.0", now: () => now, fetch: async () => json({ ...item, expiresAt: "1970-01-01T00:00:01Z" }) });
    expect(await service.current()).not.toBeNull();
    now = 1000;
    expect(await service.current()).toBeNull();
    expect(await announcementFeedService({ version: "1.0.0", fetch: async () => json({ ...item, minimumPaperclipVersion: "2.0.0" }) }).current()).toBeNull();
  });
  it("proxies only the current content-addressed image and caches bytes", async () => {
    const bytes = Buffer.from("test-image");
    const path = `assets/${createHash("sha256").update(bytes).digest("hex")}.png`;
    const fetch = vi.fn().mockImplementationOnce(async () => json({ ...item, image: { path, alt: "" } })).mockImplementationOnce(async () => new Response(bytes, { headers: { "Content-Type": "image/png" } }));
    const service = announcementFeedService({ version: "1.0.0", fetch });
    expect(await service.image("other")).toBeNull();
    const images = await Promise.all([service.image(item.id), service.image(item.id)]);
    expect(images[0]?.bytes).toEqual(bytes);
    expect(images[1]).toEqual(images[0]);
    await service.image(item.id);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[1][0])).toBe(`https://pages.paperclip.ing/announcements/v1/${path}`);
  });
  it("rejects image digest mismatches and cools down image retries", async () => {
    const fetch = vi.fn().mockImplementationOnce(async () => json({ ...item, image: { path: `assets/${"0".repeat(64)}.png`, alt: "" } })).mockImplementation(async () => new Response("wrong", { headers: { "Content-Type": "image/png" } }));
    const service = announcementFeedService({ version: "1.0.0", fetch });
    expect(await service.image(item.id)).toBeNull();
    expect(await service.image(item.id)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("deduplicates and caches validated animations on the configured host", async () => {
    const bytes = Buffer.from("<div style='animation:pulse 2s infinite'>Team</div>");
    const path = `assets/${createHash("sha256").update(bytes).digest("hex")}.html`;
    const fetch = vi.fn().mockImplementationOnce(async () => json({ ...item, image: { path: `assets/${"0".repeat(64)}.png`, alt: "Poster" }, animation: { path, alt: "Team" } }))
      .mockImplementationOnce(async () => new Response(bytes, { headers: { "Content-Type": "text/html; charset=utf-8" } }));
    const service = announcementFeedService({ version: "1.0.0", feedUrl: "https://mirror.example/preview/current.json", fetch });
    expect(await service.animation("wrong-id")).toBeNull();
    const result = await Promise.all([service.animation(item.id), service.animation(item.id)]);
    expect(result[0]?.bytes.toString()).toContain("Team");
    expect(result[1]).toEqual(result[0]);
    await service.animation(item.id);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[1][0])).toBe(`https://mirror.example/preview/${path}`);
    expect(fetch.mock.calls[1][1]).toMatchObject({ credentials: "omit", redirect: "error", headers: { Accept: "text/html" } });
  });
  it.each([
    ["<script>alert(1)</script>", "text/html", 200],
    ["<div>ok</div>", "text/plain", 200],
    ["not found", "text/html", 404],
    ["x".repeat(128 * 1024 + 1), "text/html", 200],
  ])("falls back on rejected animation assets and cools down retries", async (html, contentType, status) => {
    const path = `assets/${createHash("sha256").update(html).digest("hex")}.html`;
    const fetch = vi.fn().mockImplementationOnce(async () => json({ ...item, image: { path: `assets/${"0".repeat(64)}.png`, alt: "Poster" }, animation: { path, alt: "Team" } }))
      .mockImplementation(async () => new Response(html, { status, headers: { "Content-Type": contentType } }));
    const service = announcementFeedService({ version: "1.0.0", fetch });
    expect(await service.animation(item.id)).toBeNull();
    expect(await service.animation(item.id)).toBeNull();
    expect((await service.current())?.id).toBe(item.id);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

});
