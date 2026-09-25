import { describe, expect, it } from "vitest";
import {
  AGGREGATOR_PRIORITY,
  AGGREGATOR_SUPPORT_INDEX,
  explicitAggregatorQuery,
  findAggregatorService,
  parseAggregatorRoute,
  aggregatorProviderQuestion,
  aggregatorContinuationInstruction,
} from "./connection-routing.js";
import type { ConnectionSearchResultItem } from "./types/connection-intent.js";

describe("aggregator routing contract", () => {
  it("ranks providers and resolves aliases without fuzzy service claims", () => {
    expect(AGGREGATOR_PRIORITY).toEqual([
      "composio",
      "arcade",
      "executor",
      "zapier",
    ]);
    expect(findAggregatorService("  Hub Spot ")?.slug).toBe("hubspot");
    expect(findAggregatorService("my unknown crm")).toBeUndefined();
  });
  it("rejects forged or unbounded route identifiers", () => {
    expect(parseAggregatorRoute("via:arcade:hubspot")).toEqual({
      provider: "arcade",
      targetService: "hubspot",
    });
    for (const value of [
      "via:other:hubspot",
      "via:composio:https://evil",
      "via:composio:../secret",
      "via:executor:",
    ])
      expect(parseAggregatorRoute(value)).toBeNull();
  });
  it("always discloses external handling and offers None even with one provider", () => {
    const results = [
      {
        service: "via:composio:hubspot",
        aggregator: { provider: "composio" },
        reason: "Verify app authorization",
      },
    ] as ConnectionSearchResultItem[];
    const question = aggregatorProviderQuestion("hubspot", "HubSpot", results);
    expect(question.prompt).toContain("external service");
    expect(question.prompt).toContain("handle the connection and requests");
    expect(question.options.map((option) => option.id)).toEqual([
      "via:composio:hubspot",
      "none",
    ]);
    expect(question.selectionMode).toBe("single");
    expect(question.allowOther).toBe(false);
  });
  it.each(AGGREGATOR_PRIORITY)(
    "does not claim underlying app readiness for %s",
    (provider) => {
      expect(aggregatorContinuationInstruction(provider, "HubSpot")).toContain(
        "HubSpot access is not yet verified",
      );
      expect(aggregatorContinuationInstruction(provider, "HubSpot")).toContain(
        "ask before switching providers",
      );
    },
  );
});

it("recognizes a service in capability searches without guessing ambiguous or partial names", () => {
  expect(findAggregatorService("HubSpot recent contacts")?.slug).toBe(
    "hubspot",
  );
  expect(
    findAggregatorService("connect atlassian jira and read issues")?.slug,
  ).toBe("jira");
  expect(
    findAggregatorService("HubSpot and Salesforce contacts"),
  ).toBeUndefined();
  expect(findAggregatorService("notionally similar")).toBeUndefined();
});

it("keeps dates per app/provider claim and parses only an unambiguous explicit provider", () => {
  for (const app of AGGREGATOR_SUPPORT_INDEX)
    for (const date of Object.values(app.providers))
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(explicitAggregatorQuery("HubSpot through Arcade")).toEqual({
    provider: "arcade",
    serviceQuery: "HubSpot",
  });
  expect(
    explicitAggregatorQuery("HubSpot via Arcade or via Composio"),
  ).toBeNull();
  expect(explicitAggregatorQuery("arcade games")).toBeNull();
  expect(explicitAggregatorQuery("HubSpot via Arcade or Composio")).toBeNull();
  expect(explicitAggregatorQuery("Jira via Arcade, not Zapier")).toEqual({
    provider: "arcade",
    serviceQuery: "Jira",
  });
  expect(explicitAggregatorQuery("Jira via Arcade, not Arcade")).toBeNull();
});
