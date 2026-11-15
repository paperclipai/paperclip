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
    const migration = await readFile(new URL("../../../packages/db/src/migrations/0488_material_masked_marvel.sql", import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) if (statement.trim()) await context.db.execute(sql.raw(statement));
    expect((await store.read(scope, [target])).get(url)?.result.preview?.state).toBe("merged");
  });
});
