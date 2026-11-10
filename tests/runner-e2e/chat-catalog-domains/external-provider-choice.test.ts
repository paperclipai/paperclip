import { describe, expect, it } from "vitest";
import { getConnectableAppDefinition } from "../../../packages/shared/src/app-definitions.js";
import {
  gradeProviderChoice,
  notionSetupChoices,
  truthfulNotionChoices,
  publicChoiceMessages,
  intendedNotionCard,
  supportedNotionLink,
} from "./external-provider-choice.js";
const reason = "Vercel Connect setup is disabled on this Paperclip instance.";
function valid() {
  return {
    scenarioId: "connection-setup.choose-provider",
    companyId: "company",
    leadId: "ceo",
    reply:
      "Use Notion sign-in for the easiest connection. Vercel Connect is disabled here; ask the administrator to enable it before choosing that option.",
    phaseReplies: [],
    runs: [{ id: "source-run", agentId: "ceo", status: "succeeded" }],
    connections: [],
    profiles: [],
    secrets: [],
    endpoints: [],
    interactions: [],
    activity: [],
    links: [],
    humanQueries: [],
    state: {
      advertisedChoices: notionSetupChoices({
        apps: [getConnectableAppDefinition("notion")!],
        credentialSources: { vercelConnect: { available: false, reason } },
      }).advertisedChoices,
      catalogChoicesIndependentlyMatched: true,
      choiceExplanation: {
        runId: "source-run",
        eventId: "message",
        body: "Use Notion sign-in. Vercel Connect is disabled; ask an administrator to enable it.",
      },
      choiceExplanationVisible: true,
      selectionLane: "inline-card",
      selectionAttributionMatched: true,
      catalogOfficialOAuth: true,
      unavailableAdvertised: true,
      unavailableReason: reason,
      modelDirectedNotionSetup: true,
      selectedNotionVisible: true,
      signInControlVisible: true,
      originalConversationRetained: true,
      originalQueryRetained: true,
    },
  };
}
describe("current Notion catalog setup choices", () => {
  it("derives offered and unavailable choices from real catalog shape without any account", () => {
    const gallery = {
      apps: [getConnectableAppDefinition("notion")!],
      credentialSources: { vercelConnect: { available: false, reason } },
    };
    expect(notionSetupChoices(gallery)).toMatchObject({
      methodKey: "mcp-oauth",
      serverUrl: "https://mcp.notion.com/mcp",
      unavailableReason: reason,
    });
    expect(() =>
      notionSetupChoices({
        ...gallery,
        credentialSources: { vercelConnect: { available: true, reason: null } },
      }),
    ).toThrow(/Setup blocker/);
    expect(() => notionSetupChoices({ ...gallery, apps: [] })).toThrow(
      /Setup blocker/,
    );
  });
  it("accepts current user-facing choices and the selected real setup path", () =>
    expect(gradeProviderChoice(valid()).passed).toBe(true));
  it("rejects missing prerequisites, wrong setup, lost task and premature connection", () => {
    for (const mutate of [
      (o: ReturnType<typeof valid>) => {
        o.state.choiceExplanation.body =
          "Notion sign-in and Vercel Connect both work immediately.";
      },
      (o: ReturnType<typeof valid>) => {
        o.state.choiceExplanation.body =
          "I've connected Notion. Vercel Connect is disabled; ask an administrator.";
      },
      (o: ReturnType<typeof valid>) => {
        o.state.modelDirectedNotionSetup = false;
      },
      (o: ReturnType<typeof valid>) => {
        o.state.originalConversationRetained = false;
      },
      (o: ReturnType<typeof valid>) => {
        o.state.signInControlVisible = false;
      },
    ]) {
      const o = valid();
      mutate(o);
      expect(gradeProviderChoice(o).passed).toBe(false);
    }
    expect(
      truthfulNotionChoices(
        "Sign in to Notion. Vercel Connect needs workload OIDC configured first.",
        "Vercel Connect needs workload OIDC or PAPERCLIP_VERCEL_CONNECT_ACCESS_TOKEN.",
      ),
    ).toBe(true);
    expect(gradeProviderChoice(undefined).passed).toBe(false);
  });
});

import type { ConnectionIntentInteraction } from "../../../packages/shared/src/types/issue.js";
describe("actual source attribution and supported choice lanes", () => {
  it("accepts a complete explanation with either actual selection lane; bare original card remains nonpassing", () => {
    for (const lane of ["inline-card", "method-link"]) {
      const o = valid();
      o.state.selectionLane = lane;
      expect(gradeProviderChoice(o).passed).toBe(true);
    }
    const original = valid();
    original.reply = "";
    original.state.choiceExplanation.body =
      "I’ll check the available Notion connection flow and give you the shortest setup path.";
    expect(gradeProviderChoice(original).passed).toBe(false);
  });
  it("rejects lost catalog, invisible explanation, wrong source run and unbound selection", () => {
    for (const change of [
      { catalogChoicesIndependentlyMatched: false },
      { advertisedChoices: { service: "notion" } },
      {
        advertisedChoices: {
          ...valid().state.advertisedChoices,
          alternative: {
            source: "vercel_connect",
            available: true,
            reason: null,
          },
        },
      },
      { choiceExplanationVisible: false },
      { selectionAttributionMatched: false },
      {
        choiceExplanation: {
          body: valid().state.choiceExplanation.body,
          runId: "foreign",
          eventId: "message",
        },
      },
    ]) {
      const o = valid();
      Object.assign(o.state, change);
      expect(gradeProviderChoice(o).passed).toBe(false);
    }
  });
  it("accepts only completed public messages from the exact source company/agent/run", () => {
    const e = {
      seq: 1,
      eventType: "item.completed",
      runId: "run",
      companyId: "company",
      agentId: "ceo",
      payload: {
        prpEvent: {
          runId: "run",
          payload: {
            item: {
              type: "agentMessage",
              phase: "commentary",
              status: "completed",
              id: "msg",
              text: "Public setup explanation",
            },
          },
        },
      },
    };
    const target = { runId: "run", companyId: "company", agentId: "ceo" };
    expect(publicChoiceMessages([e], target)).toEqual([
      { runId: "run", eventId: "msg", body: "Public setup explanation" },
    ]);
    for (const delta of [
      { runId: "foreign" },
      { agentId: "other" },
      { companyId: "foreign" },
      { eventType: "item.started" },
    ])
      expect(publicChoiceMessages([{ ...e, ...delta }], target)).toEqual([]);
    const hidden = structuredClone(e);
    hidden.payload.prpEvent.payload.item.phase = "analysis";
    expect(publicChoiceMessages([hidden], target)).toEqual([]);
  });
  it("binds the inline request to the actual person, task, native run and Notion service", () => {
    const c = {
        id: "intent",
        kind: "connection_intent",
        status: "pending",
        companyId: "company",
        issueId: "issue",
        createdByAgentId: "ceo",
        addresseeUserId: "human",
        sourceRunId: "run",
        payload: { serviceSlug: "notion" },
      } as ConnectionIntentInteraction,
      target = {
        companyId: "company",
        issueId: "issue",
        agentId: "ceo",
        humanId: "human",
        runIds: ["run"],
      };
    expect(intendedNotionCard([c], target)?.id).toBe("intent");
    for (const delta of [
      { companyId: "foreign" },
      { issueId: "other" },
      { createdByAgentId: "other" },
      { addresseeUserId: "other" },
      { sourceRunId: "other" },
      { status: "answered" },
      { payload: { serviceSlug: "slack" } },
    ])
      expect(
        intendedNotionCard(
          [{ ...c, ...delta } as ConnectionIntentInteraction],
          target,
        ),
      ).toBeUndefined();
    expect(
      intendedNotionCard([c, { ...c, id: "duplicate" }], target),
    ).toBeUndefined();
  });
  it("allows actual same-company selected method links and rejects wrong method/company/provider", () => {
    expect(
      supportedNotionLink(
        "/ACORN/apps/connect?source=notion&method=mcp-oauth",
        "http://fixture.invalid",
        "ACORN",
        "mcp-oauth",
      ),
    ).toBe(true);
    for (const link of [
      "https://other.invalid/ACORN/apps/connect?source=notion",
      "/OTHER/apps/connect?source=notion",
      "/ACORN/apps/connect?source=slack",
      "/ACORN/apps/connect?source=notion&method=unrelated",
    ])
      expect(
        supportedNotionLink(
          link,
          "http://fixture.invalid",
          "ACORN",
          "mcp-oauth",
        ),
      ).toBe(false);
  });
});
