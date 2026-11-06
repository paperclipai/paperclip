import { bindNotificationPublicEvents, publicNotificationFrame, type NotificationPublicFrame, type NotificationBoundFrame, type NotificationObserverInput } from "./internal-notification-events.js";
import { expect, type Page } from "@playwright/test";
import { extractUserMentionIds } from "../../../packages/shared/src/project-mentions.js";
import type { ChatCatalogCase } from "../chat-catalog-contract.js";
import { pollUntil } from "../api.js";
import { makeDefinition } from "./internal-definition.js";
import { mainPerson, observerPerson, personRead } from "./internal-privacy.js";
import { checks, entity, hasLink, observation, observeInternal, project, putDocument, sameTask, task, type Entity, type InternalObservation } from "./internal-support.js";
type Frame = NotificationBoundFrame;
interface ToastReceipt { text: string; hrefs: string[]; at: number }
interface ObserverEvidence { principalId: string; visibility: string; frames: Frame[]; toasts: ToastReceipt[]; sockets: string[] }
interface AudienceObservation extends InternalObservation { alex: ObserverEvidence; riley: ObserverEvidence; observedAt: number }
interface ObserverProbe { page: Page; principalId: string; companyId: string; taskId: string; origin: string; frames: NotificationPublicFrame[]; sockets: string[]; overflow: boolean; baseline?: { sessionPrincipalId: string; activityIds: string[]; commentIds: string[] } }
const negativeWindowMs = 2000;
declare global { interface Window { __paperclipAudienceToastReceipts?: ToastReceipt[] } }
async function startObserver(page: Page, principalId: string, target: Entity, href: string, companyId: string): Promise<ObserverProbe> {
  const probe: ObserverProbe = { page, principalId, companyId, taskId: target.id, origin: new URL(href).origin, frames: [], sockets: [], overflow: false };
  page.on("websocket", socket => {
    const path = new URL(socket.url()).pathname; if (!/\/events\/ws$/.test(path)) return; probe.sockets.push(path);
    socket.on("framereceived", frame => {
      try { const message = JSON.parse(String(frame.payload));
        const actual = publicNotificationFrame(message, companyId, target.id, Date.now());
        if (actual) { if (probe.frames.length >= 128) probe.overflow = true; else probe.frames.push(actual); }
      } catch { /* Non-JSON transport frames are not task/comment evidence. */ }
    });
  });
  await page.goto(href, { waitUntil: "domcontentloaded" });
  await page.evaluate(({ id, identifier }) => {
    window.__paperclipAudienceToastReceipts = [];
    const seen = new WeakMap<Node, string>();
    const capture = () => { for (const node of document.querySelectorAll('aside[aria-live="polite"] li')) {
      const hrefs = [...node.querySelectorAll("a[href]")].map(link => link.getAttribute("href")!);
      if (!hrefs.some(href => href.split(/[/?#]/).includes(id) || !!identifier && href.split(/[/?#]/).includes(identifier))) continue;
      const text = node.textContent?.trim() ?? ""; const key = JSON.stringify([text, hrefs]); if (seen.get(node) === key) continue; seen.set(node, key);
      window.__paperclipAudienceToastReceipts!.push({ text, hrefs, at: Date.now() });
    } };
    new MutationObserver(capture).observe(document.body, { childList: true, subtree: true, characterData: true }); capture();
  }, { id: target.id, identifier: target.identifier });
  return probe;
}
async function publicProbeRows(probe: ObserverProbe) {
  const read = async (route: string) => {
    const response = await probe.page.request.get(new URL(route, probe.origin).href, { timeout: 15000, maxRedirects: 0 });
    try { if (response.status() !== 200) throw new Error("Notification observer lacks authenticated saved evidence"); return await response.json(); }
    finally { await response.dispose(); }
  };
  const [activity, comments] = await Promise.all([read(`/api/issues/${probe.taskId}/activity`), read(`/api/issues/${probe.taskId}/comments?order=asc`)]);
  if (!Array.isArray(activity) || !Array.isArray(comments)) throw new Error("Notification observer saved evidence is not a list");
  return { activity: activity.map((row: Record<string, unknown>) => ({ id: row.id, companyId: row.companyId, entityType: row.entityType, entityId: row.entityId,
    action: row.action, actorType: row.actorType, actorId: row.actorId, createdAt: row.createdAt, details: { commentId: (row.details as Record<string, unknown> | null)?.commentId } })),
    comments: comments.map((row: Record<string, unknown>) => ({ id: row.id, companyId: row.companyId, issueId: row.issueId, createdAt: row.createdAt,
      authorAgentId: row.authorAgentId, authorUserId: row.authorUserId, deletedAt: row.deletedAt })) };
}
async function armProbe(probe: ObserverProbe) {
  const session = await probe.page.request.get(new URL("/api/auth/get-session", probe.origin).href, { timeout: 15000, maxRedirects: 0 });
  let personId: unknown;
  try { if (session.status() !== 200) throw new Error("Notification observer has no actual session"); personId = (await session.json())?.user?.id; }
  finally { await session.dispose(); }
  if (personId !== probe.principalId) throw new Error("Notification observer session principal mismatch");
  const rows = await publicProbeRows(probe);
  if (rows.comments.length || rows.activity.some(row => row.action === "issue.comment_added")) throw new Error("Notification observer requires the fresh comment boundary before the participation control");
  probe.baseline = { sessionPrincipalId: probe.principalId, activityIds: rows.activity.map(row => String(row.id)), commentIds: rows.comments.map(row => String(row.id)) };
  probe.frames.length = 0;
}
async function observeProbe(probe: ObserverProbe) {
  const browser = await probe.page.evaluate(() => ({ visibility: document.visibilityState, toasts: window.__paperclipAudienceToastReceipts ?? [] }));
  const input: NotificationObserverInput | undefined = probe.baseline ? { principalId: probe.principalId, sessionPrincipalId: probe.baseline.sessionPrincipalId,
    frames: structuredClone(probe.frames), overflow: probe.overflow, baselineActivityIds: probe.baseline.activityIds, baselineCommentIds: probe.baseline.commentIds,
    ...await publicProbeRows(probe) } : undefined;
  return { principalId: probe.principalId, sockets: [...probe.sockets], ...browser, input };
}
function commentEvent(person: ObserverEvidence, commentId: string, taskId: string) { return person.frames.find(frame => frame.principalId === person.principalId && frame.commentId === commentId && frame.taskId === taskId); }
function actualToast(person: ObserverEvidence, since: number, target: Entity, origin: string) {
  return person.toasts.some(toast => toast.at >= since - 100 && /commented/i.test(toast.text) && toast.hrefs.some(href => {
    try { const u = new URL(href, origin); const parts = u.pathname.split("/"); const index = parts.indexOf("issues"); return u.origin === origin && index >= 0 && [target.id, target.identifier].includes(parts[index + 1]); } catch { return false; }
  }));
}
function validAudience(value: unknown) { const o = observation(value) as AudienceObservation | undefined; return o && [o.alex, o.riley].every(person => !!person && typeof person.principalId === "string" && typeof person.visibility === "string" && [person.frames, person.toasts, person.sockets].every(Array.isArray)) && typeof o.observedAt === "number" ? o : undefined; }
function firstUpdate(o: AudienceObservation) { return o.comments.filter(row => row.authorAgentId === o.leadId && o.runs.some(run => run.id === row.createdByRunId)); }
function firstAudiencePasses(o: AudienceObservation) {
  const target = entity(o.state, "task"); const comments = firstUpdate(o); const update = comments[0]; const alex = update && commentEvent(o.alex, update.id, target.id); const riley = update && commentEvent(o.riley, update.id, target.id);
  return comments.length === 1 && !!update && !extractUserMentionIds(update.body ?? "").includes(String(o.state.rileyId))
    && /\bdraft\b/i.test(update.body ?? "") && /\b(?:ready|available|review)\b/i.test(update.body ?? "")
    && !!alex && alex.eligible && actualToast(o.alex, alex.at, entity(o.state, "task"), o.origin) && !!riley && !riley.eligible
    && o.observedAt - riley.at >= negativeWindowMs && !actualToast(o.riley, riley.at, entity(o.state, "task"), o.origin)
    && o.alex.visibility === "visible" && o.riley.visibility === "visible" && o.alex.sockets.length > 0 && o.riley.sockets.length > 0;
}
export function gradeNotificationAudience(value: unknown) {
  const c = checks(); const o = validAudience(value);
  c.add("independent-two-principal-notifications", !!o, "Actual task comments, per-principal production socket events and independently observed browser toasts are required."); if (!o) return c.result();
  const first = validAudience(o.state.firstAudience);
  c.add("normal-update-participant-only", !!first && firstAudiencePasses(first), `The exact first saved comment reaches both authorized cache subscribers; only participating Alex receives eligibility and an actual personal toast. Riley's negative observation settles for ${negativeWindowMs}ms after that same event.`);
  const previousIds = new Set(first?.comments.map(row => row.id) ?? []); const second = firstUpdate(o).filter(row => !previousIds.has(row.id)); const update = second[0];
  const riley = update && commentEvent(o.riley, update.id, entity(o.state, "task").id); const alex = update && commentEvent(o.alex, update.id, entity(o.state, "task").id);
  c.add("explicit-mentioned-person-now-notified", second.length === 1 && !!update && extractUserMentionIds(update.body ?? "").includes(String(o.state.rileyId))
    && !!riley && riley.eligible && actualToast(o.riley, riley.at, entity(o.state, "task"), o.origin) && !!alex && alex.eligible && actualToast(o.alex, alex.at, entity(o.state, "task"), o.origin)
    && riley.at >= Number(o.state.mentionPhaseStartedAt) && o.riley.visibility === "visible" && o.alex.visibility === "visible",
    "The second declared human request produces a distinct saved mention and that exact event causes Riley's real browser toast, alongside Alex's.");
  const before = entity(o.state, "task");
  c.add("saved-target-and-participation", sameTask(before, o.tasks.find(row => row.id === before.id)) && hasLink(o, "issues", before)
    && o.state.alexId !== o.state.rileyId && o.alex.principalId === o.state.alexId && o.riley.principalId === o.state.rileyId
    && o.comments.some(row => row.id === (o.state.participation as Entity | undefined)?.id && row.authorUserId === o.state.alexId)
    && !o.comments.some(row => row.authorUserId === o.state.rileyId), "Both distinct signed-in people can read the unchanged task; Alex actually participated and Riley only gains relevance through the explicit mention.");
  const inventedDelivery = o.reply.split(/[.\n;]|,\s*but\s*/).some(part => /\b(?:toast|browser notification)\b[^.\n]*(?:delivered|shown|received)|\b(?:delivered|shown|received)\b[^.\n]*(?:toast|browser notification)/i.test(part)
    && !/\b(?:cannot|can't|not|don't|haven't|unverified|unable)\b/i.test(part));
  c.add("no-unobserved-browser-delivery-claim", !inventedDelivery, "The agent may confirm the saved update or mention, but cannot claim it observed delivery in other people's browsers.");
  return c.result();
}
function notificationAudience(): ChatCatalogCase {
  let riley: Awaited<ReturnType<typeof observerPerson>> | undefined; let alexProbe: ObserverProbe | undefined; let rileyProbe: ObserverProbe | undefined;
  let latestBinding: ReturnType<typeof bindNotificationPublicEvents> | undefined;
  const observeAudienceProbes = async () => {
    if (!alexProbe || !rileyProbe) throw new Error("Missing actual observer pages");
    const [alex, riley] = await Promise.all([observeProbe(alexProbe), observeProbe(rileyProbe)]);
    latestBinding = alex.input && riley.input ? bindNotificationPublicEvents(alexProbe.companyId, alexProbe.taskId, [alex.input, riley.input]) : undefined;
    return { alex: { principalId: alex.principalId, visibility: alex.visibility, sockets: alex.sockets, toasts: alex.toasts, frames: latestBinding?.frames[0] ?? [] },
      riley: { principalId: riley.principalId, visibility: riley.visibility, sockets: riley.sockets, toasts: riley.toasts, frames: latestBinding?.frames[1] ?? [] } };
  };
  let observe: (ctx: Parameters<ChatCatalogCase["setup"]>[0], state: Record<string, unknown>) => Promise<AudienceObservation>;
  const base = makeDefinition("inbox-search.notification-audience", async ctx => {
    const alexId = await mainPerson(ctx); riley = await observerPerson(ctx);
    try {
      const p = await project(ctx); const t = await task(ctx, "Launch task", p.id, { assigneeAgentId: ctx.input.fixtures.agent.id, description: "The launch draft is complete and ready for human review; post ordinary task discussion updates without changing task execution." });
      await putDocument(ctx, t.id, "# Launch draft\nThe Acorn Notes draft is ready for human review.\n");
      const read = await personRead(riley, `/api/issues/${t.id}`); if (read.status !== 200) throw new Error("The nonparticipant is not an actual authorized task reader");
      const origin = ctx.input.api.baseURL; const href = `${origin}/${ctx.input.fixtures.company.issuePrefix}/activity`;
      alexProbe = await startObserver(await ctx.input.page.context().newPage(), alexId, t, href, ctx.input.fixtures.company.id); rileyProbe = await startObserver(await riley.context.newPage(), riley.id, t, href, ctx.input.fixtures.company.id);
      await pollUntil({ label: "Observer page visibility and production socket registration", deadlineAt: Date.now() + 15000,
        load: observeAudienceProbes,
        accept: proof => proof.alex.visibility === "visible" && proof.riley.visibility === "visible" && proof.alex.sockets.length > 0 && proof.riley.sockets.length > 0 });
      await Promise.all([armProbe(alexProbe), armProbe(rileyProbe)]);
      await rileyProbe.page.waitForTimeout(250);
      const participation = await ctx.input.api.post<Entity>(`/api/issues/${t.id}/comments`, { body: "I am following the launch draft. Please post an update here when it is ready." });
      await pollUntil({ label: "Both real signed-in task cache subscriptions", deadlineAt: Date.now() + 30000,
        load: observeAudienceProbes,
        accept: proof => proof.alex.visibility === "visible" && proof.riley.visibility === "visible" && !!commentEvent(proof.alex, participation.id, t.id) && !!commentEvent(proof.riley, participation.id, t.id) });
      return { project: p, task: t, alexId, rileyId: riley.id, participation, negativeWindowMs };
    } catch (error) { await ctx.input.evidence("chat-notification-public-event-binding.json", { binding: latestBinding ?? null }).catch(() => undefined); await alexProbe?.page.close(); await rileyProbe?.page.close(); await riley.dispose(); riley = undefined; throw error; }
  }, gradeNotificationAudience);
  observe = async (ctx, state) => {
    if (!alexProbe || !rileyProbe) throw new Error("Missing actual observer pages");
    const o = await observeInternal(ctx, state); const { alex, riley } = await observeAudienceProbes();
    return { ...o, alex, riley, observedAt: Date.now() };
  };
  return { ...base, authentication: "human-session", expectedRunCount: 2, minimumRunCount: 2, expectedHumanMessageCount: 2, attemptTimeoutMs: 480000,
    sourceFiles: [...base.sourceFiles, "chat-catalog-domains/internal-notification-audience.ts", "chat-catalog-domains/internal-notification-events.ts", "chat-catalog-domains/internal-privacy.ts", "chat-catalog-domains/identity-auth.ts", "../../packages/shared/src/project-mentions.ts"], observe,
    async act(ctx, state) {
      const first = await pollUntil({ label: "Normal participant-only actual browser notification", deadlineAt: Date.now() + 180000,
        load: () => observe(ctx, state), accept: o => o.runs.length === 1 && o.runs[0]?.status === "succeeded" && ctx.issue()?.conversationState === "waiting" && firstAudiencePasses(o) });
      state.firstAudience = { ...first, state: structuredClone(state) }; await ctx.input.evidence("chat-catalog-normal-update-notification-audience.json", state.firstAudience);
      for (const probe of [alexProbe!, rileyProbe!]) { const buttons = probe.page.getByRole("button", { name: "Dismiss notification", exact: true }); for (let i = 0; i < 10 && await buttons.count(); i++) await buttons.first().click(); await expect(buttons).toHaveCount(0); }
      state.mentionPhaseStartedAt = Date.now(); const { sendChatMessage } = await import("../chat-flow.js");
      await sendChatMessage(ctx.input.page, `Post another update on that same launch task and explicitly mention [Riley](user://${state.rileyId}) so Riley is included.`);
    },
    async verifyResult(ctx, state, value) { await base.verifyResult(ctx, state, value); const o = value as AudienceObservation;
      await ctx.input.evidence("chat-catalog-explicit-mention-browser-audience.json", { alex: o.alex, riley: o.riley, observedAt: o.observedAt, mentionPhaseStartedAt: state.mentionPhaseStartedAt }); },
    async cleanup() { await alexProbe?.page.close(); await rileyProbe?.page.close(); alexProbe = undefined; rileyProbe = undefined; await riley?.dispose(); riley = undefined; },
  };
}
export const notificationAudienceCases: readonly ChatCatalogCase[] = [notificationAudience()];
