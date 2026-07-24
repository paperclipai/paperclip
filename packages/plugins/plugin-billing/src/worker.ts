import { definePlugin, type PaperclipPlugin, type PluginApiRequestInput, type PluginApiResponse, type PluginContext, type PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { PROVIDER_STUB, SWEEP_JOB_KEY, WEBHOOK_ENDPOINT_KEY } from "./constants.js";
import { parseBillingConfig, type BillingConfig } from "./config.js";
import { ensureSubscriptionForCompany, ownerResolverFromContext, type OwnerResolver } from "./creation.js";
import { BillingUserError } from "./domain.js";
import { ensureStubWebhookSecret } from "./hmac.js";
import { HttpStubTransport, SqlStubStateStore, StubProvider, type StubStateStore, type StubTransport } from "./provider/stub.js";
import { BillingService, type ServiceDeps } from "./service.js";
import { standingWriterFromContext } from "./standing.js";
import { SqlBillingStore } from "./store-sql.js";
import type { BillingStore } from "./store.js";
import { runBillingSweep, type SweepDeps } from "./sweep.js";
import { handleProviderWebhook } from "./webhook.js";

export interface WorkerOverrides {
  store?: BillingStore;
  stubStateStore?: StubStateStore;
  transport?: StubTransport;
  now?: () => Date;
  /** Test hook: receives the worker's StubProvider once setup builds it. */
  onStubReady?: (stub: StubProvider) => void;
}

interface RuntimeBase {
  store: BillingStore;
  stub: StubProvider;
  owners: OwnerResolver;
  now: () => Date;
}

// ---------------------------------------------------------------- authz

function requireCompanyFromData(params: Record<string, unknown>): string {
  const companyId = params.companyId;
  if (typeof companyId !== "string" || companyId.length === 0) {
    throw new BillingUserError("company_scope_required", "This data key requires a host-authorized company scope.");
  }
  return companyId;
}

function requireCompanyFromAction(context: PluginPerformActionContext): string {
  if (typeof context.companyId !== "string" || context.companyId.length === 0) {
    throw new BillingUserError("company_scope_required", "This action requires a host-authorized company scope.");
  }
  return context.companyId;
}

/**
 * Bridge calls without a companyId pass assertInstanceAdmin host-side
 * (server/src/routes/plugins.ts assertPluginBridgeScope). A defined
 * context.companyId proves the caller came through the company path instead.
 */
function requireAdminAction(context: PluginPerformActionContext): void {
  if (context.companyId !== null || context.actor.type !== "user") {
    throw new BillingUserError("instance_admin_required", "Only the instance admin bridge path may perform this action.");
  }
}

function requireAdminData(params: Record<string, unknown>): void {
  if (params.companyId !== undefined) {
    throw new BillingUserError("instance_admin_required", "Only the instance admin bridge path may read this data.");
  }
}

function requireTargetCompany(params: Record<string, unknown>): string {
  const target = params.targetCompanyId;
  if (typeof target !== "string" || target.length === 0) {
    throw new BillingUserError("invalid_target", "targetCompanyId is required.");
  }
  return target;
}

function toApiResponse(error: unknown): PluginApiResponse {
  if (error instanceof BillingUserError) {
    const status = error.code === "already_subscribed" || error.code === "checkout_confirming" ? 409 : 400;
    return { status, body: { error: error.code, message: error.message } };
  }
  throw error;
}

// ---------------------------------------------------------------- worker

export function createWorker(overrides: WorkerOverrides = {}): PaperclipPlugin {
  let base: RuntimeBase | null = null;
  let workerState: {
    ctx: PluginContext;
    serviceDeps: () => Promise<ServiceDeps>;
    sweepDeps: () => Promise<SweepDeps>;
  } | null = null;

  const plugin = definePlugin({
    async setup(ctx: PluginContext) {
      const now = overrides.now ?? (() => new Date());
      const store = overrides.store ?? new SqlBillingStore(ctx.db);
      const stubStateStore = overrides.stubStateStore ?? new SqlStubStateStore(ctx.db);
      const secret = await ensureStubWebhookSecret(ctx.state);
      const transport = overrides.transport
        ?? new HttpStubTransport(async () => (await loadConfig(ctx)).instanceBaseUrl);
      const stub = new StubProvider({ store: stubStateStore, secret, transport, now });
      base = { store, stub, owners: ownerResolverFromContext(ctx), now };
      overrides.onStubReady?.(stub);

      async function loadConfig(context: PluginContext): Promise<BillingConfig> {
        try {
          return parseBillingConfig(await context.config.get());
        } catch {
          return parseBillingConfig(undefined);
        }
      }

      async function serviceDeps(): Promise<ServiceDeps> {
        const runtime = base!;
        return {
          store: runtime.store,
          config: await loadConfig(ctx),
          standing: standingWriterFromContext(ctx),
          provider: runtime.stub, // config.provider is "stub" in v1; a future adapter switches here
          logger: ctx.logger,
          now: runtime.now,
          owners: runtime.owners,
        };
      }

      async function sweepDeps(): Promise<SweepDeps> {
        const deps = await serviceDeps();
        return {
          ...deps,
          companies: {
            list: async () => {
              // ctx.companies.list only supports offset/limit windowing (no
              // cursor, no total count) — page to completion instead of
              // taking the first page. A truncated list here is what used to
              // make sweep phase 4 force-cancel every company past company
              // #500 (they looked "deleted"); complete:false tells sweep.ts
              // to skip that phase entirely instead of trusting a partial view.
              const pageSize = 500;
              // Safety ceiling (500k companies) against a host bug that never
              // shrinks the page below pageSize — bail out rather than loop
              // forever, and report the list as incomplete.
              const maxPages = 1000;
              const companies: Array<{ id: string; status: string }> = [];
              let offset = 0;
              for (let page = 0; page < maxPages; page += 1) {
                const batch = await ctx.companies.list({ limit: pageSize, offset });
                for (const company of batch) {
                  companies.push({ id: company.id, status: String(company.status) });
                }
                if (batch.length < pageSize) {
                  return { companies, complete: true };
                }
                offset += pageSize;
              }
              ctx.logger.warn("billing sweep: company list pagination hit its safety cap; treating as incomplete", {
                pagesRead: maxPages,
                companiesRead: companies.length,
              });
              return { companies, complete: false };
            },
          },
          stub: deps.config.provider === PROVIDER_STUB ? base!.stub : undefined,
        };
      }

      // ---- company lifecycle: company.created exists in the catalog; company.deleted
      // ---- does NOT (sweep-only detection — Global Constraints deviation 4).
      ctx.events.on("company.created", async (event) => {
        const companyId = event.companyId;
        if (!companyId) return;
        await ensureSubscriptionForCompany(await sweepDeps(), companyId);
      });

      ctx.jobs.register(SWEEP_JOB_KEY, async () => {
        const report = await runBillingSweep(await sweepDeps());
        ctx.logger.info("billing sweep finished", { ...report });
      });

      // ---- data (UI bridge reads)
      ctx.data.register("billing-summary", async (params) => {
        const companyId = requireCompanyFromData(params);
        return new BillingService(await serviceDeps()).summary(companyId);
      });

      ctx.data.register("stub-session", async (params) => {
        const companyId = requireCompanyFromData(params);
        const sessionRef = String(params.sessionRef ?? "");
        const session = await base!.stub.getSession(sessionRef);
        if (!session || session.companyId !== companyId) {
          throw new BillingUserError("forbidden", "forbidden: session does not belong to this company");
        }
        return session;
      });

      ctx.data.register("admin-overview", async (params) => {
        requireAdminData(params);
        return new BillingService(await serviceDeps()).adminOverview();
      });

      // ---- actions (UI bridge mutations)
      ctx.actions.register("create-checkout", async (_params, context) => {
        const companyId = requireCompanyFromAction(context);
        return new BillingService(await serviceDeps()).createCheckout(companyId);
      });

      ctx.actions.register("resolve-checkout", async (params, context) => {
        const companyId = requireCompanyFromAction(context);
        return new BillingService(await serviceDeps()).resolveCheckout(companyId, String(params.sessionRef ?? ""));
      });

      ctx.actions.register("one-click-subscribe", async (_params, context) => {
        const companyId = requireCompanyFromAction(context);
        return new BillingService(await serviceDeps()).oneClickSubscribe(companyId);
      });

      ctx.actions.register("cancel-at-period-end", async (_params, context) => {
        const companyId = requireCompanyFromAction(context);
        return new BillingService(await serviceDeps()).cancelAtPeriodEnd(companyId);
      });

      ctx.actions.register("resume-subscription", async (_params, context) => {
        const companyId = requireCompanyFromAction(context);
        return new BillingService(await serviceDeps()).resume(companyId);
      });

      ctx.actions.register("open-portal", async (_params, context) => {
        const companyId = requireCompanyFromAction(context);
        return new BillingService(await serviceDeps()).portal(companyId);
      });

      ctx.actions.register("stub-checkout-complete", async (params, context) => {
        const companyId = requireCompanyFromAction(context);
        const sessionRef = String(params.sessionRef ?? "");
        const session = await base!.stub.getSession(sessionRef);
        if (!session || session.companyId !== companyId) {
          throw new BillingUserError("forbidden", "forbidden: session does not belong to this company");
        }
        const outcome = String(params.outcome ?? "pay");
        if (outcome === "fail") {
          await base!.stub.failCheckout(sessionRef);
        } else if (outcome === "cancel") {
          await base!.stub.cancelCheckout(sessionRef);
        } else {
          const savePaymentMethod = params.savePaymentMethod === true;
          await base!.stub.completeCheckout(sessionRef, { savePaymentMethod });
          if (savePaymentMethod) {
            const deps = await serviceDeps();
            const sub = await deps.store.getSubscriptionByCompany(companyId);
            if (sub) await new BillingService(deps).markSavedMethod(sub.ownerUserId);
          }
        }
        return { ok: true, session: await base!.stub.getSession(sessionRef) };
      });

      // ---- admin actions (instance-admin bridge path only)
      ctx.actions.register("admin-set-price-override", async (params, context) => {
        requireAdminAction(context);
        const target = requireTargetCompany(params);
        const priceCents = params.priceCents === null || params.priceCents === undefined ? null : Number(params.priceCents);
        return new BillingService(await serviceDeps()).adminSetPriceOverride(target, priceCents);
      });

      ctx.actions.register("admin-extend-trial", async (params, context) => {
        requireAdminAction(context);
        const target = requireTargetCompany(params);
        return new BillingService(await serviceDeps()).adminExtendTrial(target, Number(params.days));
      });

      ctx.actions.register("admin-force-resync", async (params, context) => {
        requireAdminAction(context);
        const target = requireTargetCompany(params);
        return new BillingService(await serviceDeps()).adminForceResync(target);
      });

      // stash for onWebhook/onApiRequest closures
      workerState = { ctx, serviceDeps, sweepDeps };
    },

    async onWebhook(input) {
      if (!workerState) throw new Error("billing worker not initialized");
      if (input.endpointKey !== WEBHOOK_ENDPOINT_KEY) {
        throw new Error(`unknown webhook endpoint: ${input.endpointKey}`);
      }
      await handleProviderWebhook(await workerState.serviceDeps(), {
        headers: input.headers,
        rawBody: input.rawBody,
      });
    },

    async onApiRequest(input: PluginApiRequestInput): Promise<PluginApiResponse> {
      if (!workerState) return { status: 503, body: { error: "not_initialized" } };
      const service = new BillingService(await workerState.serviceDeps());
      try {
        switch (input.routeKey) {
          case "creation-summary": {
            const userId = input.actor.userId;
            if (!userId) return { status: 403, body: { error: "board_user_required" } };
            return { status: 200, body: await service.creationSummary(userId) };
          }
          case "summary":
            return { status: 200, body: await service.summary(input.companyId) };
          case "create-checkout":
            return { status: 200, body: await service.createCheckout(input.companyId) };
          case "resolve-checkout": {
            const sessionRef = String((input.body as Record<string, unknown> | null)?.sessionRef ?? "");
            return { status: 200, body: await service.resolveCheckout(input.companyId, sessionRef) };
          }
          case "one-click":
            return { status: 200, body: await service.oneClickSubscribe(input.companyId) };
          case "cancel":
            return { status: 200, body: await service.cancelAtPeriodEnd(input.companyId) };
          case "resume":
            return { status: 200, body: await service.resume(input.companyId) };
          case "portal":
            return { status: 200, body: await service.portal(input.companyId) };
          default:
            return { status: 404, body: { error: `unknown billing route: ${input.routeKey}` } };
        }
      } catch (error) {
        return toApiResponse(error);
      }
    },

    async onHealth() {
      return { status: "ok", message: "billing worker running" };
    },
  });

  return plugin;
}

export default createWorker();
