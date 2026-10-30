import { describe, expect, it } from "vitest";
import { scoreConnectionSearch } from "./connection-search.js";
import { AGGREGATOR_SUPPORT_INDEX, searchAggregatorServices } from "./connection-routing.js";

describe("connection search relevance", () => {
  it.each(["agentmail", "agent mail", "AGENT-MAIL", "Agentmial", "Agentmai", "Agentmaill"])(
    "recognizes a name in a long query: %s", name => {
      expect(scoreConnectionSearch(`Please acquire an email address through ${name} and remember it`, ["AgentMail"]).nameScore).toBeGreaterThan(0);
    },
  );
  it("ranks a named service above generic capability overlap", () => {
    const query = "Help me connect Linear to read project documentation";
    expect(scoreConnectionSearch(query, ["Linear"]).score)
      .toBeGreaterThan(scoreConnectionSearch(query, ["Notion"], "Read project documentation").score);
  });
  it("ignores repeated filler and retains capability matches", () => {
    const base = scoreConnectionSearch("spreadsheets", ["Sheets"], "Read spreadsheets");
    expect(scoreConnectionSearch("please please help me find tools for spreadsheets", ["Sheets"], "Read spreadsheets").score).toBe(base.score);
  });
  it.each(["email", "contacts"])("retains the capability word %s without treating it as a product name", word => {
    expect(scoreConnectionSearch(`Find a connection for ${word}`, ["Workspace"], `Search ${word}`).score).toBeGreaterThan(0);
    expect(scoreConnectionSearch(`Find a connection for ${word}`, [word]).nameScore).toBe(0);
  });
  it("supports a partial name without turning substrings of prose into service claims", () => {
    expect(scoreConnectionSearch("agen", ["AgentMail"]).nameScore).toBeGreaterThan(0);
    expect(scoreConnectionSearch("notionally similar", ["Notion"]).nameScore).toBe(0);
    expect(scoreConnectionSearch("please find tools", ["Findymail"]).nameScore).toBe(0);
    expect(scoreConnectionSearch("our team's projects", ["Teams"]).nameScore).toBe(0);
  });
  it("indexes the public aggregator catalog with valid routes and evidence", () => {
    expect(AGGREGATOR_SUPPORT_INDEX.length).toBeGreaterThan(1000);
    expect(new Set(AGGREGATOR_SUPPORT_INDEX.map(app => app.slug)).size).toBe(AGGREGATOR_SUPPORT_INDEX.length);
    for (const app of AGGREGATOR_SUPPORT_INDEX) expect(app.slug).toMatch(/^[a-z0-9][a-z0-9-]{0,79}$/);
    expect(searchAggregatorServices("circle back meeting notes")[0]?.service).toMatchObject({
      slug: "circleback-mcp", evidenceUrls: { composio: "https://docs.composio.dev/toolkits/circleback_mcp" },
    });
  });
});
