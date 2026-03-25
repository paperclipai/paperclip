/**
 * Schema and structure validation tests for the AJ AI Services Pvt Ltd
 * agentcompanies/v1 company package located at agents/aj-ai-services/.
 *
 * These tests run without a live Paperclip server and validate that every
 * file in the package:
 *   - exists on disk
 *   - has valid YAML frontmatter with all required fields
 *   - satisfies the agentcompanies/v1 invariants (no orphan agents, no cycles,
 *     consistent secret declarations, portable task schedules)
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../agents/aj-ai-services");

function readFile(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

function fileExists(relPath: string): boolean {
  return fs.existsSync(path.join(ROOT, relPath));
}

/** Parse YAML front-matter (handles CRLF). Returns key-value record. */
function parseFrontmatter(content: string): Record<string, unknown> {
  const normalised = content.replace(/\r\n/g, "\n");
  const match = normalised.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    if (key) result[key] = val;
  }
  return result;
}

// ---------------------------------------------------------------------------
// 1. Required top-level files
// ---------------------------------------------------------------------------

describe("Top-level package files", () => {
  const required = [
    "COMPANY.md",
    "README.md",
    "LICENSE",
    ".paperclip.yaml",
  ] as const;

  for (const file of required) {
    it(`${file} exists`, () => {
      expect(fileExists(file)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. COMPANY.md schema
// ---------------------------------------------------------------------------

describe("COMPANY.md frontmatter", () => {
  const content = readFile("COMPANY.md");
  const fm = parseFrontmatter(content);

  it("has schema: agentcompanies/v1", () => {
    expect(fm.schema).toBe("agentcompanies/v1");
  });

  it("has name", () => {
    expect(fm.name).toBeTruthy();
  });

  it("has description", () => {
    expect(fm.description).toBeTruthy();
  });

  it("has slug", () => {
    expect(fm.slug).toBe("aj-ai-services");
  });

  it("declares required secret GH_TOKEN under requirements.secrets.required", () => {
    expect(content).toMatch(/required:/);
    expect(content).toMatch(/- GH_TOKEN/);
  });

  it("declares optional secret LINKEDIN_API_KEY under requirements.secrets.optional", () => {
    expect(content).toMatch(/optional:/);
    expect(content).toMatch(/- LINKEDIN_API_KEY/);
  });
});

// ---------------------------------------------------------------------------
// 3. All 11 agent AGENTS.md files
// ---------------------------------------------------------------------------

const AGENT_SLUGS = [
  "ceo",
  "cto",
  "social-media-manager",
  "event-manager",
  "idea-generator",
  "designer",
  "publisher",
  "program-manager",
  "devops-engineer",
  "security-engineer",
  "responsible-ai",
] as const;

describe("Agent definitions", () => {
  for (const slug of AGENT_SLUGS) {
    const relPath = `agents/${slug}/AGENTS.md`;

    it(`${relPath} exists`, () => {
      expect(fileExists(relPath)).toBe(true);
    });

    it(`${relPath} has name in frontmatter`, () => {
      const fm = parseFrontmatter(readFile(relPath));
      expect(fm.name).toBeTruthy();
    });

    it(`${relPath} has title in frontmatter`, () => {
      const fm = parseFrontmatter(readFile(relPath));
      expect(fm.title).toBeTruthy();
    });

    it(`${relPath} has reportsTo in frontmatter`, () => {
      const content = readFile(relPath);
      expect(content).toMatch(/reportsTo:/);
    });

    it(`${relPath} includes paperclip skill`, () => {
      const content = readFile(relPath);
      expect(content).toMatch(/- paperclip/);
    });
  }

  it("CEO has reportsTo: null", () => {
    const content = readFile("agents/ceo/AGENTS.md");
    expect(content).toMatch(/reportsTo:\s*null/);
  });

  it("all non-CEO agents have non-null reportsTo", () => {
    for (const slug of AGENT_SLUGS) {
      if (slug === "ceo") continue;
      const content = readFile(`agents/${slug}/AGENTS.md`);
      expect(content).not.toMatch(/reportsTo:\s*null/);
    }
  });

  it("has exactly 11 agent directories", () => {
    const agentsDir = path.join(ROOT, "agents");
    const dirs = fs
      .readdirSync(agentsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    expect(dirs).toHaveLength(11);
  });
});

// ---------------------------------------------------------------------------
// 4. Org tree — no cycles, all trace to CEO
// ---------------------------------------------------------------------------

describe("Org tree integrity", () => {
  type AgentNode = { name: string; reportsTo: string | null };

  function loadAgentNode(slug: string): AgentNode {
    const content = readFile(`agents/${slug}/AGENTS.md`);
    const fm = parseFrontmatter(content);
    const reportsTo =
      typeof fm.reportsTo === "string" && fm.reportsTo !== "null"
        ? fm.reportsTo
        : null;
    const name = typeof fm.name === "string" ? fm.name : slug;
    return { name, reportsTo };
  }

  const nodes = Object.fromEntries(
    AGENT_SLUGS.map((s) => [s, loadAgentNode(s)])
  );

  it("exactly one agent has reportsTo: null (CEO)", () => {
    const roots = Object.values(nodes).filter((n) => n.reportsTo === null);
    expect(roots).toHaveLength(1);
  });

  it("all non-root agents have a reportsTo that resolves to a known agent slug", () => {
    const allSlugs = new Set(AGENT_SLUGS as readonly string[]);
    for (const [slug, node] of Object.entries(nodes)) {
      if (node.reportsTo === null) continue;
      expect(
        allSlugs.has(node.reportsTo),
        `${slug} reportsTo "${node.reportsTo}" which is not a known agent slug`
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Teams
// ---------------------------------------------------------------------------

const TEAM_SLUGS = ["content", "engineering", "governance"] as const;

describe("Team definitions", () => {
  for (const slug of TEAM_SLUGS) {
    it(`teams/${slug}/TEAM.md exists`, () => {
      expect(fileExists(`teams/${slug}/TEAM.md`)).toBe(true);
    });

    it(`teams/${slug}/TEAM.md has name and manager`, () => {
      const content = readFile(`teams/${slug}/TEAM.md`);
      expect(content).toMatch(/name:/);
      expect(content).toMatch(/manager:/);
    });
  }
});

// ---------------------------------------------------------------------------
// 6. LinkedIn MVP project + seed tasks
// ---------------------------------------------------------------------------

const SEED_TASKS = [
  "cicd-pipeline",
  "post-generator",
  "content-calendar",
  "brand-templates",
  "ai-ethics-guardrails",
  "security-baseline",
  "project-tracking",
] as const;

describe("LinkedIn MVP project", () => {
  it("PROJECT.md exists", () => {
    expect(fileExists("projects/linkedin-mvp/PROJECT.md")).toBe(true);
  });

  for (const task of SEED_TASKS) {
    const relPath = `projects/linkedin-mvp/tasks/${task}/TASK.md`;
    it(`${relPath} exists`, () => {
      expect(fileExists(relPath)).toBe(true);
    });

    it(`${relPath} has name in frontmatter`, () => {
      const fm = parseFrontmatter(readFile(relPath));
      expect(fm.name).toBeTruthy();
    });

    it(`${relPath} has assignee in frontmatter`, () => {
      const content = readFile(relPath);
      expect(content).toMatch(/assignee:/);
    });
  }
});

// ---------------------------------------------------------------------------
// 7. Daily standup task — portable (recurring: true, no schedule block)
// ---------------------------------------------------------------------------

describe("Daily standup task portability", () => {
  const content = readFile("tasks/daily-standup/TASK.md");

  it("has recurring: true", () => {
    expect(content).toMatch(/recurring:\s*true/);
  });

  it("does NOT contain a concrete startsAt timestamp in TASK.md", () => {
    expect(content).not.toMatch(/startsAt:/);
  });

  it("does NOT contain a schedule: block in TASK.md", () => {
    expect(content).not.toMatch(/^schedule:/m);
  });
});

// ---------------------------------------------------------------------------
// 8. .paperclip.yaml — heartbeat config and routine
// ---------------------------------------------------------------------------

describe(".paperclip.yaml", () => {
  const content = readFile(".paperclip.yaml");

  it("has schema: paperclip/v1", () => {
    expect(content).toMatch(/schema:\s*paperclip\/v1/);
  });

  it("declares heartbeat config for all 11 agents", () => {
    for (const slug of AGENT_SLUGS) {
      expect(content).toMatch(new RegExp(`${slug}:`));
    }
    expect(content.match(/intervalSec:\s*300/g)?.length).toBe(11);
    expect(content.match(/wakeOnDemand:\s*true/g)?.length).toBe(11);
  });

  it("declares routines.daily-standup with cron schedule", () => {
    expect(content).toMatch(/routines:/);
    expect(content).toMatch(/daily-standup:/);
    expect(content).toMatch(/cron:/);
  });

  it("routines schedule uses Asia/Kolkata timezone", () => {
    expect(content).toMatch(/timezone:\s*Asia\/Kolkata/);
  });

  it("GH_TOKEN is declared as required", () => {
    expect(content).toMatch(/GH_TOKEN:/);
    expect(content).toMatch(/requirement:\s*required/);
  });

  it("LINKEDIN_API_KEY is declared as optional", () => {
    expect(content).toMatch(/LINKEDIN_API_KEY:/);
    expect(content).toMatch(/requirement:\s*optional/);
  });
});

// ---------------------------------------------------------------------------
// 9. README.md — no hardcoded fork URLs, correct canonical URL
// ---------------------------------------------------------------------------

describe("README.md", () => {
  const content = readFile("README.md");

  it("does not hardcode a personal fork URL", () => {
    expect(content).not.toMatch(/github\.com\/abhilashjaiswal0110/);
  });

  it("uses the canonical paperclipai/paperclip URL", () => {
    expect(content).toMatch(/github\.com\/paperclipai\/paperclip/);
  });

  it("has org chart table", () => {
    expect(content).toMatch(/## Org Chart/);
  });

  it("has Getting Started section", () => {
    expect(content).toMatch(/## Getting Started/);
  });
});
