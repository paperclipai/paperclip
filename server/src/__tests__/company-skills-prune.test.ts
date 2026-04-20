import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companySkills,
  createDb,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Mock the adapter layer so usage() never tries to call real adapters
vi.mock("../adapters/index.js", () => ({
  findActiveServerAdapter: () => null,
}));

// Mock ghFetch so readUrlSkillImports never makes real HTTP calls.
// gitHubApiBase and resolveRawGitHubUrl are pure functions — pass them through.
const mockGhFetch = vi.fn();
vi.mock("../services/github-fetch.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/github-fetch.js")>();
  return {
    ...original,
    ghFetch: (...args: unknown[]) => mockGhFetch(...args),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping company-skills prune tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("scanProjectWorkspaces prune path", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const companyId = randomUUID();
  const agentId = randomUUID();
  const skillKeepId = randomUUID();
  const skillPruneId = randomUUID();
  const projectId = randomUUID();

  const sourceLocator = "https://github.com/test-org/test-skills";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-skills-prune-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    // Seed company
    await db.insert(companies).values({
      id: companyId,
      name: "Test Co",
      issuePrefix: `T${Date.now().toString(36).slice(-4).toUpperCase()}`,
    });

    // Seed project (no workspaces — local scan phase will find nothing)
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Test Project",
    });

    // Seed agent with both skills in desired config
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Builder",
      adapterType: "claude_local",
      adapterConfig: {
        paperclipSkillSync: {
          desiredSkills: [
            `test-org/test-skills/keep-skill`,
            `test-org/test-skills/prune-skill`,
          ],
        },
      },
    });

    // Seed two GitHub-sourced skills from the same repo
    await db.insert(companySkills).values([
      {
        id: skillKeepId,
        companyId,
        key: "test-org/test-skills/keep-skill",
        slug: "keep-skill",
        name: "Keep Skill",
        markdown: "# Keep Skill",
        sourceType: "github",
        sourceLocator,
        sourceRef: "abc123",
        metadata: { sourceKind: "github", owner: "test-org", repo: "test-skills", ref: "abc123", trackingRef: "main" },
      },
      {
        id: skillPruneId,
        companyId,
        key: "test-org/test-skills/prune-skill",
        slug: "prune-skill",
        name: "Prune Skill",
        markdown: "# Prune Skill",
        sourceType: "github",
        sourceLocator,
        sourceRef: "abc123",
        metadata: { sourceKind: "github", owner: "test-org", repo: "test-skills", ref: "abc123", trackingRef: "main" },
      },
    ]);
  });

  afterEach(async () => {
    mockGhFetch.mockReset();
    await db.delete(companySkills).where(eq(companySkills.companyId, companyId));
    await db.delete(projects).where(eq(projects.companyId, companyId));
    await db.delete(agents).where(eq(agents.companyId, companyId));
    await db.delete(companies).where(eq(companies.id, companyId));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * Helper: configure mockGhFetch to simulate a GitHub repo that contains
   * only the specified skill slugs (each with a SKILL.md in its directory).
   */
  function stubGitHubSource(slugs: string[]) {
    const sha = "deadbeef".repeat(5);
    const tree = slugs.map((slug) => ({
      path: `${slug}/SKILL.md`,
      type: "blob",
    }));

    mockGhFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = url;

      // GET /repos/{owner}/{repo} → default branch
      if (u.match(/\/repos\/test-org\/test-skills$/)) {
        return new Response(JSON.stringify({ default_branch: "main" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      // GET /repos/{owner}/{repo}/commits/{ref} → pinned SHA
      if (u.includes("/commits/")) {
        return new Response(JSON.stringify({ sha }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      // GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1 → file tree
      if (u.includes("/git/trees/")) {
        return new Response(JSON.stringify({ tree }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      // GET raw content for SKILL.md files
      if (u.includes("raw.githubusercontent.com") || u.includes("/raw/")) {
        const match = u.match(/\/([^/]+)\/SKILL\.md$/);
        const slug = match?.[1] ?? "unknown";
        const markdown = [
          "---",
          `name: ${slug}`,
          `slug: ${slug}`,
          "---",
          "",
          `# ${slug}`,
          "",
        ].join("\n");
        return new Response(markdown, {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }

      // Default: 404
      return new Response("Not Found", { status: 404 });
    });
  }

  it("prunes a skill removed from the source, detaches it from agents, and emits a warning", async () => {
    // GitHub returns only "keep-skill" — "prune-skill" is no longer in the repo
    stubGitHubSource(["keep-skill"]);

    const { companySkillService } = await import("../services/company-skills.js");
    const svc = companySkillService(db);
    const result = await svc.scanProjectWorkspaces(companyId, {});

    // The pruned skill should be deleted from the database
    const remaining = await db
      .select()
      .from(companySkills)
      .where(eq(companySkills.companyId, companyId));
    const remainingSlugs = remaining.map((row) => row.slug);
    expect(remainingSlugs).toContain("keep-skill");
    expect(remainingSlugs).not.toContain("prune-skill");

    // The agent's desired skills should no longer include the pruned skill key
    const [agentRow] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId));
    const config = agentRow!.adapterConfig as Record<string, unknown>;
    const syncConfig = config.paperclipSkillSync as Record<string, unknown>;
    const desiredSkills = syncConfig.desiredSkills as string[];
    expect(desiredSkills).not.toContain("test-org/test-skills/prune-skill");
    expect(desiredSkills).toContain("test-org/test-skills/keep-skill");

    // A warning should be emitted about the detached skill
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("prune-skill"),
        expect.stringContaining("Builder"),
      ]),
    );
  });

  it("deletes a pruned skill even when no agents reference it", async () => {
    // Remove the prune skill from the agent's desired skills before scanning
    await db.update(agents).set({
      adapterConfig: {
        paperclipSkillSync: {
          desiredSkills: ["test-org/test-skills/keep-skill"],
        },
      },
    }).where(eq(agents.id, agentId));

    stubGitHubSource(["keep-skill"]);

    const { companySkillService } = await import("../services/company-skills.js");
    const svc = companySkillService(db);
    const result = await svc.scanProjectWorkspaces(companyId, {});

    const remaining = await db
      .select()
      .from(companySkills)
      .where(eq(companySkills.companyId, companyId));
    const remainingSlugs = remaining.map((r) => r.slug);
    expect(remainingSlugs).toContain("keep-skill");
    expect(remainingSlugs).not.toContain("prune-skill");

    // A deletion warning should still be emitted (no detachment, but deletion is confirmed)
    const deleteWarnings = result.warnings.filter((w) => w.includes("prune-skill") && w.includes("deleted"));
    expect(deleteWarnings).toHaveLength(1);
    // No agent-detachment warning since no agents used it
    const detachWarnings = result.warnings.filter((w) => w.includes("prune-skill") && w.includes("detached"));
    expect(detachWarnings).toHaveLength(0);
  });

  it("skips pruning when the GitHub tree response is truncated", async () => {
    // Simulate GitHub returning a truncated tree (too many files)
    const sha = "deadbeef".repeat(5);
    mockGhFetch.mockImplementation(async (url: string) => {
      const u = url;
      if (u.match(/\/repos\/test-org\/test-skills$/)) {
        return new Response(JSON.stringify({ default_branch: "main" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.includes("/commits/")) {
        return new Response(JSON.stringify({ sha }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.includes("/git/trees/")) {
        return new Response(
          JSON.stringify({
            tree: [{ path: "keep-skill/SKILL.md", type: "blob" }],
            truncated: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("Not Found", { status: 404 });
    });

    const { companySkillService } = await import("../services/company-skills.js");
    const svc = companySkillService(db);
    const result = await svc.scanProjectWorkspaces(companyId, {});

    // Both seeded skills should still exist — truncated tree must not trigger pruning
    const remaining = await db
      .select()
      .from(companySkills)
      .where(eq(companySkills.companyId, companyId));
    const remainingSlugs = remaining.map((r) => r.slug);
    expect(remainingSlugs).toContain("keep-skill");
    expect(remainingSlugs).toContain("prune-skill");

    // A warning should be emitted for the failed source
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Could not re-scan source"),
      ]),
    );
  });

  it("skips pruning when the source fetch fails and emits a warning", async () => {
    // Simulate GitHub being down
    mockGhFetch.mockRejectedValue(new Error("network error"));

    const { companySkillService } = await import("../services/company-skills.js");
    const svc = companySkillService(db);
    const result = await svc.scanProjectWorkspaces(companyId, {});

    // Both seeded skills should still exist (bundled skills may also be present)
    const remaining = await db
      .select()
      .from(companySkills)
      .where(eq(companySkills.companyId, companyId));
    const remainingSlugs = remaining.map((r) => r.slug);
    expect(remainingSlugs).toContain("keep-skill");
    expect(remainingSlugs).toContain("prune-skill");

    // A warning should mention the failed source
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Could not re-scan source"),
      ]),
    );
  });
});
