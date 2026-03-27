/**
 * Schema and structure validation tests for the CyberShield AI
 * agentcompanies/v1 company package located at agents/cybershield-ai/.
 *
 * Tests run without a live Paperclip server and validate:
 *   - All required files exist on disk
 *   - Frontmatter has expected top-level keys
 *   - agentcompanies/v1 invariants (no orphan agents, no cycles)
 *   - Consistent secret declarations
 *   - Portable task schedules
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../agents/cybershield-ai");

function readFile(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

function fileExists(relPath: string): boolean {
  return fs.existsSync(path.join(ROOT, relPath));
}

/** Extract flat key: value frontmatter entries. Not a full YAML parser. */
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
  const required = ["COMPANY.md", "README.md", "LICENSE", ".paperclip.yaml"] as const;

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

  it("has slug: cybershield-ai", () => {
    expect(fm.slug).toBe("cybershield-ai");
  });

  it("declares required secret NVD_API_KEY", () => {
    expect(content).toMatch(/- NVD_API_KEY/);
  });

  it("declares required secret SHODAN_API_KEY", () => {
    expect(content).toMatch(/- SHODAN_API_KEY/);
  });

  it("declares optional secrets", () => {
    expect(content).toMatch(/optional:/);
    expect(content).toMatch(/VIRUSTOTAL_API_KEY|JIRA_API_KEY|SLACK_WEBHOOK_URL/);
  });
});

// ---------------------------------------------------------------------------
// 3. All 9 agent AGENTS.md files
// ---------------------------------------------------------------------------

const AGENT_SLUGS = [
  "ceo",
  "ciso",
  "threat-analyst",
  "vulnerability-scanner",
  "incident-responder",
  "compliance-officer",
  "pen-test-engineer",
  "security-awareness-coach",
  "risk-orchestrator",
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

  it("has exactly 9 agent directories", () => {
    const agentsDir = path.join(ROOT, "agents");
    const dirs = fs
      .readdirSync(agentsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    expect(dirs).toHaveLength(9);
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

  const nodes = Object.fromEntries(AGENT_SLUGS.map((s) => [s, loadAgentNode(s)]));

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

  it("CISO reports to ceo", () => {
    expect(nodes["ciso"].reportsTo).toBe("ceo");
  });

  it("threat-analyst, vulnerability-scanner, incident-responder all report to ciso", () => {
    expect(nodes["threat-analyst"].reportsTo).toBe("ciso");
    expect(nodes["vulnerability-scanner"].reportsTo).toBe("ciso");
    expect(nodes["incident-responder"].reportsTo).toBe("ciso");
  });

  it("compliance-officer, pen-test-engineer, security-awareness-coach, risk-orchestrator all report to ceo", () => {
    expect(nodes["compliance-officer"].reportsTo).toBe("ceo");
    expect(nodes["pen-test-engineer"].reportsTo).toBe("ceo");
    expect(nodes["security-awareness-coach"].reportsTo).toBe("ceo");
    expect(nodes["risk-orchestrator"].reportsTo).toBe("ceo");
  });
});

// ---------------------------------------------------------------------------
// 5. Teams
// ---------------------------------------------------------------------------

const TEAM_SLUGS = ["security-operations", "compliance", "red-team"] as const;

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

  it("has exactly 3 team directories", () => {
    const teamsDir = path.join(ROOT, "teams");
    const dirs = fs
      .readdirSync(teamsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    expect(dirs).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 6. Threat and Compliance Platform project + seed tasks
// ---------------------------------------------------------------------------

const SEED_TASKS = [
  "threat-intelligence-setup",
  "vuln-management-pipeline",
  "incident-response-playbooks",
  "soc2-evidence-collection",
  "pen-test-automation",
  "phishing-sim-framework",
  "risk-dashboard",
] as const;

describe("Threat and Compliance Platform project", () => {
  it("PROJECT.md exists", () => {
    expect(fileExists("projects/threat-and-compliance-platform/PROJECT.md")).toBe(true);
  });

  it("PROJECT.md has name and owner", () => {
    const content = readFile("projects/threat-and-compliance-platform/PROJECT.md");
    expect(content).toMatch(/name:/);
    expect(content).toMatch(/owner:/);
  });

  for (const task of SEED_TASKS) {
    const relPath = `projects/threat-and-compliance-platform/tasks/${task}/TASK.md`;

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

    it(`${relPath} has project: threat-and-compliance-platform`, () => {
      const content = readFile(relPath);
      expect(content).toMatch(/project:\s*threat-and-compliance-platform/);
    });
  }
});

// ---------------------------------------------------------------------------
// 7. Recurring tasks — portable
// ---------------------------------------------------------------------------

const RECURRING_TASKS = [
  "daily-threat-brief",
  "weekly-vuln-scan",
  "monthly-compliance-check",
] as const;

describe("Recurring task portability", () => {
  for (const task of RECURRING_TASKS) {
    const relPath = `tasks/${task}/TASK.md`;

    it(`${relPath} exists`, () => {
      expect(fileExists(relPath)).toBe(true);
    });

    it(`${relPath} has recurring: true`, () => {
      const content = readFile(relPath);
      expect(content).toMatch(/recurring:\s*true/);
    });

    it(`${relPath} does NOT contain a concrete startsAt timestamp`, () => {
      const content = readFile(relPath);
      expect(content).not.toMatch(/startsAt:/);
    });

    it(`${relPath} does NOT contain a schedule: block`, () => {
      const content = readFile(relPath);
      expect(content).not.toMatch(/^schedule:/m);
    });
  }

  it("daily-threat-brief is assigned to threat-analyst", () => {
    const content = readFile("tasks/daily-threat-brief/TASK.md");
    expect(content).toMatch(/assignee:\s*threat-analyst/);
  });

  it("weekly-vuln-scan is assigned to vulnerability-scanner", () => {
    const content = readFile("tasks/weekly-vuln-scan/TASK.md");
    expect(content).toMatch(/assignee:\s*vulnerability-scanner/);
  });

  it("monthly-compliance-check is assigned to compliance-officer", () => {
    const content = readFile("tasks/monthly-compliance-check/TASK.md");
    expect(content).toMatch(/assignee:\s*compliance-officer/);
  });
});

// ---------------------------------------------------------------------------
// 8. .paperclip.yaml
// ---------------------------------------------------------------------------

describe(".paperclip.yaml", () => {
  const content = readFile(".paperclip.yaml");

  it("has schema: paperclip/v1", () => {
    expect(content).toMatch(/schema:\s*paperclip\/v1/);
  });

  it("declares heartbeat config for all 9 agents", () => {
    for (const slug of AGENT_SLUGS) {
      expect(content).toMatch(new RegExp(`${slug}:`));
    }
    expect(content.match(/intervalSec:\s*300/g)?.length).toBe(9);
    expect(content.match(/wakeOnDemand:\s*true/g)?.length).toBe(9);
  });

  it("declares NVD_API_KEY as required for vulnerability-scanner", () => {
    expect(content).toMatch(/NVD_API_KEY:/);
    expect(content).toMatch(/requirement:\s*required/);
  });

  it("declares SHODAN_API_KEY as required for threat-analyst", () => {
    expect(content).toMatch(/SHODAN_API_KEY:/);
  });

  it("declares optional secrets for threat and incident agents", () => {
    expect(content).toMatch(/VIRUSTOTAL_API_KEY:/);
    expect(content).toMatch(/SLACK_WEBHOOK_URL:/);
    expect(content).toMatch(/requirement:\s*optional/);
  });

  it("declares all 3 routines", () => {
    expect(content).toMatch(/routines:/);
    expect(content).toMatch(/daily-threat-brief:/);
    expect(content).toMatch(/weekly-vuln-scan:/);
    expect(content).toMatch(/monthly-compliance-check:/);
  });

  it("routines have cron schedules", () => {
    const cronMatches = content.match(/cron:/g);
    expect(cronMatches?.length).toBe(3);
  });

  it("routines use UTC timezone", () => {
    expect(content).toMatch(/timezone:\s*UTC/);
  });
});

// ---------------------------------------------------------------------------
// 9. README.md
// ---------------------------------------------------------------------------

describe("README.md", () => {
  const content = readFile("README.md");

  it("uses the canonical paperclipai/paperclip URL", () => {
    expect(content).toMatch(/github\.com\/paperclipai\/paperclip/);
  });

  it("has Org Chart section", () => {
    expect(content).toMatch(/## Org Chart/);
  });

  it("has Getting Started section", () => {
    expect(content).toMatch(/## Getting Started/);
  });

  it("has Teams section", () => {
    expect(content).toMatch(/## Teams/);
  });

  it("has Projects section", () => {
    expect(content).toMatch(/## Projects/);
  });

  it("has Recurring Tasks section", () => {
    expect(content).toMatch(/## Recurring Tasks/);
  });

  it("documents 48-hour critical CVE SLA", () => {
    expect(content).toMatch(/48.hour|48 hour/);
  });

  it("documents SOC 2 readiness", () => {
    expect(content).toMatch(/SOC 2/);
  });

  it("documents the board approval gate", () => {
    expect(content).toMatch(/[Aa]pproval [Gg]ate|approval gate/);
  });
});

// ---------------------------------------------------------------------------
// 10. Agent-specific content checks
// ---------------------------------------------------------------------------

describe("Agent content checks", () => {
  it("threat-analyst mentions NVD API and Shodan", () => {
    const content = readFile("agents/threat-analyst/AGENTS.md");
    expect(content).toMatch(/NVD/);
    expect(content).toMatch(/Shodan/);
  });

  it("threat-analyst mentions MITRE ATT&CK", () => {
    const content = readFile("agents/threat-analyst/AGENTS.md");
    expect(content).toMatch(/MITRE/);
  });

  it("vulnerability-scanner mentions CVSS and 48-hour SLA", () => {
    const content = readFile("agents/vulnerability-scanner/AGENTS.md");
    expect(content).toMatch(/CVSS/);
    expect(content).toMatch(/48/);
  });

  it("incident-responder mentions runbook", () => {
    const content = readFile("agents/incident-responder/AGENTS.md");
    expect(content).toMatch(/runbook/);
  });

  it("compliance-officer mentions ISO 27001, SOC 2, and GDPR", () => {
    const content = readFile("agents/compliance-officer/AGENTS.md");
    expect(content).toMatch(/ISO 27001/);
    expect(content).toMatch(/SOC 2/);
    expect(content).toMatch(/GDPR/);
  });

  it("pen-test-engineer mentions rules of engagement", () => {
    const content = readFile("agents/pen-test-engineer/AGENTS.md");
    expect(content).toMatch(/[Rr]ules of [Ee]ngagement/);
  });

  it("risk-orchestrator defines risk scoring model", () => {
    const content = readFile("agents/risk-orchestrator/AGENTS.md");
    expect(content).toMatch(/[Rr]isk [Ss]cor/);
  });

  it("ciso defines P1/P2/P3/P4 severity tiers", () => {
    const content = readFile("agents/ciso/AGENTS.md");
    expect(content).toMatch(/P1/);
    expect(content).toMatch(/P2/);
    expect(content).toMatch(/P3/);
    expect(content).toMatch(/P4/);
  });
});
