import { describe, expect, it } from "vitest";
import {
  gradeNotionSetup,
  personalNotionGuidance,
  notionSetupExternalCases,
} from "./external-notion-setup.js";
import {
  validNotionOAuthInput,
  validNotionOAuthReceipt,
  notionSelfWorkspaceMatches,
  type NotionOAuthInput,
  type NotionOAuthReceipt,
} from "./external-notion-oauth-contract.js";
import type { ExternalObservation } from "./external-support.js";
const workspaceId = "11111111-1111-4111-8111-111111111111",
  pageId = "22222222-2222-4222-8222-222222222222";
const storage = (domain: string) => ({
  cookies: [
    {
      name: "session",
      value: "synthetic-private-session",
      domain,
      path: "/",
      secure: true,
    },
  ],
  origins: [],
});
const input: NotionOAuthInput = {
  operation: "authorize",
  publicOrigin: "https://owned.example.test",
  companyId: "company",
  prefix: "ACORN",
  humanId: "person",
  agentId: "ceo",
  intentId: "intent",
  issueId: "source",
  workspaceId,
  workspaceName: "Synthetic Launch",
  providerEmail: "synthetic@example.test",
  publicSession: storage("owned.example.test"),
  notionSession: storage(".notion.so"),
};
function receipt(): NotionOAuthReceipt {
  return {
    connectionId: "connection",
    humanId: "person",
    intentId: "intent",
    personalDraft: true,
    credentialAbsentAtHandoff: true,
    providerHandoff: true,
    resumedSameDraft: false,
    draftSurvivedReload: false,
    consentCompleted: true,
    callbackReturned: true,
    workspaceMatched: true,
    providerHumanMatched: true,
    processIsolation: true,
    testRunnerAttached: false,
    tracingEnabled: false,
    videoEnabled: false,
  };
}
function valid(id: string): ExternalObservation {
  return {
    scenarioId: id,
    companyId: "company",
    leadId: "ceo",
    origin: "http://127.0.0.1:3100",
    state: {
      intentId: "intent",
      initialRunId: "initial",
      humanId: "person",
      pendingBeforeHuman: true,
      cardVisible: true,
      pendingWithoutCredential: true,
      oauthReceipt: receipt(),
      connectionId: "connection",
      samePersonalActive: true,
      currentHumanPreserved: true,
      originalSourcePreserved: true,
      sourceIssueId: "source",
      readEntryIds: ["read"],
      decisions: [
        {
          runId: "continuation",
          decisions: [
            {
              invocation: {
                runId: "continuation",
                agentId: "ceo",
                issueId: "source",
                connectionId: "connection",
                catalogEntryId: "read",
                status: "succeeded",
              },
            },
          ],
        },
      ],
      pages: [
        {
          id: pageId,
          editedAt: "2026-10-26T08:00:00.000Z",
          fact: {
            subjectAliases: ["launch", "release"],
            valueAliases: ["November 8", "8 November"],
          },
        },
      ],
      pagesUnchanged: true,
    },
    reply: "As of Oct 26, 2026, the release is now set for 8 November.",
    phaseReplies: [
      {
        runId: "initial",
        body: "Please connect your personal Notion with the secure setup card; I cannot read it until you authorize.",
      },
      {
        runId: "continuation",
        commentId: "comment",
        body: "As of Oct 26, 2026, the release is now set for 8 November.",
      },
    ],
    connections: [{ id: "connection" }],
    interactions: [
      {
        id: "intent",
        kind: "connection_intent",
        sourceRunId: "initial",
        addresseeUserId: "person",
        resolvedByUserId: "person",
        result: { outcome: "connected", connectionId: "connection" },
        payload: { serviceSlug: "notion" },
      },
    ],
    profiles: [],
    secrets: [],
    endpoints: [],
    activity: [],
    links: [`https://www.notion.so/Launch-${pageId}?source=chat`],
    runs: [
      { id: "initial", status: "succeeded" },
      { id: "continuation", status: "succeeded" },
    ],
    humanQueries: [],
  } as unknown as ExternalObservation;
}
describe("named Notion human setup controls", () => {
  it("accepts actual personal callback plus a new source-bound body read", () => {
    for (const id of [
      "connection-setup.notion-missing",
      "connection-setup.return-from-login",
    ])
      expect(gradeNotionSetup(valid(id)).passed).toBe(true);
  });
  it("accepts actual leave/reload/resume of the same credential-free draft", () => {
    const o = valid("connection-setup.save-and-resume");
    o.state.savedDraft = {
      ...receipt(),
      intentId: null,
      consentCompleted: false,
      callbackReturned: false,
      workspaceMatched: false,
      providerHumanMatched: false,
      draftSurvivedReload: true,
    };
    o.state.savedBeforeCanonical = true;
    (o.state.oauthReceipt as NotionOAuthReceipt).resumedSameDraft = true;
    expect(gradeNotionSetup(o).passed).toBe(true);
  });
  const wrong: Array<[string, (o: ExternalObservation) => void]> = [
    [
      "wrong addressed human",
      (o) => {
        o.state.humanId = "other";
      },
    ],
    [
      "premature completed summary",
      (o) => {
        o.phaseReplies[0]!.body =
          "I've already reviewed Notion. The launch is November 8.";
      },
    ],
    [
      "provider refusal alone",
      (o) => {
        o.state.oauthReceipt = undefined;
        o.state.decisions = [];
        o.phaseReplies[1]!.body = "Notion is unavailable; I could not read it.";
      },
    ],
    [
      "wrong granted workspace",
      (o) => {
        (o.state.oauthReceipt as NotionOAuthReceipt).workspaceMatched = false;
      },
    ],
    [
      "another callback user",
      (o) => {
        (o.state.oauthReceipt as NotionOAuthReceipt).humanId = "other";
      },
    ],
    [
      "duplicate connection",
      (o) => {
        o.connections.push({ id: "duplicate" });
      },
    ],
    [
      "oracle-only read",
      (o) => {
        o.state.decisions = [];
      },
    ],
    [
      "read on wrong source",
      (o) => {
        (o.state.decisions as any[])[0].decisions[0].invocation.issueId =
          "unrelated";
      },
    ],
    [
      "stale or title-only summary",
      (o) => {
        o.phaseReplies[1]!.body = "The launch page title looks promising.";
      },
    ],
    [
      "wrong update date",
      (o) => {
        o.phaseReplies[1]!.body = "On Oct 25, 2026 the launch is November 8.";
      },
    ],
    [
      "wrong page identity",
      (o) => {
        o.links = ["https://www.notion.so/33333333333343338333333333333333"];
      },
    ],
  ];
  for (const [name, mutate] of wrong)
    it(`rejects ${name}`, () => {
      const o = valid("connection-setup.notion-missing");
      mutate(o);
      expect(gradeNotionSetup(o).passed).toBe(false);
    });
  it("requires independently distinct real shared/personal authority and preserves the shared audience", () => {
    const o = valid("connection-setup.notion-wrong-account");
    o.connections.push({ id: "shared" });
    Object.assign(o.state, {
      sharedConnectionId: "shared",
      sharedWorkspaceMatched: true,
      sharedMcpWorkspaceMatched: true,
      sharedCannotReadPersonal: true,
      sharedAuthorityPreserved: true,
    });
    expect(gradeNotionSetup(o).passed).toBe(true);
    for (const key of [
      "sharedWorkspaceMatched",
      "sharedMcpWorkspaceMatched",
      "sharedCannotReadPersonal",
      "sharedAuthorityPreserved",
    ]) {
      const wrong = structuredClone(o);
      wrong.state[key] = false;
      expect(gradeNotionSetup(wrong).passed).toBe(false);
    }
    const wrong = structuredClone(o);
    wrong.phaseReplies[0]!.body =
      "Connect the shared company Notion account and give everyone access.";
    expect(gradeNotionSetup(wrong).passed).toBe(false);
  });
  it("gates human personal setup on actual personal-account guidance", () => {
    expect(
      personalNotionGuidance(
        "Please connect your personal Notion workspace using the setup request.",
      ),
    ).toBe(true);
    for (const text of [
      "Connect the shared company account.",
      "I've connected your personal workspace.",
      "I have already authorized your personal account.",
    ])
      expect(personalNotionGuidance(text)).toBe(false);
  });
  it("rejects a fabricated or replaced resume draft", () => {
    const o = valid("connection-setup.save-and-resume");
    o.state.savedDraft = { ...receipt(), connectionId: "other" };
    o.state.savedBeforeCanonical = true;
    expect(gradeNotionSetup(o).passed).toBe(false);
  });
  it("keeps exact concrete callbacks and phase bounds", () => {
    expect(notionSetupExternalCases.map((c) => c.scenarioId)).toHaveLength(4);
    for (const c of notionSetupExternalCases) {
      expect(
        [c.setup, c.act, c.observe, c.verifyResult, c.cleanup].every(
          (f) => typeof f === "function",
        ),
      ).toBe(true);
      expect(c.expectedRunCount).toBe(2);
      expect(c.expectedHumanMessageCount).toBe(1);
      expect(c.coverageGaps).toBeUndefined();
    }
  });
  it("accepts only isolated selected official provider/public sessions", () => {
    expect(validNotionOAuthInput(input)).toBe(true);
    for (const change of [
      { publicOrigin: "http://owned.example.test" },
      { publicSession: storage("127.0.0.1") },
      { notionSession: storage("notion.so.attacker.test") },
      { workspaceName: "Synthetic\nLaunch" },
      { providerEmail: "not-an-email" },
    ])
      expect(validNotionOAuthInput({ ...input, ...change })).toBe(false);
  });
  it("requires actual same-user closed callback receipt", () => {
    expect(validNotionOAuthReceipt(receipt(), input)).toBe(true);
    for (const change of [
      { callbackReturned: false },
      { processIsolation: false },
      { humanId: "other" },
      { intentId: "wrong" },
      { providerHumanMatched: false },
      { workspaceMatched: false },
      { extra: "private" },
    ])
      expect(
        validNotionOAuthReceipt(
          { ...receipt(), ...change } as NotionOAuthReceipt,
          input,
        ),
      ).toBe(false);
  });
  it("matches only actual workspace authority, never a coincidental nested ID", () => {
    expect(
      notionSelfWorkspaceMatches(
        {
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  type: "bot",
                  bot: { workspace_id: workspaceId },
                }),
              },
            ],
          },
        },
        workspaceId,
      ),
    ).toBe(true);
    expect(
      notionSelfWorkspaceMatches(
        { workspace: { id: workspaceId.replaceAll("-", "") } },
        workspaceId,
      ),
    ).toBe(true);
    for (const result of [
      { unrelated: { id: workspaceId } },
      { workspace: { id: pageId } },
      { type: "bot", bot: {} },
      { content: [{ type: "text", text: "Notion connected" }] },
    ])
      expect(notionSelfWorkspaceMatches(result, workspaceId)).toBe(false);
  });
});
