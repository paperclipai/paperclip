import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { inArray } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  goals,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  extractGitHubPullRequestReferences,
  getMergeConfirmationPullRequestReferences,
  issueThreadInteractionService,
} from "../services/issue-thread-interactions.js";
import {
  PULL_REQUEST_CACHE_MAX_ENTRIES,
  setBoundedPullRequestCacheEntry,
} from "../services/github-pull-request-merge.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

describe("merged pull-request confirmation extraction", () => {
  it("bounds shared pull-request state caches", () => {
    const cache = new Map<string, number>();
    for (let index = 0; index <= PULL_REQUEST_CACHE_MAX_ENTRIES; index += 1) {
      setBoundedPullRequestCacheEntry(cache, `pr-${index}`, index);
    }

    expect(cache.size).toBe(PULL_REQUEST_CACHE_MAX_ENTRIES);
    expect(cache.has("pr-0")).toBe(false);
    expect(cache.get(`pr-${PULL_REQUEST_CACHE_MAX_ENTRIES}`)).toBe(PULL_REQUEST_CACHE_MAX_ENTRIES);
  });

  it("extracts and deduplicates full GitHub URLs and owner/repo#N shorthand", () => {
    expect(extractGitHubPullRequestReferences([
      "Merge https://github.com/PaperclipAI/paperclip/pull/39.",
      "Also paperclipai/paperclip#40 and PAPERCLIPAI/paperclip#40.",
    ])).toEqual([
      { host: "github.com", owner: "PaperclipAI", repo: "paperclip", number: 39 },
      { host: "github.com", owner: "paperclipai", repo: "paperclip", number: 40 },
    ]);
  });

  it("requires merge intent and excludes document and tool-action confirmations", () => {
    const base = {
      kind: "request_confirmation",
      title: "Merge PaperclipAI/paperclip#39?",
      summary: null,
      payload: { version: 1, prompt: "Merge the pull request?" },
    } as const;
    expect(getMergeConfirmationPullRequestReferences(base)).toHaveLength(1);
    expect(getMergeConfirmationPullRequestReferences({
      ...base,
      title: "Approve the release?",
    })).toEqual([]);
    expect(getMergeConfirmationPullRequestReferences({
      ...base,
      payload: { ...base.payload, target: { type: "issue_document", key: "plan" } },
    })).toEqual([]);
    expect(getMergeConfirmationPullRequestReferences({
      ...base,
      payload: { ...base.payload, toolAction: { actionRequestId: "action-1" } },
    })).toEqual([]);
  });

  it("finds references in merge-confirmation body and custom target fields", () => {
    expect(getMergeConfirmationPullRequestReferences({
      kind: "request_confirmation",
      title: "Merge the linked PR?",
      summary: "The checks are green.",
      payload: {
        version: 1,
        prompt: "Merge the linked pull request?",
        detailsMarkdown: "Primary: paperclipai/paperclip#39",
        target: {
          type: "custom",
          key: "github-pr-40",
          href: "https://github.com/paperclipai/paperclip/pull/40",
        },
      },
    })).toEqual([
      { host: "github.com", owner: "paperclipai", repo: "paperclip", number: 39 },
      { host: "github.com", owner: "paperclipai", repo: "paperclip", number: 40 },
    ]);
  });

  it("denies governed actions mentioned in details or custom target metadata", () => {
    const base = {
      kind: "request_confirmation",
      title: "Merge the linked PR?",
      summary: "The checks are green.",
    } as const;
    expect(getMergeConfirmationPullRequestReferences({
      ...base,
      payload: {
        version: 1,
        prompt: "Merge the linked pull request?",
        detailsMarkdown: "Deploy to production after paperclipai/paperclip#39 merges.",
      },
    })).toEqual([]);
    expect(getMergeConfirmationPullRequestReferences({
      ...base,
      payload: {
        version: 1,
        prompt: "Merge the linked pull request?",
        target: {
          type: "custom",
          label: "Release to production",
          href: "https://github.com/paperclipai/paperclip/pull/39",
        },
      },
    })).toEqual([]);
  });

  it("fails closed when a merge confirmation includes an additional action clause", () => {
    expect(getMergeConfirmationPullRequestReferences({
      kind: "request_confirmation",
      title: "Merge the linked PR?",
      summary: null,
      payload: {
        version: 1,
        prompt: "Merge paperclipai/paperclip#39?",
        detailsMarkdown: "Erase all customer records after paperclipai/paperclip#39 merges.",
      },
    })).toEqual([]);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres.sequential("merged pull-request confirmation sweep", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-merged-pr-confirmations-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueThreadInteractions);
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("accepts only all-merged cards, wakes the assignee, and audits the system actor", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "MPR",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Ship safely",
      level: "task",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Land the changes",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const interactionIds = {
      merged: randomUUID(),
      boardOrAgents: randomUUID(),
      someOpen: randomUUID(),
      zeroRefs: randomUUID(),
      toolAction: randomUUID(),
      extraAction: randomUUID(),
    };
    const common = {
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee_on_accept",
      requestedResolverPolicy: "board_only",
      effectiveResolverPolicy: "board_only",
    } as const;
    await db.insert(issueThreadInteractions).values([
      {
        ...common,
        id: interactionIds.merged,
        title: "Merge https://github.com/paperclipai/paperclip/pull/39?",
        payload: { version: 1, prompt: "Merge the PR?" },
      },
      {
        ...common,
        id: interactionIds.boardOrAgents,
        title: "Merge paperclipai/paperclip#39?",
        requestedResolverPolicy: "board_or_agents",
        effectiveResolverPolicy: "board_or_agents",
        payload: { version: 1, prompt: "Merge the PR?" },
      },
      {
        ...common,
        id: interactionIds.someOpen,
        title: "Ready to merge paperclipai/paperclip#39 and paperclipai/paperclip#41?",
        payload: { version: 1, prompt: "Ready to merge both PRs?" },
      },
      {
        ...common,
        id: interactionIds.zeroRefs,
        title: "Merge the pending PR?",
        payload: { version: 1, prompt: "Merge it?" },
      },
      {
        ...common,
        id: interactionIds.toolAction,
        title: "Merge paperclipai/paperclip#42?",
        payload: {
          version: 1,
          prompt: "Merge the PR?",
          toolAction: { version: 1, actionRequestId: "action-1" },
        },
      },
      {
        ...common,
        id: interactionIds.extraAction,
        title: "Merge the linked PR?",
        payload: {
          version: 1,
          prompt: "Merge paperclipai/paperclip#39?",
          detailsMarkdown: "Erase all customer records after paperclipai/paperclip#39 merges.",
        },
      },
    ]);

    const wakeup = vi.fn(async () => ({ id: "wake-1" }));
    const resolvePullRequestState = vi.fn(async (_resolvedCompanyId: string, reference: { number: number }) =>
      reference.number === 41 ? "open" as const : "merged" as const
    );
    const service = issueThreadInteractionService(db, {
      wakeup,
      resolvePullRequestState,
    });

    await expect(service.sweepMergedPullRequestConfirmations()).resolves.toEqual({
      checked: 6,
      candidates: 3,
      accepted: 2,
      woken: 2,
    });

    const stored = await db
      .select({ id: issueThreadInteractions.id, status: issueThreadInteractions.status })
      .from(issueThreadInteractions)
      .where(inArray(issueThreadInteractions.id, Object.values(interactionIds)));
    expect(new Map(stored.map((row) => [row.id, row.status]))).toEqual(new Map([
      [interactionIds.merged, "accepted"],
      [interactionIds.boardOrAgents, "accepted"],
      [interactionIds.someOpen, "pending"],
      [interactionIds.zeroRefs, "pending"],
      [interactionIds.toolAction, "pending"],
      [interactionIds.extraAction, "pending"],
    ]));
    expect(wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      requestedByActorType: "system",
      requestedByActorId: "system:pr-merged",
      idempotencyKey: `interaction:${interactionIds.merged}:accepted`,
    }));
    expect(wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      requestedByActorType: "system",
      requestedByActorId: "system:pr-merged",
      idempotencyKey: `interaction:${interactionIds.boardOrAgents}:accepted`,
    }));
    expect(resolvePullRequestState).toHaveBeenCalledTimes(2);

    const audit = await db.select().from(activityLog);
    expect(audit).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actorType: "system",
        actorId: "system:pr-merged",
        action: "issue.thread_interaction_accepted",
        entityId: issueId,
        details: expect.objectContaining({
          interactionId: interactionIds.merged,
          resolutionActorKind: "system",
          pullRequests: ["paperclipai/paperclip#39"],
        }),
      }),
    ]));
  });
});
