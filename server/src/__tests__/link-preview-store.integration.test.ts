import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { companies, linkPreviews } from "@paperclipai/db";
import { recognizeLinkPreview } from "@paperclipai/shared";
import { sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { describeEmbeddedPostgres, useEmbeddedPostgres } from "./helpers/route-test-harness.js";
import { createLinkPreviewStore } from "../services/link-preview-store.js";
import { createLinkPreviewService } from "../services/link-previews.js";

const url = "https://github.com/acme/web/pull/42";
const target = recognizeLinkPreview(url)!;
const preview = { target, title: "Durable PR", state: "merged" as const, author: "alice", updatedAt: null };

describeEmbeddedPostgres("durable link preview cache", () => {
  const context = useEmbeddedPostgres("link-previews-");
  async function fixture() {
    const companyId = randomUUID();
    await context.db.insert(companies).values({ id: companyId, name: "Link cache", issuePrefix: companyId });
    return { companyId, userId: "alice" };
  }
  it("bounds retained rows across concurrent store instances and isolates their quotas", async () => {
    const scope = await fixture();
    const other = { ...scope, userId: "bob" };
    const now = Date.now();
    const seed = Array.from({ length: 1_000 }, (_, n) => ({
      companyId: scope.companyId, viewerId: scope.userId, channel: "github", resourceKind: "pull_request",
      canonicalUrl: url + n, status: null, metadata: {}, checkedAt: new Date(now - 1_000 + n), expiresAt: new Date(now + 60_000),
    }));
    await context.db.insert(linkPreviews).values([...seed, { ...seed[0], viewerId: other.userId }]);
    const first = createLinkPreviewStore(context.db);
    const second = createLinkPreviewStore(context.db);
    await Promise.all(Array.from({ length: 8 }, (_, n) => (n % 2 ? first : second).write(scope,
      recognizeLinkPreview(url + (1_000 + n))!, { result: { preview: null, maxAgeMs: 60_000 }, expiresAt: now + 60_000 }, now + n)));
    const rows = await context.db.select().from(linkPreviews).where(sql`${linkPreviews.companyId} = ${scope.companyId}`);
    expect(rows.filter(row => row.viewerId === scope.userId)).toHaveLength(1_000);
    expect(rows.filter(row => row.viewerId === other.userId)).toHaveLength(1);
    const saved = await first.read(scope, [recognizeLinkPreview(url + "0")!, recognizeLinkPreview(url + "1007")!]);
    expect(saved.has(url + "0")).toBe(false);
    expect(saved.has(url + "1007")).toBe(true);
  });
  it("removes long-expired rows on writes and preserves recent stale status", async () => {
    const scope = await fixture();
    const now = Date.now();
    const expired = now - 31 * 24 * 60 * 60_000;
    await context.db.insert(linkPreviews).values([
      { companyId: scope.companyId, viewerId: scope.userId, channel: "github", resourceKind: "pull_request", canonicalUrl: url,
        status: "merged", metadata: { title: preview.title }, checkedAt: new Date(expired - 60_000), expiresAt: new Date(expired) },
      { companyId: scope.companyId, viewerId: scope.userId, channel: "github", resourceKind: "pull_request", canonicalUrl: url + "1",
        status: "merged", metadata: { title: preview.title }, checkedAt: new Date(now - 120_000), expiresAt: new Date(now - 60_000) },
    ]);
    const store = createLinkPreviewStore(context.db);
    await store.write(scope, recognizeLinkPreview(url + "2")!, { result: { preview: null, maxAgeMs: 60_000 }, expiresAt: now + 60_000 }, now);
    const saved = await store.read(scope, [target, recognizeLinkPreview(url + "1")!, recognizeLinkPreview(url + "2")!]);
    expect(saved.has(url)).toBe(false);
    expect(saved.get(url + "1")?.result.preview?.state).toBe("merged");
    expect(saved.has(url + "2")).toBe(true);
  });
  it.each(["failure", "success", "timeout", "stale timeout"])("keeps another replica's concurrent hydration after provider %s", async (settlement) => {
    const scope = await fixture();
    const store = createLinkPreviewStore(context.db);
    let now = 1_000;
    const oldPreview = { ...preview, state: "open" as const };
    await store.write(scope, target, { result: { preview: oldPreview, maxAgeMs: 1_000 }, expiresAt: 2_000 }, now);
    let finish!: (value: { preview: typeof oldPreview | null; maxAgeMs: number }) => void;
    let started!: () => void;
    const providerStarted = new Promise<void>(done => { started = done; });
    const resolve = vi.fn(() => new Promise<{ preview: typeof oldPreview | null; maxAgeMs: number }>(done => { finish = done; started(); }));
    const write = vi.fn(store.write);
    const first = createLinkPreviewService([{ key: "github", resolve }], { store: { ...store, write }, now: () => now, timeoutMs: 1_000 });
    await first.cached(scope, [url]);
    now = 3_000;
    const pending = first.get(scope, url);
    await providerStarted;
    now = 4_000;
    const expiresAt = settlement === "stale timeout" ? 3_500 : 34_000;
    await store.write(scope, target, { result: { preview, maxAgeMs: 30_000 }, expiresAt }, now);
    expect((await first.cached(scope, [url])).results[url].preview).toEqual(preview);
    if (!settlement.includes("timeout")) finish({ preview: settlement === "success" ? oldPreview : null, maxAgeMs: 60_000 });
    expect(await pending).toEqual({ preview, maxAgeMs: Math.max(0, expiresAt - now) });
    // A second batch checks that the process did not retain the older status.
    expect((await first.cached(scope, [url])).results[url].preview).toEqual(preview);
    const saved = (await store.read(scope, [target])).get(url)!;
    expect(saved.result.preview).toEqual(preview);
    expect(saved.checkedAt).toBe(4_000);
    expect(saved.expiresAt).toBe(expiresAt);
    expect(write).not.toHaveBeenCalled();
    finish({ preview: null, maxAgeMs: 60_000 });
  });
  it.each(["open", "negative"])("rechecks expired %s memory before calling the provider", async (initialState) => {
    const scope = await fixture();
    const store = createLinkPreviewStore(context.db);
    let now = 1_000;
    const resolve = vi.fn(async () => ({ preview: initialState === "open" ? { ...preview, state: "open" as const } : null, maxAgeMs: 60_000 }));
    const first = createLinkPreviewService([{ key: "github", resolve }], { store, now: () => now });
    await first.get(scope, url);
    now = 62_000;
    const other = createLinkPreviewService([{ key: "github", resolve: async () => ({ preview, maxAgeMs: 60_000 }) }], { store, now: () => now });
    await other.get(scope, url);
    resolve.mockRejectedValue(new Error("provider unavailable"));

    expect((await first.get(scope, url)).preview).toEqual(preview);
    expect(resolve).toHaveBeenCalledTimes(1);
    const saved = (await store.read(scope, [target])).get(url)!;
    expect(saved.result.preview).toEqual(preview);
    expect(saved.expiresAt).toBe(122_000);
  });
  it.each(["failure", "timeout"])("retains the newest stale stored preview on provider %s", async (failure) => {
    const scope = await fixture();
    const store = createLinkPreviewStore(context.db);
    let now = 1_000;
    let requests = 0;
    const resolve = async (_target: import("@paperclipai/shared").LinkPreviewTarget, _scope: import("../services/link-previews.js").LinkPreviewScope, signal: AbortSignal) => {
      if (++requests === 1) return { preview: { ...preview, state: "open" as const }, maxAgeMs: 60_000 };
      if (failure === "failure") throw new Error("provider unavailable");
      return new Promise<never>((_done, reject) => signal.addEventListener("abort", () => reject(new Error("timeout"))));
    };
    const first = createLinkPreviewService([{ key: "github", resolve }], { store, now: () => now, timeoutMs: 100 });
    await first.get(scope, url);
    now = 62_000;
    await store.write(scope, target, { result: { preview, maxAgeMs: 1_000 }, expiresAt: 63_000 }, now);
    now = 64_000;
    expect((await first.get(scope, url)).preview).toEqual(preview);
    await vi.waitFor(async () => expect((await store.read(scope, [target])).get(url)?.expiresAt).toBe(124_000));
    expect((await store.read(scope, [target])).get(url)?.result.preview).toEqual(preview);
  });
  it("compares check times rather than cache lifetimes when hydrating", async () => {
    const scope = await fixture();
    const store = createLinkPreviewStore(context.db);
    let now = 1_000;
    await store.write(scope, target, { result: { preview: { ...preview, state: "open" }, maxAgeMs: 60_000 }, expiresAt: 61_000 }, now);
    const service = createLinkPreviewService([{ key: "github", resolve: async () => ({ preview: null, maxAgeMs: 60_000 }) }], { store, now: () => now });
    await service.cached(scope, [url]);
    await store.write(scope, target, { result: { preview, maxAgeMs: 1_000 }, expiresAt: 4_000 }, 3_000);
    now = 5_000;
    expect((await service.cached(scope, [url])).results[url]).toEqual({ preview, maxAgeMs: 0 });
  });
  it("keeps a failed durable read's fallback local and accepts recovered stored status", async () => {
    const scope = await fixture();
    const store = createLinkPreviewStore(context.db);
    const read = vi.fn(store.read);
    let now = 1_000;
    const resolve = vi.fn(async () => ({ preview: { ...preview, state: "open" as const }, maxAgeMs: 60_000 }));
    const first = createLinkPreviewService([{ key: "github", resolve }], { store: { ...store, read }, now: () => now });
    await first.get(scope, url);
    now = 62_000;
    await store.write(scope, target, { result: { preview, maxAgeMs: 60_000 }, expiresAt: 122_000 }, now);
    now = 64_000;
    read.mockRejectedValueOnce(new Error("temporary database outage"));
    resolve.mockRejectedValueOnce(new Error("provider unavailable"));
    expect((await first.get(scope, url)).preview?.state).toBe("open");
    const saved = (await store.read(scope, [target])).get(url)!;
    expect(saved.result.preview).toEqual(preview);
    expect(saved.expiresAt).toBe(122_000);
    expect((await first.cached(scope, [url])).results[url].preview).toEqual(preview);
  });
  it.each(["missing", "failed"])("reads another replica's saved status after a %s batch read", async (initialRead) => {
    const scope = await fixture();
    const store = createLinkPreviewStore(context.db);
    const read = vi.fn(store.read);
    if (initialRead === "failed") read.mockRejectedValueOnce(new Error("temporary database outage"));
    const write = vi.fn(store.write);
    const resolve = vi.fn(async () => { throw new Error("provider unavailable"); });
    const first = createLinkPreviewService([{ key: "github", resolve }], { store: { read, write } });
    expect(await first.cached(scope, [url])).toEqual({ results: {} });

    const other = createLinkPreviewService([{ key: "github", resolve: async () => ({ preview, maxAgeMs: 60_000 }) }], { store });
    await other.get(scope, url);
    expect((await first.get(scope, url)).preview).toEqual(preview);
    expect(read).toHaveBeenCalledTimes(2);
    expect(resolve).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect((await store.read(scope, [target])).get(url)?.result.preview).toEqual(preview);
  });
  it("survives service recreation, reuses canonical URLs across tasks, and isolates viewers/companies", async () => {
    const scope = await fixture();
    const store = createLinkPreviewStore(context.db);
    const resolve = vi.fn(async () => ({ preview, maxAgeMs: 60_000 }));
    const make = () => createLinkPreviewService([{ key: "github", resolve }], { store });
    await make().get(scope, url);
    const restored = await make().cached(scope, [url, "https://www.github.com/ACME/WEB/pull/42/files#review"]);
    expect(Object.keys(restored.results)).toEqual([url]);
    expect(restored.results[url].preview).toMatchObject({ title: preview.title, state: "merged", target: { canonicalUrl: url } });
    expect(restored.results[url].maxAgeMs).toBeGreaterThan(0);
    await make().get(scope, url);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(await make().cached({ ...scope, userId: "bob" }, [url])).toEqual({ results: {} });
    expect(await make().cached(await fixture(), [url])).toEqual({ results: {} });
  });
  it("returns stale status immediately, refreshes on demand, and persists negative freshness", async () => {
    const scope = await fixture();
    const store = createLinkPreviewStore(context.db);
    let now = 1_000;
    const resolve = vi.fn(async () => ({ preview, maxAgeMs: 60_000 }));
    const make = () => createLinkPreviewService([{ key: "github", resolve }], { store, now: () => now });
    await make().get(scope, url);
    now += 61_000;
    expect((await make().cached(scope, [url])).results[url]).toEqual({ preview, maxAgeMs: 0 });
    expect(resolve).toHaveBeenCalledTimes(1);
    resolve.mockRejectedValueOnce(new Error("outage"));
    expect((await make().get(scope, url)).preview).toEqual(preview);
    await make().get(scope, url);
    expect(resolve).toHaveBeenCalledTimes(2);
    const missing = url + "1";
    resolve.mockRejectedValueOnce(new Error("private"));
    await make().get(scope, missing);
    await make().get(scope, missing);
    expect(resolve).toHaveBeenCalledTimes(3);
    expect((await make().cached(scope, [missing])).results[missing].preview).toBeNull();
  });
  it("persists provider timeout freshness across service restarts without extending the response", async () => {
    const scope = await fixture();
    const database = createLinkPreviewStore(context.db);
    let saved!: () => void;
    const persisted = new Promise<void>(done => { saved = done; });
    const store = { ...database, write: async (...args: Parameters<typeof database.write>) => { await database.write(...args); saved(); } };
    const resolve = vi.fn((_target: import("@paperclipai/shared").LinkPreviewTarget, _scope: import("../services/link-previews.js").LinkPreviewScope, signal: AbortSignal) => new Promise<never>((_done, reject) => {
      signal.addEventListener("abort", () => reject(new Error("timeout")));
    }));
    const first = createLinkPreviewService([{ key: "github", resolve }], { store, timeoutMs: 100 });
    expect((await first.get(scope, url)).preview).toBeNull();
    await persisted;
    const restarted = createLinkPreviewService([{ key: "github", resolve }], { store });
    expect((await restarted.get(scope, url)).preview).toBeNull();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect((await restarted.cached(scope, [url])).results[url].maxAgeMs).toBeGreaterThan(0);
  });
  it("reads a 50-link page in one indexed select and does not require task relationships", async () => {
    const scope = await fixture();
    const store = createLinkPreviewStore(context.db);
    const targets = Array.from({ length: 50 }, (_, n) => recognizeLinkPreview(url + n)!);
    await Promise.all(targets.map(t => store.write(scope, t, { result: { preview: { ...preview, target: t }, maxAgeMs: 60_000 }, expiresAt: 61_000 }, 1_000)));
    const select = vi.spyOn(context.db, "select");
    expect((await store.read(scope, targets)).size).toBe(50);
    expect(select).toHaveBeenCalledTimes(1);
    select.mockRestore();
    const plan = await context.db.execute(sql`EXPLAIN SELECT * FROM link_previews WHERE company_id = ${scope.companyId} AND viewer_id = 'alice' AND canonical_url IN (${sql.join(targets.map(t => sql`${t.canonicalUrl}`), sql`, `)})`);
    expect(JSON.stringify(plan)).toContain("link_previews_scope_url_uq");
  });
  it("supports other channels/statuses and older writers cannot replace newer results", async () => {
    const scope = await fixture();
    const store = createLinkPreviewStore(context.db);
    const deployment = { ...target, provider: "vercel", kind: "deployment", canonicalUrl: "https://vercel.com/acme/build/123" };
    await context.db.insert(linkPreviews).values({ companyId: scope.companyId, viewerId: scope.userId, channel: deployment.provider,
      resourceKind: deployment.kind, canonicalUrl: deployment.canonicalUrl, status: "deployed", metadata: { deploymentId: "123", region: "iad1" }, checkedAt: new Date(), expiresAt: new Date() });
    await store.write(scope, target, { result: { preview, maxAgeMs: 60_000 }, expiresAt: 65_000 }, 5_000);
    await store.write(scope, target, { result: { preview: { ...preview, state: "open" }, maxAgeMs: 60_000 }, expiresAt: 61_000 }, 1_000);
    expect((await store.read(scope, [target])).get(url)?.result.preview?.state).toBe("merged");
    const migration = await readFile(new URL("../../../packages/db/src/migrations/0489_real_sage.sql", import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) if (statement.trim()) await context.db.execute(sql.raw(statement));
    expect((await store.read(scope, [target])).get(url)?.result.preview?.state).toBe("merged");
  });
});
