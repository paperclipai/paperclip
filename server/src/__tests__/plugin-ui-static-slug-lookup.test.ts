/**
 * Regression test for MYO-500: `GET /_plugins/:pluginId/ui/*` returned a 500
 * when `:pluginId` was a plugin key (slug, e.g. "acme.example") instead of
 * the database UUID.
 *
 * Root cause: drizzle-orm's postgres-js driver wraps the raw `postgres`
 * `PostgresError` in a `DrizzleQueryError`. The route's fallback logic
 * checked `error.code` to detect an invalid-UUID lookup (SQLSTATE 22P02)
 * and fall back to a plugin-key lookup, but that code lives on
 * `error.cause`, not on the wrapper itself — so the check always missed and
 * the error propagated as an unhandled 500 instead of falling back to
 * `getByKey`.
 *
 * This test exercises the real `pluginRegistryService` against an embedded
 * Postgres instance (no registry mocking) so it reproduces the actual
 * driver error shape.
 */
import express from "express";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, plugins, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { pluginUiStaticRoutes } from "../routes/plugin-ui-static.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin UI slug lookup tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("plugin UI static route — slug vs UUID lookup", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db: Db;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("plugin-ui-static-slug-lookup");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterAll(async () => {
    if (stopDb) await stopDb();
  });

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function createPluginPackage(source = "export const marker = 'slug-lookup-bundle';\n") {
    const packageRoot = path.join(tmpdir(), `paperclip-plugin-ui-static-slug-${randomUUID()}`);
    const uiDir = path.join(packageRoot, "dist", "ui");
    mkdirSync(uiDir, { recursive: true });
    writeFileSync(path.join(uiDir, "index.js"), source);
    tempDirs.push(packageRoot);
    return packageRoot;
  }

  async function createApp() {
    const app = express();
    app.use((req, _res, next) => {
      req.actor = { type: "none", source: "none" } as typeof req.actor;
      next();
    });
    app.use(pluginUiStaticRoutes(db, { localPluginDir: tmpdir() }));
    app.use(errorHandler);
    return app;
  }

  async function installPlugin(pluginKey: string, packageRoot: string) {
    const [row] = await db
      .insert(plugins)
      .values({
        pluginKey,
        packageName: "paperclip-plugin-slug-lookup-example",
        version: "1.0.0",
        status: "ready",
        packagePath: packageRoot,
        manifestJson: {
          id: pluginKey,
          entrypoints: {
            ui: "./dist/ui",
          },
        } as never,
      })
      .returning();
    return row;
  }

  it("serves the UI bundle when addressed by database UUID", async () => {
    const packageRoot = createPluginPackage();
    const plugin = await installPlugin("yesterday-ai.paperclip-plugin-company-wizard-uuid", packageRoot);
    const app = await createApp();

    const res = await request(app).get(`/_plugins/${plugin.id}/ui/index.js`);

    expect(res.status).toBe(200);
    expect(res.text).toContain("slug-lookup-bundle");
  });

  it("serves the UI bundle when addressed by plugin_key slug instead of UUID", async () => {
    const packageRoot = createPluginPackage();
    const pluginKey = "yesterday-ai.paperclip-plugin-company-wizard";
    await installPlugin(pluginKey, packageRoot);
    const app = await createApp();

    const res = await request(app).get(`/_plugins/${pluginKey}/ui/index.js`);

    expect(res.status).toBe(200);
    expect(res.text).toContain("slug-lookup-bundle");
  });

  it("returns 404 (not 500) for an unknown plugin_key slug", async () => {
    const app = await createApp();

    const res = await request(app).get("/_plugins/does.not.exist/ui/index.js");

    expect(res.status).toBe(404);
  });
});
