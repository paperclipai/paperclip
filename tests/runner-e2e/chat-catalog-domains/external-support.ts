import { cleanupIdentityProbes } from "./identity-support.js";
import { expect } from "@playwright/test";
import type { ChatCatalogCase, ChatCatalogContext } from "../chat-catalog-contract.js";
import { observeInternal, checks, type Entity, type InternalObservation } from "./internal-support.js";

export interface ExternalObservation extends InternalObservation {
  phaseReplies: Array<{ runId: string; body: string; commentId?: string }>;
  connections: Entity[]; profiles: Entity[]; secrets: Entity[]; endpoints: Entity[];
  interactions: Array<Entity & { kind: string; payload?: Record<string, unknown>; resolvedByUserId?: string; resolvedByAgentId?: string }>;
}
export const root = (ctx: ChatCatalogContext) => `/api/companies/${ctx.input.fixtures.company.id}`;
export async function observeExternal(ctx: ChatCatalogContext, state: Record<string, unknown>): Promise<ExternalObservation> {
  const o = await observeInternal(ctx, state);
  const [connections, profiles, secrets, endpoints, interactions] = await Promise.all([
    ctx.input.api.get<{ connections: Entity[] }>(`${root(ctx)}/tools/connections`), ctx.input.api.get<{ profiles: Entity[] }>(`${root(ctx)}/tools/profiles`),
    ctx.input.api.get<Entity[]>(`${root(ctx)}/secrets`), ctx.input.api.get<Entity[]>(`${root(ctx)}/chat-endpoints`),
    ctx.issue() ? ctx.input.api.get<ExternalObservation["interactions"]>(`/api/issues/${ctx.issue()!.id}/interactions`) : Promise.resolve([]),
  ]);
  const comments = ctx.issue() ? await ctx.input.api.get<Entity[]>(`/api/issues/${ctx.issue()!.id}/comments?order=asc`) : [];
  const phaseReplies = comments.filter(row => row.authorAgentId === ctx.input.fixtures.agent.id && o.runs.some(run => run.id === row.createdByRunId))
    .map(row => ({ runId: row.createdByRunId!, commentId: row.id, body: row.body ?? "" }));
  return { ...o, phaseReplies, connections: connections.connections, profiles: profiles.profiles, secrets, endpoints, interactions };
}
export function externalObservation(value: unknown): ExternalObservation | undefined {
  const o = value as ExternalObservation | undefined;
  return o && typeof o.scenarioId === "string" && typeof o.reply === "string" && typeof o.companyId === "string" && !!o.state
    && [o.phaseReplies, o.connections, o.profiles, o.secrets, o.endpoints, o.interactions, o.activity, o.links, o.runs, o.humanQueries].every(Array.isArray) ? o : undefined;
}
export function definition(id: string, setup: ChatCatalogCase["setup"], grade: ChatCatalogCase["grade"], extra: Partial<ChatCatalogCase> = {}): ChatCatalogCase {
  const result: ChatCatalogCase = { scenarioId: id, setup, grade, observe: observeExternal,
    oracleVersion: "paperclip.chat-catalog.external.v1", expectedRunCount: 1, turnTimeoutMs: 120_000, attemptTimeoutMs: 300_000,
    sourceFiles: ["chat-catalog-domains/external-support.ts", "chat-catalog-domains/internal-support.ts", `chat-catalog-domains/external-${id.split(".")[0]}.ts`, `chat-scenarios/${id.split(".")[0]}.yaml`],
    async verifyResult(ctx, state, value) {
      const o = externalObservation(value); if (!o) throw new Error("Complete external result evidence required");
      const paths = [state.resultPath, ...(Array.isArray(state.resultPaths) ? state.resultPaths : [])].filter((path): path is string => typeof path === "string");
      if (!paths.length) throw new Error("Case must declare its public result surface");
      const href = o.links.find(link => {
        try { const url = new URL(link, o.origin); return url.origin === o.origin && paths.includes(url.pathname); } catch { return false; }
      });
      if (!href) throw new Error("The reply did not render the intended public management/result link");
      const source = ctx.input.page.url();
      await ctx.input.page.locator(`[id^="comment-"] a[href=${JSON.stringify(href)}]`).first().click();
      await ctx.input.page.waitForURL(url => paths.includes(url.pathname));
      await expect(ctx.input.page.getByRole("main")).toBeVisible();
      if (typeof state.resultLabel === "string") await expect(ctx.input.page.getByText(state.resultLabel, { exact: true }).first()).toBeVisible();
      await ctx.input.evidence("chat-catalog-external-result.json", { scenarioId: o.scenarioId, pathname: new URL(ctx.input.page.url()).pathname, label: state.resultLabel });
      await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
      await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible();
    }, ...extra };
  return { ...result, sourceFiles: [...new Set([...result.sourceFiles, "chat-catalog-domains/identity-support.ts"])],
    async setup(ctx) { try { return await result.setup(ctx); } catch (error) { await cleanupIdentityProbes(ctx); throw error; } },
    async cleanup(ctx, state) { try { await result.cleanup?.(ctx, state); } finally { await cleanupIdentityProbes(ctx); } },
  };
}
export function sameRows(before: unknown, after: unknown): boolean { return JSON.stringify(before) === JSON.stringify(after); }
export { checks };

/** Bind visible result verification to the exact persisted model comment. */
export async function verifyRenderedReply(ctx: ChatCatalogContext, value: unknown, excludeRunId?: string) {
  const o = externalObservation(value); if (!o) throw new Error("Missing rendered reply observation");
  const reply = o.phaseReplies.filter(row => row.runId !== excludeRunId).at(-1);
  if (!reply?.commentId || !reply.body.trim()) throw new Error("No persisted result comment for this phase");
  await expect(ctx.input.page.locator(`[id=${JSON.stringify(`comment-${reply.commentId}`)}]`)).toBeVisible();
  await ctx.input.evidence("chat-catalog-external-visible-reply.json", { scenarioId: o.scenarioId, commentId: reply.commentId, runId: reply.runId });
}
