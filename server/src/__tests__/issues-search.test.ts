import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { sql, eq } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import { companies, agents, goals, issues } from "@paperclipai/db";
import { issueService } from "../services/issues.js";

describe("Issue Search", () => {
  let db: ReturnType<typeof createDb>;
  let svc: ReturnType<typeof issueService>;
  let companyId: string;
  let agentId: string;
  let goalId: string;

  beforeAll(() => {
    const url = process.env.DATABASE_URL || process.env.PAPERCLIP_DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL or PAPERCLIP_DATABASE_URL must be set for tests");
    }
    db = createDb(url);
    svc = issueService(db);
  });

  beforeEach(async () => {
    // Create a test company
    const [company] = await db
      .insert(companies)
      .values({
        name: "Test Company Search",
        code: `TSTSRCH-${Date.now()}`,
      })
      .returning();
    companyId = company.id;

    // Create a test agent
    const [agent] = await db
      .insert(agents)
      .values({
        companyId,
        name: "Test Agent",
        role: "engineer",
        status: "idle",
        adapterType: "test",
        adapterConfig: {},
      })
      .returning();
    agentId = agent.id;

    const [goal] = await db
      .insert(goals)
      .values({
        companyId,
        title: "Search Goal",
        status: "active",
      })
      .returning();
    goalId = goal.id;

    // Create test issues
    await db.insert(issues).values([
      {
        companyId,
        identifier: "ZERA-87",
        issueNumber: 87,
        title: "Test issue with discord lowercase in title",
        description: "This is a test issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: agentId,
      },
      {
        companyId,
        identifier: "ZERA-41",
        issueNumber: 41,
        title: "Discord Community Setup",
        description: "Set up Discord server for community",
        status: "done",
        priority: "high",
        createdByAgentId: agentId,
      },
      {
        companyId,
        identifier: "ZERA-100",
        issueNumber: 100,
        title: "Pricing page updates",
        description: "Update the pricing information",
        status: "todo",
        priority: "medium",
        goalId,
        createdByAgentId: agentId,
      },
      {
        companyId,
        identifier: "ZERA-101",
        issueNumber: 101,
        title: "Critical onboarding fix",
        description: "Critical priority issue",
        status: "in_progress",
        priority: "critical",
        createdByAgentId: agentId,
      },
    ]);
  });

  test("search should be case-insensitive", async () => {
    // Search for "discord" (lowercase)
    const lowercaseResults = await svc.list(companyId, { q: "discord" });
    expect(lowercaseResults.length).toBeGreaterThan(0);
    expect(lowercaseResults.some((issue) => issue.identifier === "ZERA-87")).toBe(true);
    expect(lowercaseResults.some((issue) => issue.identifier === "ZERA-41")).toBe(true);

    // Search for "Discord" (capitalized)
    const capitalizedResults = await svc.list(companyId, { q: "Discord" });
    expect(capitalizedResults.length).toBeGreaterThan(0);
    expect(capitalizedResults.some((issue) => issue.identifier === "ZERA-87")).toBe(true);
    expect(capitalizedResults.some((issue) => issue.identifier === "ZERA-41")).toBe(true);

    // Results should be the same
    expect(lowercaseResults.length).toBe(capitalizedResults.length);
  });

  test("search should match identifiers", async () => {
    // Search for full identifier
    const fullIdentifierResults = await svc.list(companyId, { q: "ZERA-87" });
    expect(fullIdentifierResults.length).toBeGreaterThan(0);
    expect(fullIdentifierResults[0].identifier).toBe("ZERA-87");

    // Search for lowercase identifier
    const lowercaseIdentifierResults = await svc.list(companyId, { q: "zera-87" });
    expect(lowercaseIdentifierResults.length).toBeGreaterThan(0);
    expect(lowercaseIdentifierResults[0].identifier).toBe("ZERA-87");

    // Search for partial identifier (number only)
    const partialResults = await svc.list(companyId, { q: "87" });
    expect(partialResults.length).toBeGreaterThan(0);
    expect(partialResults.some((issue) => issue.identifier === "ZERA-87")).toBe(true);
  });

  test("search should match across title, description, and identifier", async () => {
    const pricingResults = await svc.list(companyId, { q: "pricing" });
    expect(pricingResults.length).toBeGreaterThan(0);
    expect(pricingResults.some((issue) => issue.identifier === "ZERA-100")).toBe(true);
  });

  test("search results should be ranked by relevance", async () => {
    const results = await svc.list(companyId, { q: "discord" });

    // Title matches should come before description matches
    expect(results.length).toBeGreaterThan(0);

    // The issue with "discord" starting the title should rank higher
    const titleStartIndex = results.findIndex((issue) =>
      issue.title.toLowerCase().startsWith("discord")
    );
    const titleContainsIndex = results.findIndex((issue) =>
      issue.title.toLowerCase().includes("discord") &&
      !issue.title.toLowerCase().startsWith("discord")
    );

    if (titleStartIndex !== -1 && titleContainsIndex !== -1) {
      expect(titleStartIndex).toBeLessThan(titleContainsIndex);
    }
  });

  test("filters issues by goalId", async () => {
    const results = await svc.list(companyId, { goalId });
    expect(results).toHaveLength(1);
    expect(results[0]?.identifier).toBe("ZERA-100");
  });

  test("filters issues by priority", async () => {
    const results = await svc.list(companyId, { priority: "high" });
    expect(results).toHaveLength(1);
    expect(results[0]?.identifier).toBe("ZERA-41");
  });

  test("applies limit to issue list", async () => {
    const results = await svc.list(companyId, { status: "todo,in_progress,done", limit: 2 });
    expect(results).toHaveLength(2);
  });
});
