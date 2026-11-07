import { pollUntil } from "../api.js";
import { remainingIdentityObservationBudget } from "./identity-support.js";
import type { ChatCatalogCase, ChatCatalogContext } from "../chat-catalog-contract.js";
import { makeDefinition, fixtureWorker } from "./internal-definition.js";
import { checks, companyPath, entity, hasLink, observation, observeInternal, project, sameTask, task, type Entity, type InternalObservation } from "./internal-support.js";
import type { IssueAttachment } from "../../../packages/shared/src/types/issue.js";

interface InventoryOwner extends Entity { companyId?: string; lifecycleState?: string; lifecycleVersion?: number; lifecycleHolds?: string[]; lifecycleError?: unknown }
export interface InventoryOwnerPause { before: InventoryOwner; requested: InventoryOwner }
export function inventoryOwnerWasReady(owner: InventoryOwner, companyId: string, id: string) {
  return owner.id === id && owner.companyId === companyId && owner.lifecycleState === "ready"
    && ["idle", "active", "running"].includes(owner.status ?? "") && !owner.lifecycleError
    && Number.isSafeInteger(owner.lifecycleVersion) && owner.lifecycleVersion! >= 0 && Number.isSafeInteger(owner.lifecycleVersion! + 2)
    && Array.isArray(owner.lifecycleHolds) && owner.lifecycleHolds.length === 0;
}
export function inventoryOwnerPauseRetained(receipt: InventoryOwnerPause | undefined, current: InventoryOwner, companyId: string, id: string) {
  if (!receipt || !inventoryOwnerWasReady(receipt.before, companyId, id)) return false;
  const { before, requested } = receipt;
  const held = (row: InventoryOwner) => row.id === id && row.companyId === companyId && row.status === "paused" && !row.lifecycleError
    && Array.isArray(row.lifecycleHolds) && row.lifecycleHolds.length === 1 && row.lifecycleHolds[0] === "manual";
  return held(requested) && held(current) && current.lifecycleState === "paused" && current.lifecycleVersion === before.lifecycleVersion! + 2
    && (requested.lifecycleState === "pausing" && requested.lifecycleVersion === before.lifecycleVersion! + 1
      || requested.lifecycleState === "paused" && requested.lifecycleVersion === current.lifecycleVersion);
}
export interface InventoryDeliverable { id: string; href: string; body: string }
export type InventoryObservation = InternalObservation & { sourceIssueId?: string; deliverables?: InventoryDeliverable[] };
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Where a task is presented: a rendered chat link, or a task link/identifier inside a linked run deliverable. */
function presentations(o: InventoryObservation, row: Entity) {
  const found: Array<{ doc: number; at: number; text: string }> = [];
  const href = o.links.find(link => hasLink({ ...o, links: [link] }, "issues", row));
  if (href && o.reply.includes(href)) found.push({ doc: 0, at: o.reply.indexOf(href), text: o.reply });
  (o.deliverables ?? []).forEach((file, index) => {
    const tokens = [row.id, row.identifier].filter((value): value is string => !!value);
    for (const token of tokens) {
      const match = new RegExp(`(?<![A-Za-z0-9-])${escapeRegExp(token)}(?![A-Za-z0-9])`).exec(file.body);
      if (match) { found.push({ doc: index + 1, at: match.index, text: file.body }); break; }
    }
  });
  return found;
}
function groupContext(text: string, at: number) {
  const lineStart = text.lastIndexOf("\n", at) + 1; const lineEnd = text.indexOf("\n", at);
  const line = text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
  const prior = text.slice(0, lineStart).split("\n").reverse().find(line => /^\s*(?:#{1,6}\s+|\*\*)/.test(line)) ?? "";
  return `${line} ${prior}`.toLowerCase();
}
export function gradeOpenInventory(value: unknown) {
  const c = checks(); const o = observation(value) as InventoryObservation | undefined;
  c.add("independent-inventory", !!o && Array.isArray(o.state.originalTasks), "The independently saved, settled multi-page inventory is required.");
  if (!o || !Array.isArray(o.state.originalTasks)) return c.result();
  const originals = o.state.originalTasks as Entity[]; const p = entity(o.state, "project");
  const open = originals.filter(row => row.projectId === p.id && !["done", "cancelled"].includes(row.status ?? ""));
  const placed = new Map(open.map(row => [row.id, presentations(o, row)] as const));
  const shown = open.filter(row => placed.get(row.id)!.length > 0);
  const excluded = originals.filter(row => !open.includes(row));
  const linkedDeliverables = (o.deliverables ?? []).every(file => o.links.includes(file.href) && o.reply.includes(file.href));
  c.add("real-more-than-default-page", open.length > 500 && open.some(row => row.status === "blocked") && open.some(row => row.status !== "blocked")
    && originals.every(row => sameTask(row, o.tasks.find(now => now.id === row.id))),
    "More than the production default 500 settled open rows exist, mixing blocked and other work, and the read-only answer preserves every saved task.");
  c.add("full-or-explicitly-bounded", linkedDeliverables && (shown.length === open.length || shown.length > 0
    && new RegExp(`\\b${shown.length}\\b`).test(o.reply) && new RegExp(`\\b${open.length}\\b`).test(o.reply)),
    "Every open task is presented (in chat or a deliverable linked from the reply), or the reply states its actual shown count and the full open count.");
  c.add("terminal-and-other-project-excluded", excluded.every(row => !presentations(o, row).length), "Completed, cancelled and other-project work is excluded.");
  const owners = o.state.ownerLabels as Record<string, string>;
  const named = Object.entries(owners ?? {}).filter(([key]) => key !== "unassigned").map(([, label]) => label.toLowerCase());
  let correctlyGrouped = !!owners;
  for (const row of shown) for (const at of placed.get(row.id)!) {
    const context = groupContext(at.text, at.at); const key = row.assigneeAgentId ?? "unassigned";
    const owner = owners?.[key]?.toLowerCase();
    if (!owner) correctlyGrouped = false;
    else if (key === "unassigned" ? named.some(label => context.includes(label)) : !context.includes(owner)) correctlyGrouped = false;
  }
  c.add("actual-single-owner-groups", shown.length > 0 && correctlyGrouped, "Each presented item sits under its actual single assignee, and unassigned items under no named owner.");
  c.add("blocked-first-within-owner", Object.keys(owners ?? {}).every(owner => {
    const group = shown.filter(row => (row.assigneeAgentId ?? "unassigned") === owner);
    const docs = new Set(group.flatMap(row => placed.get(row.id)!.map(at => at.doc)));
    return [...docs].every(doc => {
      const at = (row: Entity) => placed.get(row.id)!.find(place => place.doc === doc)?.at;
      const blocked = group.filter(row => row.status === "blocked").map(at).filter((v): v is number => v !== undefined);
      const other = group.filter(row => row.status !== "blocked").map(at).filter((v): v is number => v !== undefined);
      return !blocked.length || !other.length || Math.max(...blocked) < Math.min(...other);
    });
  }), "Blocked work precedes other open items within every owner group.");
  // The chat answer itself (its comment and linked deliverable on the conversation) and run plumbing are not work changes.
  c.add("read-only-audit", !!o.sourceIssueId && !o.activity.some(row => row.agentId === o.leadId && (row.action === "issue.created"
    || ["issue", "project", "goal", "agent"].includes(String((row as Entity & { entityType?: string }).entityType))
      && (row as Entity & { entityId?: string }).entityId !== o.sourceIssueId && row.action !== "issue.read_marked")),
    "Organizing the answer creates no control-plane work changes outside the conversation.");
  return c.result();
}
export async function observeOpenInventory(ctx: ChatCatalogContext, state: Record<string, unknown>): Promise<InventoryObservation> {
  const o = await observeInternal(ctx, state); const source = ctx.issue();
  const runIds = new Set(o.runs.map(run => run.id)); const deliverables: InventoryDeliverable[] = [];
  if (source) for (const file of await ctx.input.api.get<IssueAttachment[]>(`/api/issues/${source.id}/attachments`)) {
    const href = o.links.find(link => new URL(link, o.origin).pathname === `/api/attachments/${file.id}/content`);
    if (!href || file.createdByAgentId !== o.leadId || !runIds.has(file.originatingRunId ?? "") || file.byteSize > 1024 * 1024) continue;
    deliverables.push({ id: file.id, href, body: (await ctx.input.api.getAttachmentContent(file.id)).toString("utf8") });
  }
  return { ...o, sourceIssueId: source?.id, deliverables };
}
async function settledInventory(ctx: ChatCatalogContext, ids: readonly string[], deadlineAt: number) {
  // Product recovery may legitimately re-status seeded work (for example, assigned to a paused owner).
  // Record the inventory only after it stops changing, so the answer is judged against current records.
  const read = async () => {
    const rows = await ctx.input.api.getRunObservation<Entity[]>(`${companyPath(ctx)}/issues?includeAgentCreatedTasks=true&limit=1000`);
    return ids.map(id => rows.find(row => row.id === id)!);
  };
  let last = await read(); let stableSince = Date.now();
  while (Date.now() - stableSince < 25_000) {
    if (Date.now() + 2_000 >= deadlineAt) throw new Error("Seeded inventory did not settle within the observation budget");
    await new Promise(resolve => setTimeout(resolve, 2_000));
    const next = await read();
    if (next.some(row => !row) || next.some((row, index) => !sameTask(last[index]!, row))) { last = next; stableSince = Date.now(); }
  }
  if (last.some(row => !row)) throw new Error("Seeded inventory rows are missing");
  return last;
}
export function openInventoryTaskSeed(index: number, workerId: string, secondWorkerId: string) {
  const owner = index % 3 === 0 ? workerId : index % 3 === 1 ? secondWorkerId : null;
  return {
    title: `Launch work ${String(index + 1).padStart(3, "0")}`,
    status: index % 7 === 0 ? "blocked" : index % 2 === 0 && owner ? "in_progress" : "todo",
    assigneeAgentId: owner,
    description: "Existing launch work. This inventory fixture records current state and must not trigger execution.",
  };
}
function openInventory(): ChatCatalogCase {
  const base = makeDefinition("tasks.organize-open-work", async ctx => {
    const p = await project(ctx); const other = await project(ctx, "Experiments"); const worker = await fixtureWorker(ctx);
    const secondWorker = await fixtureWorker(ctx);
    await ctx.input.api.patch(`/api/agents/${secondWorker.id}`, { name: "Riley" });
    // Existing ownership is prerequisite state. Pause both owners before seeding
    // actionable statuses so preparing an inventory never starts provider work.
    remainingIdentityObservationBudget(ctx);
    const deadlineAt = ctx.observationDeadlineAt!;
    const companyId = ctx.input.fixtures.company.id;
    const ownerPauseReceipts: InventoryOwnerPause[] = [];
    if ((await ctx.allRuns()).length) throw new Error("Inventory prerequisites unexpectedly admitted work");
    for (const id of [worker.id, secondWorker.id]) {
      const before = await ctx.input.api.get<InventoryOwner>(`/api/agents/${id}`);
      if (!inventoryOwnerWasReady(before, companyId, id)) throw new Error("Inventory owner was not genuinely ready before manual pause");
      const requested = await ctx.input.api.post<InventoryOwner>(`/api/agents/${id}/pause`);
      const receipt = { before, requested }; ownerPauseReceipts.push(receipt);
      await pollUntil({ label: "Actual inventory owner manual pause completes", deadlineAt,
        load: () => ctx.input.api.get<InventoryOwner>(`/api/agents/${id}`),
        accept: row => Date.now() < deadlineAt && inventoryOwnerPauseRetained(receipt, row, companyId, id),
        reject: row => row.lifecycleError ? "Inventory owner pause failed" : undefined });
    }
    const originalTasks: Entity[] = [];
    for (let index = 0; index < 501; index++) {
      const { title, ...fields } = openInventoryTaskSeed(index, worker.id, secondWorker.id);
      originalTasks.push(await task(ctx, title, p.id, fields));
    }
    originalTasks.push(await task(ctx, "Completed launch work", p.id, { status: "done" }), await task(ctx, "Cancelled launch work", p.id, { status: "cancelled" }),
      await task(ctx, "Unrelated experiment", other.id));
    remainingIdentityObservationBudget(ctx);
    const settled = await settledInventory(ctx, originalTasks.map(row => row.id), deadlineAt);
    originalTasks.splice(0, originalTasks.length, ...settled);
    if ((await ctx.allRuns()).length) throw new Error("Seeding the paused-owner inventory unexpectedly admitted work");
    return { project: p, originalTasks, workerIds: [worker.id, secondWorker.id], ownerPauseReceipts, ownerLabels: { [worker.id]: "Morgan", [secondWorker.id]: "Riley", unassigned: "Unassigned" } };
  }, gradeOpenInventory);
  return { ...base, observe: observeOpenInventory, oracleVersion: "paperclip.chat-catalog.internal.organize-open-work.v2",
    sourceFiles: [...base.sourceFiles, "chat-catalog-domains/internal-task-inventory.ts"], attemptTimeoutMs: 600_000,
    setupPolicy: { readiness: "preserve-scenario", invariantCheckIds: ["inventory-owners-paused", "lead-ready", "inventory-settled"] },
    async verifySetup(ctx, state) {
      const c = checks();
      const lead = await ctx.input.api.get<Entity & { lifecycleState: string }>(`/api/agents/${ctx.input.fixtures.agent.id}`);
      const ids = state.workerIds as string[];
      const owners = await Promise.all(ids.map(id => ctx.input.api.get<InventoryOwner>(`/api/agents/${id}`)));
      const receipts = state.ownerPauseReceipts as InventoryOwnerPause[] | undefined;
      c.add("inventory-owners-paused", ids.length === 2 && new Set(ids).size === 2 && receipts?.length === 2
        && owners.every((row, index) => inventoryOwnerPauseRetained(receipts[index], row, ctx.input.fixtures.company.id, ids[index]!)),
        "Both actual owners were ready before manual pause and retain their exact completed paused lifecycle, version and manual hold; no provider work is admitted.");
      c.add("lead-ready", lead.lifecycleState === "ready" && ["idle", "active"].includes(lead.status ?? ""), "The CEO remains ready for the canonical inventory query.");
      const current = await ctx.input.api.getRunObservation<Entity[]>(`${companyPath(ctx)}/issues?includeAgentCreatedTasks=true&limit=1000`);
      const originals = state.originalTasks as Entity[];
      c.add("inventory-settled", originals.every(row => sameTask(row, current.find(now => now.id === row.id))),
        "The recorded inventory is still the current task state when the query is sent.");
      return c.result();
    },
    async verifyResult(ctx, state, value) {
      const o = observation(value)! as InventoryObservation; const shown = o.tasks.filter(row => hasLink(o, "issues", row));
      if (!shown.length) {
        // The inventory was delivered as a linked file: require that each deliverable link was rendered in this conversation.
        const files = o.deliverables ?? [];
        if (!files.length || files.some(file => !o.renderedLinkEvidence?.some(link => link.href === file.href))) throw new Error("No rendered task or inventory deliverable link");
        return;
      }
      const representatives = new Map<string, Entity>();
      for (const row of shown) {
        const key = `${row.assigneeAgentId ?? "unassigned"}:${row.status === "blocked" ? "blocked" : "other"}`;
        if (!representatives.has(key)) representatives.set(key, row);
      }
      await base.verifyResult(ctx, state, { ...o, tasks: [...representatives.values()], projects: [], goals: [] });
    },
  };
}
export const taskInventoryCases: readonly ChatCatalogCase[] = [openInventory()];
