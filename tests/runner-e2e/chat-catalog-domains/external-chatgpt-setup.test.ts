import { describe, expect, it } from "vitest";
import {
  gradeChatgptSetup,
  truthfulChatgptHandoff,
  chatgptSetupCase,
} from "./external-chatgpt-setup.js";
import {
  namedChatgptRequest,
  exactAcceptedChatgptScopes,
  chatgptConsentDisclosure,
  validChatgptInput,
  validChatgptReceipt,
  createdChatgptAppId,
  setupCheckComment,
  type ChatgptInput,
  type ChatgptReceipt,
} from "./external-chatgpt-contract.js";
import type { ExternalObservation } from "./external-support.js";
import type { McpConnectionRequest } from "../../../packages/shared/src/public-mcp.js";
const company = "11111111-1111-4111-8111-111111111111",
  grant = "22222222-2222-4222-8222-222222222222",
  comment = "33333333-3333-4333-8333-333333333333";
const scopes = ["paperclip:read", "paperclip:write", "offline_access"];
function input(): ChatgptInput {
  return {
    operation: "setup",
    executionId:
      "catalog.local.assistant-connections.connect-external-assistant",
    attemptId: "a".repeat(32),
    receiptPath: "/private/receipt.json",
    backendOrigin: "http://127.0.0.1:3100",
    publicOrigin: "https://fixture.example.test",
    companyId: company,
    companyName: "Synthetic Company",
    prefix: "ACORN",
    humanId: "person",
    operatorRef: "qa-operator",
    authorizationRef: "authorized-chatgpt",
    publicSession: {
      cookies: [
        {
          name: "session",
          value: "synthetic-test-only",
          domain: "fixture.example.test",
          path: "/",
          secure: true,
        },
      ],
      origins: [],
    },
    control: {
      id: comment,
      identifier: "ACORN-2",
      title: "Assistant setup control",
      ownerFact: "Mira Patel",
    },
  };
}
function receipt(): ChatgptReceipt {
  return {
    operation: "setup",
    executionId: input().executionId,
    attemptId: input().attemptId,
    companyId: company,
    humanId: "person",
    processIsolation: true,
    testRunnerAttached: false,
    tracingEnabled: false,
    videoEnabled: false,
    operatorAvailable: true,
    grantId: grant,
    requestId: "request",
    commentId: comment,
    clientRequestId: "tool-request",
    actualChatgptUi: true,
    realHumanConsent: true,
    actualProviderCallback: true,
    boundMcpComment: true,
    zeroNativeAdmissions: true,
    requestedScopes: [...scopes],
    acceptedScopes: [...scopes],
    configureDisclosed: true,
    consentWording: "Write all of your Paperclip data",
  };
}
function valid(): ExternalObservation {
  return {
    scenarioId: chatgptSetupCase.scenarioId,
    origin: "http://fixture.invalid",
    companyId: company,
    leadId: "ceo",
    reply: "Open the ChatGPT connection setup and complete the human consent.",
    links: ["/ACORN/apps/assistant-connection"],
    state: {
      namedReceipt: receipt(),
      humanId: "person",
      operatorAvailable: true,
      setupMetadataMatched: true,
      actualBrowserInstructionsVisible: true,
      resultPath: "/ACORN/apps/assistant-connection",
      assistantConnections: [
        {
          id: grant,
          companyId: company,
          clientName: "ChatGPT",
          scopes: [...scopes],
          revokedAt: null,
        },
      ],
      currentPersonPreserved: true,
      controlTaskId: "control",
      ownerFact: "Mira Patel",
      controlCommentCount: 1,
      controlComment: {
        id: comment,
        companyId: company,
        issueId: "control",
        authorUserId: "person",
        authorAgentId: null,
        createdByRunId: null,
        clientRequestId: "tool-request",
        body: "Setup check: the launch owner is Mira Patel.",
      },
      controlTaskUnchanged: true,
      noAgentAssignmentOrWatchdog: true,
      zeroNativeAdmissions: true,
      unauthenticatedMcpStatus: 401,
      unauthenticatedHintDidNotGrant: true,
    },
    activity: [
      {
        id: "authorization",
        action: "mcp.connection_authorized",
        entityId: grant,
        actorType: "user",
        actorId: "person",
        details: { clientId: "actual-chatgpt-client", scopes: [...scopes] },
      },
      {
        id: "call",
        action: "mcp.tool_called",
        entityId: grant,
        actorType: "user",
        actorId: "person",
        details: {
          clientId: "actual-chatgpt-client",
          operation: "paperclip_add_comment",
          requestId: "tool-request",
        },
      },
    ],
    phaseReplies: [],
    connections: [],
    profiles: [],
    secrets: [],
    endpoints: [],
    interactions: [],
    tasks: [],
    projects: [],
    goals: [],
    comments: [],
    documents: [],
    revisions: [],
    humanQueries: [],
    runs: [],
  };
}
describe("named ChatGPT real human setup independent authorities", () => {
  it("accepts actual named grant, grounded client comment, exact audit and unchanged inert task", () =>
    expect(gradeChatgptSetup(valid()).passed).toBe(true));
  const wrong: Record<string, (o: ExternalObservation) => void> = {
    "operator acknowledgement without actual provider UI": (o) => {
      (o.state.namedReceipt as ChatgptReceipt).actualChatgptUi = undefined;
    },
    "generic MCP client": (o) => {
      (
        o.state.assistantConnections as Array<{ clientName: string }>
      )[0]!.clientName = "Synthetic MCP";
    },
    "wrong company": (o) => {
      (o.state.namedReceipt as ChatgptReceipt).companyId = "other";
    },
    "wrong person": (o) => {
      o.state.currentPersonPreserved = false;
    },
    "wrong grant client audit": (o) => {
      o.activity[1]!.details = {
        ...o.activity[1]!.details,
        clientId: "surrogate",
      };
    },
    "authorized scopes differ from saved grant": (o) => {
      o.activity[0]!.details = {
        ...o.activity[0]!.details,
        scopes: ["paperclip:read"],
      };
    },
    "REST surrogate lacks MCP audit": (o) => {
      o.activity.pop();
    },
    "unrelated tool request": (o) => {
      o.activity[1]!.details = {
        ...o.activity[1]!.details,
        requestId: "other",
      };
    },
    "wrong task": (o) => {
      (o.state.controlComment as { issueId: string }).issueId = "other";
    },
    "wrong read fact": (o) => {
      (o.state.controlComment as { body: string }).body =
        "Setup check: the launch owner is Evan Hayes.";
    },
    "extra write": (o) => {
      o.activity.push({ ...o.activity[1]!, id: "extra" });
    },
    "native wake": (o) => {
      o.state.zeroNativeAdmissions = false;
    },
    "task mutation": (o) => {
      o.state.controlTaskUnchanged = false;
    },
    "company hint authority": (o) => {
      o.state.unauthenticatedMcpStatus = 200;
    },
    "connected before actual human action": (o) => {
      o.reply = "I've already connected ChatGPT. Open setup.";
    },
    "unexpected configure": (o) => {
      (
        o.state.assistantConnections as Array<{ scopes: string[] }>
      )[0]!.scopes.push("paperclip:configure");
    },
    "grant to agent impersonation": (o) => {
      (
        o.state.assistantConnections as Array<{ scopes: string[] }>
      )[0]!.scopes.push("paperclip:agent");
    },
  };
  for (const [name, mutate] of Object.entries(wrong))
    it(`rejects ${name}`, () => {
      const o = valid();
      mutate(o);
      expect(gradeChatgptSetup(o).passed).toBe(false);
    });
  it("permits requested, visibly disclosed, explicitly accepted configure but rejects hidden or extra authority", () => {
    const o = valid(),
      r = o.state.namedReceipt as ChatgptReceipt;
    r.requestedScopes!.push("paperclip:configure");
    r.acceptedScopes!.push("paperclip:configure");
    (
      o.state.assistantConnections as Array<{ scopes: string[] }>
    )[0]!.scopes.push("paperclip:configure");
    o.activity[0]!.details!.scopes = [...scopes, "paperclip:configure"];
    expect(gradeChatgptSetup(o).passed).toBe(true);
    r.configureDisclosed = false;
    expect(gradeChatgptSetup(o).passed).toBe(false);
  });
  it("accepts natural truthful setup direction and rejects affirmative contractions", () => {
    for (const reply of [
      "ChatGPT is not yet connected. Open setup.",
      "After you have connected ChatGPT, use the app.",
      "I cannot connect ChatGPT on your behalf.",
    ])
      expect(truthfulChatgptHandoff(reply)).toBe(true);
    for (const reply of [
      "I've connected ChatGPT.",
      "I’ve already authorized ChatGPT.",
      "I have installed ChatGPT.",
      "ChatGPT is already connected.",
    ])
      expect(truthfulChatgptHandoff(reply)).toBe(false);
  });
});
describe("finite private named-provider contract", () => {
  it("requires secure public-host-only session and bounded exact-case input", () => {
    expect(validChatgptInput(input())).toBe(true);
    for (const mutate of [
      (i: ChatgptInput) => {
        i.executionId = "unrelated";
      },
      (i: ChatgptInput) => {
        i.publicSession.cookies[0]!.secure = false;
      },
      (i: ChatgptInput) => {
        i.publicSession.cookies[0]!.domain = "chatgpt.com";
      },
      (i: ChatgptInput) => {
        i.control!.ownerFact = "@agent";
      },
    ]) {
      const i = input();
      mutate(i);
      expect(validChatgptInput(i)).toBe(false);
    }
  });
  it("receipt is closed, bound to actual attempt/person, and cannot carry token/session values", () => {
    expect(validChatgptReceipt(receipt(), input())).toBe(true);
    for (const delta of [
      { attemptId: "b".repeat(32) },
      { humanId: "other" },
      { accessToken: "must-not-be-exported" },
      { actualProviderCallback: false },
      { acceptedScopes: [...scopes, "paperclip:agent"] },
    ])
      expect(
        validChatgptReceipt(
          { ...receipt(), ...delta } as ChatgptReceipt,
          input(),
        ),
      ).toBe(false);
  });
  it("accepts actual broad write wording plus explicit requested configure acknowledgement", () => {
    expect(
      chatgptConsentDisclosure(true, "Write all of your Paperclip data", true),
    ).toBe(true);
    expect(
      chatgptConsentDisclosure(true, "Write all of your Paperclip data", false),
    ).toBe(false);
    expect(
      chatgptConsentDisclosure(true, "Read all of your Paperclip data", true),
    ).toBe(false);
    expect(
      chatgptConsentDisclosure(
        false,
        "Write all of your Paperclip data",
        false,
      ),
    ).toBe(true);
  });
  it("requires actual named official callback/person/company request", () => {
    const r = {
      id: "request",
      clientName: "ChatGPT",
      redirectOrigin: "https://chatgpt.com",
      clientOrigin: "https://chatgpt.com",
      agentConnection: false,
      requestedWrite: true,
      requestedConfigure: false,
      offlineAccess: true,
      requiresSignIn: false,
      requestedCompanyId: company,
      companies: [
        { id: company, name: "Synthetic", logoUrl: null, canWrite: true },
      ],
      setupUrl: null,
    } satisfies McpConnectionRequest;
    expect(namedChatgptRequest(r, company)).toBe(true);
    for (const delta of [
      { clientName: "Test MCP" },
      { redirectOrigin: "https://attacker.invalid" },
      { requestedCompanyId: "other" },
      { agentConnection: true },
      { requiresSignIn: true },
      { requestedWrite: false },
      { companies: [] },
    ])
      expect(namedChatgptRequest({ ...r, ...delta }, company)).toBe(false);
  });
  it("accepts only exact requested and accepted scopes, with actual configure disclosure", () => {
    expect(exactAcceptedChatgptScopes(scopes, scopes, false)).toBe(true);
    expect(
      exactAcceptedChatgptScopes(
        [...scopes, "paperclip:configure"],
        [...scopes, "paperclip:configure"],
        true,
      ),
    ).toBe(true);
    for (const [r, a, d] of [
      [scopes, [...scopes, "paperclip:configure"], true],
      [
        [...scopes, "paperclip:configure"],
        [...scopes, "paperclip:configure"],
        false,
      ],
      [scopes, ["paperclip:read"], true],
      [[...scopes, "paperclip:agent"], [...scopes, "paperclip:agent"], true],
    ])
      expect(exactAcceptedChatgptScopes(r, a, d)).toBe(false);
  });
  it("scopes provider cleanup to actual new app ID and submitted actual URL/name", () => {
    const text = "New owned app https://fixture.example.test/mcp/paperclip";
    expect(
      createdChatgptAppId(
        { app: { id: "owned_app_123" } },
        "New owned app",
        text,
        "https://fixture.example.test/mcp/paperclip",
      ),
    ).toBe("owned_app_123");
    expect(
      createdChatgptAppId(
        { id: "owned_app_123" },
        "Unrelated app",
        text,
        "https://fixture.example.test/mcp/paperclip",
      ),
    ).toBeUndefined();
    expect(
      createdChatgptAppId(
        { id: "../escape" },
        "New owned app",
        text,
        "https://fixture.example.test/mcp/paperclip",
      ),
    ).toBeUndefined();
  });
  it("grounded neutral comment tolerates punctuation but no mentions/wrong fact or extra action", () => {
    expect(
      setupCheckComment(
        " Setup check: the launch owner is Mira Patel! ",
        "Mira Patel",
      ),
    ).toBe(true);
    for (const b of [
      "Setup check: the launch owner is Evan Hayes.",
      "Setup check: the launch owner is Mira Patel. Start work.",
      "@Mira Patel",
      "<p>Setup check: the launch owner is Mira Patel.</p>",
    ])
      expect(setupCheckComment(b, "Mira Patel")).toBe(false);
  });
});
