import { groundedOverviewBlocker, reportsRecordedTaskState } from "./recorded-work-claims.js";
import type { ChatCatalogCase } from "../chat-catalog-contract.js";
import { project, task, goal, putDocument, entity, observation, checks, hasLink, sameTask, type Entity } from "./internal-support.js";
import { makeDefinition, retryDefinition, fixtureWorker } from "./internal-definition.js";

export function grade_activity(value: unknown) {
  const c = checks(); const o = observation(value);
  c.add("complete-independent-observation", !!o, "Missing API, document, audit or rendered-link evidence cannot pass.");
  if (!o) return c.result();
  const before = o.state.task ? entity(o.state, "task") : undefined;
  const current = before && o.tasks.find(row => row.id === before.id);
  const savedProject = o.state.project ? entity(o.state, "project") : undefined;
  const projectNow = savedProject && o.projects.find(row => row.id === savedProject.id);
  const authored = (action: string, id: string) => o.activity.some(row => row.action === action && row.entityId === id && row.agentId === o.leadId);
  const linkedTask = () => !!current && hasLink(o, "issues", current);
  switch (o.scenarioId) {
    case "activity.company-overview": {
      const blocked = entity(o.state, "blockedTask"); const done = entity(o.state, "doneTask"); const worker = entity(o.state, "worker");
      const expected = [before, blocked, done].filter((row): row is Entity => !!row);
      c.add("actual-work-summary", expected.length === 3 && expected.every(row => sameTask(row, o.tasks.find(now => now.id === row.id)) && hasLink(o, "issues", row))
        && !!before && reportsRecordedTaskState(o.reply, before, expected, "in_progress")
        && reportsRecordedTaskState(o.reply, blocked, expected, "blocked") && reportsRecordedTaskState(o.reply, done, expected, "done"),
        "The overview links the actual active, blocked and completed work without changing its state.");
      c.add("grounded-blocker", groundedOverviewBlocker(o.reply, blocked, expected, o.state.blocker), "The blocked task carries the actual recorded reason and the answer grounds that reason in the same task without claiming it is resolved. Incidental fixture nonces are not a user requirement.");
      c.add("idle-is-not-broken", o.agents?.some(row => row.id === worker.id && row.status === "idle") === true
        && /\bMorgan\b[^.\n]*\b(?:idle|available|not currently working)\b/i.test(o.reply)
        && !/\bMorgan\b\s+(?:is|looks|appears)\s+(?:broken|failed|stuck)/i.test(o.reply),
        "The actual idle engineer is described as available, without claiming a runtime failure.");
      const asserted = [...o.reply.matchAll(/\b(\d+)\s+(active|blocked|completed|done)\s+(?:tasks?|items?)\b/gi)];
      c.add("scoped-counts", asserted.every(match => Number(match[1]) === 1) && !o.reply.includes(String(o.state.hiddenMarker)),
        "Any explicit state counts match the three visible tasks, and hidden-company work is absent.");
      c.add("observation-context", /\b(?:as of|right now|currently|at present)\b/i.test(o.reply), "The overview identifies its current observation context.");
      break;
    }
    case "activity.audit-change": {
      const priorityEvents = (o.state.priorityEvents as Entity[] | undefined) ?? [];
      c.add("real-two-change-history", priorityEvents.length === 2 && priorityEvents.every(event => o.activity.some(row => row.id === event.id)), "Both fixture priority changes remain visible on the exact task.");
      c.add("attribution-and-values", attributedPriorityChanges(o.reply, priorityEvents, before),
        "Recorded actors bind each actual transition, including a truthful common actor header; wrong actors, tasks or changes cannot pass.");
      c.add("recorded-event-times", priorityEvents.length === 2 && priorityEvents.every(event => mentionsRecordedTime(o.reply, event.createdAt,
        String(o.state.observedAt ?? ""), String(o.state.timezone ?? "UTC"), priorityEvents.map(row => row.createdAt))),
        "Reported calendar and clock times match the actual retained events in UTC or the browser's declared timezone.");
      c.add("read-only-history", !!before && sameTask(before, current) && linkedTask() && !o.activity.some(row => row.entityId === before.id && row.agentId === o.leadId), "Reading task audit does not mutate the task or manufacture audit records.");
      break;
    }
    default: c.add("implemented-scenario", false, "No independent oracle is implemented for this scenario.");
  }
  return c.result();
}

const define = (id: string, setup: ChatCatalogCase["setup"]) => makeDefinition(id, setup, grade_activity);
export const activityCases: readonly ChatCatalogCase[] = [
  companyOverview(),
  define("activity.audit-change", async ctx => {
    const p = await project(ctx); let t = await task(ctx, "Website task", p.id);
    await ctx.input.api.patch(`/api/issues/${t.id}`, { priority: "high" });
    t = await ctx.input.api.patch(`/api/issues/${t.id}`, { priority: "low" });
    const activity = await ctx.input.api.get<Entity[]>(`/api/issues/${t.id}/activity`);
    return { project: p, task: t, observedAt: new Date().toISOString(), timezone: await ctx.input.page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), priorityEvents: activity.filter(row => row.action === "issue.updated" && row.details?.priority) };
  }),
];

export function mentionsRecordedTime(reply: string, recordedAt: string | undefined, observedAt: string, timezone: string, allRecordedAt: Array<string | undefined> = []): boolean {
  const date = new Date(recordedAt ?? ""); const observed = new Date(observedAt);
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(observed.getTime())) return false;
  const zones = [...new Set(["UTC", timezone])];
  try {
    const dates = zones.map(timeZone => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date));
    const times = zones.map(timeZone => new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date));
    const explicitDates = [...reply.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map(match => match[0]);
    const explicitTimes = [...reply.matchAll(/\b(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?\b/gi)].map(match => {
      let hour = Number(match[1]); if (match[3]) hour = hour % 12 + (match[3].toUpperCase() === "PM" ? 12 : 0);
      return `${String(hour).padStart(2, "0")}:${match[2]}`;
    });
    const allDates = allRecordedAt.length ? allRecordedAt.flatMap(value => zones.map(timeZone => new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date(value ?? "")))) : dates;
    const allTimes = allRecordedAt.length ? allRecordedAt.flatMap(value => zones.map(timeZone => new Intl.DateTimeFormat("en-GB", {
      timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).format(new Date(value ?? "")))) : times;
    if (explicitTimes.length && (!explicitTimes.some(time => times.includes(time)) || explicitTimes.some(time => !allTimes.includes(time)))) return false;
    const namedDates = [...reply.matchAll(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi)]
      .map(match => `${match[1]!.toLowerCase()} ${Number(match[2])}`);
    const named = (value: string | undefined) => zones.map(timeZone => new Intl.DateTimeFormat("en-US", { timeZone, month: "long", day: "numeric" }).format(new Date(value ?? "")).toLowerCase());
    if (namedDates.length && (!namedDates.some(day => named(recordedAt).includes(day))
      || namedDates.some(day => !(allRecordedAt.length ? allRecordedAt.flatMap(named) : named(recordedAt)).includes(day)))) return false;
    if (explicitDates.length) return explicitDates.some(day => dates.includes(day)) && explicitDates.every(day => allDates.includes(day));
    if (/\btoday\b/i.test(reply)) return zones.some((timeZone, index) => dates[index] === new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(observed));
    if (explicitTimes.length) return true;
    return zones.some(timeZone => {
      const month = new Intl.DateTimeFormat("en-US", { timeZone, month: "long" }).format(date);
      const day = new Intl.DateTimeFormat("en-US", { timeZone, day: "numeric" }).format(date);
      return new RegExp(`\\b${month}\\s+${day}\\b`, "i").test(reply);
    });
  } catch { return false; }
}

function companyOverview(): ChatCatalogCase {
  const base = define("activity.company-overview", async ctx => {
    const p = await project(ctx); const worker = await fixtureWorker(ctx);
    const active = await task(ctx, "Website draft", p.id, { status: "in_progress", assigneeUserId: "local-board" });
    const blocker = `approved launch colors ${ctx.input.nonce}`;
    const blockedTask = await task(ctx, "Accessibility review", p.id, { status: "blocked", description: `Waiting for ${blocker}.` });
    const doneTask = await task(ctx, "Launch brief delivered", p.id, { status: "done" });
    const hiddenCompany = await ctx.input.api.post<Entity>("/api/companies", { name: `Hidden company ${ctx.input.nonce}` });
    const hiddenMarker = `Hidden acquisition ${ctx.input.nonce}`;
    await ctx.input.api.post(`/api/companies/${hiddenCompany.id}/issues`, { title: hiddenMarker, status: "blocked" });
    return { project: p, task: active, blockedTask, doneTask, worker, blocker, hiddenCompany, hiddenMarker };
  });
  return { ...base, oracleVersion: "paperclip.chat-catalog.activity-overview.grounded.v2", sourceFiles: [...base.sourceFiles, "chat-catalog-domains/recorded-work-claims.ts"], async verifySetup(ctx, state) {
    const active = await ctx.input.api.get<Entity & { assigneeUserId: string | null }>(`/api/issues/${entity(state, "task").id}`);
    const worker = await ctx.input.api.get<Entity>(`/api/agents/${entity(state, "worker").id}`);
    const c = checks();
    c.add("human-owned-active-work", active.status === "in_progress" && active.assigneeUserId === "local-board" && !active.assigneeAgentId,
      "The active task has a real local board owner without admitting agent execution.");
    c.add("idle-worker-no-setup-run", worker.status === "idle" && (await ctx.allRuns()).length === 0,
      "Morgan remains genuinely idle and fixture preparation admits no native run.");
    return c.result();
  }, async observe(ctx, state) {
    const o = await observeInternal(ctx, state);
    return { ...o, agents: await ctx.input.api.get<Entity[]>(`/api/companies/${ctx.input.fixtures.company.id}/agents`) };
  }, async cleanup(ctx, state) { await ctx.input.api.delete(`/api/companies/${entity(state, "hiddenCompany").id}`, { allowNotFound: true }); } };
}
import { observeInternal } from "./internal-support.js";

function mentionsRecordedActor(reply: string, actorId: string): boolean {
  const identities = actorId === "local-board" ? [actorId, "Local board", "Board"] : [actorId];
  return identities.some(identity => {
    const name = identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${name}\\s+(?:changed|updated|set|made|raised|lowered|edited)\\b`, "i").test(reply)
      || new RegExp(`\\b(?:by|actor|editor)\\s*[:=]?\\s*(?:the\\s+)?${name}\\b`, "i").test(reply)
      || new RegExp(`\\|\\s*${name}\\s*\\|`, "i").test(reply)
      || new RegExp(`(?:^|\\n)\\s*(?:#{1,6}\\s*|\\*\\*)?${name}(?:\\*\\*)?\\s*:`, "i").test(reply);
  });
}

/** A common actor header scopes following bullets; repeating the actor in every
 * line is unnecessary. Explicit contrary actor/transition claims still fail. */
export function attributedPriorityChanges(reply: string, events: Entity[], target?: Entity): boolean {
  if (events.length !== 2 || events.some(event => !event.actorId || !event.details?.priority)) return false;
  const plain = reply.replace(/[`*]/g, "");
  const taskRefs = plain.match(/\b[A-Z]{2,10}-\d+\b/g) ?? [];
  if (target?.identifier && taskRefs.some(id => id !== target.identifier)) return false;
  let cursor = 0;
  const parts = plain.split(/[;\n]|\.(?:\s|$)/).filter(part => part.trim()).map(text => { const start = plain.indexOf(text, cursor); cursor = start + text.length; return { text, start, end: cursor }; });
  const tokens = [...plain.matchAll(/\b(low|medium|high|critical)\b/gi)];
  const pairs: Array<{ from: string; to: string; start: number; end: number }> = [];
  for (let i = 0; i + 1 < tokens.length; i++) {
    const left = tokens[i]!, right = tokens[i + 1]!;
    if (/^\s*(?:→|->|to)\s*$/i.test(plain.slice(left.index! + left[0].length, right.index))) pairs.push({ from: left[1]!.toLowerCase(), to: right[1]!.toLowerCase(), start: left.index!, end: right.index! });
  }
  const change = (event: Entity) => {
    const changes = event.details?.changes as { priority?: { from?: unknown } } | undefined;
    const previous = event.details?._previous as { priority?: unknown } | undefined;
    const raw = changes?.priority?.from ?? previous?.priority;
    return { to: String(event.details!.priority).toLowerCase(), from: typeof raw === "string" ? raw.toLowerCase() : undefined };
  };
  if (pairs.some(pair => !events.some(event => { const expected = change(event); return pair.to === expected.to && (!expected.from || pair.from === expected.from); }))) return false;
  return events.every(event => {
    const actor = event.actorId!, expected = change(event);
    const headerAt = parts.findIndex(part => mentionsRecordedActor(part.text, actor) && /\b(?:twice|both|two|priority|edits?|changes?)\b/i.test(part.text));
    const aliases = actor === "local-board" ? [actor, "board"] : [actor.toLowerCase()];
    return parts.some((entry, partIndex) => {
      const part = entry.text;
      if (!new RegExp(`\\b${expected.to}\\b`, "i").test(part)) return false;
      const contraryActor = [...part.matchAll(/\b([a-z0-9_-]+)\s+(?:changed|updated|set|made|raised|lowered|edited)\b/gi)]
        .some(match => !aliases.includes(match[1]!.toLowerCase()) && !["priority", "it", "they", "both", "changes", "edits"].includes(match[1]!.toLowerCase()));
      if (contraryActor) return false;
      if (!mentionsRecordedActor(part, actor) && !(headerAt >= 0 && partIndex >= headerAt)) return false;
      // A priority named only as the starting value of another transition is
      // not a report that this priority change occurred.
      return tokens.some(token => token[1]!.toLowerCase() === expected.to && token.index! >= entry.start && token.index! < entry.end
        && (!pairs.some(pair => pair.start === token.index) || pairs.some(pair => pair.end === token.index)));
    });
  });
}
