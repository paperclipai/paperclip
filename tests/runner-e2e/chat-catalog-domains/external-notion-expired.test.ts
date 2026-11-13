import { describe, it, expect } from "vitest";
import {
  gradeNotionExpired,
  hasNotionAuthFailure,
  notionRepairGuidance,
  notionExpiredExternalCases,
} from "./external-notion-expired.js";
import { qualifiedNotionExpiry } from "./external-notion-expiry.js";
import {
  validNotionOAuthInput,
  validNotionOAuthReceipt,
  type NotionOAuthInput,
  type NotionOAuthReceipt,
} from "./external-notion-oauth-contract.js";
import type { ExternalObservation } from "./external-support.js";
import type { ToolRunDecisionLookup } from "../../../packages/shared/src/types/tool-access.js";
const pageId = "22222222-2222-4222-8222-222222222222";
function valid(): ExternalObservation {
  return {
    scenarioId: "connection-setup.notion-expired",
    companyId: "company",
    leadId: "ceo",
    origin: "http://127.0.0.1:3100",
    reply: "As of Oct 26, 2026, the launch is now November 8.",
    state: {
      connectionId: "connection",
      humanId: "person",
      sourceIssueId: "source",
      validBeforeExpiry: true,
      sameWorkspaceBeforeExpiry: true,
      actualProvider401: true,
      expiryQualified: true,
      firstAuthFailure: true,
      firstReply:
        "Notion authorization expired. Please reconnect the existing account.",
      exactReconnectPath: true,
      firstIntentId: "first",
      finalIntentId: "second",
      firstInitialRunId: "initial",
      finalInitialRunId: "repeat",
      cancelledSnapshot: true,
      cancelConnectionUnchanged: true,
      cancelNoSuccessfulRead: true,
      truthfulCancelReply: true,
      cancelReply:
        "You declined, so I could not read Notion; the research is incomplete.",
      finalInitialReply:
        "Please reconnect the existing Notion account because its authorization expired.",
      finalAuthFailure: true,
      finalGuidanceCorrect: true,
      repairReceipt: {
        connectionId: "connection",
        humanId: "person",
        intentId: "second",
        personalDraft: false,
        credentialAbsentAtHandoff: false,
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
      },
      authorityPreserved: true,
      repairRunIds: ["resumed"],
      readEntryIds: ["read"],
      decisions: [
        {
          runId: "resumed",
          decisions: [
            {
              invocation: {
                runId: "resumed",
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
            subjectAliases: ["launch"],
            valueAliases: ["November 8", "8 November"],
          },
        },
      ],
      repairedReply: "As of Oct 26, 2026, the launch is now November 8.",
      pagesUnchanged: true,
    },
    phaseReplies: [],
    connections: [{ id: "connection" }],
    interactions: [
      {
        id: "first",
        kind: "connection_intent",
        addresseeUserId: "person",
        resolvedByUserId: "person",
        result: { outcome: "declined" },
      },
      {
        id: "second",
        kind: "connection_intent",
        addresseeUserId: "person",
        resolvedByUserId: "person",
        sourceRunId: "repeat",
        result: { outcome: "connected", connectionId: "connection" },
      },
    ],
    profiles: [],
    secrets: [],
    endpoints: [],
    activity: [],
    links: [`https://www.notion.so/Launch-${pageId}`],
    runs: [],
    humanQueries: [
      "Read my Notion and tell me the latest on the launch.",
      "Read my Notion and tell me the latest on the launch.",
    ],
  } as unknown as ExternalObservation;
}
describe("expired Notion cancellation and actual repair controls", () => {
  it("accepts independent natural expiry, retained cancellation and a fresh same-account read", () =>
    expect(gradeNotionExpired(valid()).passed).toBe(true));
  const wrong: Array<[string, (o: ExternalObservation) => void]> = [
    [
      "no real expiry",
      (o) => {
        o.state.actualProvider401 = false;
      },
    ],
    [
      "credential was invalid from the start",
      (o) => {
        o.state.validBeforeExpiry = false;
      },
    ],
    [
      "no original native failed read",
      (o) => {
        o.state.firstAuthFailure = false;
      },
    ],
    [
      "false initial completion",
      (o) => {
        o.state.firstReply =
          "I've already reconnected Notion and read the launch.";
      },
    ],
    [
      "wrong repair route",
      (o) => {
        o.state.exactReconnectPath = false;
      },
    ],
    [
      "cancel was used as consent",
      (o) => {
        o.state.cancelNoSuccessfulRead = false;
      },
    ],
    [
      "cancellation fabricated",
      (o) => {
        o.state.cancelledSnapshot = false;
      },
    ],
    [
      "unrelated second request",
      (o) => {
        o.humanQueries[1] = "Summarize a different workspace.";
      },
    ],
    [
      "same request resolved twice",
      (o) => {
        o.state.finalIntentId = "first";
      },
    ],
    [
      "wrong account repaired",
      (o) => {
        (o.state.repairReceipt as NotionOAuthReceipt).connectionId = "other";
      },
    ],
    [
      "provider unavailable without positive outcome",
      (o) => {
        o.state.repairReceipt = undefined;
        o.state.decisions = [];
      },
    ],
    [
      "shared audience expanded",
      (o) => {
        o.state.authorityPreserved = false;
      },
    ],
    [
      "no fresh native provider read",
      (o) => {
        o.state.decisions = [];
      },
    ],
    [
      "cached facts claimed before repair",
      (o) => {
        o.state.firstReply =
          "Notion authorization expired; reconnect it. The launch is November 8.";
      },
    ],
    [
      "title-only final summary",
      (o) => {
        o.state.repairedReply = "The launch page title is promising.";
      },
    ],
  ];
  for (const [name, mutate] of wrong)
    it(`rejects ${name}`, () => {
      const o = valid();
      mutate(o);
      expect(gradeNotionExpired(o).passed).toBe(false);
    });
  it("qualifies only a finite explicit natural-expiry window", () => {
    const now = Date.parse("2026-10-27T10:00:00Z"),
      p = {
        authorizationExpiresAt: new Date(now + 180000).toISOString(),
        authorizationFailureKind: "natural-expiry",
      };
    expect(qualifiedNotionExpiry(p, now)).toBe(true);
    for (const change of [
      { authorizationFailureKind: "revoked" },
      { authorizationExpiresAt: new Date(now - 1).toISOString() },
      { authorizationExpiresAt: new Date(now + 3600000).toISOString() },
      { authorizationExpiresAt: "invalid" },
    ])
      expect(qualifiedNotionExpiry({ ...p, ...change }, now)).toBe(false);
  });
  it("binds actual authentication failure to exact native run, source and account", () => {
    const rows = [
      {
        runId: "run",
        decisions: [
          {
            invocation: {
              runId: "run",
              issueId: "source",
              connectionId: "connection",
              status: "failed",
              errorCode: "upstream_error",
              errorMessage: "HTTP 401 Unauthorized",
            },
          },
        ],
      },
    ] as unknown as ToolRunDecisionLookup[];
    expect(hasNotionAuthFailure(rows, "run", "connection", "source")).toBe(
      true,
    );
    for (const args of [
      ["other", "connection", "source"],
      ["run", "other", "source"],
      ["run", "connection", "other"],
    ])
      expect(hasNotionAuthFailure(rows, args[0]!, args[1]!, args[2]!)).toBe(
        false,
      );
    const wrong = structuredClone(rows);
    wrong[0]!.decisions[0]!.invocation.status = "succeeded";
    expect(hasNotionAuthFailure(wrong, "run", "connection", "source")).toBe(
      false,
    );
  });
  it("accepts truthful repair direction but rejects affirmative completed claims", () => {
    for (const text of [
      "I have not reconnected Notion; please reconnect the expired account.",
      "Notion authorization expired. Use its reconnect path.",
    ])
      expect(notionRepairGuidance(text)).toBe(true);
    for (const text of [
      "I've already repaired Notion; reconnect again if needed.",
      "I have already read Notion after reconnecting.",
    ])
      expect(notionRepairGuidance(text)).toBe(false);
  });
  it("keeps public reconnect distinct from new personal setup in private receipts", () => {
    const storage = (domain: string) => ({
      cookies: [
        {
          name: "session",
          value: "synthetic-private-value",
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
      intentId: "second",
      issueId: "source",
      reconnectId: "connection",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      workspaceName: "Synthetic Launch",
      providerEmail: "synthetic@example.test",
      publicSession: storage("owned.example.test"),
      notionSession: storage(".notion.so"),
    };
    const receipt = valid().state.repairReceipt as NotionOAuthReceipt;
    expect(validNotionOAuthInput(input)).toBe(true);
    expect(validNotionOAuthReceipt(receipt, input)).toBe(true);
    expect(
      validNotionOAuthReceipt({ ...receipt, personalDraft: true }, input),
    ).toBe(false);
    expect(
      validNotionOAuthReceipt({ ...receipt, connectionId: "other" }, input),
    ).toBe(false);
    expect(validNotionOAuthInput({ ...input, draftId: "another" })).toBe(false);
  });
  it("provides all callbacks and explicitly bounded actual phases", () => {
    const c = notionExpiredExternalCases[0]!;
    expect(
      [c.setup, c.act, c.observe, c.verifyResult, c.cleanup].every(
        (f) => typeof f === "function",
      ),
    ).toBe(true);
    expect(c.expectedRunCount).toBe(4);
    expect(c.expectedHumanMessageCount).toBe(2);
    expect(c.coverageGaps).toBeUndefined();
  });
});
