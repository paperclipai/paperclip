import type { ToolRunContext } from "@paperclipai/plugin-sdk";
import type { ChannelProvider } from "./providers/types.js";
import type { StrOpsStore } from "./store/types.js";
import { ingestNewBookings } from "./domain/ingest.js";
import { isPropertyAvailable, nightsBetween } from "./domain/availability.js";

export interface RegisterDeps {
  defaultCompanyId: string;
  store: StrOpsStore;
  channelProvider: ChannelProvider;
}

interface RegisterCtx {
  tools: { register(name: string, def: unknown, handler: (params: unknown, runCtx: ToolRunContext) => Promise<unknown>): void };
  jobs: { register(jobKey: string, handler: (job: { jobKey: string; runId: string; trigger: string; scheduledAt: string }) => Promise<unknown>): void };
  data: { register(key: string, handler: (params?: Record<string, unknown>) => Promise<unknown>): void };
  logger: { info: (msg: string, meta?: Record<string, unknown>) => void; warn: (msg: string, meta?: Record<string, unknown>) => void; error: (msg: string, meta?: Record<string, unknown>) => void };
}

function reqString(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  if (typeof v !== "string" || v.trim() === "") throw new Error(`${key} is required`);
  return v;
}

/** Resolve authoritative companyId from the run context.
 *  Returns null (scope violation) if the caller supplied a companyId that differs from the run-scoped one. */
function resolveCompany(
  params: Record<string, unknown>,
  runCtx: ToolRunContext,
  defaultCompanyId: string,
): string | null {
  const authoritative = runCtx.companyId ?? defaultCompanyId;
  const caller = typeof params.companyId === "string" && params.companyId ? params.companyId : null;
  if (caller !== null && caller !== authoritative) return null;
  return authoritative;
}

const SCOPE_VIOLATION = { content: "company_scope_violation", data: { error: "company_scope_violation" } } as const;

export function registerStrOps(ctx: RegisterCtx, deps: RegisterDeps): void {
  const { store, channelProvider, defaultCompanyId } = deps;

  ctx.data.register("health", async () => ({ status: "ok", plugin: "str-ops" }));

  ctx.tools.register("list_properties", {
    displayName: "List properties",
    description: "List STR properties for the company.",
    parametersSchema: { type: "object", properties: { companyId: { type: "string" } } },
  }, async (params, runCtx) => {
    const p = params as Record<string, unknown>;
    const companyId = resolveCompany(p, runCtx, defaultCompanyId);
    if (companyId === null) return SCOPE_VIOLATION;
    const properties = await store.listProperties(companyId);
    return { content: `${properties.length} properties`, data: { properties } };
  });

  ctx.tools.register("get_owner", {
    displayName: "Get owner",
    description: "Fetch an owner by id.",
    parametersSchema: { type: "object", properties: { companyId: { type: "string" }, ownerId: { type: "string" } }, required: ["ownerId"] },
  }, async (params, runCtx) => {
    const p = params as Record<string, unknown>;
    const companyId = resolveCompany(p, runCtx, defaultCompanyId);
    if (companyId === null) return SCOPE_VIOLATION;
    const owner = await store.getOwner(companyId, reqString(p, "ownerId"));
    return { content: owner ? owner.name : "not found", data: { owner } };
  });

  ctx.tools.register("list_bookings", {
    displayName: "List bookings",
    description: "List bookings for the company, optionally filtered by property.",
    parametersSchema: { type: "object", properties: { companyId: { type: "string" }, propertyId: { type: "string" } } },
  }, async (params, runCtx) => {
    const p = params as Record<string, unknown>;
    const companyId = resolveCompany(p, runCtx, defaultCompanyId);
    if (companyId === null) return SCOPE_VIOLATION;
    const propertyId = typeof p.propertyId === "string" ? p.propertyId : undefined;
    const bookings = await store.listBookings(companyId, propertyId ? { propertyId } : undefined);
    return { content: `${bookings.length} bookings`, data: { bookings } };
  });

  ctx.tools.register("check_availability", {
    displayName: "Check availability",
    description: "Return whether a property is free for a date range.",
    parametersSchema: {
      type: "object",
      properties: { companyId: { type: "string" }, propertyId: { type: "string" }, checkIn: { type: "string" }, checkOut: { type: "string" } },
      required: ["propertyId", "checkIn", "checkOut"],
    },
  }, async (params, runCtx) => {
    const p = params as Record<string, unknown>;
    const companyId = resolveCompany(p, runCtx, defaultCompanyId);
    if (companyId === null) return SCOPE_VIOLATION;
    const available = await isPropertyAvailable(store, companyId, reqString(p, "propertyId"), reqString(p, "checkIn"), reqString(p, "checkOut"));
    return { content: available ? "available" : "unavailable", data: { available } };
  });

  ctx.tools.register("upsert_booking", {
    displayName: "Upsert booking",
    description: "Create a confirmed booking after an availability check (manual entry).",
    parametersSchema: {
      type: "object",
      properties: {
        companyId: { type: "string" }, propertyId: { type: "string" }, channel: { type: "string" },
        externalRef: { type: "string" }, checkIn: { type: "string" }, checkOut: { type: "string" },
        guestName: { type: "string" }, guestContact: { type: "string" }, guestLocale: { type: "string" },
        grossCents: { type: "number" }, feesCents: { type: "number" },
      },
      required: ["propertyId", "channel", "externalRef", "checkIn", "checkOut", "guestName", "guestContact"],
    },
  }, async (params, runCtx) => {
    const p = params as Record<string, unknown>;
    const companyId = resolveCompany(p, runCtx, defaultCompanyId);
    if (companyId === null) return SCOPE_VIOLATION;
    const propertyId = reqString(p, "propertyId");
    if (!(await store.getProperty(companyId, propertyId))) {
      return { content: "unknown property", data: { created: null, unknownProperty: true } };
    }
    const checkIn = reqString(p, "checkIn");
    const checkOut = reqString(p, "checkOut");
    if (!(await isPropertyAvailable(store, companyId, propertyId, checkIn, checkOut))) {
      return { content: "conflict: dates unavailable", data: { created: null, conflict: true } };
    }
    const guest = await store.upsertGuestByContact({
      companyId, name: reqString(p, "guestName"), contact: reqString(p, "guestContact"),
      locale: p.guestLocale === "fr" ? "fr" : "en",
    });
    const booking = await store.insertBooking({
      companyId, propertyId, guestId: guest.id, channel: reqString(p, "channel"),
      status: "confirmed", checkIn, checkOut, nights: nightsBetween(checkIn, checkOut),
      grossCents: typeof p.grossCents === "number" ? p.grossCents : 0,
      feesCents: typeof p.feesCents === "number" ? p.feesCents : 0,
      externalRef: reqString(p, "externalRef"),
    });
    return { content: `booking created (${booking.nights} nights)`, data: { created: booking } };
  });

  ctx.jobs.register("channel-poll", async (job) => {
    const result = await ingestNewBookings({ companyId: defaultCompanyId, store, channelProvider });
    ctx.logger.info("channel-poll ingested bookings", { runId: job.runId, ...summarize(result) });
    return summarize(result);
  });
}

function summarize(result: { created: unknown[]; skippedDuplicate: number; skippedUnknownProperty: number; skippedConflict: number }) {
  return {
    created: result.created.length,
    skippedDuplicate: result.skippedDuplicate,
    skippedUnknownProperty: result.skippedUnknownProperty,
    skippedConflict: result.skippedConflict,
  };
}
