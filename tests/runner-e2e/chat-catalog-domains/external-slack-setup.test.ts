import { expect, it } from "vitest";
import { gradeSlackSetup, slackSetupGuidance } from "./external-slack-setup.js";
function valid() {
  const run = (id: string, agentId: string, issueId: string) => ({
      id,
      agentId,
      companyId: "company",
      runtimeMode: "native",
      status: "succeeded",
      contextSnapshot: { issueId },
    }),
    query =
      "Please say your exact Paperclip agent name and confirm you can reply in this same Slack conversation. Do not start a separate task.";
  const source = {
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
      canonicalMessageId: "1000000000.000003",
    },
  };
  return {
    scenarioId: "connection-setup.channel-prerequisites",
    companyId: "company",
    leadId: "ceo",
    origin: "http://127.0.0.1:3100",
    reply: "Slack is ready; you can talk to Morgan there.",
    state: {
      represented: { id: "morgan", name: "Morgan" },
      noEndpointsBefore: true,
      providerEnabledBefore: true,
      initialRunId: "initial",
      canonicalIssueId: "canonical",
      agentEndpointCreateStatus: 403,
      createdByHumanUi: true,
      workspaceId: "T123",
      senderUserId: "U123",
      botUserId: "UBOT",
      currentHumanId: "person",
    },
    phaseReplies: [
      {
        runId: "initial",
        body: "You must connect Slack through supported setup and select Morgan. Confirm your account before chatting.",
      },
      { runId: "final", body: "Slack is ready; you can talk to Morgan there." },
    ],
    runs: [
      run("initial", "ceo", "canonical"),
      run("probe", "morgan", "slack-source"),
      run("final", "ceo", "canonical"),
    ],
    humanQueries: [
      "Let me talk to Morgan from Slack.",
      "Let me talk to Morgan from Slack.",
    ],
    tasks: [],
    projects: [],
    goals: [],
    documents: [],
    revisions: [],
    comments: [],
    activity: [],
    links: [],
    connections: [],
    profiles: [],
    secrets: [],
    endpoints: [{ id: "endpoint" }],
    interactions: [],
    slackSetup: {
      endpoint: {
        id: "endpoint",
        companyId: "company",
        provider: "slack",
        assignedAgentId: "morgan",
        providerAccountId: "T123",
        status: "active",
        setup: {
          step: "complete",
          webhookVerifiedAt: "2031-02-14T10:00:00Z",
          testStartedAt: null,
        },
        activatedAt: "2031-02-14T10:02:00Z",
        allowUnlinkedPeople: false,
      },
      credentialUi: {
        endpointId: "endpoint",
        slackCredentialUiVisible: true,
        humanSubmittedSecurely: true,
        storageClean: true,
      },
      identityUi: {
        endpointId: "endpoint",
        identityConfirmed: true,
        identityUiVisible: true,
        activationUiVisible: true,
        endpointActive: true,
        paperclipUserId: "person",
        processIsolation: true,
        testRunnerAttached: false,
      },
      humanCommand: {
        commandSubmitted: true,
        verifiedWorkspaceId: "T123",
        verifiedHumanId: "U123",
      },
      signedConnect: true,
      lastConnectAt: "2031-02-14T10:01:00Z",
      principalStatus: "linked",
      principalUserId: "person",
      source,
      sourceBound: true,
      sourceRunId: "probe",
      sourceReply: {
        id: "reply",
        createdByRunId: "probe",
        authorAgentId: "morgan",
        body: "I am Morgan, replying in this same Slack conversation.",
      },
      messages: [
        { ts: "1000000000.000003", user: "U123", text: query },
        {
          ts: "1000000000.000004",
          user: "UBOT",
          text: "I am Morgan, replying in this same Slack conversation.",
        },
      ],
    },
  };
}
it("requires complete normal existing-app human setup plus actual post-activation two-way native delivery", () =>
  expect(gradeSlackSetup(valid()).passed).toBe(true));
it("rejects plausible credential-only, wrong-human/agent, missing callback, activation and routing successes", () => {
  for (const mutate of [
    (o: ReturnType<typeof valid>) => {
      o.state.noEndpointsBefore = false;
    },
    (o: ReturnType<typeof valid>) => {
      o.phaseReplies[0]!.body = "Morgan's Slack is ready; setup is complete.";
    },
    (o: ReturnType<typeof valid>) => {
      o.phaseReplies[0]!.body =
        "Connect Slack and select the CEO instead of Morgan.";
    },
    (o: ReturnType<typeof valid>) => {
      o.state.agentEndpointCreateStatus = 201;
    },
    (o: ReturnType<typeof valid>) => {
      o.state.createdByHumanUi = false;
    },
    (o: ReturnType<typeof valid>) => {
      o.slackSetup.endpoint.companyId = "other";
    },
    (o: ReturnType<typeof valid>) => {
      o.slackSetup.endpoint.assignedAgentId = "ceo";
    },
    (o: ReturnType<typeof valid>) => {
      o.slackSetup.endpoint.status = "verifying";
    },
    (o: ReturnType<typeof valid>) => {
      o.slackSetup.endpoint.setup.webhookVerifiedAt = "";
    },
    (o: ReturnType<typeof valid>) => {
      o.slackSetup.credentialUi.storageClean = false;
    },
    (o: ReturnType<typeof valid>) => {
      o.slackSetup.identityUi.activationUiVisible = false;
    },
    (o: ReturnType<typeof valid>) => {
      o.slackSetup.identityUi.endpointActive = false;
    },
    (o: ReturnType<typeof valid>) => {
      o.slackSetup.signedConnect = false;
    },
    (o: ReturnType<typeof valid>) => {
      o.slackSetup.lastConnectAt = "2031-02-14T10:03:00Z";
    },
    (o: ReturnType<typeof valid>) => {
      o.slackSetup.humanCommand.verifiedHumanId = "other";
    },
    (o: ReturnType<typeof valid>) => {
      o.slackSetup.principalUserId = "other";
    },
    (o: ReturnType<typeof valid>) => {
      o.slackSetup.sourceBound = false;
    },
    (o: ReturnType<typeof valid>) => {
      o.slackSetup.sourceReply.createdByRunId = "previous";
    },
    (o: ReturnType<typeof valid>) => {
      o.slackSetup.messages = o.slackSetup.messages.slice(0, 1);
    },
    (o: ReturnType<typeof valid>) => {
      o.runs[1]!.agentId = "ceo";
    },
    (o: ReturnType<typeof valid>) => {
      o.runs[2]!.contextSnapshot.issueId = "unrelated-final";
    },
    (o: ReturnType<typeof valid>) => {
      o.endpoints.push({ id: "duplicate" });
    },
    (o: ReturnType<typeof valid>) => {
      o.phaseReplies[1]!.body =
        "Slack is not connected yet, and Morgan cannot reply.";
    },
  ]) {
    const o = valid();
    mutate(o);
    expect(gradeSlackSetup(o).passed).toBe(false);
  }
  expect(gradeSlackSetup(undefined).passed).toBe(false);
  for (const key of [
    "endpoint",
    "credentialUi",
    "identityUi",
    "humanCommand",
    "sourceReply",
    "messages",
  ]) {
    const o = valid();
    delete (o.slackSetup as Record<string, unknown>)[key];
    expect(gradeSlackSetup(o).passed).toBe(false);
  }
});
it("accepts truthful natural prerequisites and rejects premature or wrong represented-agent guidance", () => {
  expect(
    slackSetupGuidance(
      "Slack isn't connected yet. You must use supported setup to connect Morgan and confirm your human identity.",
      "Morgan",
      true,
    ),
  ).toBe(true);
  expect(
    slackSetupGuidance(
      "You can set up Slack for Morgan through the supported human authorization page.",
      "Morgan",
      true,
    ),
  ).toBe(true);
  expect(
    slackSetupGuidance(
      "Slack is ready. You can configure Morgan later.",
      "Morgan",
      true,
    ),
  ).toBe(false);
  expect(
    slackSetupGuidance(
      "Select the CEO to connect Slack; Morgan will use it later.",
      "Morgan",
      true,
    ),
  ).toBe(false);
});
