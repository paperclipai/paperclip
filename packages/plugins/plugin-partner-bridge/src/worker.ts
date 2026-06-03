import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { readFileSync } from "node:fs";
import { CouchStore } from "./store/couch-store.js";
import { createCouchHttp } from "./store/couch-http.js";
import { HttpPaperclipApi } from "./paperclip/api.js";
import { HttpHermesConnector } from "./hermes/http.js";
import { registerPartnerBridge } from "./register.js";
import type { LinkConfig } from "./types.js";

function loadLinks(raw: string | undefined): LinkConfig[] {
  if (raw && raw.trim()) { try { return JSON.parse(raw) as LinkConfig[]; } catch { /* fall through */ } }
  try { return JSON.parse(readFileSync(new URL("../fixtures/link.json", import.meta.url), "utf8")) as LinkConfig[]; } catch { return []; }
}

const plugin = definePlugin({
  async setup(ctx) {
    const cfg = (await ctx.config.get()) as Record<string, unknown>;
    const s = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

    const couchUrl = s(cfg.couchUrl) ?? process.env.PB_COUCHDB_URL ?? "http://127.0.0.1:5984";
    const couchDb = s(cfg.couchDb) ?? process.env.PB_COUCHDB_DB ?? "partner_bridge";
    const http = createCouchHttp({ baseUrl: couchUrl, user: s(cfg.couchUser) ?? process.env.PB_COUCHDB_USER, password: s(cfg.couchPassword) ?? process.env.PB_COUCHDB_PASSWORD });
    const store = new CouchStore(http, couchDb);
    await store.ensure();

    const api = new HttpPaperclipApi({ baseUrl: s(cfg.paperclipBaseUrl) ?? process.env.PB_PAPERCLIP_URL ?? "http://127.0.0.1:3100", token: s(cfg.paperclipToken) });
    const hermes = new HttpHermesConnector({ baseUrl: s(cfg.hermesBaseUrl) ?? "http://127.0.0.1:7400", token: s(cfg.hermesToken) });
    const links = loadLinks(s(cfg.links));
    const inboundSecret = s(cfg.inboundSecret) ?? process.env.PB_INBOUND_SECRET ?? "";

    registerPartnerBridge(ctx, { api, store, hermes, links, inboundSecret });
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
