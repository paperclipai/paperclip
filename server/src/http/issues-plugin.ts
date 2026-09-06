import { Elysia, t } from "elysia";
import { forbidden, notFound, unauthorized } from "../errors.js";
import type { HttpActor } from "./actor-context.js";
import { createHttpAuthorization } from "./authorization.js";
import { getAccessibleHttpResource } from "./accessible-resource.js";
import type { ActorResolver } from "./context.js";

/**
 * Record shapes shared by the issues plugin. Each mirrors the minimal row
 * shape the Express oracle composes for the corresponding endpoint.
 */
export type IssueRecord = {
  id: string;
  companyId: string;
  parentId?: string | null;
  projectId?: string | null;
  goalId?: string | null;
  identifier?: string | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  status?: string;
  title?: string;
  [key: string]: unknown;
};

export type IssueCommentRecord = {
  id: string;
  issueId?: string;
  companyId?: string;
  authorType?: string;
  authorId?: string;
  [key: string]: unknown;
};

export type WorkProductRecord = {
  id: string;
  issueId?: string;
  [key: string]: unknown;
};

export type IssueDocumentRecord = {
  key: string;
  issueId?: string;
  [key: string]: unknown;
};

export type ListIssuesOptions = {
  limit?: number;
  offset?: number;
  assigneeUserId?: string;
  touchedByUserId?: string;
  inboxArchivedByUserId?: string;
  unreadForUserId?: string;
  attention?: string;
  sortField?: string;
  sortDir?: string;
  view?: string;
  [key: string]: unknown;
};

export type IssuesPluginOptions = {
  resolveActor: ActorResolver;
  /** Gate mirroring Express `assertAgentIssueMutationAllowed`. */
  assertCanMutate?: (actor: HttpActor, issue: IssueRecord) => Promise<void>;
  /** Gate mirroring Express `assertIssueReadAllowed`. */
  assertCanRead?: (actor: HttpActor, issue: IssueRecord) => Promise<void>;
  list: (companyId: string, options?: ListIssuesOptions) => Promise<unknown>;
  count?: (companyId: string, options?: Record<string, unknown>) => Promise<unknown>;
  getById: (id: string) => Promise<IssueRecord | null>;
  getByIdWithReadProjection?: (id: string) => Promise<Record<string, unknown> | null>;
  listComments: (issueId: string, options?: Record<string, unknown>) => Promise<unknown>;
  createComment: (issueId: string, body: unknown, actor: HttpActor) => Promise<IssueCommentRecord>;
  listDocuments: (
    issueId: string,
    options?: { includeSystem?: boolean },
  ) => Promise<unknown>;
  getDocumentByKey: (
    issueId: string,
    key: string,
    options?: Record<string, unknown>,
  ) => Promise<IssueDocumentRecord | null>;
  listWorkProducts: (
    issueId: string,
    options?: { refreshPullRequests?: boolean },
  ) => Promise<unknown>;
  listExternalObjects?: (issueId: string) => Promise<unknown>;
  getExternalObjectSummary?: (issueId: string) => Promise<unknown>;
  logActivity?: (input: Record<string, unknown>) => Promise<void>;
};

async function resolveActor(
  options: IssuesPluginOptions,
  ctx: { request: Request; actor?: HttpActor },
): Promise<HttpActor> {
  const actor = ctx.actor ?? (await options.resolveActor(ctx.request));
  if (!actor) throw unauthorized();
  return actor;
}

function query(params: URLSearchParams): Record<string, string | undefined> {
  return Object.fromEntries(params.entries());
}

async function requireReadableIssue(
  options: IssuesPluginOptions,
  actor: HttpActor,
  method: string,
  id: string,
): Promise<IssueRecord> {
  const issue = await getAccessibleHttpResource(actor, method, options.getById(id), "Issue not found");
  await options.assertCanRead?.(actor, issue);
  return issue;
}

async function requireMutableIssue(
  options: IssuesPluginOptions,
  actor: HttpActor,
  method: string,
  id: string,
): Promise<IssueRecord> {
  const issue = await getAccessibleHttpResource(actor, method, options.getById(id), "Issue not found");
  await options.assertCanMutate?.(actor, issue);
  return issue;
}

export function createIssuesPlugin(options: IssuesPluginOptions) {
  return new Elysia({ name: "paperclip-issues" })
    .get("/api/companies/:companyId/issues", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      const companyId = ctx.params.companyId;
      createHttpAuthorization(actor, ctx.request.method).requireCompany(companyId);
      const q = query(new URL(ctx.request.url).searchParams);
      const me = actor.type === "board" && actor.userId ? actor.userId : undefined;
      const result = await options.list(companyId, {
        ...q,
        assigneeUserId: q.assigneeUserId === "me" ? me : (q.assigneeUserId as string | undefined),
        touchedByUserId: q.touchedByUserId === "me" ? me : (q.touchedByUserId as string | undefined),
        inboxArchivedByUserId:
          q.inboxArchivedByUserId === "me" ? me : (q.inboxArchivedByUserId as string | undefined),
        unreadForUserId: q.unreadForUserId === "me" ? me : (q.unreadForUserId as string | undefined),
      });
      return result;
    })
    .get("/api/issues/:id", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      const issue = await requireReadableIssue(options, actor, ctx.request.method, ctx.params.id);
      if (options.getByIdWithReadProjection) {
        return options.getByIdWithReadProjection(issue.id);
      }
      return issue;
    })
    .get("/api/issues/:id/comments", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      const issue = await requireReadableIssue(options, actor, ctx.request.method, ctx.params.id);
      return options.listComments(issue.id);
    })
    .post(
      "/api/issues/:id/comments",
      async (ctx) => {
        const actor = await resolveActor(options, ctx);
        const issue = await requireMutableIssue(options, actor, ctx.request.method, ctx.params.id);
        const comment = await options.createComment(issue.id, ctx.body, actor);
        ctx.set.status = 201;
        await options.logActivity?.({
          companyId: issue.companyId,
          action: "issue.comment.added",
          entityType: "comment",
          entityId: comment.id,
        });
        return comment;
      },
      { body: t.Any() },
    )
    .get("/api/issues/:id/documents", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      const issue = await requireReadableIssue(options, actor, ctx.request.method, ctx.params.id);
      const url = new URL(ctx.request.url);
      return options.listDocuments(issue.id, {
        includeSystem: url.searchParams.get("includeSystem") === "true",
      });
    })
    .get("/api/issues/:id/documents/:key", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      const issue = await requireReadableIssue(options, actor, ctx.request.method, ctx.params.id);
      const key = String(ctx.params.key ?? "").trim().toLowerCase();
      const doc = await options.getDocumentByKey(issue.id, key);
      if (!doc) throw notFound("Document not found");
      return doc;
    })
    .get("/api/issues/:id/work-products", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      const issue = await requireReadableIssue(options, actor, ctx.request.method, ctx.params.id);
      const url = new URL(ctx.request.url);
      return options.listWorkProducts(issue.id, {
        refreshPullRequests: url.searchParams.get("refreshPullRequests") === "true",
      });
    })
    .get("/api/issues/:id/external-objects", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      const issue = await requireReadableIssue(options, actor, ctx.request.method, ctx.params.id);
      if (!options.listExternalObjects) throw notFound("Not found");
      return options.listExternalObjects(issue.id);
    })
    .get("/api/issues/:id/external-object-summary", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      const issue = await requireReadableIssue(options, actor, ctx.request.method, ctx.params.id);
      if (!options.getExternalObjectSummary) throw notFound("Not found");
      return options.getExternalObjectSummary(issue.id);
    });
}
