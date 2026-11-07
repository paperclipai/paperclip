import {
  definePlugin,
  runWorker,
  type PluginApiRequestInput,
  type PluginContext,
  type PluginPerformActionContext,
} from "@paperclipai/plugin-sdk";
import {
  ENTITY_TYPES,
  isCompanyId,
  isRecord,
  PluginRequestError,
  stringField,
} from "./contracts.js";
import { OPERATIONS_JOBS, PLUGIN_ID } from "./manifest.js";
import {
  acceptCashfreeStatusEvent,
  acceptPaddleStatusEvent,
  createPaymentOrder,
} from "./payments.js";
import {
  acceptIntakeEvent,
  convertRequestToClient,
  createClient,
  createFollowUpIssue,
  createLeadFromApi,
  createRequest,
  findEntity,
  listOverview,
  logMutation,
  MAX_RECORDS,
  scopedEntityType,
  updateRecord,
} from "./crm.js";
import {
  createSandboxQualificationTask,
  qualificationTaskStatus,
} from "./qualification.js";

const JOB_BLOCKED_MESSAGE = "This ArchLead operation is a migration hook only; its business logic has not been ported.";

let activeContext: PluginContext | null = null;

function parseLimit(value: string | string[] | undefined): number | null {
  if (value === undefined) return 50;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, MAX_RECORDS) : null;
}

function requireCompanyScope(companyId: unknown): string {
  if (!isCompanyId(companyId)) throw new Error("A valid company scope is required");
  return companyId;
}

function requireMatchingCompany(body: unknown, companyId: string): Record<string, unknown> {
  if (!isRecord(body)) throw new PluginRequestError(400, "Request body must be an object");
  if (body.companyId !== companyId) throw new PluginRequestError(403, "Request company does not match the authorized company");
  return body;
}

function requireActionCompany(
  params: Record<string, unknown>,
  context: PluginPerformActionContext,
): string {
  const hostCompanyId = requireCompanyScope(context.companyId ?? context.actor.companyId);
  if (params.companyId !== undefined && params.companyId !== hostCompanyId) {
    throw new Error("Action company does not match the host-authorized company");
  }
  if (context.actor.type !== "user" || !context.actor.userId) {
    throw new Error("This action requires an authenticated Paperclip board user");
  }
  return hostCompanyId;
}

async function runMutation(
  ctx: PluginContext,
  companyId: string,
  operationValue: unknown,
  rawInput: unknown,
): Promise<unknown> {
  if (!isRecord(rawInput)) throw new Error("Mutation input must be an object");
  const input = requireMatchingCompany({ ...rawInput, companyId: rawInput.companyId ?? companyId }, companyId);
  const operation = stringField(operationValue, 80);
  if (!operation) throw new PluginRequestError(400, "Mutation operation is required");

  if (operation === "create-lead") {
    const result = await createLeadFromApi(ctx, companyId, input);
    if (result.created) {
      await logMutation(ctx, companyId, ENTITY_TYPES.request, result.request.id, "Created an ArchLead lead and CRM request");
    }
    return result;
  }
  if (operation === "create-request") {
    const result = await createRequest(ctx, companyId, input);
    if (result.created) await logMutation(ctx, companyId, ENTITY_TYPES.request, result.record.id, "Created an ArchLead CRM request");
    return result;
  }
  if (operation === "create-client") {
    const result = await createClient(ctx, companyId, input);
    if (result.created) await logMutation(ctx, companyId, ENTITY_TYPES.client, result.record.id, "Created an ArchLead client record");
    return result;
  }
  if (operation === "create-payment-order") {
    const result = await createPaymentOrder(ctx, companyId, input);
    if (result.created) {
      await logMutation(ctx, companyId, "archlead-payment-order", String(result.order.externalId), "Created a pending provider payment order");
    }
    return result;
  }
  if (operation === "create-sandbox-qualification") {
    return createSandboxQualificationTask(ctx, companyId, input);
  }
  if (operation === "update-record") {
    const record = await updateRecord(ctx, companyId, input.entityType, input.externalId, input.patch);
    await logMutation(ctx, companyId, record.entityType, record.id, "Updated an ArchLead Operations record", {
      externalId: record.externalId,
    });
    return record;
  }
  if (operation === "convert-request") {
    const result = await convertRequestToClient(ctx, companyId, input.externalId);
    if (result.created || !result.linked) {
      await logMutation(ctx, companyId, ENTITY_TYPES.client, result.client.id, "Converted a won CRM request to a pending client", {
        requestExternalId: result.request.externalId,
      });
    }
    return result;
  }
  throw new PluginRequestError(400, "Unsupported ArchLead Operations mutation");
}

const plugin = definePlugin({
  async setup(ctx) {
    activeContext = ctx;
    for (const { jobKey } of OPERATIONS_JOBS) {
      ctx.jobs.register(jobKey, async () => {
        throw new Error(`${JOB_BLOCKED_MESSAGE} Job: ${jobKey}`);
      });
    }

    ctx.data.register("overview", async (params) => {
      const companyId = requireCompanyScope(params.companyId);
      const limit = typeof params.limit === "number" ? params.limit : undefined;
      const offset = typeof params.offset === "number" ? params.offset : undefined;
      return listOverview(ctx, companyId, { limit, offset });
    });

    ctx.actions.register("admin-mutation", async (params, actionContext) => {
      const companyId = requireActionCompany(params, actionContext);
      return runMutation(ctx, companyId, params.operation, params);
    });

    ctx.actions.register("create-follow-up-issue", async (params, actionContext) => {
      const companyId = requireActionCompany(params, actionContext);
      return createFollowUpIssue(ctx, companyId, params.entityType, params.externalId);
    });
  },

  async onApiRequest(input: PluginApiRequestInput) {
    const ctx = activeContext;
    if (!ctx) throw new Error("ArchLead Operations worker is not initialized");
    let companyId: string;
    try {
      companyId = requireCompanyScope(input.companyId);
    } catch (error) {
      return { status: 400, body: { error: error instanceof Error ? error.message : "Invalid company scope" } };
    }

    if (input.routeKey === "list-records") {
      const entityType = input.query.entityType === undefined ? null : scopedEntityType(input.query.entityType);
      if (input.query.entityType !== undefined && !entityType) {
        return { status: 400, body: { error: "Unsupported entityType" } };
      }
      const limit = parseLimit(input.query.limit);
      if (limit === null) return { status: 400, body: { error: "limit must be a positive integer" } };
      const records = entityType
        ? await ctx.entities.list({ entityType, scopeKind: "company", scopeId: companyId, limit })
        : (await Promise.all(Object.values(ENTITY_TYPES).map((type) =>
          ctx.entities.list({ entityType: type, scopeKind: "company", scopeId: companyId, limit }),
        ))).flat();
      return { status: 200, body: { records } };
    }

    if (input.routeKey === "get-qualification-task") {
      const externalLeadId = stringField(input.params.externalLeadId, 200);
      if (!externalLeadId) return { status: 400, body: { error: "externalLeadId is required" } };
      const record = await findEntity(ctx, companyId, ENTITY_TYPES.qualificationTask, externalLeadId);
      if (!record) return { status: 404, body: { error: "Sandbox qualification task not found" } };
      return { status: 200, body: await qualificationTaskStatus(ctx, companyId, record) };
    }

    const body = isRecord(input.body) ? input.body : null;
    if (!body) return { status: 400, body: { error: "Request body must be an object" } };
    if (body.companyId !== companyId) {
      return { status: 403, body: { error: "Request company does not match the authorized company" } };
    }

    try {
      if (input.routeKey === "create-lead") {
        const result = await runMutation(ctx, companyId, "create-lead", body);
        return { status: (result as { created: boolean }).created ? 201 : 200, body: result };
      }
      if (input.routeKey === "create-request") {
        const result = await runMutation(ctx, companyId, "create-request", body);
        return { status: (result as { created: boolean }).created ? 201 : 200, body: result };
      }
      if (input.routeKey === "create-client") {
        const result = await runMutation(ctx, companyId, "create-client", body);
        return { status: (result as { created: boolean }).created ? 201 : 200, body: result };
      }
      if (input.routeKey === "create-payment-order") {
        const result = await runMutation(ctx, companyId, "create-payment-order", body);
        return { status: (result as { created: boolean }).created ? 201 : 200, body: result };
      }
      if (input.routeKey === "create-qualification-task") {
        const result = await createSandboxQualificationTask(ctx, companyId, body);
        const { created, ...response } = result;
        return { status: created ? 201 : 200, body: response };
      }
      if (input.routeKey === "update-record") {
        const result = await runMutation(ctx, companyId, "update-record", {
          ...body,
          entityType: input.params.entityType,
          externalId: input.params.externalId,
        });
        return { status: 200, body: result };
      }
      if (input.routeKey === "convert-request") {
        const result = await runMutation(ctx, companyId, "convert-request", {
          ...body,
          externalId: input.params.externalId,
        });
        return { status: 200, body: result };
      }
      return { status: 404, body: { error: "Unknown ArchLead Operations route" } };
    } catch (error) {
      if (error instanceof PluginRequestError) {
        return { status: error.status, body: { error: error.message } };
      }
      throw error;
    }
  },

  async onWebhook(input) {
    const ctx = activeContext;
    if (!ctx) throw new Error("ArchLead Operations worker is not initialized");
    if (input.endpointKey === "intake") {
      await acceptIntakeEvent(ctx, input);
      return;
    }
    if (input.endpointKey === "cashfree-events") {
      await acceptCashfreeStatusEvent(ctx, input);
      return;
    }
    if (input.endpointKey === "paddle-events") {
      await acceptPaddleStatusEvent(ctx, input);
      return;
    }
    throw new Error(`Unsupported ArchLead Operations webhook endpoint: ${input.endpointKey}`);
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
