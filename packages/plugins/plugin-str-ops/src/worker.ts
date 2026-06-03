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

    // CouchDB record store. Config from env; default localhost.
    const couchUrl = process.env.STR_OPS_COUCHDB_URL ?? "http://127.0.0.1:5984";
    const couchDb = process.env.STR_OPS_COUCHDB_DB ?? "str_ops";
    const http = createCouchHttp({
      baseUrl: couchUrl,
      user: process.env.STR_OPS_COUCHDB_USER,
      password: process.env.STR_OPS_COUCHDB_PASSWORD,
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
