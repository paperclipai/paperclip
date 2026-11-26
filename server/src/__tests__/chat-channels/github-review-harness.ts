import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect } from "vitest";
import {
  chatActions,
  chatEndpoints,
  chatExternalPrincipals,
  chatGitHubReviews,
  chatIdentityLinks,
  heartbeatRuns,
} from "@paperclipai/db";
import { githubChatManagementService } from "../../services/chat-github-management.js";
import { githubChatReviewService } from "../../services/chat-github-reviews.js";
import { githubReviewCheckService } from "../../services/chat-github-checks.js";
import { githubAutomaticReviewEvent } from "../../services/chat-github-events.js";
import { makeMessage, makeThread } from "./providers.js";
import type { ChatChannelHarness } from "./harness.js";
import type { GitHubHarness } from "./github-harness.js";

export function createGitHubReviewHarness(h: ChatChannelHarness, gh: GitHubHarness) {
  const {
    seedCompany,
    readChatConversationsByEndpointId,
    readChatEndpointsById,
    readChatGitHubReviewsByEndpointId,
    chatWakeContext,
    deliverMessage,
  } = h;
  const { signedGitHubWebhookRequest, configuredGitHubEndpoint } = gh;

  async function reviewBotFixture() {
    const db = h.db;
    const fixture = await seedCompany();
    const context = await configuredGitHubEndpoint(fixture, {}, true);
    const endpoint = await context.service.get(context.endpoint.id);
    const [principal] = await db
      .insert(chatExternalPrincipals)
      .values({
        companyId: fixture.companyId,
        provider: "github",
        providerAccountId: endpoint.providerAccountId!,
        externalId: "42",
        kind: "user",
        displayName: "Octocat",
        handle: "octocat",
        isBot: false,
      })
      .returning();
    await db.insert(chatIdentityLinks).values({
      companyId: fixture.companyId,
      endpointId: endpoint.id,
      principalId: principal.id,
      paperclipUserId: "owner-user",
      status: "linked",
      confirmedAt: new Date(),
    });
    const management = githubChatManagementService(db, context.providerFetch);
    const initial = await management.configuration(endpoint.id, "owner-user");
    await management.saveConfiguration(
      endpoint.id,
      {
        expectedRevision: initial.revision,
        configuration: { ...initial.configuration, toolsEnabled: true },
      },
      "owner-user",
    );
    await context.service.update(
      endpoint.id,
      { allowGroupChats: true },
      "owner-user",
    );
    return { ...fixture, ...context, endpoint, principal, management };
  }

  async function subscribedGitHubFixture(threadId = "github:paperclipai/paperclip:issue:419") {
    const f = await reviewBotFixture();
    const thread = makeThread({ channelId: "paperclipai/paperclip", id: threadId }).thread;
    await deliverMessage({
      callbacks: f.callbacks,
      endpointId: f.endpoint.id,
      provider: "github",
      thread,
      trigger: "mention",
      message: makeMessage({
        id: "41901",
        text: `@${f.endpoint.botUsername} start this thread`,
        userId: "42",
        userName: "octocat",
        mentioned: true,
      }),
    });
    const [conversation] = await readChatConversationsByEndpointId(f.endpoint.id);
    return { ...f, thread, conversation };
  }

  async function addPeerGitHubBot(f: Awaited<ReturnType<typeof reviewBotFixture>>) {
    const db = h.db;
    const peer = await f.service.create(
      f.companyId,
      { provider: "github", assignedAgentId: f.assignedAgentId, name: "Gonzo" },
      "owner-user",
    );
    await db
      .update(chatEndpoints)
      .set({ botUsername: "gonzo[bot]", status: "active" })
      .where(eq(chatEndpoints.id, peer.id));
    return peer;
  }

  async function toolReplyFixture(
    threadId = "github:paperclipai/paperclip:issue:418",
    reportOnly = false,
    findingCategories?: string[],
  ) {
    const db = h.db;
    const f = await reviewBotFixture();
    if (reportOnly || findingCategories) {
      const config = await f.management.configuration(f.endpoint.id, "owner-user");
      await f.management.saveConfiguration(
        f.endpoint.id,
        {
          expectedRevision: config.revision,
          configuration: {
            ...config.configuration,
            defaults: {
              ...config.configuration.defaults,
              ...(reportOnly ? { ratingThreshold: null } : {}),
              ...(findingCategories ? { findingCategories } : {}),
            },
          },
        },
        "owner-user",
      );
    }
    const thread = makeThread({ channelId: "paperclipai/paperclip", id: threadId }).thread;
    await deliverMessage({
      callbacks: f.callbacks,
      endpointId: f.endpoint.id,
      provider: "github",
      thread,
      trigger: "mention",
      message: makeMessage({
        id: "41801",
        text: "Are you there?",
        userId: "42",
        userName: "octocat",
        mentioned: true,
      }),
    });
    const [conversation] = await readChatConversationsByEndpointId(f.endpoint.id);
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: f.companyId,
        agentId: f.assignedAgentId,
        status: "running",
        runtimeMode: "native",
        contextSnapshot: await chatWakeContext({
          endpointId: f.endpoint.id,
          issueId: conversation.issueId,
          provider: "github",
          providerMessageId: "41801",
        }),
      })
      .returning();
    const session = {
      companyId: f.companyId,
      agentId: f.assignedAgentId,
      issueId: conversation.issueId,
      runId: run.id,
    };
    return { ...f, conversation, run, session };
  }

  async function publicationRetryFixture(findingCategories?: string[]) {
    const db = h.db;
    const f = await toolReplyFixture("github:paperclipai/paperclip:418", true, findingCategories);
    const head = "b".repeat(40);
    const inline: Array<{ id: number; body: string; html_url: string; user: { login: string } }> = [];
    const checks: Array<{ id: number; external_id: string; app: { id: number }; html_url: string }> = [];
    const writes: Array<{ path: string; method: string }> = [];
    const provider = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/pulls/418")) {
        return Response.json({
          number: 418,
          state: "open",
          draft: false,
          head: { sha: head },
          base: { sha: "a".repeat(40), ref: "master" },
          user: { id: 42, login: "octocat", type: "User" },
          labels: [],
        });
      }
      if (url.includes("/files?")) {
        return Response.json([
          { filename: "src/math.ts", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new" },
        ]);
      }
      if (url.includes("/pulls/418/comments?")) return Response.json(inline);
      if (url.includes("/check-runs?")) return Response.json({ check_runs: checks });
      if (init?.method === "POST" && url.endsWith("/pulls/418/comments")) {
        writes.push({ path: url, method: init.method });
        const item = {
          id: 420 + inline.length,
          body: JSON.parse(String(init.body)).body,
          html_url: "https://github.com/acme/repo/pull/418#discussion_r420",
          user: { login: f.endpoint.botUsername! },
        };
        inline.push(item);
        return Response.json(item);
      }
      if (url.includes("/check-runs") && init?.method) {
        writes.push({ path: url, method: init.method });
        const body = JSON.parse(String(init.body));
        const check = checks[0] ?? {
          id: 419,
          external_id: body.external_id,
          app: { id: Number(f.endpoint.botExternalId) },
          html_url: "https://github.com/checks/419",
        };
        if (!checks.length) checks.push(check);
        return Response.json(check);
      }
      return undefined;
    };
    f.setSupplementalProviderFetch(provider);
    const service = githubChatReviewService(db, f.providerFetch);
    await service.execute(f.session, "begin_review", { reviewedCommit: head });
    const assessment = {
      reviewedCommit: head,
      score: 3,
      complete: true,
      summary: "Advisory review",
      rationale: "Reviewed the file",
      coverage: { reviewedPaths: ["src/math.ts"], omittedPaths: [], limitations: [] },
      findings: [],
    };
    const action = async () =>
      (
        await db
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, f.endpoint.id),
              eq(chatActions.kind, "github_review_publication"),
            ),
          )
      )[0];
    return { ...f, service, head, assessment, provider, action, inline, checks, writes };
  }

  async function reviewCheckWorkerFixture(status: "running" | "failed" = "failed") {
    const db = h.db;
    const f = await toolReplyFixture("github:paperclipai/paperclip:418");
    const config = await f.management.configuration(f.endpoint.id, "owner-user");
    const event = githubAutomaticReviewEvent(
      {
        action: "opened",
        repository: { id: 97531, full_name: "paperclipai/paperclip" },
        sender: { id: 42, login: "octocat" },
        pull_request: {
          number: 418,
          title: "Review",
          body: "",
          draft: false,
          base: { sha: "a".repeat(40), ref: "master" },
          head: { sha: "b".repeat(40) },
          user: { id: 42, login: "octocat" },
          labels: [],
        },
      },
      randomUUID(),
    )!;
    const [review] = await db
      .insert(chatGitHubReviews)
      .values({
        companyId: f.companyId,
        endpointId: f.endpoint.id,
        issueId: f.conversation.issueId!,
        runId: f.run.id,
        repositoryId: "97531",
        repository: event.repository,
        pullNumber: 418,
        headSha: event.headSha,
        deliveryId: event.deliveryId,
        configurationRevision: config.revision,
        policySnapshot: config.configuration.defaults,
        event,
      })
      .returning();
    await db.update(heartbeatRuns).set({ status }).where(eq(heartbeatRuns.id, f.run.id));
    const writes: Record<string, unknown>[] = [];
    const requests: string[] = [];
    let remoteHead = event.headSha;
    let unavailable = false;
    f.setSupplementalProviderFetch(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/pulls/418")) {
        requests.push(url);
        return Response.json({ head: { sha: remoteHead } });
      }
      if (url.includes("/check-runs?")) {
        requests.push(url);
        return Response.json({ check_runs: [] });
      }
      if (url.endsWith("/check-runs") && init?.method === "POST") {
        requests.push(url);
        if (unavailable) return Response.json({ message: "injected check outage" }, { status: 503 });
        writes.push(JSON.parse(String(init.body)));
        return Response.json({ id: 418, html_url: "https://github.com/checks/418" });
      }
      return undefined;
    });
    const checks = githubReviewCheckService(db, f.providerFetch);
    const [endpoint] = await readChatEndpointsById(f.endpoint.id);
    const action = async () =>
      (
        await db
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, endpoint.id),
              eq(chatActions.kind, "github_review_check"),
            ),
          )
      )[0];
    return {
      ...f,
      event,
      review,
      endpoint,
      checks,
      writes,
      requests,
      action,
      enqueue: () => checks.enqueue(endpoint, event, true, "authorized"),
      setRemoteHead: (value: string) => {
        remoteHead = value;
      },
      setUnavailable: (value: boolean) => {
        unavailable = value;
      },
    };
  }

  async function reviewProjectionFixture(cancelFirst = true) {
    const db = h.db;
    const f = await reviewBotFixture();
    const deliveryId = randomUUID();
    const payload = {
      action: "synchronize",
      installation: { id: 2468 },
      repository: {
        id: 97531,
        full_name: "paperclipai/paperclip",
        name: "paperclip",
        owner: { id: 1357, login: "paperclipai" },
      },
      sender: { id: 42, login: "octocat" },
      pull_request: {
        number: 82,
        title: "Rapid pushes",
        body: "",
        draft: false,
        base: { sha: "a".repeat(40), ref: "master" },
        head: { sha: "b".repeat(40) },
        user: { id: 42, login: "octocat", type: "User" },
        labels: [],
      },
    };
    f.setSupplementalProviderFetch(async (input) =>
      String(input).endsWith("/pulls/82")
        ? Response.json({ ...payload.pull_request, head: { sha: "c".repeat(40) } })
        : undefined,
    );
    const checks = githubReviewCheckService(db, f.providerFetch);
    const [endpoint] = await readChatEndpointsById(f.endpoint.id);
    const event = githubAutomaticReviewEvent(payload, deliveryId)!;
    await checks.enqueue(endpoint, event, true, "authorized");
    const action = async () =>
      (
        await db
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, endpoint.id),
              eq(chatActions.kind, "github_review_check"),
            ),
          )
      )[0];
    if (cancelFirst) await checks.processPending();
    const admit = async () => {
      expect(
        (
          await f.service.handleWebhook(
            endpoint.publicId,
            "github",
            signedGitHubWebhookRequest({
              event: "pull_request",
              delivery: deliveryId,
              payload,
              webhookSecret: f.webhookSecret,
            }),
          )
        ).status,
      ).toBeLessThan(300);
      await expect
        .poll(async () => (await readChatGitHubReviewsByEndpointId(endpoint.id)).length, {
          timeout: 10_000,
        })
        .toBe(1);
      return (await readChatGitHubReviewsByEndpointId(endpoint.id))[0];
    };
    const read = async (id: string) =>
      (await db.select().from(chatGitHubReviews).where(eq(chatGitHubReviews.id, id)))[0];
    return { ...f, endpoint, event, action, checks, admit, read };
  }

  return {
    reviewBotFixture,
    subscribedGitHubFixture,
    addPeerGitHubBot,
    toolReplyFixture,
    publicationRetryFixture,
    reviewCheckWorkerFixture,
    reviewProjectionFixture,
  };
}
