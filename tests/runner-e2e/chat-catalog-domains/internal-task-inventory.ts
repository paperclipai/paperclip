import { pollUntil } from "../api.js";
import { remainingIdentityObservationBudget } from "./identity-support.js";
import type { ChatCatalogCase } from "../chat-catalog-contract.js";
import { makeDefinition, fixtureWorker } from "./internal-definition.js";
import { checks, entity, hasLink, observation, project, sameTask, task, type Entity } from "./internal-support.js";

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
export function gradeOpenInventory(value: unknown) {
  const c = checks(); const o = observation(value);
  c.add("independent-inventory", !!o && Array.isArray(o.state.originalTasks), "The independently saved multi-page inventory is required.");
  if (!o || !Array.isArray(o.state.originalTasks)) return c.result();
  const originals = o.state.originalTasks as Entity[]; const p = entity(o.state, "project");
  const open = originals.filter(row => row.projectId === p.id && !["done", "cancelled"].includes(row.status ?? ""));
  const shown = open.filter(row => hasLink(o, "issues", row));
  const excluded = originals.filter(row => !open.includes(row));
  c.add("real-more-than-default-page", open.length > 500 && originals.every(row => sameTask(row, o.tasks.find(now => now.id === row.id))),
    "More than the production default 500 rows exist and the read-only answer preserves every saved task.");
  c.add("full-or-explicitly-bounded", shown.length === open.length || shown.length > 0
    && /\b(?:partial|first|limited|remaining|more results|not exhaustive|not all)\b/i.test(o.reply)
    && new RegExp(`\\b${shown.length}\\b`).test(o.reply) && new RegExp(`\\b${open.length}\\b`).test(o.reply),
    "All open work is linked, or the answer explicitly states its actual shown count and full inventory bound.");
  c.add("terminal-and-other-project-excluded", excluded.every(row => !hasLink(o, "issues", row)), "Completed, cancelled and other-project work is excluded.");
  const owners = o.state.ownerLabels as Record<string, string>;
  const positions = new Map<string, number>();
  let correctlyGrouped = !!owners;
  for (const row of shown) {
    const href = o.links.find(link => hasLink({ ...o, links: [link] }, "issues", row))!;
    const at = o.reply.indexOf(href); positions.set(row.id, at);
    if (at < 0) { correctlyGrouped = false; continue; }
    const lineStart = o.reply.lastIndexOf("\n", at) + 1;
    const lineEnd = o.reply.indexOf("\n", at);
    const line = o.reply.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
    const prior = o.reply.slice(0, lineStart).split("\n").reverse().find(text => /^\s*(?:#{1,6}\s+|\*\*)/.test(text)) ?? "";
    const owner = owners[row.assigneeAgentId ?? "unassigned"];
    if (!owner || !`${line} ${prior}`.toLowerCase().includes(owner.toLowerCase())) correctlyGrouped = false;
  }
  c.add("actual-single-owner-groups", shown.length > 0 && correctlyGrouped, "Each rendered item is grouped under its actual single assignee or the unassigned group.");
  c.add("blocked-first-within-owner", Object.keys(owners ?? {}).every(owner => {
    const group = shown.filter(row => (row.assigneeAgentId ?? "unassigned") === owner);
    const blocked = group.filter(row => row.status === "blocked").map(row => positions.get(row.id) ?? -1);
    const other = group.filter(row => row.status !== "blocked").map(row => positions.get(row.id) ?? -1);
    return !blocked.length || !other.length || Math.max(...blocked) < Math.min(...other);
  }), "Blocked work precedes other open items within every owner group.");
  c.add("read-only-audit", !o.activity.some(row => row.agentId === o.leadId && row.action !== "issue.read_marked"), "Organizing the answer creates no control-plane work changes.");
  return c.result();
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
    if ((await ctx.allRuns()).length) throw new Error("Seeding the paused-owner inventory unexpectedly admitted work");
    return { project: p, originalTasks, workerIds: [worker.id, secondWorker.id], ownerPauseReceipts, ownerLabels: { [worker.id]: "Morgan", [secondWorker.id]: "Riley", unassigned: "Unassigned" } };
  }, gradeOpenInventory);
  return { ...base, sourceFiles: [...base.sourceFiles, "chat-catalog-domains/internal-task-inventory.ts"], attemptTimeoutMs: 600_000,
    setupPolicy: { readiness: "preserve-scenario", invariantCheckIds: ["inventory-owners-paused", "lead-ready"] },
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
      return c.result();
    },
    async verifyResult(ctx, state, value) {
      const o = observation(value)!; const shown = o.tasks.filter(row => hasLink(o, "issues", row));
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
