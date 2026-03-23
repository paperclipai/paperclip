/**
 * gstack Agent Import — Garry Tan's Engineering Excellence Framework
 *
 * Creates 10 specialized agents based on gstack roles:
 * Strategist → Eng Manager → Code Reviewer, QA, Release, Documenter, Debugger
 *                           → Design Lead, Retro Lead, Safety Officer
 *
 * Run: npx tsx packages/db/src/seed-gstack-agents.ts
 */

import { createDb } from "./client.js";
import { agents } from "./schema/index.js";
import { eq, and } from "drizzle-orm";

const url = process.env.DATABASE_URL!;
if (!url) throw new Error("DATABASE_URL is required");
const db = createDb(url);

const COMPANY_ID = "e4f86ad5-bcdd-4ac9-9972-11ed5f6c7820"; // EVOHAUS AI

interface GstackAgent {
  name: string;
  role: "ceo" | "cto" | "designer" | "engineer" | "qa" | "devops" | "researcher" | "pm";
  title: string;
  icon: string;
  capabilities: string;
  adapterType: "claude_local" | "codex_local" | "gemini_local";
  parentName: string | null; // name of parent agent (resolved to ID later)
  gstackSkills: string[];
  description: string;
}

const GSTACK_AGENTS: GstackAgent[] = [
  // === TIER 1: STRATEGIC (Opus) ===
  {
    name: "gstack-stratejist",
    role: "ceo",
    title: "Product Strategist",
    icon: "brain",
    capabilities: "product-strategy,scope-decisions,yc-forcing-questions",
    adapterType: "claude_local",
    parentName: null,
    gstackSkills: ["office-hours", "plan-ceo-review"],
    description: "YC-style product strategy: demand validation, scope decisions, 10-star product thinking. Uses /office-hours for ideation and /plan-ceo-review for strategic rethink.",
  },

  // === TIER 2: OPERATIONAL (Opus/Sonnet) ===
  {
    name: "gstack-eng-manager",
    role: "cto",
    title: "Engineering Manager",
    icon: "cpu",
    capabilities: "architecture,data-flow,test-coverage,technical-planning",
    adapterType: "claude_local",
    parentName: "gstack-stratejist",
    gstackSkills: ["plan-eng-review"],
    description: "Locks architecture decisions: data models, API contracts, error handling, observability. Interactive walkthrough with opinionated recommendations.",
  },
  {
    name: "gstack-design-lead",
    role: "designer",
    title: "Design Lead",
    icon: "eye",
    capabilities: "ui-ux-review,design-system,visual-qa,accessibility",
    adapterType: "claude_local",
    parentName: "gstack-stratejist",
    gstackSkills: ["plan-design-review", "design-review", "design-consultation"],
    description: "Rates design dimensions 0-10, explains what makes it a 10, fixes to reach it. Both plan-phase review and live site visual QA.",
  },
  {
    name: "gstack-code-reviewer",
    role: "engineer",
    title: "Code Reviewer",
    icon: "search",
    capabilities: "pr-review,sql-safety,race-conditions,security-audit",
    adapterType: "claude_local",
    parentName: "gstack-eng-manager",
    gstackSkills: ["review"],
    description: "Pre-landing PR review: SQL safety, LLM trust boundary violations, conditional side effects. Two-pass system: critical then informational.",
  },
  {
    name: "gstack-qa-engineer",
    role: "qa",
    title: "QA Engineer",
    icon: "shield",
    capabilities: "browser-testing,bug-fixing,health-score,regression-tests",
    adapterType: "claude_local",
    parentName: "gstack-eng-manager",
    gstackSkills: ["qa", "qa-only", "browse", "setup-browser-cookies"],
    description: "Systematically tests web apps via headless Chromium (~100ms/command). Three tiers: Quick/Standard/Exhaustive. Fixes bugs atomically with screenshot evidence.",
  },
  {
    name: "gstack-release-engineer",
    role: "devops",
    title: "Release Engineer",
    icon: "rocket",
    capabilities: "version-bump,changelog,pr-creation,deploy,canary",
    adapterType: "claude_local",
    parentName: "gstack-eng-manager",
    gstackSkills: ["ship", "land-and-deploy", "canary"],
    description: "One-command ship: tests → review → version bump → changelog → PR. Then merge → deploy → canary verification with rollback option.",
  },
  {
    name: "gstack-documenter",
    role: "researcher",
    title: "Technical Documenter",
    icon: "code",
    capabilities: "documentation-sync,changelog,readme-update,architecture-docs",
    adapterType: "claude_local",
    parentName: "gstack-eng-manager",
    gstackSkills: ["document-release"],
    description: "Post-ship documentation sync: README, ARCHITECTURE, CONTRIBUTING, CLAUDE.md updates. Polishes CHANGELOG voice, cleans up TODOs.",
  },
  {
    name: "gstack-debugger",
    role: "engineer",
    title: "Root Cause Debugger",
    icon: "wrench",
    capabilities: "root-cause-analysis,regression-testing,systematic-debugging",
    adapterType: "claude_local",
    parentName: "gstack-eng-manager",
    gstackSkills: ["investigate"],
    description: "Iron Law: NO FIXES WITHOUT ROOT CAUSE. Four phases: investigate → analyze → hypothesize → implement. Scope-locked to affected modules.",
  },

  // === TIER 3: SUPPORT ===
  {
    name: "gstack-retro-lead",
    role: "pm",
    title: "Retrospective Lead",
    icon: "zap",
    capabilities: "retrospective,metrics,trend-analysis,team-health",
    adapterType: "claude_local",
    parentName: "gstack-stratejist",
    gstackSkills: ["retro", "benchmark"],
    description: "Weekly engineering retrospective: commit history analysis, per-contributor breakdown, hotspot detection, test coverage ratio, focus score, shipping velocity.",
  },
  {
    name: "gstack-safety-officer",
    role: "devops",
    title: "Safety Officer",
    icon: "shield",
    capabilities: "destructive-command-guard,scope-restriction,safety-gates",
    adapterType: "claude_local",
    parentName: "gstack-stratejist",
    gstackSkills: ["careful", "freeze", "guard", "unfreeze"],
    description: "Safety guardrails: warns before rm -rf, DROP TABLE, force-push, kubectl delete. /freeze locks edits to specific directories. /guard combines both.",
  },
];

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

console.log("Seeding gstack agents...");

// Check if already seeded
const existing = await db
  .select()
  .from(agents)
  .where(and(eq(agents.companyId, COMPANY_ID), eq(agents.name, "gstack-stratejist")));

if (existing.length > 0) {
  console.log("gstack agents already seeded. Skipping.");
  process.exit(0);
}

// Phase 1: Insert root agent (no parent)
const rootAgents = GSTACK_AGENTS.filter((a) => a.parentName === null);
const insertedMap = new Map<string, string>(); // name → id

for (const agent of rootAgents) {
  const [inserted] = await db
    .insert(agents)
    .values({
      companyId: COMPANY_ID,
      name: agent.name,
      role: agent.role,
      title: agent.title,
      icon: agent.icon,
      capabilities: agent.capabilities,
      status: "idle",
      adapterType: agent.adapterType,
      adapterConfig: {},
      runtimeConfig: {},
      budgetMonthlyCents: 5000,
      metadata: {
        level: "gstack",
        division: "engineering-excellence",
        gstackSkills: agent.gstackSkills,
        description: agent.description,
        source: "garrytan/gstack",
        ethos: "boil-the-lake",
      },
    })
    .returning();
  insertedMap.set(agent.name, inserted!.id);
  console.log(`  ✓ ${agent.name} (${agent.role}) — root`);
}

// Phase 2: Insert child agents (with parent)
const childAgents = GSTACK_AGENTS.filter((a) => a.parentName !== null);

for (const agent of childAgents) {
  const parentId = insertedMap.get(agent.parentName!);
  if (!parentId) {
    // Parent might be in this batch — insert parent first if needed
    const parentAgent = GSTACK_AGENTS.find((a) => a.name === agent.parentName);
    if (parentAgent && !insertedMap.has(parentAgent.name)) {
      const parentParentId = parentAgent.parentName
        ? insertedMap.get(parentAgent.parentName)
        : null;
      const [insertedParent] = await db
        .insert(agents)
        .values({
          companyId: COMPANY_ID,
          name: parentAgent.name,
          role: parentAgent.role,
          title: parentAgent.title,
          icon: parentAgent.icon,
          capabilities: parentAgent.capabilities,
          status: "idle",
          reportsTo: parentParentId ?? undefined,
          adapterType: parentAgent.adapterType,
          adapterConfig: {},
          runtimeConfig: {},
          budgetMonthlyCents: 5000,
          metadata: {
            level: "gstack",
            division: "engineering-excellence",
            gstackSkills: parentAgent.gstackSkills,
            description: parentAgent.description,
            source: "garrytan/gstack",
            ethos: "boil-the-lake",
          },
        })
        .returning();
      insertedMap.set(parentAgent.name, insertedParent!.id);
      console.log(`  ✓ ${parentAgent.name} (${parentAgent.role})`);
    }
  }

  const resolvedParentId = insertedMap.get(agent.parentName!);
  const [inserted] = await db
    .insert(agents)
    .values({
      companyId: COMPANY_ID,
      name: agent.name,
      role: agent.role,
      title: agent.title,
      icon: agent.icon,
      capabilities: agent.capabilities,
      status: "idle",
      reportsTo: resolvedParentId ?? undefined,
      adapterType: agent.adapterType,
      adapterConfig: {},
      runtimeConfig: {},
      budgetMonthlyCents: 3000,
      metadata: {
        level: "gstack",
        division: "engineering-excellence",
        gstackSkills: agent.gstackSkills,
        description: agent.description,
        source: "garrytan/gstack",
        ethos: "boil-the-lake",
      },
    })
    .returning();
  insertedMap.set(agent.name, inserted!.id);
  console.log(`  ✓ ${agent.name} (${agent.role}) → ${agent.parentName}`);
}

console.log(`\ngstack seed complete: ${insertedMap.size} agents created`);
console.log("\nHierarchy:");
console.log("  gstack-stratejist (CEO)");
console.log("  ├── gstack-eng-manager (CTO)");
console.log("  │   ├── gstack-code-reviewer (Engineer)");
console.log("  │   ├── gstack-qa-engineer (QA)");
console.log("  │   ├── gstack-release-engineer (DevOps)");
console.log("  │   ├── gstack-documenter (Researcher)");
console.log("  │   └── gstack-debugger (Engineer)");
console.log("  ├── gstack-design-lead (Designer)");
console.log("  ├── gstack-retro-lead (PM)");
console.log("  └── gstack-safety-officer (DevOps)");

process.exit(0);
