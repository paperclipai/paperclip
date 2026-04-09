import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ensureWikiDir,
  getWikiForRun,
  applyWikiUpdates,
  listPages,
  readPage,
  writePage,
  deletePage,
} from "../services/agent-wiki.js";

import { vi } from "vitest";

let tmpDir: string;

vi.mock("../home-paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../home-paths.js")>();
  return {
    ...actual,
    resolveAgentWikiDir: (agentId: string) => path.join(tmpDir, agentId, "wiki"),
  };
});

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("ensureWikiDir", () => {
  it("creates wiki folder with seed files", async () => {
    const wikiDir = await ensureWikiDir("agent-1");
    expect(wikiDir).toContain("agent-1/wiki");

    const index = await fs.readFile(path.join(wikiDir, "index.md"), "utf-8");
    expect(index).toBe("# Wiki Index\n");

    const learnings = await fs.readFile(path.join(wikiDir, "learnings.md"), "utf-8");
    expect(learnings).toBe("# Learnings\n");
  });

  it("does not overwrite existing files", async () => {
    const wikiDir = await ensureWikiDir("agent-1");
    await fs.writeFile(path.join(wikiDir, "index.md"), "# Custom Index\n", "utf-8");

    await ensureWikiDir("agent-1");
    const index = await fs.readFile(path.join(wikiDir, "index.md"), "utf-8");
    expect(index).toBe("# Custom Index\n");
  });
});

describe("getWikiForRun", () => {
  it("reads the 3 context files", async () => {
    await ensureWikiDir("agent-2");
    const bundle = await getWikiForRun("agent-2", null);
    expect(bundle.indexPage).toBe("# Wiki Index\n");
    expect(bundle.learningsPage).toBe("# Learnings\n");
    expect(bundle.projectPage).toBeNull();
    expect(bundle.projectSlug).toBeNull();
  });

  it("reads project page when slug provided", async () => {
    const wikiDir = await ensureWikiDir("agent-3");
    const projDir = path.join(wikiDir, "projects");
    await fs.mkdir(projDir, { recursive: true });
    await fs.writeFile(path.join(projDir, "my-project.md"), "# My Project\n", "utf-8");

    const bundle = await getWikiForRun("agent-3", "my-project");
    expect(bundle.projectPage).toBe("# My Project\n");
    expect(bundle.projectSlug).toBe("my-project");
  });

  it("returns null project page when file missing", async () => {
    await ensureWikiDir("agent-4");
    const bundle = await getWikiForRun("agent-4", "nonexistent");
    expect(bundle.projectPage).toBeNull();
  });
});

describe("applyWikiUpdates", () => {
  it("upserts files and rebuilds index", async () => {
    await ensureWikiDir("agent-5");
    await applyWikiUpdates("agent-5", [
      { action: "upsert", path: "learnings.md", content: "# Updated Learnings\nSome content" },
      { action: "upsert", path: "topics/kafka.md", content: "# Kafka Patterns\nContent here" },
    ]);

    const learnings = await readPage("agent-5", "learnings.md");
    expect(learnings).toBe("# Updated Learnings\nSome content");

    const kafka = await readPage("agent-5", "topics/kafka.md");
    expect(kafka).toBe("# Kafka Patterns\nContent here");

    const index = await readPage("agent-5", "index.md");
    expect(index).toContain("[Updated Learnings](learnings.md)");
    expect(index).toContain("[Kafka Patterns](topics/kafka.md)");
  });

  it("deletes files", async () => {
    await ensureWikiDir("agent-6");
    await applyWikiUpdates("agent-6", [
      { action: "upsert", path: "topics/temp.md", content: "# Temp" },
    ]);
    expect(await readPage("agent-6", "topics/temp.md")).toBe("# Temp");

    await applyWikiUpdates("agent-6", [
      { action: "delete", path: "topics/temp.md" },
    ]);
    expect(await readPage("agent-6", "topics/temp.md")).toBeNull();
  });
});

describe("path traversal prevention", () => {
  it("rejects paths with .. via writePage", async () => {
    await ensureWikiDir("agent-traversal");
    await expect(writePage("agent-traversal", "../../../etc/passwd", "bad")).rejects.toThrow();
  });

  it("rejects non-md paths via writePage", async () => {
    await ensureWikiDir("agent-traversal");
    await expect(writePage("agent-traversal", "evil.sh", "bad")).rejects.toThrow();
  });
});

describe("listPages", () => {
  it("lists all markdown files", async () => {
    await ensureWikiDir("agent-7");
    await applyWikiUpdates("agent-7", [
      { action: "upsert", path: "topics/a.md", content: "# Topic A" },
      { action: "upsert", path: "projects/b.md", content: "# Project B" },
    ]);

    const pages = await listPages("agent-7");
    const paths = pages.map((p) => p.path);
    expect(paths).toContain("index.md");
    expect(paths).toContain("learnings.md");
    expect(paths).toContain("topics/a.md");
    expect(paths).toContain("projects/b.md");
  });
});

// ---------------------------------------------------------------------------
// Post-run simulation: resultJson → parseWikiUpdates → applyWikiUpdates
// → getWikiForRun on next run sees the changes
// ---------------------------------------------------------------------------

describe("post-run wiki modification flow", () => {
  const AGENT = "agent-postrun";

  it("wiki updates via writePage are visible in next run", async () => {
    // ── Run 1: first run, wiki is empty seed ──
    const bundle1 = await getWikiForRun(AGENT, "payment-service");
    expect(bundle1.learningsPage).toBe("# Learnings\n");
    expect(bundle1.projectPage).toBeNull();

    // Simulate wiki synthesis writing pages via MCP tools (writePage)
    await writePage(AGENT, "learnings.md",
      "# Learnings\n\n- Always set HTTP timeout to 30s for payment gateway calls\n- Retry with exponential backoff on 503\n");
    await writePage(AGENT, "projects/payment-service.md",
      "# Payment Service\n\n## Architecture\n- Uses Stripe API v2023-10\n- Gateway timeout: 30s\n\n## Known Issues\n- Occasional 503 from Stripe during peak hours\n");
    await writePage(AGENT, "topics/stripe-integration.md",
      "# Stripe Integration\n\n## API Version\nv2023-10\n\n## Error Handling\n- 503: retry with backoff\n- 429: respect Retry-After header\n");

    // ── Run 2: next run should see all updated wiki content ──
    const bundle2 = await getWikiForRun(AGENT, "payment-service");

    expect(bundle2.learningsPage).toContain("Always set HTTP timeout to 30s");
    expect(bundle2.learningsPage).toContain("exponential backoff");

    expect(bundle2.projectPage).not.toBeNull();
    expect(bundle2.projectPage).toContain("Stripe API v2023-10");
    expect(bundle2.projectPage).toContain("Gateway timeout: 30s");

    // Index should reflect all pages
    expect(bundle2.indexPage).toContain("learnings.md");
    expect(bundle2.indexPage).toContain("projects/payment-service.md");
    expect(bundle2.indexPage).toContain("topics/stripe-integration.md");

    // Topic page readable via readPage (simulating MCP tool call)
    const stripePage = await readPage(AGENT, "topics/stripe-integration.md");
    expect(stripePage).toContain("Retry-After header");
  });

  it("agent accumulates knowledge across multiple runs", async () => {
    // ── Run 1: agent learns about deployment (via writePage, simulating MCP tool) ──
    await getWikiForRun(AGENT, null);
    await writePage(AGENT, "learnings.md", "# Learnings\n\n- Deploy via `make deploy-prod`\n");
    await writePage(AGENT, "topics/deployment.md", "# Deployment\n\n## Production\n- Run `make deploy-prod`\n- Requires VPN access\n");

    // ── Run 2: agent learns more, updates learnings and adds new topic ──
    const bundle2 = await getWikiForRun(AGENT, null);
    expect(bundle2.learningsPage).toContain("make deploy-prod");

    await writePage(AGENT, "learnings.md",
      "# Learnings\n\n- Deploy via `make deploy-prod`\n- DB migrations must run before deploy\n- Always check Grafana after deploy\n");
    await writePage(AGENT, "topics/monitoring.md",
      "# Monitoring\n\n## Grafana\n- Dashboard: grafana.internal/d/api-latency\n- Check p99 after every deploy\n");

    // ── Run 3: verify accumulated knowledge ──
    const bundle3 = await getWikiForRun(AGENT, null);

    // Learnings should have content from both runs
    expect(bundle3.learningsPage).toContain("make deploy-prod");
    expect(bundle3.learningsPage).toContain("DB migrations must run before deploy");
    expect(bundle3.learningsPage).toContain("check Grafana after deploy");

    // Index should list both topic pages
    expect(bundle3.indexPage).toContain("topics/deployment.md");
    expect(bundle3.indexPage).toContain("topics/monitoring.md");

    // Both topics should be readable
    expect(await readPage(AGENT, "topics/deployment.md")).toContain("Requires VPN access");
    expect(await readPage(AGENT, "topics/monitoring.md")).toContain("p99 after every deploy");
  });

  it("agent can delete outdated wiki pages post-run", async () => {
    await getWikiForRun(AGENT, null);

    // Run 1: create two topic pages via writePage
    await writePage(AGENT, "topics/old-api.md", "# Old API\nDeprecated v1 API notes");
    await writePage(AGENT, "topics/new-api.md", "# New API\nv2 API notes");

    expect(await readPage(AGENT, "topics/old-api.md")).toContain("Deprecated v1");
    expect(await readPage(AGENT, "topics/new-api.md")).toContain("v2 API");

    // Run 2: agent decides to clean up old page and update the other
    await deletePage(AGENT, "topics/old-api.md");
    await writePage(AGENT, "topics/new-api.md", "# New API\nv2 API notes\n\n## Migration\n- All v1 endpoints removed\n");

    // Old page gone
    expect(await readPage(AGENT, "topics/old-api.md")).toBeNull();

    // New page updated
    expect(await readPage(AGENT, "topics/new-api.md")).toContain("All v1 endpoints removed");

    // Index no longer lists old page
    const bundle = await getWikiForRun(AGENT, null);
    expect(bundle.indexPage).not.toContain("topics/old-api.md");
    expect(bundle.indexPage).toContain("topics/new-api.md");
  });

  it("agent creates project page that appears in next project-scoped run", async () => {
    // Run 1: working on auth-service, no project page yet
    const bundle1 = await getWikiForRun(AGENT, "auth-service");
    expect(bundle1.projectSlug).toBe("auth-service");
    expect(bundle1.projectPage).toBeNull();

    // Agent creates the project page via writePage
    await writePage(AGENT, "projects/auth-service.md",
      "# Auth Service\n\n## Stack\n- JWT tokens with RS256\n- Redis session store\n");

    // Run 2: same project — now sees the page
    const bundle2 = await getWikiForRun(AGENT, "auth-service");
    expect(bundle2.projectPage).toContain("JWT tokens with RS256");
    expect(bundle2.projectPage).toContain("Redis session store");

    // Run 3: different project — does not see auth-service page
    const bundle3 = await getWikiForRun(AGENT, "billing-service");
    expect(bundle3.projectPage).toBeNull();
    expect(bundle3.projectSlug).toBe("billing-service");

    // But index still lists it
    expect(bundle3.indexPage).toContain("projects/auth-service.md");
  });

  it("handles no wiki changes gracefully", async () => {
    await ensureWikiDir(AGENT);

    // apply empty — should not throw
    await applyWikiUpdates(AGENT, []);

    // Wiki should still be in seed state
    const bundle = await getWikiForRun(AGENT, null);
    expect(bundle.learningsPage).toContain("# Learnings");
  });

  it("index is correctly rebuilt with grouped sections after agent updates", async () => {
    await ensureWikiDir(AGENT);

    await writePage(AGENT, "learnings.md", "# Key Learnings\nImportant stuff");
    await writePage(AGENT, "projects/alpha.md", "# Alpha Project");
    await writePage(AGENT, "projects/beta.md", "# Beta Project");
    await writePage(AGENT, "topics/testing.md", "# Testing Strategy");
    await writePage(AGENT, "topics/ci-cd.md", "# CI/CD Pipeline");

    const bundle = await getWikiForRun(AGENT, "alpha");
    const index = bundle.indexPage;

    // Should have grouped sections
    expect(index).toContain("## Root");
    expect(index).toContain("## Projects");
    expect(index).toContain("## Topics");

    // Should have links with extracted titles
    expect(index).toContain("[Key Learnings](learnings.md)");
    expect(index).toContain("[Alpha Project](projects/alpha.md)");
    expect(index).toContain("[Beta Project](projects/beta.md)");
    expect(index).toContain("[Testing Strategy](topics/testing.md)");
    expect(index).toContain("[CI/CD Pipeline](topics/ci-cd.md)");
  });
});

describe("writePage and deletePage", () => {
  it("writes and deletes pages", async () => {
    await ensureWikiDir("agent-8");
    await writePage("agent-8", "topics/new.md", "# New Topic");
    expect(await readPage("agent-8", "topics/new.md")).toBe("# New Topic");

    const deleted = await deletePage("agent-8", "topics/new.md");
    expect(deleted).toBe(true);
    expect(await readPage("agent-8", "topics/new.md")).toBeNull();
  });

  it("returns false when deleting nonexistent page", async () => {
    await ensureWikiDir("agent-9");
    const deleted = await deletePage("agent-9", "topics/nope.md");
    expect(deleted).toBe(false);
  });
});
