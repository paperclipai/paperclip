import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { CouchStore } from "./store/couch-store.js";
import { createCouchHttp } from "./store/couch-http.js";
import { MockChannelProvider } from "./providers/mock-channel.js";
import { registerStrOps } from "./register.js";
import { readFileSync } from "node:fs";
import type { RawBooking } from "./domain/types.js";

function loadSeedBookings(): RawBooking[] {
  try {
    return JSON.parse(readFileSync(new URL("../fixtures/seed-bookings.json", import.meta.url), "utf8")) as RawBooking[];
  } catch {
    return [];
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    // PoC: single company. Resolve the first company as the default scope.
    const companies = await ctx.companies.list();
    const defaultCompanyId = companies[0]?.id ?? "";

    // CouchDB record store. Config from ctx.config (operator-set via POST /api/plugins/:id/config),
    // falling back to env vars (useful in dev when env is not scrubbed).
    const cfg = (await ctx.config.get()) as Record<string, unknown>;
    const s = (v: unknown): string | undefined =>
      typeof v === "string" && v.trim() ? v.trim() : undefined;
    const couchUrl      = s(cfg.couchUrl)      ?? process.env.STR_OPS_COUCHDB_URL      ?? "http://127.0.0.1:5984";
    const couchDb       = s(cfg.couchDb)       ?? process.env.STR_OPS_COUCHDB_DB       ?? "str_ops";
    const couchUser     = s(cfg.couchUser)     ?? process.env.STR_OPS_COUCHDB_USER;
    const couchPassword = s(cfg.couchPassword) ?? process.env.STR_OPS_COUCHDB_PASSWORD;
    const http = createCouchHttp({
      baseUrl: couchUrl,
      user: couchUser,
      password: couchPassword,
    });
    const store = new CouchStore(http, couchDb);
    await store.ensure();

    const channelProvider = new MockChannelProvider(loadSeedBookings());
    registerStrOps(ctx, { defaultCompanyId, store, channelProvider });

    // Demo seed action (operator-triggered).
    ctx.actions.register("seed-demo", async (params) => {
      const { seedDemo } = await import("./seed.js");
      const companyId = typeof params?.companyId === "string" && params.companyId ? params.companyId : defaultCompanyId;
      return seedDemo(store, companyId);
    });
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
