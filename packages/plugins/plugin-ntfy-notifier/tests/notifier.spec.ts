import { describe, expect, it } from "vitest";
import {
  AGENT_ID,
  APPROVAL_ID,
  BASE_CONFIG,
  COMPANY_ID,
  INTERACTION_ID,
  ISSUE_ID,
  PRIVATE_ISSUE_ID,
  SECRET_TITLE,
  TOKEN,
  USER_ID,
  approvalCreated,
  event,
  interactionCreated,
  issueUpdated,
  okResponse,
  setup,
} from "./fixtures.js";

function blockIssue(s: ReturnType<typeof setup>, owner: unknown, at = "2026-01-01T00:00:00.000Z") {
  s.harness.seed({
    issues: [
      {
        id: ISSUE_ID,
        companyId: COMPANY_ID,
        identifier: "EX-42",
        title: SECRET_TITLE,
        status: "blocked",
        unblockDescriptor: owner === undefined ? null : { owner, action: SECRET_TITLE },
        blockedTransitionAt: at,
      } as never,
    ],
  });
}

describe("trigger filtering", () => {
  it("notifies once for an approval waiting for the board", async () => {
    const s = setup();
    await expect(s.notifier.handle(approvalCreated())).resolves.toBe("sent");
    expect(s.requests).toHaveLength(1);
  });

  it("notifies for an interaction addressed to a person", async () => {
    const s = setup();
    await expect(s.notifier.handle(interactionCreated())).resolves.toBe("sent");
    expect(s.requests).toHaveLength(1);
  });

  it("notifies for an interaction with no addressee (board inbox)", async () => {
    const s = setup();
    const outcome = await s.notifier.handle(interactionCreated({ addresseeUserId: null, effectiveResolverPolicy: "anyone" }));
    expect(outcome).toBe("sent");
  });

  it("ignores an interaction addressed to an agent", async () => {
    const s = setup();
    const outcome = await s.notifier.handle(
      interactionCreated({ addresseeAgentId: AGENT_ID, addresseeUserId: null, effectiveResolverPolicy: "anyone" }),
    );
    expect(outcome).toBe("ignored");
    expect(s.requests).toHaveLength(0);
  });

  it("ignores an interaction that is no longer pending", async () => {
    const s = setup();
    await expect(s.notifier.handle(interactionCreated({ interactionStatus: "answered" }))).resolves.toBe("ignored");
  });

  it("accepts a raw activity.logged row for interaction creation", async () => {
    const s = setup();
    const outcome = await s.notifier.handle(
      event("activity.logged", {
        payload: {
          action: "issue.thread_interaction_created",
          entityType: "issue",
          entityId: ISSUE_ID,
          details: { interactionId: INTERACTION_ID, interactionStatus: "pending", addresseeAgentId: null },
        },
      }),
    );
    expect(outcome).toBe("sent");
  });

  it("ignores ordinary activity, comments, resolutions and other events", async () => {
    const s = setup();
    const noise = [
      event("activity.logged", { payload: { action: "issue.comment_added", entityType: "issue", entityId: ISSUE_ID } }),
      event("activity.logged", { payload: { action: "issue.thread_interaction_answered", details: { interactionId: INTERACTION_ID } } }),
      event("issue.comment.created", { entityType: "issue", entityId: ISSUE_ID, payload: { body: SECRET_TITLE } }),
      event("approval.decided", { entityType: "approval", entityId: APPROVAL_ID, payload: { status: "approved" } }),
      event("issue.thread_interaction_accepted", { entityType: "issue", entityId: ISSUE_ID, payload: { interactionId: INTERACTION_ID } }),
      issueUpdated({ status: "in_review", changes: { status: { from: "in_progress", to: "in_review" } } }),
      issueUpdated({ title: "renamed", changes: { title: { from: "a", to: "b" } } }),
    ];
    for (const e of noise) await expect(s.notifier.handle(e)).resolves.toBe("ignored");
    expect(s.requests).toHaveLength(0);
  });

  it("notifies when an issue becomes blocked on a board-owned unblock step", async () => {
    const s = setup();
    blockIssue(s, "board");
    const outcome = await s.notifier.handle(
      issueUpdated({ status: "blocked", changes: { status: { from: "in_progress", to: "blocked" } } }),
    );
    expect(outcome).toBe("sent");
  });

  it("notifies when an issue becomes blocked on a user-owned unblock step", async () => {
    const s = setup();
    blockIssue(s, { userId: USER_ID });
    const outcome = await s.notifier.handle(
      issueUpdated({ status: "blocked", changes: { status: { from: "todo", to: "blocked" } } }),
    );
    expect(outcome).toBe("sent");
  });

  it("does not notify for a blocker owned by an agent or with no descriptor", async () => {
    const s = setup();
    const update = issueUpdated({ status: "blocked", changes: { status: { from: "todo", to: "blocked" } } });
    blockIssue(s, { agentId: AGENT_ID });
    await expect(s.notifier.handle(update)).resolves.toBe("not_eligible");
    blockIssue(s, undefined);
    await expect(s.notifier.handle(update)).resolves.toBe("not_eligible");
    expect(s.requests).toHaveLength(0);
  });

  it("does not notify for a blocker the plugin cannot read", async () => {
    const s = setup();
    const outcome = await s.notifier.handle(
      issueUpdated({ status: "blocked", changes: { status: { from: "todo", to: "blocked" } } }, PRIVATE_ISSUE_ID),
    );
    expect(outcome).toBe("not_eligible");
  });

  it("respects per-trigger enable flags", async () => {
    const s = setup({ config: { ...BASE_CONFIG, triggers: { approvals: false, interactions: false, blockerAttention: false } } });
    blockIssue(s, "board");
    await expect(s.notifier.handle(approvalCreated())).resolves.toBe("ignored");
    await expect(s.notifier.handle(interactionCreated())).resolves.toBe("ignored");
    await expect(
      s.notifier.handle(issueUpdated({ status: "blocked", changes: { status: { from: "todo", to: "blocked" } } })),
    ).resolves.toBe("ignored");
    expect(s.requests).toHaveLength(0);
  });

  it("does nothing for a company without config", async () => {
    const s = setup({ config: {} });
    await expect(s.notifier.handle(approvalCreated())).resolves.toBe("not_configured");
    expect(s.requests).toHaveLength(0);
  });
});

describe("privacy of the outbound request", () => {
  it("sends only the fixed body, a click link, the fixed title and tag, auth and content type", async () => {
    const s = setup();
    await s.notifier.handle(interactionCreated());
    const [request] = s.requests;
    expect(request.url).toBe("https://ntfy.example.test/decisions");
    expect(request.method).toBe("POST");
    expect(request.body).toBe("A decision is waiting: EX-42");
    expect(request.headers).toEqual({
      "Content-Type": "text/plain; charset=utf-8",
      Click: "https://paperclip.example.test/EX/issues/EX-42",
      Title: "Paperclip decision EX-42",
      Tags: "paperclip",
      Authorization: `Bearer ${TOKEN}`,
    });
  });

  it("adds only a numeric Priority header when configured", async () => {
    const s = setup({ config: { ...BASE_CONFIG, priority: 4 } });
    await s.notifier.handle(approvalCreated());
    expect(Object.keys(s.requests[0].headers).sort()).toEqual(["Authorization", "Click", "Content-Type", "Priority", "Tags", "Title"]);
    expect(s.requests[0].headers.Priority).toBe("4");
  });

  it("never forwards titles, question text, agent or user ids", async () => {
    const s = setup();
    await s.notifier.handle(interactionCreated());
    await s.notifier.handle(approvalCreated());
    const serialized = JSON.stringify(s.requests);
    for (const secret of [SECRET_TITLE, "Nightingale", AGENT_ID, USER_ID, INTERACTION_ID, "ask_user_questions"]) {
      expect(serialized).not.toContain(secret);
    }
    // Title and Tags are fixed constants: only the canonical identifier follows the prefix.
    expect(s.requests.map((request) => request.headers.Title)).toEqual(["Paperclip decision EX-42", "Paperclip decision EX-42"]);
    expect(s.requests.map((request) => request.headers.Tags)).toEqual(["paperclip", "paperclip"]);
  });

  it("omits the Authorization header when no token is configured", async () => {
    const { tokenSecretRef: _omit, ...open } = BASE_CONFIG;
    const s = setup({ config: open });
    await s.notifier.handle(approvalCreated());
    expect(s.requests[0].headers.Authorization).toBeUndefined();
  });

  it("links an approval without an issue to its approval page, with the fixed word 'approval'", async () => {
    const s = setup();
    await s.notifier.handle(approvalCreated([]));
    expect(s.requests[0].body).toBe("A decision is waiting: approval");
    expect(s.requests[0].headers.Click).toBe(`https://paperclip.example.test/EX/approvals/${APPROVAL_ID}`);
  });

  it("falls back to the issue UUID link when the issue is not readable", async () => {
    const s = setup();
    await s.notifier.handle(interactionCreated({}, PRIVATE_ISSUE_ID));
    expect(s.requests[0].body).toBe("A decision is waiting");
    expect(s.requests[0].headers.Click).toBe(`https://paperclip.example.test/EX/issues/${PRIVATE_ISSUE_ID}`);
  });

  it("keeps logs free of tokens, URLs, identifiers and event text", async () => {
    const s = setup({ fetch: async () => new Response("denied", { status: 403 }) });
    await s.notifier.handle(interactionCreated());
    const ok = setup();
    await ok.notifier.handle(approvalCreated());
    const logs = JSON.stringify([...s.harness.logs, ...ok.harness.logs]);
    expect(logs.length).toBeGreaterThan(2);
    for (const secret of [TOKEN, "ntfy.example.test", "decisions", "EX-42", SECRET_TITLE, ISSUE_ID, APPROVAL_ID, INTERACTION_ID]) {
      expect(logs).not.toContain(secret);
    }
  });
});

describe("durable dedupe", () => {
  it("sends once when the same event is delivered twice, even concurrently", async () => {
    const s = setup();
    const e = approvalCreated();
    const outcomes = await Promise.all([s.notifier.handle(e), s.notifier.handle({ ...e, eventId: "dup" })]);
    expect(outcomes.sort()).toEqual(["duplicate", "sent"]);
    await expect(s.notifier.handle(e)).resolves.toBe("duplicate");
    expect(s.requests).toHaveLength(1);
  });

  it("does not send again after a simulated restart (new notifier, same state)", async () => {
    const s = setup();
    await s.notifier.handle(interactionCreated());
    const restarted = s.makeNotifier();
    await expect(restarted.handle(interactionCreated())).resolves.toBe("duplicate");
    expect(s.requests).toHaveLength(1);
  });

  it("dedupes an interaction seen through both event paths", async () => {
    const s = setup();
    await s.notifier.handle(interactionCreated());
    const replay = event("activity.logged", {
      payload: {
        action: "issue.thread_interaction_created",
        entityType: "issue",
        entityId: ISSUE_ID,
        details: { interactionId: INTERACTION_ID, interactionStatus: "pending", addresseeAgentId: null },
      },
    });
    await expect(s.notifier.handle(replay)).resolves.toBe("duplicate");
    expect(s.requests).toHaveLength(1);
  });

  it("keys a blocker on its blocked episode, so a later episode notifies again", async () => {
    const s = setup();
    const update = issueUpdated({ status: "blocked", changes: { status: { from: "todo", to: "blocked" } } });
    blockIssue(s, "board", "2026-01-01T00:00:00.000Z");
    await expect(s.notifier.handle(update)).resolves.toBe("sent");
    await expect(s.notifier.handle(update)).resolves.toBe("duplicate");
    blockIssue(s, "board", "2026-01-02T00:00:00.000Z");
    await expect(s.notifier.handle(update)).resolves.toBe("sent");
    expect(s.requests).toHaveLength(2);
  });

  it("keeps distinct decisions distinct", async () => {
    const s = setup();
    await s.notifier.handle(approvalCreated([ISSUE_ID], APPROVAL_ID));
    await s.notifier.handle(approvalCreated([ISSUE_ID], "00000000-0000-4000-8000-0000000000b2"));
    expect(s.requests).toHaveLength(2);
  });

  it("does not mark a failed send, so a replay can deliver it", async () => {
    let fail = true;
    const s = setup({ fetch: async () => (fail ? new Response("", { status: 503 }) : okResponse()) });
    await expect(s.notifier.handle(approvalCreated())).resolves.toBe("send_failed");
    fail = false;
    await expect(s.notifier.handle(approvalCreated())).resolves.toBe("sent");
    await expect(s.notifier.handle(approvalCreated())).resolves.toBe("duplicate");
  });
});

describe("outbound failure handling", () => {
  it("retries a 5xx a bounded number of times then gives up", async () => {
    const s = setup({ fetch: async () => new Response("", { status: 502 }) });
    await expect(s.notifier.handle(approvalCreated())).resolves.toBe("send_failed");
    expect(s.requests).toHaveLength(3);
    const warn = s.harness.logs.find((l) => l.message.includes("publish failed"));
    expect(warn?.meta).toMatchObject({ reason: "http_status", status: 502, attempts: 3 });
  });

  it("does not retry a 4xx other than 408/429", async () => {
    const s = setup({ fetch: async () => new Response("", { status: 401 }) });
    await expect(s.notifier.handle(approvalCreated())).resolves.toBe("send_failed");
    expect(s.requests).toHaveLength(1);
  });

  it("treats a 401/403 auth rejection as a failure: one attempt, redacted log, no dedupe mark", async () => {
    let denied = true;
    const s = setup({ fetch: async () => (denied ? new Response("forbidden", { status: 403 }) : okResponse()) });
    const e = approvalCreated();
    await expect(s.notifier.handle(e)).resolves.toBe("send_failed");
    expect(s.requests).toHaveLength(1);
    const warn = s.harness.logs.find((l) => l.message.includes("publish failed"));
    expect(warn?.meta).toMatchObject({ reason: "http_status", status: 403, attempts: 1 });
    expect(JSON.stringify(s.harness.logs)).not.toContain(TOKEN);
    denied = false;
    await expect(s.notifier.handle({ ...e, eventId: "redelivery" })).resolves.toBe("sent");
    expect(s.requests).toHaveLength(2);
  });

  it("recovers when a retry succeeds", async () => {
    const s = setup({ fetch: async (attempt) => (attempt < 2 ? new Response("", { status: 429 }) : okResponse()) });
    await expect(s.notifier.handle(approvalCreated())).resolves.toBe("sent");
    expect(s.requests).toHaveLength(2);
  });

  it("times out a hung request and stays bounded", async () => {
    const s = setup({ fetch: () => new Promise<Response>(() => {}) });
    const started = Date.now();
    await expect(s.notifier.handle(approvalCreated())).resolves.toBe("send_failed");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(s.requests).toHaveLength(3);
    const warn = s.harness.logs.find((l) => l.message.includes("publish failed"));
    expect(warn?.meta).toMatchObject({ reason: "timeout" });
  });

  it("treats a network error as a failure without throwing", async () => {
    const s = setup({ fetch: async () => { throw new TypeError(`connect ECONNREFUSED ${TOKEN}`); } });
    await expect(s.notifier.handle(approvalCreated())).resolves.toBe("send_failed");
    expect(JSON.stringify(s.harness.logs)).not.toContain(TOKEN);
  });

  it("skips without sending when the token secret cannot be resolved", async () => {
    const s = setup({ config: { ...BASE_CONFIG, tokenSecretRef: { type: "secret_ref", secretId: "00000000-0000-4000-8000-00000000ffff" } } });
    await expect(s.notifier.handle(approvalCreated())).resolves.toBe("token_unavailable");
    expect(s.requests).toHaveLength(0);
    // Not marked: a later event can still be delivered once the secret works.
    await expect(s.notifier.handle(approvalCreated())).resolves.toBe("token_unavailable");
  });

  it("never throws even when host reads fail", async () => {
    const s = setup();
    s.harness.ctx.state.get = async () => { throw new Error(`db down ${TOKEN}`); };
    await expect(s.notifier.handle(approvalCreated())).resolves.toBe("error");
    expect(JSON.stringify(s.harness.logs)).not.toContain(TOKEN);
  });
});
