import { timingSafeEqual } from "node:crypto";
import type { LinkConfig } from "./types.js";
import type { BridgeStore } from "./store/types.js";
import type { PaperclipApi } from "./paperclip/types.js";
import type { HermesConnector, InboundMessage } from "./hermes/types.js";
import { syncLink, handleInbound, type SyncDeps } from "./domain/sync.js";

export interface RegisterDeps {
  api: PaperclipApi;
  store: BridgeStore;
  hermes: HermesConnector;
  links: LinkConfig[];
  inboundSecret: string;
}

interface RegisterCtx {
  jobs: { register(jobKey: string, handler: (job: { jobKey: string; runId: string; trigger: string; scheduledAt: string }) => Promise<unknown>): void };
  data: { register(key: string, handler: (params?: Record<string, unknown>) => Promise<unknown>): void };
  actions: { register(key: string, handler: (params: Record<string, unknown>) => Promise<unknown>): void };
  logger: { info: (m: string, meta?: Record<string, unknown>) => void; warn: (m: string, meta?: Record<string, unknown>) => void; error: (m: string, meta?: Record<string, unknown>) => void };
}

function secretOk(provided: unknown, expected: string): boolean {
  if (typeof provided !== "string" || provided.length !== expected.length) return false;
  try { return timingSafeEqual(Buffer.from(provided), Buffer.from(expected)); } catch { return false; }
}

export function registerPartnerBridge(ctx: RegisterCtx, deps: RegisterDeps): void {
  const linkById = new Map(deps.links.map((l) => [l.linkId, l]));
  const syncDeps = (link: LinkConfig): SyncDeps => ({ api: deps.api, store: deps.store, hermes: deps.hermes, link });

  ctx.data.register("health", async () => ({ status: "ok", plugin: "partner-bridge", links: deps.links.map((l) => l.linkId) }));

  ctx.jobs.register("bridge-sync", async (job) => {
    let processed = 0;
    for (const link of deps.links) { await syncLink(syncDeps(link)); processed++; }
    ctx.logger.info("bridge-sync pass complete", { runId: job.runId, links: processed });
    return { links: processed };
  });

  // Hermes -> plugin inbound (POST /api/plugins/:id/actions/inbound). Auth via shared secret in the payload.
  ctx.actions.register("inbound", async (params) => {
    const msg = params as unknown as InboundMessage;
    if (!secretOk(msg.secret, deps.inboundSecret)) return { ok: false, error: "unauthorized" };
    const link = linkById.get(msg.linkId);
    if (!link) return { ok: false, error: "unknown_link" };
    await handleInbound(syncDeps(link), msg);
    return { ok: true };
  });
}
