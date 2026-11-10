import type { ChatCatalogCase } from "../chat-catalog-contract.js";
import { makeDefinition } from "./internal-definition.js";
import { mainPerson } from "./internal-privacy.js";
import { readSearchProbeResponse } from "./internal-search-response.js";
import { checks, entity, hasLink, observation, observeInternal, project, putDocument, sameTask, task, type Entity, type InternalObservation } from "./internal-support.js";

interface DesignObservation extends InternalObservation {
  approvedRevision?: Entity; approvalComments: Entity[]; olderApprovalComments: Entity[]; privateReadStatus: number; agentSearchStatus: number; agentSearchResults: unknown[];
}
function designClauses(reply: string) { return reply.split(/[.\n;]|\b(?:whereas|while|but)\b/i); }
function contradictsDraftApproval(reply: string, target: Entity) {
  return designClauses(reply).some(part => {
    const taskReferences = part.match(/\b[A-Z][A-Z0-9]*-\d+\b/g) ?? [];
    if (taskReferences.some(id => id !== target.identifier)) return false;
    if (!/\b(?:revision\s*2|version\s*2|v2|violet\s+navigation)\b/i.test(part)) return false;
    return [...part.matchAll(/\b(?:approved|signed[ -]off)\b/gi)].some(match =>
      !/(?:\b(?:not|never)|\bno longer|\b(?:hasn't|haven't|wasn't|weren't|isn't|aren't))(?:\s+(?:yet|been|ever|officially|currently|formally))*\s*$/i.test(part.slice(0, match.index)));
  });
}
function describesUnapprovedCurrentDraft(reply: string, target: Entity) {
  return designClauses(reply).some(part => {
    const taskReferences = part.match(/\b[A-Z][A-Z0-9]*-\d+\b/g) ?? [];
    if (taskReferences.length && (!target.identifier || taskReferences.some(id => id !== target.identifier))) return false;
    const versions = [...part.matchAll(/\b(?:revision|version)\s*(\d+)\b|\bv(\d+)\b/gi)].map(match => Number(match[1] ?? match[2]));
    if (versions.some(version => version !== 2)) return false;
    return /\b(?:newer|later|latest|current|revision\s*2|version\s*2|v2|violet\s+navigation)\b/i.test(part)
      && /\b(?:unapproved|not approved|not yet approved|pending review)\b/i.test(part)
      && !/\b(?:not|never|no longer|isn't)\s+(?:an?\s+)?(?:unapproved|pending review)\b/i.test(part);
  });
}
export function gradeDesignSearch(value: unknown) {
  const c = checks(); const o = observation(value) as DesignObservation | undefined;
  c.add("independent-design-history", !!o && Array.isArray(o.approvalComments) && Array.isArray(o.agentSearchResults), "Saved design revision, human approval and actual acting-agent search evidence are required.");
  if (!o || !Array.isArray(o.approvalComments) || !Array.isArray(o.agentSearchResults)) return c.result();
  const approved = o.state.approvedRevision as Entity | undefined; const target = o.state.task as Entity | undefined;
  const originals = o.state.originalTasks as Entity[] | undefined; const current = o.documents.find(row => row.key === "plan");
  c.add("real-approved-revision-retained", !!approved && !!o.approvedRevision && approved.id === o.approvedRevision.id && approved.body === o.approvedRevision.body
    && Array.isArray(o.olderApprovalComments) && o.olderApprovalComments.some(row => row.id === (o.state.olderApprovalComment as Entity | undefined)?.id
      && row.authorUserId === o.state.ownerId && row.body === (o.state.olderApprovalComment as Entity).body
      && Number.isFinite(Date.parse(row.createdAt ?? "")) && Date.parse(row.createdAt!) <= Date.parse((o.state.approvalComment as Entity).createdAt ?? ""))
    && o.approvalComments.some(row => row.id === (o.state.approvalComment as Entity | undefined)?.id && row.authorUserId === o.state.ownerId && row.body === (o.state.approvalComment as Entity).body),
    "The exact historical revision and real human approval comment remain saved rather than inferring approval from latest edit time.");
  c.add("approved-design-distinguished-from-newer-draft", !!target && hasLink(o, "issues", target)
    && designClauses(o.reply).some(sentence => /\b(?:approved|signed[ -]off)\b/i.test(sentence)
      && /\b(?:revision\s*1|version\s*1|v1|amber\s+navigation)/i.test(sentence)
      && !/\b(?:not|never|no longer)\s+(?:yet\s+)?(?:approved|signed[ -]off)\b|\bunapproved\b/i.test(sentence))
    && describesUnapprovedCurrentDraft(o.reply, target)
    && !contradictsDraftApproval(o.reply, target),
    "The answer links the actual approved design and explains that the later revision is still a draft.");
  c.add("read-only-design-search", !!originals && originals.every(row => sameTask(row, o.tasks.find(now => now.id === row.id)))
    && current?.latestRevisionId === o.state.draftRevisionId && current?.body === o.state.draftBody
    && !o.activity.some(row => row.agentId === o.leadId && originals.some(original => original.id === row.entityId) && /issue\.(?:document_|updated|comment_added)/.test(row.action ?? "")),
    "Finding a design does not approve a draft, rewrite its history or mutate prerequisite work.");
  const hidden = o.state.privateTask as Entity | undefined; const marker = String(o.state.privateMarker);
  c.add("inaccessible-design-excluded", [403, 404].includes(o.privateReadStatus) && o.agentSearchStatus === 200 && !!hidden
    && !JSON.stringify(o.agentSearchResults).includes(hidden.id) && !JSON.stringify(o.agentSearchResults).includes(marker)
    && !o.reply.includes(marker) && !o.reply.includes(hidden.id) && !o.reply.includes(hidden.title ?? marker)
    && !o.links.some(link => link.includes(hidden.id) || !!hidden.identifier && link.includes(hidden.identifier)),
    "A healthy acting-agent search cannot expose the inaccessible project's design or snippet, including through copied links.");
  return c.result();
}
function findDesign(): ChatCatalogCase {
  let key: { id: string; token: string } | undefined;
  const base = makeDefinition("inbox-search.find-design", async ctx => {
    const ownerId = await mainPerson(ctx); const p = await project(ctx);
    const olderTask = await task(ctx, "Earlier launch website design", p.id);
    const olderDesign = await putDocument(ctx, olderTask.id, "# Earlier launch website design\nSlate navigation and a waitlist-only form.\n");
    const olderApprovalComment = await ctx.input.api.post<Entity>(`/api/issues/${olderTask.id}/comments`, { body: `I approve this earlier website design revision ${olderDesign.latestRevisionId}: slate navigation and waitlist-only form.` });
    const t = await task(ctx, "Launch website design", p.id);
    const approvedRevision = await putDocument(ctx, t.id, "# Launch website design v1\nAmber navigation, accessible signup and research-team testimonials.\n");
    const approvalComment = await ctx.input.api.post<Entity>(`/api/issues/${t.id}/comments`, {
      body: `I approve revision 1 (${approvedRevision.latestRevisionId}) of the launch website design: amber navigation with accessible signup. This is the signed-off design.`,
    });
    const draftBody = "# Launch website design v2 — unapproved draft\nViolet navigation and animated pricing. Review is still pending; this revision has not been approved.\n";
    const draft = await putDocument(ctx, t.id, draftBody, approvedRevision.latestRevisionId!);
    const marketing = await task(ctx, "Launch marketing notes", p.id); await putDocument(ctx, marketing.id, "# Launch design discussion\nUnapproved campaign concepts; not the website design.\n");
    const privateMarker = `SEALED-DESIGN-${ctx.input.nonce}`; const hiddenProject = await project(ctx, "Restricted launch designs", { visibility: "private" });
    const hidden = await task(ctx, `Private website design ${privateMarker}`, hiddenProject.id);
    await putDocument(ctx, hidden.id, `# Approved private launch design\n${privateMarker}. Not accessible to the acting agent.\n`);
    if (!ctx.input.privateSecrets) throw new Error("Design search requires attempt-private probe credential redaction");
    key = await ctx.input.api.postSensitive(`/api/agents/${ctx.input.fixtures.agent.id}/keys`, { name: `design-search-${ctx.input.nonce}` }); ctx.input.privateSecrets.push(key!.token);
    return { project: p, task: t, ownerId, olderTask, olderApprovalComment, originalTasks: [olderTask, t, marketing, hidden], approvedRevision: { id: approvedRevision.latestRevisionId, body: approvedRevision.body },
      approvalComment, draftRevisionId: draft.latestRevisionId, draftBody, privateTask: hidden, privateMarker };
  }, gradeDesignSearch);
  return { ...base, authentication: "human-session", sourceFiles: [...base.sourceFiles, "chat-catalog-domains/internal-design-search.ts", "chat-catalog-domains/internal-privacy.ts", "chat-catalog-domains/identity-auth.ts"],
    async observe(ctx, state): Promise<DesignObservation> {
      if (!key) throw new Error("Design probe credential was not created during setup");
      const read = async (path: string) => {
        const url = new URL(path, ctx.input.api.baseURL); if (url.origin !== ctx.input.api.baseURL || !url.pathname.startsWith("/api/")) throw new Error("Design probe escaped fixture API");
        const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${key!.token}` } });
        return readSearchProbeResponse(response);
      };
      const o = await observeInternal(ctx, state); const hidden = entity(state, "privateTask"); const target = entity(state, "task");
      const [privateRead, search] = await Promise.all([read(`/api/issues/${hidden.id}`), read(`/api/companies/${o.companyId}/search?q=launch%20website%20design`)]);
      const result = search.body as { results?: unknown[] } | null;
      if (search.status === 200 && !Array.isArray(result?.results)) throw new Error("Design search lacks production results collection");
      return { ...o, approvedRevision: o.revisions.find(row => row.id === (state.approvedRevision as Entity).id),
        olderApprovalComments: await ctx.input.api.get<Entity[]>(`/api/issues/${entity(state, "olderTask").id}/comments?order=asc`),
        approvalComments: await ctx.input.api.get<Entity[]>(`/api/issues/${target.id}/comments?order=asc`), privateReadStatus: privateRead.status,
        agentSearchStatus: search.status, agentSearchResults: result?.results ?? [] };
    },
    async cleanup(ctx) { if (key) { await ctx.input.api.delete(`/api/agents/${ctx.input.fixtures.agent.id}/keys/${key.id}`, { allowNotFound: true }); key = undefined; } },
  };
}
export const designSearchCases: readonly ChatCatalogCase[] = [findDesign()];
