import { describe, expect, it, vi } from "vitest";
import {
  BrabrixSkillHubClient,
  type BrabrixSkillHubConfig,
} from "../integrations/brabrix-skillhub/brabrix-skillhub-client.js";

function baseConfig(overrides: Partial<BrabrixSkillHubConfig> = {}): BrabrixSkillHubConfig {
  return {
    apiUrl: "https://api.brabrix.dev",
    enabled: true,
    apiToken: null,
    apiKey: null,
    endpoints: {
      searchSkills: "/api/public/dev-hub/items",
      getSkillById: "/api/public/dev-hub/items/{skillId}",
      getSkillCategories: "/api/public/dev-hub/categories",
      getFeaturedSkills: "/api/public/dev-hub/featured",
    },
    timeoutMs: 10_000,
    maxRetries: 1,
    retryDelayMs: 1,
    ...overrides,
  };
}

describe("BrabrixSkillHubClient", () => {
  it("searches and normalizes skills", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({
        data: {
          skills: [
            {
              id: "skill-1",
              slug: "backend-standards",
              name: "Backend Standards",
              summary: "Rules for backend teams",
              category: "backend",
              tags: ["typescript", "api"],
              featured: true,
              markdown: "# Backend Standards",
              prompts: ["Always write tests."],
              rules: ["No breaking contracts."],
            },
          ],
        },
        total: 1,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const client = new BrabrixSkillHubClient(baseConfig(), fetchMock);
    const result = await client.searchSkills({ query: "backend", tags: ["api"] });

    expect(result.total).toBe(1);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]).toMatchObject({
      id: "skill-1",
      slug: "backend-standards",
      name: "Backend Standards",
      category: "backend",
      featured: true,
      tags: ["typescript", "api"],
    });
    expect(result.skills[0]?.contentBlocks.length).toBeGreaterThan(0);
  });

  it("loads skill categories and featured skills", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({
          categories: [
            { key: "backend", label: "Backend" },
            { key: "qa", label: "Quality Assurance" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({
          skills: [
            {
              id: "skill-2",
              slug: "qa-checklist",
              name: "QA Checklist",
              featured: true,
              markdown: "# QA Checklist",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ));

    const client = new BrabrixSkillHubClient(baseConfig(), fetchMock);
    const categories = await client.getSkillCategories();
    const featured = await client.getFeaturedSkills();

    expect(categories).toEqual([
      { key: "backend", label: "Backend", description: null },
      { key: "qa", label: "Quality Assurance", description: null },
    ]);
    expect(featured).toHaveLength(1);
    expect(featured[0]?.slug).toBe("qa-checklist");
  });

  it("retries retryable errors", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ categories: [{ key: "frontend", label: "Frontend" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ));

    const client = new BrabrixSkillHubClient(baseConfig({ maxRetries: 1, retryDelayMs: 1 }), fetchMock);
    const categories = await client.getSkillCategories();

    expect(categories).toEqual([{ key: "frontend", label: "Frontend", description: null }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
