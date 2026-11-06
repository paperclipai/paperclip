import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely, chatCatalogNativePhaseRemainingBudget } from "../chat-catalog-contract.js";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import type { ChatQueryAttachmentReceipt } from "../chat-query-attachments.js";
import { pollUntil } from "../api.js";
import { sendChatMessage } from "../chat-flow.js";
import { readRegisteredArtifacts } from "../registered-artifact.js";
import { observeCompletionUpdate } from "../completion-update-flow.js";
import { completionDelivery } from "../completion-updates.js";
import { checks, type Entity } from "./internal-support.js";
import { openStandingChat } from "./identity-support.js";
import { prepareRuntimeWorkerGate, releaseRuntimeWorker } from "./runtime-busy-worker.js";
import { runtimeDefinition, runtimeObservation, observeRuntime, type RuntimeAgent } from "./runtime-support.js";
const keys = new WeakMap<ChatCatalogContext, { id: string; token: string; workerId: string }>();
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
export function launchBriefBrowserOrigin(apiBaseURL: string, browserURL: string, target: string, companyId: string, issueId: string) {
  const api = new URL(apiBaseURL), browser = new URL(browserURL), upload = new URL(target, api);
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (!uuid.test(companyId) || !uuid.test(issueId) || !["http:", "https:"].includes(api.protocol)
    || api.origin !== apiBaseURL || api.username || api.password || browser.username || browser.password
    || browser.origin !== api.origin || upload.origin !== api.origin || upload.username || upload.password || upload.search || upload.hash
    || upload.pathname !== `/api/companies/${companyId}/issues/${issueId}/attachments`) throw new Error("Human Launch brief upload escaped its owned browser and target");
  return browser.origin;
}
export function hasLaunchHeadline(html: string) {
  const heading = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  return heading?.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;|&#x0*a0;/gi, " ").replace(/\s+/g, " ").trim().toLowerCase() === "research without the busywork";
}
export function completeLaunchBrief(context: string, marker: string) {
  return context.includes(marker) && /Research without the busywork/i.test(context) && /\bsemantic\b.{0,30}\b(?:html|markup|structure)\b/i.test(context)
    && /\b(?:accessible|labelled|labeled)\b.{0,30}\b(?:label|input|control|form)|\blabel.{0,30}accessib/i.test(context)
    && /\b(?:primary|one|single)\b.{0,35}\b(?:sign.?up|signup|join|subscribe)\b.{0,30}\b(?:action|cta|button|link)\b/i.test(context);
}
export function launchPageReflectsBrief(html: string) {
  if (!hasLaunchHeadline(html) || !/<(?:main|section|header)\b/i.test(html)
    || !/<(?:a|button)\b[^>]*>[\s\S]{0,400}?(?:sign.?up|join|subscribe|early access)[\s\S]{0,100}?<\/(?:a|button)>/i.test(html)) return false;
  return [...html.matchAll(/<input\b[^>]*>/gi)].every(([input]) => /type\s*=\s*["']?hidden\b|aria-label(?:ledby)?\s*=\s*["'][^"']+/i.test(input)
    || !!input.match(/\bid\s*=\s*["']([^"']+)["']/)?.[1] && [...html.matchAll(/<label\b[^>]*\bfor\s*=\s*["']([^"']+)["']/gi)].some(label => label[1] === input.match(/\bid\s*=\s*["']([^"']+)["']/)?.[1]));
}
export function gradeDelegation(value: unknown) {
  const c = checks(), o = runtimeObservation(value);
  c.add("actual-launch-brief-and-native-handoff-evidence", !!o, "A real human-attached Launch brief, exactly one CEO-created Morgan child, native result and source completion are required."); if (!o) return c.result();
  const s = o.state, parent = s.parent as Entity, task = s.task as Entity, receipt = s.briefAttachment as ChatQueryAttachmentReceipt;
  const availableBrief = ["copied-attachment", "direct-attachment-reference"].includes(String(s.briefContextKind)) ? s.workerBriefReadStatus === 200 && s.workerBriefHash === s.briefHash
    : s.briefContextKind === "readable-parent-reference" ? s.workerParentReadStatus === 200 && s.parentLinkInspectable === true && s.workerBriefReadStatus === 200 && s.workerBriefHash === s.briefHash
    : s.briefContextKind === "faithful-durable-copy" && s.durableBriefComplete === true && s.actualWebsiteArtifact === true;
  c.add("real-parent-owner-and-human-brief", s.parentOwnedByCeo === true && !!receipt && receipt.issueId === parent.id && receipt.companyId === o.companyId
    && receipt.createdByAgentId == null && receipt.createdByUserId === s.humanId && receipt.issueCommentId === s.briefCommentId && receipt.sha256 === s.briefHash
    && s.briefDownloadedHash === s.briefHash && s.parentContextRetained === true,
  "The real Launch task remains owned by the CEO and its human comment retains the exact uploaded design brief.");
  c.add("one-authorized-child-with-durable-context", !!task && (task.parentId === parent.id || s.linkedToLaunch === true) && task.companyId === o.companyId && task.assigneeAgentId === (s.worker as Entity).id
    && s.createdFromSource === true && o.tasks.length === 2 && s.childHasBrief === true && availableBrief && s.workerTaskReadStatus === 200
    && o.activity.some(row => row.action === "issue.created" && row.entityId === task.id && row.agentId === o.leadId)
    && /report|return|complete|finish|deliver|notify.{0,60}(?:CEO|here|conversation|ready)|let (?:me|us|the CEO) know.{0,60}(?:done|ready|page|result)/i.test(task.description ?? ""),
  "The canonical request creates one real Morgan child linked to Launch, with accessible durable brief bytes and an explicit completion request.");
  const delivery = s.delivery as ReturnType<typeof completionDelivery> | undefined;
  c.add("actual-morgan-result-incorporated-back-here", s.workerWasReallyWaiting === true && task.status === "done" && s.actualWebsiteArtifact === true
    && !!delivery && delivery.checks.every(row => row.passed) && /done|complete|finish|ready|delivered/i.test(delivery.response?.body ?? "")
    && !/I (?:ran|executed|built|implemented).{0,40}(?:Launch|parent)|built (?:it|the site) myself/i.test(delivery.response?.body ?? ""),
  "Morgan produces the actual brief-based page and the same source receives its correlated accessible result, without pretending the parent executed another agent's work.");
  c.add("separate-native-ownership-and-no-duplicate-work", o.runs.length === 4 && o.runs.every(row => row.status === "succeeded")
    && o.runs.filter(row => row.agentId === (s.worker as Entity).id).length === 1
    && !o.runs.some(row => row.contextSnapshot?.issueId === parent.id || (row as typeof row & { nativeIssueId?: string }).nativeIssueId === parent.id),
  "The declared setup acknowledgement, canonical CEO turn, single Morgan child execution and one correlated completion are the entire native ledger; Launch has no masquerading execution.");
  return c.result();
}
export const runtimeDelegationCases = [runtimeDefinition("task-coordination.delegate-with-context", async ctx => {
  const prepared = await prepareRuntimeWorkerGate(ctx), root = `/api/companies/${ctx.input.fixtures.company.id}`, marker = `Launch brief ${ctx.input.nonce}`;
  const parent = await ctx.input.api.post<Entity>(`${root}/issues`, { title: "Launch", status: "backlog", description: "The CEO owns the launch. The attached human design brief defines the page; implementation should be delegated to Morgan when requested." });
  const briefComment = await ctx.input.api.post<Entity>(`/api/issues/${parent.id}/comments`, { body: "Approved design brief for later authorized implementation; no work is assigned yet." });
  const brief = `# Launch design\nHeadline: Research without the busywork\nUse semantic HTML, accessible labels and one primary signup action.\nReference: ${marker}\n`;
  const uploadTarget = `${root}/issues/${parent.id}/attachments`;
  const origin = launchBriefBrowserOrigin(ctx.input.api.baseURL, ctx.input.page.url(), uploadTarget, ctx.input.fixtures.company.id, parent.id);
  const uploaded = await ctx.input.page.request.post(uploadTarget, { headers: { Origin: origin }, multipart: { issueCommentId: briefComment.id,
    file: { name: "design-brief.md", mimeType: "text/markdown", buffer: Buffer.from(brief) } } });
  if (uploaded.status() !== 201) { await uploaded.dispose(); throw new Error("Real human Launch brief upload did not succeed"); }
  const attachment = await uploaded.json() as ChatQueryAttachmentReceipt; await uploaded.dispose();
  const session = await ctx.input.api.get<{ user: { id: string } }>("/api/auth/get-session");
  if (attachment.createdByUserId !== session.user.id || attachment.issueCommentId !== briefComment.id || attachment.sha256 !== hash(Buffer.from(brief))) throw new Error("Launch brief lacks actual human comment/byte provenance");
  await ctx.input.api.patch(`/api/issues/${parent.id}`, { assigneeAgentId: ctx.input.fixtures.agent.id });
  if ((await ctx.allRuns()).length) throw new Error("Backlog Launch prerequisite unexpectedly admitted work");
  await ctx.input.api.saveAgentInstructions(prepared.worker.id, `When an authorized Website task arrives, first run node ${JSON.stringify(prepared.gate.scriptPath)} once and wait for the real brief-release output. Do not replace the script or invent the brief. Then read the actual attached design brief referenced by the task. Implement it as website.html and register that real file as a downloadable artifact work product titled website.html. Save a non-plan delivery document with key website-delivery containing the design's reference and the actual result summary. Complete the same task without creating another task or publishing externally.`);
  if (!ctx.input.privateSecrets) throw new Error("Actual worker brief read requires the private probe sink");
  const key = await ctx.input.api.postSensitive<{ id: string; token: string }>(`/api/agents/${prepared.worker.id}/keys`, { name: "delegated-launch-brief-read" });
  ctx.input.privateSecrets.push(key.token); keys.set(ctx, { ...key, workerId: prepared.worker.id });
  await openStandingChat(ctx);
  const setupMessage = `This conversation tracks Launch ${parent.identifier ?? parent.id}, which you own. It has the actual approved design brief attached to human comment ${briefComment.id}; Morgan is available for implementation. Remember this work context and acknowledge it here, but do not start, modify, delegate or complete work until my next request.`;
  await sendChatMessage(ctx.input.page, setupMessage, chatCatalogNativePhaseRemainingBudget(ctx));
  await pollUntil({ label: "Genuine source context acknowledgement before delegation", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 150_000),
    load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns() }; },
    accept: v => chatCatalogNativePhaseIsTimely(ctx) && (v.source?.conversationState === "waiting" && v.runs.length === 1 && v.runs[0]?.agentId === ctx.input.fixtures.agent.id && v.runs[0].status === "succeeded") });
  return { worker: prepared.worker, gate: prepared.gate, parent: await ctx.input.api.get<Entity>(`/api/issues/${parent.id}`), marker,
    humanId: session.user.id, briefCommentId: briefComment.id, briefAttachment: attachment, briefHash: hash(Buffer.from(brief)),
    briefDownloadedHash: hash(await ctx.input.api.getAttachmentContent(attachment.id)), sourceId: ctx.issue()!.id };
}, gradeDelegation, {
  authentication: "human-session", setupHumanMessageCount: 1, expectedHumanMessageCount: 2, expectedRunCount: 4, attemptTimeoutMs: 900_000,
  sourceFiles: ["chat-catalog-domains/runtime-delegation.ts", "chat-catalog-domains/runtime-busy-worker.ts", "chat-catalog-domains/runtime-support.ts", "chat-catalog-domains/identity-support.ts", "completion-update-flow.ts", "completion-updates.ts", "registered-artifact.ts", "chat-scenarios/task-coordination.yaml"],
  async act(ctx, state) {
    const phase = await pollUntil({ label: "Canonical source creates exactly one actual Morgan child with Launch context", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 180_000),
      load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns(), waiting: await readFile((state.gate as { ready: string }).ready, "utf8").catch(() => ""),
        tasks: await ctx.input.api.get<Entity[]>(`/api/companies/${ctx.input.fixtures.company.id}/issues?includeAgentCreatedTasks=true&limit=1000`) }; },
      accept: v => chatCatalogNativePhaseIsTimely(ctx) && (v.source?.conversationState === "waiting" && v.runs.length === 3 && v.waiting === "waiting"
        && v.runs.some(row => row.agentId === (state.worker as Entity).id && row.status === "running")
        && v.runs.filter(row => row.agentId === ctx.input.fixtures.agent.id).every(row => row.status === "succeeded")
        && v.tasks.filter(row => row.id !== state.sourceId && row.id !== (state.parent as Entity).id).length === 1) });
    const task = phase.tasks.find(row => row.id !== state.sourceId && row.id !== (state.parent as Entity).id)!; state.task = task; state.workerWasReallyWaiting = true;
    const fromSource = await ctx.input.api.get<Entity[]>(`/api/companies/${ctx.input.fixtures.company.id}/issues?createdFromIssueId=${state.sourceId}&includeAgentCreatedTasks=true&limit=1000`);
    state.createdFromSource = fromSource.length === 1 && fromSource[0]?.id === task.id;
    const attachments = await ctx.input.api.get<ChatQueryAttachmentReceipt[]>(`/api/issues/${task.id}/attachments`), original = state.briefAttachment as ChatQueryAttachmentReceipt;
    const documents = await ctx.input.api.get<Entity[]>(`/api/issues/${task.id}/documents`), bodies: Entity[] = [];
    for (const doc of documents) bodies.push(await ctx.input.api.get<Entity>(`/api/issues/${task.id}/documents/${encodeURIComponent(doc.key!)}`));
    const context = `${task.description ?? ""}\n${bodies.map(doc => doc.body).join("\n")}`;
    state.linkedToLaunch = [...context.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)].some(match => {
      try { const url = new URL(match[1]!, ctx.input.api.baseURL), parts = url.pathname.split("/").map(decodeURIComponent), i = parts.indexOf("issues");
        return url.origin === ctx.input.api.baseURL && i >= 0 && [(state.parent as Entity).id, (state.parent as Entity).identifier].includes(parts[i + 1]); }
      catch { return false; }
    });
    const copied = attachments.find(row => row.sha256 === state.briefHash);
    let path = copied?.contentPath ?? (context.includes(original.contentPath) ? original.contentPath : undefined);
    state.parentLinkInspectable = task.parentId === (state.parent as Entity).id || state.linkedToLaunch === true;
    const key = keys.get(ctx); if (!key || key.workerId !== (state.worker as Entity).id) throw new Error("Actual Morgan brief probe identity is missing");
    async function workerRead(path: string) {
      const target = new URL(path, ctx.input.api.baseURL);
      if (target.origin !== ctx.input.api.baseURL || !/^\/api\/(?:issues|attachments)\//.test(target.pathname)) throw new Error("Worker brief read escaped fixture resources");
      return fetch(target, { redirect: "error", signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${key!.token}` } });
    }
    const ownRead = await workerRead(`/api/issues/${task.id}`); state.workerTaskReadStatus = ownRead.status;
    let workerContext = "";
    if (ownRead.ok) { const own = await ownRead.json() as Entity;
      if (own.id !== task.id || own.companyId !== ctx.input.fixtures.company.id || own.assigneeAgentId !== key.workerId) throw new Error("Worker task read returned a foreign owner or scope");
      workerContext = own.description ?? "";
      for (const doc of documents) { const response = await workerRead(`/api/issues/${task.id}/documents/${encodeURIComponent(doc.key!)}`);
        if (response.ok) workerContext += `\n${(await response.json() as Entity).body ?? ""}`; else await response.body?.cancel(); }
    } else await ownRead.body?.cancel();
    state.durableBriefComplete = completeLaunchBrief(workerContext, String(state.marker));
    if (path) state.briefContextKind = copied ? "copied-attachment" : "direct-attachment-reference";
    else if (state.parentLinkInspectable) {
      const parent = await workerRead(`/api/issues/${(state.parent as Entity).id}`); state.workerParentReadStatus = parent.status;
      if (parent.ok) { const row = await parent.json() as Entity;
        if (row.id !== (state.parent as Entity).id || row.companyId !== ctx.input.fixtures.company.id) throw new Error("Worker parent reference escaped its actual Launch scope");
        const receipts = await workerRead(`/api/issues/${row.id}/attachments`);
        if (receipts.ok && (await receipts.json() as ChatQueryAttachmentReceipt[]).some(item => item.id === original.id && item.sha256 === original.sha256 && item.issueCommentId === state.briefCommentId)) {
          path = original.contentPath; state.briefContextKind = "readable-parent-reference";
        } else if (!receipts.ok) await receipts.body?.cancel();
      } else await parent.body?.cancel();
    }
    if (!path && state.durableBriefComplete) state.briefContextKind = "faithful-durable-copy";
    state.childHasBrief = !!path || state.durableBriefComplete === true;
    if (path) {
      const target = new URL(path, ctx.input.api.baseURL); if (target.origin !== ctx.input.api.baseURL || !target.pathname.startsWith("/api/attachments/")) throw new Error("Delegated brief escaped the fixture API");
      const response = await fetch(target, { redirect: "error", signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${key.token}` } });
      state.workerBriefReadStatus = response.status;
      if (response.ok) { const bytes = new Uint8Array(await response.arrayBuffer()); if (bytes.byteLength > 65_536) throw new Error("Delegated fixture brief size exceeded"); state.workerBriefHash = hash(bytes); }
      else await response.body?.cancel();
    }
    await writeFile((state.gate as { gate: string }).gate, "The human has authorized this delegated page implementation. Read the actual task-bound approved design brief, implement its headline and signup design as website.html, retain its exact reference in the delivery document, and complete this same work task. Do not publish or create further tasks.", "utf8");
    const delivered = await observeCompletionUpdate({ page: ctx.input.page, api: ctx.input.api, sourceId: String(state.sourceId), workerId: task.id,
      marker: String(state.marker), fixtureRequest: ctx.scenario.query, allRuns: () => ctx.allRuns(), evidence: ctx.input.evidence, capture: ctx.input.capture });
    state.delivery = completionDelivery(delivered);
  },
  async observe(ctx, state) {
    const o = await observeRuntime(ctx, state), parent = await ctx.input.api.get<Entity>(`/api/issues/${(state.parent as Entity).id}`);
    state.parentOwnedByCeo = parent.assigneeAgentId === ctx.input.fixtures.agent.id;
    const original = state.briefAttachment as ChatQueryAttachmentReceipt, attachment = (await ctx.input.api.get<ChatQueryAttachmentReceipt[]>(`/api/issues/${parent.id}/attachments`)).find(row => row.id === original.id);
    state.parentContextRetained = !!attachment && attachment.sha256 === original.sha256 && attachment.issueCommentId === state.briefCommentId;
    const task = state.task as Entity | undefined;
    if (task) {
      state.task = await ctx.input.api.get<Entity>(`/api/issues/${task.id}`);
      const workerRun = o.runs.find(row => row.agentId === (state.worker as Entity).id);
      if (workerRun) { const [artifact] = await readRegisteredArtifacts(ctx.input.api, task.id, workerRun.id, ["website.html"]);
        state.actualWebsiteArtifact = artifact?.contentVerified === true && launchPageReflectsBrief(artifact.content)
          && o.revisions.some(row => row.createdByRunId === workerRun.id && row.createdByAgentId === (state.worker as Entity).id && (row.body ?? "").includes(String(state.marker))
            && o.documents.some(doc => doc.id === row.documentId && doc.latestRevisionId === row.id)); }
    }
    return o;
  },
  async verifyResult(ctx, state) {
    const source = ctx.input.page.url();
    for (const task of [state.parent as Entity, state.task as Entity]) { await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" });
      await ctx.input.page.reload({ waitUntil: "domcontentloaded" }); await expect(ctx.input.page.getByRole("heading", { name: task.title!, exact: true }).first()).toBeVisible(); }
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  },
  async cleanup(ctx, state) { try { const key = keys.get(ctx); keys.delete(ctx); if (key) await ctx.input.api.delete(`/api/agents/${key.workerId}/keys/${key.id}`, { allowNotFound: true }); }
    finally { await releaseRuntimeWorker(state); } },
})];
