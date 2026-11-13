/**
 * Addressee routing for interaction cards, tool-gateway and budget approvals,
 * computed blocker attention, and board decisions. Payloads are synthetic
 * examples of host activity details for these events.
 */
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
  setup,
} from "./fixtures.js";
import { buildMessageTitle, MESSAGE_TAGS, TITLE_PREFIX } from "../src/message.js";

const ACTION_REQUEST_ID = "00000000-0000-4000-8000-0000000000f1";
const DECISION_ID = "00000000-0000-4000-8000-0000000000f2";
const TERMINAL_ID = ISSUE_ID;
const AT_1 = "2026-03-01T10:00:00.000Z";
const AT_2 = "2026-03-02T10:00:00.000Z";

/** Shape emitted for a card created through the interaction service. */
function serviceInteraction(details: Record<string, unknown> = {}, issueId = ISSUE_ID) {
  return event("issue.thread_interaction_created", {
    entityType: "issue",
    entityId: issueId,
    payload: {
      interactionId: INTERACTION_ID,
      interactionKind: "request_confirmation",
      interactionStatus: "pending",
      continuationPolicy: "wake_assignee",
      addresseeAgentId: null,
      addresseeUserId: null,
      requestedResolverPolicy: "anyone",
      effectiveResolverPolicy: "anyone",
      toolActionRequestId: null,
      source: "interaction_service",
      agentId: AGENT_ID,
      runId: null,
      responsibleUserId: USER_ID,
      ...details,
    },
  });
}

/** A payload with no addressee keys at all (older emitters). */
function legacyInteraction(details: Record<string, unknown> = {}, issueId = ISSUE_ID) {
  return event("issue.thread_interaction_created", {
    entityType: "issue",
    entityId: issueId,
    payload: {
      identifier: "EX-42",
      interactionId: INTERACTION_ID,
      interactionKind: "ask_user_questions",
      interactionStatus: "pending",
      continuationPolicy: "wake_assignee",
      agentId: AGENT_ID,
      runId: null,
      responsibleUserId: USER_ID,
      ...details,
    },
  });
}

function seedCard(s: ReturnType<typeof setup>, card: Record<string, unknown>) {
  s.harness.seed({
    issueInteractions: [
      {
        id: INTERACTION_ID,
        companyId: COMPANY_ID,
        issueId: ISSUE_ID,
        kind: "ask_user_questions",
        status: "pending",
        addresseeAgentId: null,
        addresseeUserId: null,
        title: SECRET_TITLE,
        ...card,
      } as never,
    ],
  });
}

function blockerAttention(payload: Record<string, unknown> = {}, terminalId = TERMINAL_ID) {
  return event("issue.blocker_attention_changed", {
    entityType: "issue",
    entityId: terminalId,
    actorType: "system",
    actorId: "blocker-attention-events",
    payload: {
      state: "stalled",
      blockingTreeLive: false,
      terminalBlockerIssueId: terminalId,
      blockedIssueId: "00000000-0000-4000-8000-0000000000a9",
      dedupKey: `blocker:${terminalId}`,
      activityAt: AT_1,
      entered: true,
      baseline: false,
      ...payload,
    },
  });
}

function decisionCreated(originIssueId: string | null = ISSUE_ID, decisionId = DECISION_ID) {
  return event("decision.created", {
    entityType: "decision",
    entityId: decisionId,
    payload: { originIssueId, originAgentId: AGENT_ID, originResponsibleUserId: USER_ID, agentId: AGENT_ID, runId: null },
  });
}

describe("G1: interaction addressee routing", () => {
  it("never treats a missing addresseeAgentId key as human: unreadable card -> addressee_unknown, no send", async () => {
    const s = setup();
    await expect(s.notifier.handle(legacyInteraction())).resolves.toBe("addressee_unknown");
    expect(s.requests).toHaveLength(0);
    const logs = JSON.stringify(s.harness.logs);
    expect(logs).toContain("addressee_unknown");
    for (const secret of [INTERACTION_ID, ISSUE_ID, "EX-42", SECRET_TITLE]) expect(logs).not.toContain(secret);
  });

  it("resolves a missing key through issue.interactions.read: agent-addressed card -> 0", async () => {
    const s = setup();
    seedCard(s, { addresseeAgentId: AGENT_ID });
    await expect(s.notifier.handle(legacyInteraction())).resolves.toBe("not_eligible");
    expect(s.requests).toHaveLength(0);
  });

  it("resolves a missing key through issue.interactions.read: person-addressed card -> 1", async () => {
    const s = setup();
    seedCard(s, { addresseeUserId: USER_ID });
    await expect(s.notifier.handle(legacyInteraction())).resolves.toBe("sent");
    await expect(s.notifier.handle(legacyInteraction())).resolves.toBe("duplicate");
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0].body).toBe("A decision is waiting: EX-42");
  });

  it("does not notify a resolved card found through the fallback read", async () => {
    const s = setup();
    seedCard(s, { status: "answered" });
    await expect(s.notifier.handle(legacyInteraction())).resolves.toBe("not_eligible");
    expect(s.requests).toHaveLength(0);
  });

  it("treats a failing fallback read as unknown and does not notify", async () => {
    const s = setup();
    s.harness.ctx.issues.listInteractions = async () => {
      throw new Error(`boom ${SECRET_TITLE}`);
    };
    await expect(s.notifier.handle(legacyInteraction())).resolves.toBe("addressee_unknown");
    expect(s.requests).toHaveLength(0);
    expect(JSON.stringify(s.harness.logs)).not.toContain(SECRET_TITLE);
  });

  it("does not read the host when the payload states the addressee", async () => {
    const s = setup();
    let reads = 0;
    s.harness.ctx.issues.listInteractions = async () => {
      reads += 1;
      return [];
    };
    await s.notifier.handle(serviceInteraction({ addresseeAgentId: AGENT_ID }));
    await s.notifier.handle(serviceInteraction());
    expect(reads).toBe(0);
    expect(s.requests).toHaveLength(1);
  });

  const emitterShapes: Array<[string, Record<string, unknown>]> = [
    ["plugin-created", { interactionKind: "request_confirmation", source: "plugin" }],
    ["native question bridge", { interactionKind: "ask_user_questions", effectiveResolverPolicy: "human_only" }],
    ["runner tool authority", { interactionKind: "request_checkbox_confirmation" }],
    ["status-decision reviewer bind", { interactionKind: "request_confirmation", effectiveResolverPolicy: "anyone" }],
  ];
  for (const [name, shape] of emitterShapes) {
    it(`${name}: agent-addressed -> 0, person/board-addressed -> 1`, async () => {
      const s = setup();
      await expect(
        s.notifier.handle(serviceInteraction({ ...shape, addresseeAgentId: AGENT_ID, addresseeUserId: null })),
      ).resolves.toBe("ignored");
      expect(s.requests).toHaveLength(0);
      await expect(s.notifier.handle(serviceInteraction({ ...shape, addresseeUserId: USER_ID }))).resolves.toBe("sent");
      expect(s.requests).toHaveLength(1);
    });
  }

  it("connection intent addressed to the responsible user -> 1", async () => {
    const s = setup();
    const outcome = await s.notifier.handle(
      serviceInteraction({
        interactionKind: "connection_intent",
        addresseeUserId: USER_ID,
        requestedResolverPolicy: "human_only",
        effectiveResolverPolicy: "human_only",
      }),
    );
    expect(outcome).toBe("sent");
  });
});

describe("G2: approvals without a generic route", () => {
  function gatewayApproval(actionRequestId: string | null = ACTION_REQUEST_ID) {
    return event("approval.created", {
      entityType: "approval",
      entityId: APPROVAL_ID,
      payload: {
        type: "request_board_approval",
        issueIds: [ISSUE_ID],
        source: "tool_gateway",
        actionRequestId,
        agentId: AGENT_ID,
        runId: null,
        responsibleUserId: USER_ID,
      },
    });
  }
  const gatewayCard = () =>
    serviceInteraction({
      interactionKind: "request_confirmation",
      requestedResolverPolicy: "human_only",
      effectiveResolverPolicy: "human_only",
      toolActionRequestId: ACTION_REQUEST_ID,
    });

  it("tool-gateway approval + its card -> exactly 1 push (approval first)", async () => {
    const s = setup();
    await expect(s.notifier.handle(gatewayApproval())).resolves.toBe("sent");
    await expect(s.notifier.handle(gatewayCard())).resolves.toBe("duplicate");
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0].body).toBe("A decision is waiting: EX-42");
  });

  it("tool-gateway approval + its card -> exactly 1 push (card first, and concurrently)", async () => {
    const s = setup();
    await expect(s.notifier.handle(gatewayCard())).resolves.toBe("sent");
    await expect(s.notifier.handle(gatewayApproval())).resolves.toBe("duplicate");
    const t = setup();
    const outcomes = await Promise.all([t.notifier.handle(gatewayApproval()), t.notifier.handle(gatewayCard())]);
    expect(outcomes.sort()).toEqual(["duplicate", "sent"]);
    expect(s.requests).toHaveLength(1);
    expect(t.requests).toHaveLength(1);
  });

  it("a tool-action card with no formal approval still notifies once", async () => {
    const s = setup();
    await expect(s.notifier.handle(gatewayCard())).resolves.toBe("sent");
    await expect(s.notifier.handle(gatewayCard())).resolves.toBe("duplicate");
    expect(s.requests).toHaveLength(1);
  });

  it("a gateway-looking approval without an action request id falls back to the approval key", async () => {
    const s = setup();
    await s.notifier.handle(gatewayApproval(null));
    await expect(s.notifier.handle(approvalCreated([ISSUE_ID], APPROVAL_ID))).resolves.toBe("duplicate");
    expect(s.requests).toHaveLength(1);
  });

  it("budget hard-stop approval (no issue) -> 1 push to the approval page", async () => {
    const s = setup();
    const budget = event("approval.created", {
      entityType: "approval",
      entityId: APPROVAL_ID,
      actorType: "system",
      actorId: "budget_service",
      payload: { type: "budget_override_required", issueIds: [], source: "budget_hard_stop", budgetIncidentId: "x", agentId: null, runId: null },
    });
    await expect(s.notifier.handle(budget)).resolves.toBe("sent");
    await expect(s.notifier.handle(budget)).resolves.toBe("duplicate");
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0].body).toBe("A decision is waiting: approval");
    expect(s.requests[0].headers.Click).toBe(`https://paperclip.example.test/EX/approvals/${APPROVAL_ID}`);
  });
});

describe("G3: computed blocker attention", () => {
  it("stalled tree with no live path -> 1, repeat -> 0", async () => {
    const s = setup();
    await expect(s.notifier.handle(blockerAttention())).resolves.toBe("sent");
    await expect(s.notifier.handle(blockerAttention())).resolves.toBe("duplicate");
    await expect(s.makeNotifier().handle(blockerAttention())).resolves.toBe("duplicate");
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0].body).toBe("A decision is waiting: EX-42");
    expect(s.requests[0].headers.Click).toBe("https://paperclip.example.test/EX/issues/EX-42");
  });

  it("needs_attention also notifies", async () => {
    const s = setup();
    await expect(s.notifier.handle(blockerAttention({ state: "needs_attention" }))).resolves.toBe("sent");
  });

  it("live tree, covered state or a mismatched key -> 0", async () => {
    const s = setup();
    for (const e of [
      blockerAttention({ blockingTreeLive: true }),
      blockerAttention({ blockingTreeLive: undefined }),
      blockerAttention({ state: "covered" }),
      blockerAttention({ state: "none" }),
      blockerAttention({ dedupKey: "blocker:someone-else" }),
      blockerAttention({ activityAt: "not-a-date" }),
      blockerAttention({ terminalBlockerIssueId: "not-a-uuid" }, "not-a-uuid"),
    ]) {
      await expect(s.notifier.handle(e)).resolves.toBe("ignored");
    }
    expect(s.requests).toHaveLength(0);
  });

  it("one push per feed episode: a moved activityAt is a repeat; exit then re-entry notifies again", async () => {
    const s = setup();
    await expect(s.notifier.handle(blockerAttention({ activityAt: AT_1 }))).resolves.toBe("sent");
    await expect(s.notifier.handle(blockerAttention({ activityAt: AT_2 }))).resolves.toBe("duplicate");
    await expect(s.notifier.handle(blockerAttention({ entered: false, state: null, blockingTreeLive: null }))).resolves.toBe("episode_closed");
    await expect(s.notifier.handle(blockerAttention({ activityAt: AT_2 }))).resolves.toBe("sent");
    expect(s.requests).toHaveLength(2);
  });

  it("host-boot baseline: an open episode -> 0, an item never announced -> 1", async () => {
    const s = setup();
    await s.notifier.handle(blockerAttention({ activityAt: AT_1 }));
    const restarted = s.makeNotifier();
    await expect(restarted.handle(blockerAttention({ activityAt: AT_2, baseline: true }))).resolves.toBe("duplicate");
    await expect(
      restarted.handle(blockerAttention({ baseline: true }, PRIVATE_ISSUE_ID)),
    ).resolves.toBe("sent");
    expect(s.requests).toHaveLength(2);
  });

  it("an exit for an item never announced sends nothing", async () => {
    const s = setup();
    await expect(s.notifier.handle(blockerAttention({ entered: false, state: null, blockingTreeLive: null }))).resolves.toBe("episode_closed");
    expect(s.requests).toHaveLength(0);
  });

  it("does not collide with the human-owned blocker key for the same issue", async () => {
    const s = setup();
    await s.notifier.handle(blockerAttention({ activityAt: AT_1 }));
    s.harness.seed({
      issues: [
        {
          id: ISSUE_ID,
          companyId: COMPANY_ID,
          identifier: "EX-42",
          status: "blocked",
          unblockDescriptor: { owner: "board", action: "x" },
          blockedTransitionAt: AT_1,
        } as never,
      ],
    });
    const update = event("issue.updated", {
      entityType: "issue",
      entityId: ISSUE_ID,
      payload: { status: "blocked", changes: { status: { from: "todo", to: "blocked" } } },
    });
    await expect(s.notifier.handle(update)).resolves.toBe("sent");
    expect(s.requests).toHaveLength(2);
  });

  it("a self-terminal blocked issue with a human-owned unblock step is one decision -> 1 push in either order", async () => {
    for (const order of ["tree-first", "owner-first"]) {
      const s = setup();
      s.harness.seed({
        issues: [
          {
            id: ISSUE_ID,
            companyId: COMPANY_ID,
            identifier: "EX-42",
            status: "blocked",
            unblockDescriptor: { owner: "board", action: "x" },
            blockedTransitionAt: AT_1,
          } as never,
        ],
      });
      const tree = blockerAttention({ state: "needs_attention", blockedIssueId: ISSUE_ID });
      const owner = event("issue.updated", {
        entityType: "issue",
        entityId: ISSUE_ID,
        payload: { status: "blocked", changes: { status: { from: "todo", to: "blocked" } } },
      });
      const [first, second] = order === "tree-first" ? [tree, owner] : [owner, tree];
      await expect(s.notifier.handle(first)).resolves.toBe("sent");
      await expect(s.notifier.handle(second)).resolves.toBe("duplicate");
      expect(s.requests).toHaveLength(1);
    }
  });

  it("a terminal human-owned blocker grouped under a newer downstream issue is still one decision -> 1 push in either order", async () => {
    // The host picks the group's most recently updated blocked issue as blockedIssueId (D), but the
    // feed item is still `blocker:<T>` for terminal T, whose own board-owned step is the same decision.
    const DOWNSTREAM_ID = "00000000-0000-4000-8000-0000000000b1";
    for (const order of ["tree-first", "owner-first"]) {
      const s = setup();
      s.harness.seed({
        issues: [
          {
            id: ISSUE_ID,
            companyId: COMPANY_ID,
            identifier: "EX-42",
            status: "blocked",
            unblockDescriptor: { owner: "board", action: "x" },
            blockedTransitionAt: AT_1,
          } as never,
          { id: DOWNSTREAM_ID, companyId: COMPANY_ID, identifier: "EX-43", status: "blocked" } as never,
        ],
      });
      const tree = blockerAttention({ state: "needs_attention", blockedIssueId: DOWNSTREAM_ID });
      const owner = event("issue.updated", {
        entityType: "issue",
        entityId: ISSUE_ID,
        payload: { status: "blocked", changes: { status: { from: "todo", to: "blocked" } } },
      });
      const [first, second] = order === "tree-first" ? [tree, owner] : [owner, tree];
      await expect(s.notifier.handle(first)).resolves.toBe("sent");
      await expect(s.notifier.handle(second)).resolves.toBe("duplicate");
      expect(s.requests.map((r) => r.body)).toEqual(["A decision is waiting: EX-42"]);
    }
  });

  it("an exit while the entry push is in flight is kept: enter -> exit -> re-enter = 2 pushes, durable state closed then open", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const s = setup({
      fetch: async (n) => {
        if (n === 1) await held;
        return new Response("{}", { status: 200 });
      },
      notifier: { timeoutMs: 5_000 },
    });
    const stateKey = { scopeKind: "company" as const, scopeId: COMPANY_ID, namespace: "ntfy-notifier", stateKey: `sent:episode:blocker:${TERMINAL_ID}` };
    const entering = s.notifier.handle(blockerAttention());
    await new Promise((r) => setTimeout(r, 10));
    expect(s.requests).toHaveLength(1); // the first push is in flight
    const exiting = s.notifier.handle(blockerAttention({ entered: false, state: null, blockingTreeLive: null }));
    const repeat = s.notifier.handle(blockerAttention({ activityAt: AT_2 })); // re-entry queued behind the exit
    release();
    await expect(entering).resolves.toBe("sent");
    await expect(exiting).resolves.toBe("episode_closed");
    await expect(repeat).resolves.toBe("sent");
    expect(s.requests).toHaveLength(2);
    expect(await s.harness.ctx.state.get(stateKey)).toMatchObject({ open: true });
    // Durable order check without overlap: exit -> closed, re-entry -> sent.
    await s.notifier.handle(blockerAttention({ entered: false, state: null, blockingTreeLive: null }));
    expect(await s.harness.ctx.state.get(stateKey)).toMatchObject({ open: false });
    await expect(s.makeNotifier().handle(blockerAttention())).resolves.toBe("sent");
    expect(s.requests).toHaveLength(3);
  });

  it("an exit delivered while the entry's issue lookup is held is kept: enter(held) -> exit -> release -> re-enter = 2 pushes", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let lookupStarted!: () => void;
    const started = new Promise<void>((resolve) => (lookupStarted = resolve));
    const s = setup();
    const realGet = s.harness.ctx.issues.get.bind(s.harness.ctx.issues);
    let gets = 0;
    s.harness.ctx.issues.get = async (...args: Parameters<typeof realGet>) => {
      gets += 1;
      if (gets === 1) {
        lookupStarted();
        await held;
      }
      return realGet(...args);
    };
    const stateKey = { scopeKind: "company" as const, scopeId: COMPANY_ID, namespace: "ntfy-notifier", stateKey: `sent:episode:blocker:${TERMINAL_ID}` };
    const entering = s.notifier.handle(blockerAttention());
    await started; // the entry is waiting on its terminal issue lookup, before any dedupe step
    const exiting = s.notifier.handle(blockerAttention({ entered: false, state: null, blockingTreeLive: null }));
    let exitDone = false;
    void exiting.then(() => (exitDone = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(exitDone).toBe(false); // the exit waits for the earlier entry instead of overtaking it
    expect(s.requests).toHaveLength(0);
    release();
    await expect(entering).resolves.toBe("sent");
    await expect(exiting).resolves.toBe("episode_closed");
    expect(await s.harness.ctx.state.get(stateKey)).toMatchObject({ open: false }); // the close is retained
    await expect(s.notifier.handle(blockerAttention({ activityAt: AT_2 }))).resolves.toBe("sent");
    expect(s.requests).toHaveLength(2); // two episodes, two pushes
    expect(await s.harness.ctx.state.get(stateKey)).toMatchObject({ open: true });
  });

  it("a held lookup for one feed key does not delay an unrelated feed key or another event kind", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const s = setup();
    const realGet = s.harness.ctx.issues.get.bind(s.harness.ctx.issues);
    s.harness.ctx.issues.get = async (...args: Parameters<typeof realGet>) => {
      if (args[0] === TERMINAL_ID) await held;
      return realGet(...args);
    };
    const entering = s.notifier.handle(blockerAttention());
    await expect(s.notifier.handle(blockerAttention({}, PRIVATE_ISSUE_ID))).resolves.toBe("sent");
    await expect(s.notifier.handle(decisionCreated(null))).resolves.toBe("sent");
    expect(s.requests).toHaveLength(2);
    release();
    await expect(entering).resolves.toBe("sent");
    expect(s.requests).toHaveLength(3);
  });

  it("an exit that overlaps an entry whose push fails leaves no open episode: re-entry sends", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const s = setup({
      fetch: async (n) => {
        if (n <= 3) {
          await held;
          return new Response("no", { status: 500 });
        }
        return new Response("{}", { status: 200 });
      },
      notifier: { timeoutMs: 5_000 },
    });
    const entering = s.notifier.handle(blockerAttention());
    await new Promise((r) => setTimeout(r, 10));
    const exiting = s.notifier.handle(blockerAttention({ entered: false, state: null, blockingTreeLive: null }));
    release();
    await expect(entering).resolves.toBe("send_failed");
    await expect(exiting).resolves.toBe("episode_closed");
    await expect(s.notifier.handle(blockerAttention())).resolves.toBe("sent");
  });

  it("a self-terminal blocked issue without a human-owned step keeps the tree key -> 1", async () => {
    const s = setup();
    s.harness.seed({
      issues: [{ id: ISSUE_ID, companyId: COMPANY_ID, identifier: "EX-42", status: "blocked", unblockDescriptor: null } as never],
    });
    await expect(s.notifier.handle(blockerAttention({ state: "needs_attention", blockedIssueId: ISSUE_ID }))).resolves.toBe("sent");
    await expect(s.notifier.handle(blockerAttention({ state: "needs_attention", blockedIssueId: ISSUE_ID }))).resolves.toBe("duplicate");
  });

  it("an unreadable terminal blocker still notifies with the UUID link and no identifier", async () => {
    const s = setup();
    await expect(s.notifier.handle(blockerAttention({}, PRIVATE_ISSUE_ID))).resolves.toBe("sent");
    expect(s.requests[0].body).toBe("A decision is waiting");
    expect(s.requests[0].headers.Click).toBe(`https://paperclip.example.test/EX/issues/${PRIVATE_ISSUE_ID}`);
  });

  it("respects the blockerAttention trigger flag", async () => {
    const s = setup({ config: { ...BASE_CONFIG, triggers: { blockerAttention: false } } });
    await expect(s.notifier.handle(blockerAttention())).resolves.toBe("ignored");
  });
});

describe("board decisions (decision.created)", () => {
  it("open decision on an issue -> 1, linked to the decision queue", async () => {
    const s = setup();
    await expect(s.notifier.handle(decisionCreated())).resolves.toBe("sent");
    await expect(s.notifier.handle(decisionCreated())).resolves.toBe("duplicate");
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0].body).toBe("A decision is waiting: EX-42");
    expect(s.requests[0].headers.Click).toBe(`https://paperclip.example.test/EX/decisions?decisionId=${DECISION_ID}`);
  });

  it("decision without an origin issue -> fixed word 'decision'", async () => {
    const s = setup();
    await s.notifier.handle(decisionCreated(null));
    expect(s.requests[0].body).toBe("A decision is waiting: decision");
  });

  it("respects the decisions trigger flag", async () => {
    const s = setup({ config: { ...BASE_CONFIG, triggers: { decisions: false } } });
    await expect(s.notifier.handle(decisionCreated())).resolves.toBe("ignored");
  });

  it("keeps logs and the request free of private data for every new kind", async () => {
    const s = setup();
    await s.notifier.handle(decisionCreated());
    await s.notifier.handle(blockerAttention());
    await s.notifier.handle(serviceInteraction({ toolActionRequestId: ACTION_REQUEST_ID }));
    const logs = JSON.stringify(s.harness.logs);
    for (const secret of [TOKEN, "EX-42", SECRET_TITLE, ISSUE_ID, DECISION_ID, ACTION_REQUEST_ID, INTERACTION_ID]) {
      expect(logs).not.toContain(secret);
    }
    for (const request of s.requests) {
      expect(Object.keys(request.headers).sort()).toEqual(["Authorization", "Click", "Content-Type", "Tags", "Title"]);
      expect(request.headers.Title).toBe("Paperclip decision EX-42");
      expect(request.headers.Tags).toBe("paperclip");
      expect(request.body).not.toContain(SECRET_TITLE);
    }
  });
});

describe("fixed `Paperclip decision <ID>` title and `paperclip` tag on every publish", () => {
  const ISSUE_LINK = "https://paperclip.example.test/EX/issues/EX-42";

  /** The whole request, exactly: no other header may appear. */
  function expectPublish(
    request: { url: string; method: string; headers: Record<string, string>; body: string },
    expected: { title: string; body: string; click: string },
  ) {
    expect(request.url).toBe("https://ntfy.example.test/decisions");
    expect(request.method).toBe("POST");
    expect(request.body).toBe(expected.body);
    expect(request.headers).toEqual({
      "Content-Type": "text/plain; charset=utf-8",
      Click: expected.click,
      Title: expected.title,
      Tags: "paperclip",
      Authorization: `Bearer ${TOKEN}`,
    });
  }

  it("fixes the constants", () => {
    expect(TITLE_PREFIX).toBe("Paperclip decision");
    expect(MESSAGE_TAGS).toBe("paperclip");
  });

  it("approval with an issue", async () => {
    const s = setup();
    await expect(s.notifier.handle(approvalCreated())).resolves.toBe("sent");
    expect(s.requests).toHaveLength(1);
    expectPublish(s.requests[0], { title: "Paperclip decision EX-42", body: "A decision is waiting: EX-42", click: ISSUE_LINK });
  });

  it("approval with no linked issue -> exactly `Paperclip decision`, the fallback label stays in the body only", async () => {
    const s = setup();
    await expect(s.notifier.handle(approvalCreated([]))).resolves.toBe("sent");
    expectPublish(s.requests[0], {
      title: "Paperclip decision",
      body: "A decision is waiting: approval",
      click: `https://paperclip.example.test/EX/approvals/${APPROVAL_ID}`,
    });
  });

  it("person-addressed interaction (ask_user_questions and request_confirmation)", async () => {
    const s = setup();
    await expect(s.notifier.handle(serviceInteraction({ addresseeUserId: USER_ID }))).resolves.toBe("sent");
    expectPublish(s.requests[0], { title: "Paperclip decision EX-42", body: "A decision is waiting: EX-42", click: ISSUE_LINK });
    const t = setup();
    seedCard(t, { addresseeUserId: USER_ID });
    await expect(t.notifier.handle(legacyInteraction())).resolves.toBe("sent");
    expectPublish(t.requests[0], { title: "Paperclip decision EX-42", body: "A decision is waiting: EX-42", click: ISSUE_LINK });
  });

  it("interaction on an issue the plugin cannot read -> exactly `Paperclip decision`, UUID link", async () => {
    const s = setup();
    await expect(s.notifier.handle(serviceInteraction({}, PRIVATE_ISSUE_ID))).resolves.toBe("sent");
    expectPublish(s.requests[0], {
      title: "Paperclip decision",
      body: "A decision is waiting",
      click: `https://paperclip.example.test/EX/issues/${PRIVATE_ISSUE_ID}`,
    });
  });

  it("board decision with an issue; the decision-queue link keeps its query", async () => {
    const s = setup();
    await expect(s.notifier.handle(decisionCreated())).resolves.toBe("sent");
    expectPublish(s.requests[0], {
      title: "Paperclip decision EX-42",
      body: "A decision is waiting: EX-42",
      click: `https://paperclip.example.test/EX/decisions?decisionId=${DECISION_ID}`,
    });
  });

  it("board decision with no issue -> exactly `Paperclip decision`", async () => {
    const s = setup();
    await expect(s.notifier.handle(decisionCreated(null))).resolves.toBe("sent");
    expectPublish(s.requests[0], {
      title: "Paperclip decision",
      body: "A decision is waiting: decision",
      click: `https://paperclip.example.test/EX/decisions?decisionId=${DECISION_ID}`,
    });
  });

  it("blocker attention: entry, exit and re-entry each publish the same fixed request", async () => {
    const s = setup();
    await expect(s.notifier.handle(blockerAttention({ activityAt: AT_1 }))).resolves.toBe("sent");
    await expect(s.notifier.handle(blockerAttention({ entered: false, state: null, blockingTreeLive: null }))).resolves.toBe("episode_closed");
    await expect(s.notifier.handle(blockerAttention({ activityAt: AT_2, state: "needs_attention" }))).resolves.toBe("sent");
    expect(s.requests).toHaveLength(2);
    for (const request of s.requests) {
      expectPublish(request, { title: "Paperclip decision EX-42", body: "A decision is waiting: EX-42", click: ISSUE_LINK });
    }
  });

  it("blocker attention on an unreadable terminal blocker -> exactly `Paperclip decision`", async () => {
    const s = setup();
    await expect(s.notifier.handle(blockerAttention({}, PRIVATE_ISSUE_ID))).resolves.toBe("sent");
    expectPublish(s.requests[0], {
      title: "Paperclip decision",
      body: "A decision is waiting",
      click: `https://paperclip.example.test/EX/issues/${PRIVATE_ISSUE_ID}`,
    });
  });

  it("human-owned blocked issue (issue.updated)", async () => {
    const s = setup();
    s.harness.seed({
      issues: [
        {
          id: ISSUE_ID,
          companyId: COMPANY_ID,
          identifier: "EX-42",
          status: "blocked",
          unblockDescriptor: { owner: "board", action: "x" },
          blockedTransitionAt: AT_1,
        } as never,
      ],
    });
    const update = event("issue.updated", {
      entityType: "issue",
      entityId: ISSUE_ID,
      payload: { status: "blocked", changes: { status: { from: "todo", to: "blocked" } } },
    });
    await expect(s.notifier.handle(update)).resolves.toBe("sent");
    expectPublish(s.requests[0], { title: "Paperclip decision EX-42", body: "A decision is waiting: EX-42", click: ISSUE_LINK });
  });

  it("sentinel: issue title, question/approval text and labels never reach a header, the URL or the body", async () => {
    const SENTINEL = "zq-SENTINEL-7f3c9e1b-private";
    const seeded = () => {
      const s = setup();
      s.harness.seed({
        issues: [
          {
            id: ISSUE_ID,
            companyId: COMPANY_ID,
            identifier: "EX-42",
            title: `${SENTINEL} issue title`,
            description: `${SENTINEL} description`,
            labels: [{ id: "lbl-1", name: `${SENTINEL} label` }],
            labelIds: [`${SENTINEL}-label-id`],
            status: "blocked",
            unblockDescriptor: { owner: "board", action: `${SENTINEL} unblock step` },
            blockedTransitionAt: AT_1,
          } as never,
        ],
      });
      seedCard(s, { addresseeUserId: USER_ID, title: `${SENTINEL} card`, payload: { questions: [{ prompt: `${SENTINEL} question` }] } });
      return s;
    };
    const labels = [`${SENTINEL} label`];
    const events = [
      event("approval.created", {
        entityType: "approval",
        entityId: APPROVAL_ID,
        payload: {
          type: "request_board_approval",
          issueIds: [ISSUE_ID],
          title: `${SENTINEL} approval title`,
          summary: `${SENTINEL} approval text`,
          payload: { title: `${SENTINEL} approval`, labels },
          agentId: AGENT_ID,
          runId: null,
        },
      }),
      serviceInteraction({
        interactionId: "00000000-0000-4000-8000-0000000000c2",
        addresseeUserId: USER_ID,
        title: `${SENTINEL} question title`,
        summary: `${SENTINEL} question text`,
        payload: { questions: [{ prompt: `${SENTINEL} question` }] },
        labels,
      }),
      legacyInteraction({ title: `${SENTINEL} legacy question`, identifier: `${SENTINEL}-1`, labels }),
      event("decision.created", {
        entityType: "decision",
        entityId: DECISION_ID,
        payload: { originIssueId: ISSUE_ID, title: `${SENTINEL} decision`, question: `${SENTINEL} decision text`, labels, agentId: AGENT_ID, runId: null },
      }),
      blockerAttention({ title: `${SENTINEL} tree`, labels }),
      event("issue.updated", {
        entityType: "issue",
        entityId: ISSUE_ID,
        payload: { status: "blocked", title: `${SENTINEL} renamed`, labels, changes: { status: { from: "todo", to: "blocked" } } },
      }),
    ];
    // One fresh host per event: the self-terminal blocker tree and the
    // issue.updated blocker are one decision and would otherwise dedupe.
    const requests: Array<ReturnType<typeof setup>["requests"][number]> = [];
    const logs: unknown[] = [];
    for (const e of events) {
      const s = seeded();
      await expect(s.notifier.handle(e)).resolves.toBe("sent");
      expect(s.requests).toHaveLength(1);
      requests.push(...s.requests);
      logs.push(s.harness.logs);
    }
    expect(requests).toHaveLength(events.length);
    for (const request of requests) {
      expect(request.url).not.toContain(SENTINEL);
      expect(request.body).not.toContain(SENTINEL);
      for (const [name, value] of Object.entries(request.headers)) {
        expect(name).not.toContain(SENTINEL);
        expect(value).not.toContain(SENTINEL);
      }
      expect(request.headers.Title).toBe("Paperclip decision EX-42");
      expect(request.headers.Tags).toBe("paperclip");
    }
    expect(JSON.stringify(logs)).not.toContain(SENTINEL);
  });

  it("an unsafe or missing identifier gives exactly `Paperclip decision`", () => {
    const unsafe: Array<string | null> = [
      null,
      "",
      "EX",
      "EX-",
      "-42",
      "EX-42 ",
      " EX-42",
      "EX-42 Nightingale",
      "EX-42\r\nX-Injected: 1",
      "EX-42\nTitle: other",
      "EX_42",
      "EX-4a",
      `${"A".repeat(17)}-1`,
      `EX-${"9".repeat(13)}`,
      "ÉX-42",
      "EX-42;Tags=x",
    ];
    for (const issueIdentifier of unsafe) {
      expect(buildMessageTitle({ issueIdentifier })).toBe("Paperclip decision");
    }
    expect(buildMessageTitle({ issueIdentifier: undefined } as never)).toBe("Paperclip decision");
    // The body's fallback label never reaches the title.
    expect(buildMessageTitle({ issueIdentifier: null, fallbackLabel: "approval" } as never)).toBe("Paperclip decision");
    expect(buildMessageTitle({ issueIdentifier: "EX-42" })).toBe("Paperclip decision EX-42");
    expect(buildMessageTitle({ issueIdentifier: "abcdefghABCDEFGH-123456789012" })).toBe("Paperclip decision abcdefghABCDEFGH-123456789012");
  });

  it("an unsafe identifier read from the host gives exactly `Paperclip decision` on the wire", async () => {
    const s = setup();
    s.harness.seed({
      issues: [{ id: ISSUE_ID, companyId: COMPANY_ID, identifier: "EX-42\r\nX-Injected: 1", status: "in_progress" } as never],
    });
    await expect(s.notifier.handle(approvalCreated())).resolves.toBe("sent");
    expectPublish(s.requests[0], {
      title: "Paperclip decision",
      body: "A decision is waiting",
      click: `https://paperclip.example.test/EX/issues/${ISSUE_ID}`,
    });
  });
});
