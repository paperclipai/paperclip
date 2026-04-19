import type { PluginContext } from "@paperclipai/plugin-sdk";
import { sendMessage, escapeMarkdownV2 } from "./telegram-api.js";
import { METRIC_NAMES } from "./constants.js";
import type { Watch, WatchCondition, RegisterWatchParams } from "./types.js";

const BUILTIN_TEMPLATES: Record<
  string,
  Omit<Watch, "watchId" | "chatId" | "threadId" | "companyId" | "createdBy" | "createdAt">
> = {
  "invoice-overdue": {
    name: "Invoice Overdue",
    description: "Alert when invoices are past due",
    entityType: "custom",
    conditions: [
      { field: "dueDate", operator: "lt", value: "{{now}}" },
      { field: "status", operator: "ne", value: "paid" },
    ],
    template: "Invoice {{entityId}} is overdue (due: {{dueDate}}). Consider sending a follow-up.",
  },
  "lead-stale": {
    name: "Stale Lead",
    description: "Alert when leads have no activity for 7+ days",
    entityType: "custom",
    conditions: [
      { field: "lastActivityAt", operator: "lt", value: "{{7daysAgo}}" },
      { field: "status", operator: "eq", value: "active" },
    ],
    template: "Lead {{entityId}} has been inactive for 7+ days. Consider re-engagement.",
  },
};

export async function handleRegisterWatch(ctx: PluginContext, params: RegisterWatchParams, companyId: string) {
  const name = String(params.name ?? "");
  const description = String(params.description ?? "");
  const entityType = String(params.entityType ?? "custom") as Watch["entityType"];
  const conditions = params.conditions ?? [];
  const template = String(params.template ?? "");
  const chatId = String(params.chatId ?? "");
  const threadId = params.threadId ? Number(params.threadId) : undefined;
  const useBuiltin = params.builtinTemplate ? String(params.builtinTemplate) : undefined;

  if (!name && !useBuiltin) return { error: "Either 'name' or 'builtinTemplate' is required" };
  if (!chatId) return { error: "'chatId' is required" };

  let watch: Watch;
  const watchId = `watch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  if (useBuiltin && BUILTIN_TEMPLATES[useBuiltin]) {
    const builtin = BUILTIN_TEMPLATES[useBuiltin];
    watch = {
      ...builtin,
      watchId,
      chatId,
      threadId,
      companyId,
      createdBy: "agent",
      createdAt: new Date().toISOString(),
    };
  } else {
    if (!template) return { error: "'template' is required for custom watches" };
    watch = {
      watchId,
      name,
      description,
      entityType,
      conditions,
      template,
      chatId,
      threadId,
      companyId,
      createdBy: "agent",
      createdAt: new Date().toISOString(),
    };
  }

  const watches = await getWatchRegistry(ctx, companyId);
  watches.push(watch);
  await saveWatchRegistry(ctx, companyId, watches);
  return { content: JSON.stringify({ status: "registered", watchId, name: watch.name }) };
}

export async function checkWatches(
  ctx: PluginContext,
  token: string,
  config: { maxSuggestionsPerHourPerCompany: number; watchDeduplicationWindowMs: number },
) {
  const companies = await ctx.companies.list();
  for (const company of companies) {
    try {
      await checkWatchesForCompany(ctx, token, company.id, config);
    } catch (err) {
      ctx.logger.error("Watch check failed for company", { companyId: company.id, error: String(err) });
    }
  }
}

async function checkWatchesForCompany(
  ctx: PluginContext,
  token: string,
  companyId: string,
  config: { maxSuggestionsPerHourPerCompany: number; watchDeduplicationWindowMs: number },
) {
  const watches = await getWatchRegistry(ctx, companyId);
  if (watches.length === 0) return;

  const hourlyCount = await getHourlySuggestionCount(ctx, companyId);
  if (hourlyCount >= config.maxSuggestionsPerHourPerCompany) {
    ctx.logger.info("Watch suggestions rate-limited for company", { companyId, hourlyCount });
    return;
  }

  let sentThisRun = 0;
  for (const watch of watches) {
    if (hourlyCount + sentThisRun >= config.maxSuggestionsPerHourPerCompany) break;
    try {
      const entities = await evaluateWatch(ctx, watch, companyId);
      for (const entity of entities) {
        if (hourlyCount + sentThisRun >= config.maxSuggestionsPerHourPerCompany) break;
        const isDuplicate = await checkDedup(ctx, watch.watchId, entity.id, config.watchDeduplicationWindowMs);
        if (isDuplicate) continue;
        const message = interpolateTemplate(watch.template, entity);
        await sendMessage(
          ctx,
          token,
          watch.chatId,
          `${escapeMarkdownV2("\u{1f4a1}")} *Suggestion:* ${escapeMarkdownV2(watch.name)}\n\n${escapeMarkdownV2(message)}`,
          {
            parseMode: "MarkdownV2",
            messageThreadId: watch.threadId,
          },
        );
        await recordSuggestion(ctx, watch.watchId, entity.id);
        sentThisRun++;
        watch.lastTriggeredAt = new Date().toISOString();
      }
    } catch (err) {
      ctx.logger.error("Watch evaluation failed", { watchId: watch.watchId, error: String(err) });
    }
  }

  if (sentThisRun > 0) {
    await saveWatchRegistry(ctx, companyId, watches);
    await ctx.metrics.write(METRIC_NAMES.suggestionsEmitted, sentThisRun);
    await incrementHourlySuggestionCount(ctx, companyId, sentThisRun);
  }
}

interface MatchedEntity {
  id: string;
  [key: string]: unknown;
}

async function evaluateWatch(ctx: PluginContext, watch: Watch, companyId: string): Promise<MatchedEntity[]> {
  const matches: MatchedEntity[] = [];
  switch (watch.entityType) {
    case "issue": {
      const issues = await ctx.issues.list({ companyId, limit: 100 });
      for (const issue of issues) {
        if (matchesConditions(issue as unknown as Record<string, unknown>, watch.conditions))
          matches.push({ id: issue.id, ...(issue as unknown as Record<string, unknown>) });
      }
      break;
    }
    case "agent": {
      const agents = await ctx.agents.list({ companyId });
      for (const agent of agents) {
        if (matchesConditions(agent as unknown as Record<string, unknown>, watch.conditions))
          matches.push({ id: agent.id, ...(agent as unknown as Record<string, unknown>) });
      }
      break;
    }
    case "custom": {
      const customData = await ctx.state.get({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: `watch_data_${watch.watchId}`,
      });
      if (customData) {
        for (const item of customData as Array<Record<string, unknown>>) {
          if (matchesConditions(item, watch.conditions)) matches.push({ id: String(item.id ?? "unknown"), ...item });
        }
      }
      break;
    }
  }
  return matches;
}

function matchesConditions(record: Record<string, unknown>, conditions: WatchCondition[]): boolean {
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  for (const condition of conditions) {
    const fieldValue = record[condition.field];
    let compareValue: string = condition.value;
    if (compareValue === "{{now}}") compareValue = new Date().toISOString();
    if (compareValue === "{{7daysAgo}}") compareValue = new Date(sevenDaysAgo).toISOString();
    switch (condition.operator) {
      case "eq":
        if (fieldValue !== compareValue) return false;
        break;
      case "ne":
        if (fieldValue === compareValue) return false;
        break;
      case "gt":
        if (!(Number(fieldValue) > Number(compareValue))) return false;
        break;
      case "lt":
        if (!(String(fieldValue) < String(compareValue))) return false;
        break;
      case "contains":
        if (!String(fieldValue ?? "").includes(String(compareValue))) return false;
        break;
      case "exists":
        if ((fieldValue == null) !== !compareValue) return false;
        break;
    }
  }
  return true;
}

function interpolateTemplate(template: string, entity: Record<string, unknown>): string {
  let result = template;
  for (const [key, value] of Object.entries(entity)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), String(value ?? ""));
  }
  return result;
}

async function checkDedup(ctx: PluginContext, watchId: string, entityId: string, windowMs: number): Promise<boolean> {
  const log = (await ctx.state.get({ scopeKind: "instance", stateKey: `suggestion_log_${watchId}_${entityId}` })) as {
    sentAt: string;
  } | null;
  if (!log) return false;
  return Date.now() - new Date(log.sentAt).getTime() < windowMs;
}

async function recordSuggestion(ctx: PluginContext, watchId: string, entityId: string) {
  await ctx.state.set(
    { scopeKind: "instance", stateKey: `suggestion_log_${watchId}_${entityId}` },
    { watchId, entityId, sentAt: new Date().toISOString() },
  );
}

async function getHourlySuggestionCount(ctx: PluginContext, companyId: string): Promise<number> {
  const key = `suggestion_hourly_${companyId}_${new Date().toISOString().slice(0, 13)}`;
  const count = await ctx.state.get({ scopeKind: "instance", stateKey: key });
  return (count as number) ?? 0;
}

async function incrementHourlySuggestionCount(ctx: PluginContext, companyId: string, amount: number) {
  const key = `suggestion_hourly_${companyId}_${new Date().toISOString().slice(0, 13)}`;
  const current = await getHourlySuggestionCount(ctx, companyId);
  await ctx.state.set({ scopeKind: "instance", stateKey: key }, current + amount);
}

async function getWatchRegistry(ctx: PluginContext, companyId: string): Promise<Watch[]> {
  const watches = await ctx.state.get({ scopeKind: "company", scopeId: companyId, stateKey: `watches_${companyId}` });
  return (watches as Watch[]) ?? [];
}

async function saveWatchRegistry(ctx: PluginContext, companyId: string, watches: Watch[]) {
  await ctx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: `watches_${companyId}` }, watches);
}
