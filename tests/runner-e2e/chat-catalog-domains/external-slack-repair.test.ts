import { expect, it } from "vitest";
import {
  gradeSlackRepair,
  slackRepairGuidance,
} from "./external-slack-repair.js";
import { slackAuthorizationReceipt } from "./external-slack-authorization.js";
function valid() {
  const run = (id: string, issueId: string) => ({
      id,
      companyId: "company",
      agentId: "ceo",
      runtimeMode: "native",
      status: "succeeded",
      contextSnapshot: { issueId },
    }),
    query =
      "Please confirm you can reply in this same repaired Slack conversation. Do not start a separate task.",
    source = {
      query,
      endpointId: "endpoint",
      conversationId: "conversation",
      issueId: "slack-source",
      humanCommentId: "human",
      linkedPaperclipUserId: "person",
      providerCalls: 1,
      provider: {
        workspaceId: "T123",
        channelId: "C123",
        senderUserId: "U123",
        threadId: "1000000000.000001",
        canonicalMessageId: "1000000000.000004",
      },
    };
  return {
    scenarioId: "chat-channels.repair-endpoint",
    companyId: "company",
    leadId: "ceo",
    origin: "http://127.0.0.1:3100",
    reply: "Slack is reconnected and replies work in that thread.",
    state: {
      initialRunId: "initial",
      canonicalIssueId: "canonical",
      noSetupNative: true,
      noSetupConversation: true,
      failedSignedProviderDelivery: true,
      agentReconnectStatus: 403,
      directedEndpointId: "endpoint",
      endpointId: "endpoint",
      currentHumanId: "person",
      workspaceId: "T123",
      senderUserId: "U123",
      botUserId: "UBOT",
      threadId: "1000000000.000001",
      verificationClearedAfterReconnect: true,
      repairVerificationStarted: Date.parse("2031-02-14T10:00:00Z"),
    },
    phaseReplies: [
      {
        runId: "initial",
        body: "Slack authorization expired. You must reconnect this account through its supported human setup.",
      },
      {
        runId: "final",
        body: "Slack is reconnected and replies work in that thread.",
      },
    ],
    runs: [
      run("initial", "canonical"),
      run("slack-run", "slack-source"),
      run("final", "canonical"),
    ],
    humanQueries: [
      "Slack replies stopped working; reconnect the account.",
      "Slack replies stopped working; reconnect the account.",
    ],
    tasks: [],
    projects: [],
    goals: [],
    comments: [],
    documents: [],
    revisions: [],
    activity: [],
    links: [],
    connections: [],
    profiles: [],
    secrets: [],
    endpoints: [{ id: "endpoint" }],
    interactions: [],
    repair: {
      endpoint: {
        id: "endpoint",
        companyId: "company",
        assignedAgentId: "ceo",
        providerAccountId: "T123",
        status: "active",
        setup: { step: "complete", webhookVerifiedAt: "2031-02-14T10:00:01Z" },
        allowUnlinkedPeople: false,
      },
      oldValid: { ok: true, identityMatches: true, code: "ok" },
      expired: { ok: false, identityMatches: false, code: "token_expired" },
      fresh: { ok: true, identityMatches: true, code: "ok" },
      failedActivity: [
        {
          id: "failed",
          kind: "delivery",
          status: "failed",
          summary: "message failed",
          detail: "Slack API token_expired",
        },
      ],
      credentialUi: {
        processIsolation: true,
        testRunnerAttached: false,
        tracingEnabled: false,
        videoEnabled: false,
        apiStepRecorder: false,
        endpointId: "endpoint",
        slackCredentialUiVisible: true,
        humanSubmittedSecurely: true,
        storageClean: true,
        credentialUiRejected: false,
      },
      retryUi: {
        processIsolation: true,
        testRunnerAttached: false,
        tracingEnabled: false,
        videoEnabled: false,
        callbackRetryRequested: true,
        verifiedHumanId: "U123",
        verifiedWorkspaceId: "T123",
      },
      wizardUi: {
        processIsolation: true,
        testRunnerAttached: false,
        tracingEnabled: false,
        videoEnabled: false,
        apiStepRecorder: false,
        endpointId: "endpoint",
        activationUiVisible: true,
        endpointActive: true,
        identityWasAlreadyLinked: true,
        paperclipUserId: "person",
      },
      principalUserId: "person",
      connectAt: "2031-02-14T10:00:02Z",
      source,
      sourceBound: true,
      runId: "slack-run",
      reply: {
        id: "reply",
        createdByRunId: "slack-run",
        authorAgentId: "ceo",
        body: "I can reply in this Slack thread.",
      },
      messages: [
        { ts: "1000000000.000004", user: "U123", text: query },
        {
          ts: "1000000000.000005",
          user: "UBOT",
          text: "I can reply in this Slack thread.",
        },
      ],
      failedProviderCapture: true,
    },
  };
}
it("accepts real old-valid→expired proof, actual same-person repair UI and subsequent same-thread native reply", () =>
  expect(gradeSlackRepair(valid()).passed).toBe(true));
it("rejects wrong starting conditions, refusal-only repair, healthy-auth-only, stale verification and wrong thread/run", () => {
  for (const mutate of [
    (o: ReturnType<typeof valid>) => {
      o.repair.oldValid.ok = false;
    },
    (o: ReturnType<typeof valid>) => {
      o.repair.oldValid.identityMatches = false;
    },
    (o: ReturnType<typeof valid>) => {
      o.repair.expired.code = "invalid_auth";
    },
    (o: ReturnType<typeof valid>) => {
      o.repair.fresh.identityMatches = false;
    },
    (o: ReturnType<typeof valid>) => {
      o.state.noSetupNative = false;
    },
    (o: ReturnType<typeof valid>) => {
      o.state.failedSignedProviderDelivery = false;
    },
    (o: ReturnType<typeof valid>) => {
      o.repair.failedActivity = [];
    },
    (o: ReturnType<typeof valid>) => {
      o.phaseReplies[0]!.body =
        "I've already fixed Slack. You can reconnect later.";
    },
    (o: ReturnType<typeof valid>) => {
      o.state.directedEndpointId = "another";
    },
    (o: ReturnType<typeof valid>) => {
      o.state.agentReconnectStatus = 200;
    },
    (o: ReturnType<typeof valid>) => {
      o.repair.credentialUi.credentialUiRejected = true;
      o.repair.credentialUi.humanSubmittedSecurely = false;
    },
    (o: ReturnType<typeof valid>) => {
      o.repair.retryUi.callbackRetryRequested = false;
    },
    (o: ReturnType<typeof valid>) => {
      o.state.verificationClearedAfterReconnect = false;
    },
    (o: ReturnType<typeof valid>) => {
      o.repair.endpoint.setup.webhookVerifiedAt = "2031-02-14T09:59:00Z";
    },
    (o: ReturnType<typeof valid>) => {
      o.repair.wizardUi.activationUiVisible = false;
    },
    (o: ReturnType<typeof valid>) => {
      o.repair.wizardUi.identityWasAlreadyLinked = false;
    },
    (o: ReturnType<typeof valid>) => {
      o.repair.principalUserId = "another";
    },
    (o: ReturnType<typeof valid>) => {
      o.repair.sourceBound = false;
    },
    (o: ReturnType<typeof valid>) => {
      o.repair.source.provider.threadId = "other";
    },
    (o: ReturnType<typeof valid>) => {
      o.repair.reply.createdByRunId = "old";
    },
    (o: ReturnType<typeof valid>) => {
      o.repair.messages = o.repair.messages.slice(0, 1);
    },
    (o: ReturnType<typeof valid>) => {
      o.runs[1]!.contextSnapshot.issueId = "other";
    },
    (o: ReturnType<typeof valid>) => {
      o.runs[2]!.contextSnapshot.issueId = "other";
    },
    (o: ReturnType<typeof valid>) => {
      o.phaseReplies[1]!.body = "Slack is not reconnected or ready.";
    },
  ]) {
    const o = valid();
    mutate(o);
    expect(gradeSlackRepair(o).passed).toBe(false);
  }
  expect(gradeSlackRepair(undefined).passed).toBe(false);
  for (const key of [
    "oldValid",
    "expired",
    "fresh",
    "credentialUi",
    "retryUi",
    "wizardUi",
    "source",
    "reply",
    "messages",
  ]) {
    const o = valid();
    delete (o.repair as Record<string, unknown>)[key];
    expect(gradeSlackRepair(o).passed).toBe(false);
  }
});
it("retains truthful human repair instructions but rejects ordinary false completion claims", () => {
  expect(
    slackRepairGuidance(
      "You need to reconnect Slack in settings. I have not repaired it yet.",
    ),
  ).toBe(true);
  for (const text of [
    "I've already reconnected Slack; you can check settings.",
    "Slack replies are now working. You can reconnect it later.",
    "I have already restored Slack; use settings.",
  ]) {
    expect(slackRepairGuidance(text)).toBe(false);
  }
});
it("projects only closed authorization status and exact designated identity, never unknown account metadata", () => {
  const binding = {
    disposable: true as const,
    resourceIds: ["T123", "UBOT"],
    credentialEnv: ["PAPERCLIP_CHAT_EVAL_SLACK_BOT"],
    prerequisites: { workspaceId: "T123", botUserId: "UBOT" },
  };
  expect(
    slackAuthorizationReceipt(
      { ok: true, team_id: "T123", user_id: "UBOT" },
      binding,
    ),
  ).toEqual({ ok: true, identityMatches: true, code: "ok" });
  expect(
    slackAuthorizationReceipt({ ok: false, error: "token_expired" }, binding)
      .code,
  ).toBe("token_expired");
  expect(
    slackAuthorizationReceipt(
      { ok: true, team_id: "PRIVATEOTHER", user_id: "PRIVATEOTHER" },
      binding,
    ),
  ).toEqual({ ok: true, identityMatches: false, code: "ok" });
  expect(
    slackAuthorizationReceipt(
      { ok: false, error: "private-provider-detail" },
      binding,
    ),
  ).toEqual({ ok: false, identityMatches: false, code: "other" });
});
