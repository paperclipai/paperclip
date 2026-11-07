import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import { stringify } from "yaml";
import type { IssueAttachment } from "../../../packages/shared/src/types/issue.js";
import type { CompanyPortabilityFileEntry } from "../../../packages/shared/src/types/company-portability.js";
import type { ChatCatalogCase, ChatCatalogContext } from "../chat-catalog-contract.js";
import { makeDefinition } from "./internal-definition.js";
import { mainPerson } from "./internal-privacy.js";
import { readSearchProbeResponse } from "./internal-search-response.js";
import { checks, entity, hasLink, observation, observeInternal, project, sameTask, type Entity, type InternalObservation } from "./internal-support.js";
const sha = (body: string | Buffer) => createHash("sha256").update(body).digest("hex");
interface HistoricalTask extends Entity { completedAt?: string | null }
interface ReturnedFile { attachment: IssueAttachment; downloadedHash: string; byteSize: number }
interface SourceHistory { issueId: string; comments: Entity[]; attachments: IssueAttachment[] }
interface SearchObservation extends InternalObservation { chatIssueId: string; returnedFiles: ReturnedFile[]; sourceHistory: SourceHistory[]; finalAttachment: IssueAttachment; downloadedHash: string; deliveryComments: Entity[]; searchStatus: number; searchResults: unknown[]; privateFileStatus: number; currentSource: HistoricalTask }
export function buildHistoricalWebsiteImport(deliveryAt: string, nonce: string) {
  const specs = [
    { slug: "final-website", title: "Final launch website delivery", status: "done", at: deliveryAt, filename: "final-website.html", label: "Final approved website delivered" },
    { slug: "old-final", title: "Earlier final website delivery", status: "done", at: new Date(Date.parse(deliveryAt) - 21 * 86400000).toISOString(), filename: "old-final.html", label: "Previous final website delivered" },
    { slug: "website-draft", title: "Latest launch website draft", status: "backlog", at: new Date().toISOString(), filename: "website-draft.html", label: "Unapproved draft only, never delivered" },
    { slug: "restricted-final", title: `Restricted final website ${nonce}`, status: "done", at: deliveryAt, filename: "restricted-final.html", label: "Restricted final website delivered" },
  ];
  const files: Record<string, CompanyPortabilityFileEntry> = { "COMPANY.md": '---\nschema: "agentcompanies/v1"\nname: "Historical website fixture"\n---\nSynthetic migration fixture; source task and comment timestamps are preserved by the supported import contract.\n' };
  const tasks: Record<string, unknown> = {};
  const receipts = specs.map(spec => {
    const body = `<!doctype html><html><body><h1>${spec.title}</h1><p>${nonce}-${spec.slug}</p></body></html>\n`; const digest = sha(body);
    files[`tasks/${spec.slug}/TASK.md`] = `---\nname: ${JSON.stringify(spec.title)}\nkind: task\n---\nImported synthetic historical source. ${spec.label} on ${spec.at}. The source delivery time is preserved; importing the attachment again today does not change that original delivery date.\n`;
    files[`blobs/${digest}`] = { encoding: "base64", data: Buffer.from(body).toString("base64"), contentType: "application/octet-stream" };
    tasks[spec.slug] = { status: spec.status, priority: "medium", createdAt: new Date(Date.parse(spec.at) - 3600000).toISOString(), updatedAt: spec.at,
      ...(spec.status === "done" ? { completedAt: spec.at } : {}),
      comments: [{ body: `${spec.label}: ${spec.filename}. Original delivery timestamp: ${spec.at}. Source bytes SHA256 ${digest}.`, authorType: "user", createdAt: spec.at }],
      attachments: [{ sha256: digest, contentType: "text/html", originalFilename: spec.filename, byteSize: Buffer.byteLength(body), commentIndex: 0 }] };
    return { ...spec, body, sha256: digest };
  });
  // The production portability reader implements block YAML, not a generic
  // JSON/YAML parser. Keep keys plain and values JSON-compatible quoted scalars.
  files[".paperclip.yaml"] = stringify({ schemaVersion: 7, tasks }, { defaultKeyType: "PLAIN", defaultStringType: "QUOTE_DOUBLE", lineWidth: 0, indentSeq: true });
  return { files, receipts };
}
export function historicalWebsitePreviewMatches(value: unknown, bundle: ReturnType<typeof buildHistoricalWebsiteImport>): boolean {
  const preview = value as { errors?: unknown[]; manifest?: { schemaVersion?: number; issues?: Array<{
    slug: string; status?: string; completedAt?: string | null; comments?: Array<{ body: string; createdAt?: string | null }>;
    attachments?: Array<{ sha256: string; originalFilename?: string | null; byteSize: number; commentIndex?: number | null }>;
  }> } } | undefined;
  const issues = preview?.manifest?.issues;
  return Array.isArray(preview?.errors) && preview.errors.length === 0 && preview?.manifest?.schemaVersion === 7
    && Array.isArray(issues) && issues.length === bundle.receipts.length && bundle.receipts.every(expected => {
      const matching = issues.filter(row => row.slug === expected.slug); const row = matching[0];
      return matching.length === 1 && row?.status === expected.status && (expected.status !== "done" || row.completedAt === expected.at)
        && row.comments?.length === 1 && row.comments[0]?.createdAt === expected.at && row.comments[0].body.includes(expected.sha256)
        && row.attachments?.length === 1 && row.attachments[0]?.sha256 === expected.sha256
        && row.attachments[0].originalFilename === expected.filename && row.attachments[0].byteSize === Buffer.byteLength(expected.body)
        && row.attachments[0].commentIndex === 0;
    });
}
function fileLink(o: InternalObservation, file: IssueAttachment) {
  return o.links.find(href => { try { const url = new URL(href, o.origin); return url.origin === o.origin && !url.username && !url.password && !url.hash && url.pathname === file.contentPath; } catch { return false; } });
}

/** Read only actually rendered, same-origin attachment links through the current human's API actor. */
export async function readReturnedWebsiteFiles(ctx: ChatCatalogContext, o: InternalObservation): Promise<ReturnedFile[]> {
  const chat = ctx.issue(); if (!chat) throw new Error("Artifact response has no actual chat");
  const source = entity(o.state, "task");
  const attachments = [...await ctx.input.api.get<IssueAttachment[]>(`/api/issues/${source.id}/attachments`),
    ...await ctx.input.api.get<IssueAttachment[]>(`/api/issues/${chat.id}/attachments`)];
  const returned: ReturnedFile[] = [];
  for (const attachment of attachments) {
    if (!fileLink(o, attachment) || attachment.companyId !== o.companyId || attachment.sha256 !== o.state.finalHash
      || attachment.byteSize !== (o.state.finalAttachment as IssueAttachment).byteSize) continue;
    const bytes = await ctx.input.api.getAttachmentContent(attachment.id);
    returned.push({ attachment, downloadedHash: sha(bytes), byteSize: bytes.byteLength });
  }
  return returned;
}
function historySignature(history: SourceHistory) {
  return JSON.stringify({ issueId: history.issueId,
    comments: history.comments.map(row => [row.id, row.issueId, row.body, row.createdAt, row.authorAgentId, row.authorUserId]).sort(),
    attachments: history.attachments.map(row => [row.id, row.issueId, row.issueCommentId, row.sha256, row.byteSize, row.originalFilename, row.createdAt]).sort() });
}
function selectedDeliveryProse(o: SearchObservation, target: Entity, distractors: Entity[]) {
  const mentions = (line: string, row: Entity) => [row.id, row.identifier, row.title].filter(Boolean).some(name => line.includes(name!));
  // A separately labelled exclusion names a known other source, not the selected final.
  return o.reply.split(/\n+/).filter(line => !( /^\s*(?:[-*]\s*)?not the others?\s*:/i.test(line)
    && distractors.some(row => mentions(line, row)) && !mentions(line, target)
    && !/\b(?:the|this|selected|actual)\s+(?:approved\s+)?final\b/i.test(line))).join("\n");
}
function verifiedReturnedFile(o: SearchObservation, target: Entity, original: IssueAttachment) {
  return o.returnedFiles?.find(({ attachment: a, downloadedHash, byteSize }) => !!fileLink(o, a)
    && a.companyId === o.companyId && a.sha256 === o.state.finalHash && downloadedHash === o.state.finalHash
    && a.byteSize === original.byteSize && byteSize === original.byteSize && a.originalFilename === original.originalFilename
    && (a.id === original.id && a.issueId === target.id || a.issueId === o.chatIssueId && a.createdByAgentId === o.leadId
      && o.runs.some(run => run.id === a.originatingRunId && run.status === "succeeded")));
}

/** Compare stated delivery dates with the preserved source date, not today's import date. */
export function describesHistoricalDelivery(reply: string, deliveredAt: string) {
  const expected = new Date(deliveredAt);
  if (!Number.isFinite(expected.getTime())) return false;
  const day = expected.toISOString().slice(0, 10);
  const months = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
  const dates = new RegExp(`\\b(?:\\d{4}-\\d{2}-\\d{2}|${months}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${months}(?:,?\\s+\\d{4})?)\\b`, "gi");
  let matched = false;
  const prose = reply.replace(/\b(was|were|is|are|has|have|had|did|does|do|could|would|should|must)n['’]t\b/gi, "$1 not");
  for (const part of prose.split(/\n+|;|(?<=[.!?])\s+/)) {
    // Qualified older history may have a different date; it is not the selected final.
    if (/\b(?:older|earlier|previous|superseded|outside)\b/i.test(part)) continue;
    if (/\blast\s+week\b/i.test(part)) {
      if (/\b(?:not|never)\s+(?:(?:actually|delivered|from|during|in|the)\s+){0,3}last\s+week\b/i.test(part)) return false;
      matched = true;
    }
    for (const date of part.matchAll(dates)) {
      const prefix = part.slice(0, date.index);
      const anchors = [...prefix.matchAll(/\b(deliver(?:ed|y)?|completed|import(?:ed)?|upload(?:ed)?)\b/gi)];
      // A separately identified import/upload time must not rewrite delivery time.
      if (/^(?:import|upload)/i.test(anchors.at(-1)?.[1] ?? "")) continue;
      if (/\b(?:not|never)\s+(?:(?:actually|deliver(?:ed)?|completed|dated|on|from|during)\s+){0,3}$/i.test(prefix)) return false;
      let text = date[0].replace(/(\d)(?:st|nd|rd|th)\b/gi, "$1").replace(/\bof\s+/gi, "");
      if (!/\d{4}/.test(text)) text += ` ${expected.getUTCFullYear()}`;
      const parsed = new Date(`${text} UTC`);
      if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) return false;
      matched = true;
    }
  }
  return matched;
}
export function gradeArtifactSearch(value: unknown) {
  const c = checks(); const o = observation(value) as SearchObservation | undefined;
  c.add("real-imported-artifact-history", !!o && !!o.finalAttachment && Array.isArray(o.deliveryComments) && Array.isArray(o.searchResults) && !!o.currentSource, "Public migration receipts, original source dates and actual imported attachment/download evidence are required.");
  if (!o || !o.finalAttachment || !Array.isArray(o.deliveryComments) || !Array.isArray(o.searchResults) || !o.currentSource) return c.result();
  const target = entity(o.state, "task"); const file = o.state.finalAttachment as IssueAttachment; const hidden = entity(o.state, "privateTask");
  c.add("original-last-week-delivery-not-import-time", o.currentSource.id === target.id && o.currentSource.completedAt === o.state.deliveryAt
    && Date.parse(String(o.state.deliveryAt)) >= Number(o.state.weekStart) && Date.parse(String(o.state.deliveryAt)) < Number(o.state.weekEnd)
    && o.deliveryComments.some(row => row.id === file.issueCommentId && row.createdAt === o.state.deliveryAt && (row.body ?? "").includes(file.sha256) && /Final approved website delivered/.test(row.body ?? ""))
    && o.activity.some(row => row.action === "company.imported" && Date.parse(row.createdAt ?? "") >= Date.parse(String(o.finalAttachment.createdAt))
      && Date.parse(row.createdAt ?? "") - Date.parse(String(o.finalAttachment.createdAt)) < 300000)
    && Date.parse(String(o.finalAttachment.createdAt)) > Date.parse(String(o.state.deliveryAt)),
    "The final belongs to the requested prior week through preserved completion and attachment-bound source-comment dates; the actual attachment import happened later.");
  c.add("exact-accessible-final-and-download", o.finalAttachment.id === file.id && o.finalAttachment.issueId === target.id && o.finalAttachment.sha256 === o.state.finalHash
    && o.downloadedHash === o.state.finalHash && hasLink(o, "issues", target) && !!verifiedReturnedFile(o, target, file)
    && /\b(?:final|approved|delivered)\b/i.test(o.reply) && describesHistoricalDelivery(selectedDeliveryProse(o, target, (o.state.distractors as Entity[]) ?? []), String(o.state.deliveryAt)),
    "The answer selects the actual final from the requested source time, with both exact source and usable verified download links.");
  const distractors = o.state.distractors as Entity[] | undefined;
  c.add("draft-older-final-and-private-snippets-excluded", !!distractors && distractors.every(row => !hasLink(o, "issues", row) || row.id !== hidden.id && o.reply.split(/\n/).some(part => [row.id, row.identifier, row.title].filter(Boolean).some(name => part.includes(name!))
      && /\b(?:draft|unapproved|older|earlier|previous|outside|not (?:the )?final)\b/i.test(part)))
    && [403, 404].includes(o.privateFileStatus) && o.searchStatus === 200 && !JSON.stringify(o.searchResults).includes(hidden.id)
    && !JSON.stringify(o.searchResults).includes(String(o.state.privateMarker)) && !o.reply.includes(String(o.state.privateMarker)) && !o.reply.includes(hidden.title ?? String(o.state.privateMarker))
    && !o.links.some(href => href.includes((o.state.privateAttachment as IssueAttachment).id) || href.includes((o.state.privateAttachment as IssueAttachment).assetId)),
    "A newer unapproved draft and an older final are either omitted or clearly qualified rather than substituted, and independently denied private artifacts and previews remain outside results.");
  const originals = o.state.originalTasks as HistoricalTask[] | undefined;
  c.add("history-not-rewritten-by-search", !!originals && originals.every(row => sameTask(row, o.tasks.find(now => now.id === row.id)))
    && originals.every(row => (o.tasks.find(now => now.id === row.id) as HistoricalTask | undefined)?.completedAt === row.completedAt)
    && Array.isArray(o.state.originalHistory) && o.state.originalHistory.length === originals.length
    && originals.every(original => (o.state.originalHistory as SourceHistory[]).filter(row => row.issueId === original.id).length === 1)
    && (o.state.originalHistory as SourceHistory[]).every(before => {
      const after = o.sourceHistory?.find(row => row.issueId === before.issueId); return !!after && historySignature(before) === historySignature(after);
    })
    && !o.activity.some(row => row.agentId === o.leadId && originals.some(source => source.id === row.entityId)
      && /issue\.(?:attachment_|work_product_|updated|document_|deleted|comment_)/.test(row.action ?? "")),
    "Searching preserves the migrated tasks, delivery state and source history.");
  return c.result();
}
function findArtifact(): ChatCatalogCase {
  let key: { id: string; token: string } | undefined;
  const base = makeDefinition("documents-artifacts.find-artifact", async ctx => {
    await mainPerson(ctx);
    const timezone = await ctx.input.page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(new Date());
    const number = (name: string) => Number(parts.find(part => part.type === name)?.value); const localDate = new Date(Date.UTC(number("year"), number("month") - 1, number("day")));
    const weekEnd = localDate.getTime() - ((localDate.getUTCDay() + 6) % 7) * 86400000; const weekStart = weekEnd - 7 * 86400000;
    const deliveryAt = new Date(weekStart + 2 * 86400000 + 12 * 3600000).toISOString();
    const bundle = buildHistoricalWebsiteImport(deliveryAt, ctx.input.nonce); const root = `/api/companies/${ctx.input.fixtures.company.id}`;
    const request = { source: { type: "inline", files: bundle.files, expectedFileCount: Object.keys(bundle.files).length }, include: { company: false, agents: false, projects: false, issues: true }, target: { mode: "existing_company", companyId: ctx.input.fixtures.company.id }, collisionStrategy: "rename", pauseAutomations: true };
    const preview = await ctx.input.api.post(`${root}/imports/preview`, request);
    await ctx.input.evidence("chat-catalog-historical-import-preview.json", preview);
    if (!historicalWebsitePreviewMatches(preview, bundle)) throw new Error("Public historical preview omitted the original task dates, source comments or SHA-bound attachment linkage");
    const imported = await ctx.input.api.post(`${root}/imports/apply`, request);
    await ctx.input.evidence("chat-catalog-historical-import-apply.json", imported);
    const p = await project(ctx); const oldProject = await project(ctx, "Earlier launch experiments"); const hiddenProject = await project(ctx, "Restricted launch history", { visibility: "private" });
    const all = await ctx.input.api.get<HistoricalTask[]>(`${root}/issues?limit=1000&includeAgentCreatedTasks=true`); const records: HistoricalTask[] = [];
    const files: IssueAttachment[] = [];
    for (const receipt of bundle.receipts) {
      const matching = all.filter(row => row.title === receipt.title); if (matching.length !== 1) throw new Error("Public historical import did not produce one exact source task");
      const current = await ctx.input.api.patch<HistoricalTask>(`/api/issues/${matching[0]!.id}`, { projectId: receipt.slug === "restricted-final" ? hiddenProject.id : receipt.slug === "old-final" ? oldProject.id : p.id }); records.push(current);
      const attached = (await ctx.input.api.get<IssueAttachment[]>(`/api/issues/${current.id}/attachments`)).filter(file => file.originalFilename === receipt.filename && file.sha256 === receipt.sha256);
      if (attached.length !== 1 || sha(await ctx.input.api.getAttachmentContent(attached[0]!.id)) !== receipt.sha256) throw new Error("Imported attachment bytes or preserved source-comment linkage are missing"); files.push(attached[0]!);
    }
    if (!ctx.input.privateSecrets) throw new Error("Historical search requires private probe credential redaction");
    key = await ctx.input.api.postSensitive(`/api/agents/${ctx.input.fixtures.agent.id}/keys`, { name: `historical-search-${ctx.input.nonce}` }); ctx.input.privateSecrets.push(key!.token);
    const originalHistory = await Promise.all(records.map(async row => ({ issueId: row.id, comments: await ctx.input.api.get<Entity[]>(`/api/issues/${row.id}/comments?order=asc`), attachments: await ctx.input.api.get<IssueAttachment[]>(`/api/issues/${row.id}/attachments`) })));
    const state = { originalHistory, project: p, task: records[0], finalAttachment: files[0], finalHash: bundle.receipts[0]!.sha256, deliveryAt, weekStart, weekEnd, timezone,
      originalTasks: records, distractors: records.slice(1), privateTask: records[3], privateAttachment: files[3], privateMarker: `${ctx.input.nonce}-restricted-final` };
    await ctx.input.evidence("chat-catalog-public-historical-delivery-import.json", { preview, imported, state, provenance: "Synthetic historical migration through supported public company import. Original source completion/comment dates are preserved; attachments are re-uploaded at import time, not falsely backdated." }); return state;
  }, gradeArtifactSearch);
  return { ...base, authentication: "human-session", sourceFiles: [...base.sourceFiles, "chat-catalog-domains/internal-artifact-search.ts", "chat-catalog-domains/internal-privacy.ts", "chat-catalog-domains/identity-auth.ts"],
    async observe(ctx, state): Promise<SearchObservation> {
      if (!key) throw new Error("Historical search probe was not created during setup"); const o = await observeInternal(ctx, state); const file = state.finalAttachment as IssueAttachment;
      const read = async (path: string) => { const url = new URL(path, ctx.input.api.baseURL); if (url.origin !== ctx.input.api.baseURL || !url.pathname.startsWith("/api/")) throw new Error("Historical probe escaped fixture API");
        const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${key!.token}` } }); return readSearchProbeResponse(response); };
      const [currentSource, attachments, deliveryComments, bytes, search] = await Promise.all([
        ctx.input.api.get<HistoricalTask>(`/api/issues/${entity(state, "task").id}`), ctx.input.api.get<IssueAttachment[]>(`/api/issues/${entity(state, "task").id}/attachments`),
        ctx.input.api.get<Entity[]>(`/api/issues/${entity(state, "task").id}/comments?order=asc`), ctx.input.api.getAttachmentContent(file.id), read(`/api/companies/${o.companyId}/search?q=website`),
      ]);
      const hiddenUrl = new URL((state.privateAttachment as IssueAttachment).contentPath, ctx.input.api.baseURL);
      const denied = await fetch(hiddenUrl, { redirect: "error", signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${key.token}` } }); await denied.body?.cancel();
      const results = search.body as { results?: unknown[] } | undefined; if (search.status === 200 && !Array.isArray(results?.results)) throw new Error("Search omitted its production result collection");
      const sourceHistory = await Promise.all((state.originalTasks as Entity[]).map(async row => ({ issueId: row.id, comments: await ctx.input.api.get<Entity[]>(`/api/issues/${row.id}/comments?order=asc`), attachments: await ctx.input.api.get<IssueAttachment[]>(`/api/issues/${row.id}/attachments`) })));
      const returnedFiles = await readReturnedWebsiteFiles(ctx, o);
      return { ...o, chatIssueId: ctx.issue()!.id, returnedFiles, sourceHistory, currentSource, finalAttachment: attachments.find(row => row.id === file.id)!, downloadedHash: sha(bytes), deliveryComments, searchStatus: search.status, searchResults: results?.results ?? [], privateFileStatus: denied.status };
    },
    async verifyResult(ctx, state, value) {
      const o = value as SearchObservation; await base.verifyResult(ctx, state, value); const returned = verifiedReturnedFile(o, entity(state, "task"), state.finalAttachment as IssueAttachment); const href = returned && fileLink(o, returned.attachment); if (!href) throw new Error("Missing exact historical file link");
      const page = await ctx.input.page.context().newPage(); try { const waiting = page.waitForEvent("download", { timeout: 5000 }).catch(() => undefined);
        await page.goto(new URL(href, o.origin).href).catch(error => { if (!/download|ERR_ABORTED/i.test(String(error))) throw error; }); const download = await waiting;
        if (download) { const path = await download.path(); if (!path || sha(await readFile(path)) !== state.finalHash) throw new Error("Historical browser download differs from preserved source bytes"); }
        else await expect(page.getByRole("heading", { name: "Final launch website delivery", exact: true })).toBeVisible();
        await ctx.input.evidence("chat-catalog-historical-file-opened.json", { attachmentId: returned!.attachment.id, sourceAttachmentId: o.finalAttachment.id, deliveryAt: state.deliveryAt, importedAt: o.finalAttachment.createdAt, sha256: returned!.downloadedHash });
      } finally { await page.close(); }
    },
    async cleanup(ctx) { if (key) { await ctx.input.api.delete(`/api/agents/${ctx.input.fixtures.agent.id}/keys/${key.id}`, { allowNotFound: true }); key = undefined; } },
  };
}
export const artifactSearchCases: readonly ChatCatalogCase[] = [findArtifact()];
