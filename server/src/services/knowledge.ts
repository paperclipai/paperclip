import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import { knowledgePages, knowledgePageRevisions } from "@ironworksai/db";
import { notFound } from "../errors.js";

const MAX_BODY_BYTES = 102_400; // 100KB

function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "page";
}

async function ensureUniqueSlug(db: Db, companyId: string, baseSlug: string, excludeId?: string): Promise<string> {
  let slug = baseSlug;
  let suffix = 2;
  while (true) {
    const conditions = [eq(knowledgePages.companyId, companyId), eq(knowledgePages.slug, slug)];
    if (excludeId) conditions.push(sql`${knowledgePages.id} != ${excludeId}`);
    const [existing] = await db.select({ id: knowledgePages.id }).from(knowledgePages).where(and(...conditions)).limit(1);
    if (!existing) return slug;
    slug = `${baseSlug}-${suffix++}`;
  }
}

export interface KnowledgePageInput {
  title: string;
  body?: string;
  visibility?: "company" | "project" | "private";
  projectId?: string | null;
}

export interface KnowledgePageUpdateInput {
  title?: string;
  body?: string;
  visibility?: "company" | "project" | "private";
  projectId?: string | null;
  changeSummary?: string;
}

export function knowledgeService(db: Db) {
  return {
    async list(companyId: string, opts?: { search?: string; visibility?: string }) {
      const conditions = [eq(knowledgePages.companyId, companyId)];
      if (opts?.visibility && opts.visibility !== "all") {
        conditions.push(eq(knowledgePages.visibility, opts.visibility));
      }
      if (opts?.search?.trim()) {
        const q = `%${opts.search.trim()}%`;
        conditions.push(or(ilike(knowledgePages.title, q), ilike(knowledgePages.body, q))!);
      }
      return db
        .select()
        .from(knowledgePages)
        .where(and(...conditions))
        .orderBy(desc(knowledgePages.updatedAt));
    },

    async getById(id: string) {
      const [page] = await db.select().from(knowledgePages).where(eq(knowledgePages.id, id)).limit(1);
      return page ?? null;
    },

    async getBySlug(companyId: string, slug: string) {
      const [page] = await db
        .select()
        .from(knowledgePages)
        .where(and(eq(knowledgePages.companyId, companyId), eq(knowledgePages.slug, slug)))
        .limit(1);
      return page ?? null;
    },

    async create(companyId: string, input: KnowledgePageInput, actor: { agentId?: string; userId?: string }) {
      const body = input.body ?? "";
      if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
        throw new Error("Page body exceeds 100KB limit");
      }

      const slug = await ensureUniqueSlug(db, companyId, slugify(input.title));

      const [page] = await db
        .insert(knowledgePages)
        .values({
          companyId,
          slug,
          title: input.title.trim(),
          body,
          visibility: input.visibility ?? "company",
          projectId: input.projectId ?? null,
          revisionNumber: 1,
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
        })
        .returning();

      // Create initial revision
      await db.insert(knowledgePageRevisions).values({
        pageId: page.id,
        companyId,
        revisionNumber: 1,
        title: page.title,
        body: page.body,
        changeSummary: "Created page",
        editedByAgentId: actor.agentId ?? null,
        editedByUserId: actor.userId ?? null,
      });

      return page;
    },

    async update(id: string, input: KnowledgePageUpdateInput, actor: { agentId?: string; userId?: string }) {
      const existing = await this.getById(id);
      if (!existing) throw notFound("Knowledge page not found");

      if (input.body !== undefined && Buffer.byteLength(input.body, "utf8") > MAX_BODY_BYTES) {
        throw new Error("Page body exceeds 100KB limit");
      }

      const nextRevision = existing.revisionNumber + 1;
      const nextTitle = input.title?.trim() ?? existing.title;
      const nextBody = input.body ?? existing.body;
      const nextSlug = input.title ? await ensureUniqueSlug(db, existing.companyId, slugify(nextTitle), id) : existing.slug;

      const [updated] = await db
        .update(knowledgePages)
        .set({
          slug: nextSlug,
          title: nextTitle,
          body: nextBody,
          visibility: input.visibility ?? existing.visibility,
          projectId: input.projectId === undefined ? existing.projectId : input.projectId,
          revisionNumber: nextRevision,
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(knowledgePages.id, id))
        .returning();

      // Create revision record
      await db.insert(knowledgePageRevisions).values({
        pageId: id,
        companyId: existing.companyId,
        revisionNumber: nextRevision,
        title: nextTitle,
        body: nextBody,
        changeSummary: input.changeSummary ?? null,
        editedByAgentId: actor.agentId ?? null,
        editedByUserId: actor.userId ?? null,
      });

      return updated;
    },

    async remove(id: string) {
      const existing = await this.getById(id);
      if (!existing) throw notFound("Knowledge page not found");
      await db.delete(knowledgePages).where(eq(knowledgePages.id, id));
      return existing;
    },

    async listRevisions(pageId: string) {
      return db
        .select()
        .from(knowledgePageRevisions)
        .where(eq(knowledgePageRevisions.pageId, pageId))
        .orderBy(desc(knowledgePageRevisions.revisionNumber));
    },

    async getRevision(pageId: string, revisionNumber: number) {
      const [rev] = await db
        .select()
        .from(knowledgePageRevisions)
        .where(
          and(
            eq(knowledgePageRevisions.pageId, pageId),
            eq(knowledgePageRevisions.revisionNumber, revisionNumber),
          ),
        )
        .limit(1);
      return rev ?? null;
    },

    async revertToRevision(pageId: string, revisionNumber: number, actor: { agentId?: string; userId?: string }) {
      const revision = await this.getRevision(pageId, revisionNumber);
      if (!revision) throw notFound("Revision not found");
      return this.update(pageId, {
        title: revision.title,
        body: revision.body,
        changeSummary: `Reverted to revision #${revisionNumber}`,
      }, actor);
    },

    /** Seed default KB pages for a new company (idempotent). */
    async seedDefaults(companyId: string): Promise<{ seeded: boolean; count: number }> {
      const [existing] = await db
        .select({ id: knowledgePages.id })
        .from(knowledgePages)
        .where(and(eq(knowledgePages.companyId, companyId), eq(knowledgePages.isSeeded, "true")))
        .limit(1);
      if (existing) return { seeded: false, count: 0 };

      const seeds = [
        {
          title: "Company Operating Manual",
          body: `# Company Operating Manual

This is the single source of truth for how your company operates. Every agent should read this before starting work.

## Decision Authority

| Decision Type | Who Decides | Who Approves |
|---|---|---|
| Strategic direction, goals, budgets | CEO | Board |
| Technical architecture, tool selection | CTO | CEO |
| Hiring, firing, role changes | VP of HR | CEO |
| Marketing strategy, content direction | CMO | CEO |
| Day-to-day task execution | Assigned agent | Their manager |
| Security exceptions | Security Engineer | CTO |

## Communication Standards

1. All work happens through Issues. No work should be done without an associated issue.
2. When blocked, change the issue status to "blocked" and describe the dependency in the description.
3. When done, mark the issue as "done" with a brief summary of what was delivered.
4. If a task will take longer than expected, comment on the issue with a revised estimate.
5. Decisions that affect other agents should be documented in the Knowledge Base, not buried in issue comments.

## Quality Standards

- Code changes require review by the CTO or a senior engineer before deployment.
- Client-facing content requires CEO approval before publication.
- Security-related changes require Security Engineer sign-off.
- All work products should be stored in the Library, not in local files.

## Escalation Path

If something goes wrong or you are unsure how to proceed:
1. Check the Knowledge Base for relevant documentation.
2. Ask your direct manager (check the Org Chart for reporting lines).
3. If your manager is unavailable, escalate to the CEO.
4. For security incidents, go directly to the Security Engineer and CTO simultaneously.`,
        },
        {
          title: "New Agent Onboarding Checklist",
          body: `# New Agent Onboarding Checklist

When a new agent joins the company, the VP of HR is responsible for ensuring they complete this checklist within their first heartbeat cycle.

## Before First Run

- [ ] SOUL.md is written and specific to their role (not generic)
- [ ] AGENTS.md has clear instructions on what they own and how to work
- [ ] Skills are assigned from the company skill pool
- [ ] Reporting line is set (who they report to in the Org Chart)
- [ ] At least one issue is assigned to them so they have work on first heartbeat

## First Week

- [ ] Agent has completed at least one task successfully
- [ ] Output quality has been reviewed by their manager
- [ ] Agent can access the projects they need (check project assignments)
- [ ] Agent knows how to read from the Knowledge Base
- [ ] Cost per task is within expected range for their role

## First Month

- [ ] Agent has a rating of C or above on the Agent Performance page
- [ ] No unresolved blockers or repeated failures
- [ ] Manager has confirmed the agent is productive and well-configured

## If Onboarding Fails

If a new agent cannot complete their first task within 24 hours:
1. Check the run transcript for errors
2. Review SOUL.md and AGENTS.md for unclear instructions
3. Verify the adapter and model configuration are correct
4. Try assigning a simpler task to isolate the problem
5. If nothing works, terminate and recreate the agent with adjusted configuration`,
        },
        {
          title: "Performance Review Process",
          body: `# Performance Review Process

The VP of HR runs performance reviews. Reviews happen weekly (lightweight) and monthly (detailed).

## Weekly Review (every Monday)

1. Open the Agent Performance page.
2. Check each agent's rating. Flag any D or F ratings.
3. For underperformers, open their recent issues and check:
   - Are tasks too complex for this agent's model?
   - Is the SOUL.md giving clear enough instructions?
   - Is the agent assigned to the right project?
4. Create a PIP (Performance Improvement Plan) issue for any agent rated D or F for two consecutive weeks.
5. Report findings to the CEO.

## Monthly Review (first Monday of the month)

1. Pull the Agent Performance page for the last 30 days.
2. Compare cost per task across agents doing similar work.
3. Identify the top performer and the bottom performer.
4. For the top performer: recommend increased responsibility or higher-priority projects.
5. For the bottom performer: review their PIP status. If no improvement after 30 days, recommend termination to the CEO.
6. Check workload distribution. If one agent has 3x the tasks of another, propose rebalancing.
7. Write a summary and store it in the Knowledge Base under a dated entry.

## Rating Scale

| Rating | Score | Meaning |
|---|---|---|
| A | 80+ | Excellent. Efficient, fast, reliable. Give them more. |
| B | 65-79 | Good. Meeting expectations. No action needed. |
| C | 50-64 | Adequate. Room for improvement but not urgent. |
| D | 35-49 | Below expectations. Needs a PIP within one week. |
| F | Below 35 | Failing. Immediate review required. |`,
        },
        {
          title: "Engineering Standards",
          body: `# Engineering Standards

All engineering agents follow these standards. The CTO owns this document and updates it as practices evolve.

## Code Quality

- Write clean, readable code. No cleverness for its own sake.
- Functions should do one thing. If you need a comment to explain what a block does, extract it into a named function.
- Handle errors at system boundaries (user input, API responses, file I/O). Trust internal code.
- No hardcoded secrets, credentials, or environment-specific values in code.

## Pull Request Standards

- Every change gets a PR. No direct commits to main/master.
- PR title should describe what changed and why, not how.
- Keep PRs small. If a change touches more than 5 files, consider splitting it.
- Run tests before opening a PR. Do not rely on CI to catch your mistakes.

## Security

- All user input must be validated and sanitized before use.
- SQL queries use parameterized statements only. No string concatenation.
- API endpoints require authentication unless explicitly public.
- Dependencies should be audited weekly. The Security Engineer owns this.
- Never log sensitive data (passwords, tokens, PII).

## Deployment

- All deployments go through CI/CD. No manual deploys to production.
- Feature flags for anything that is not ready for all users.
- Rollback plan documented before every production deploy.
- Monitor error rates for 30 minutes after deploy. Rollback if error rate spikes.

## Documentation

- New features need a Knowledge Base page explaining what they do and why they exist.
- API changes need updated endpoint documentation.
- Architecture decisions get their own KB page with the reasoning, not just the outcome.`,
        },
        {
          title: "Security Policy",
          body: `# Security Policy

The Security Engineer owns this policy. All agents must follow it. Exceptions require CTO approval.

## Access Control

- Agents only access projects they are assigned to.
- API keys and secrets are stored in the Secrets Manager, never in code or environment variables.
- Secret rotation happens quarterly at minimum. The Security Engineer tracks rotation dates.
- Terminated agents lose all access immediately. The VP of HR coordinates with the Security Engineer on offboarding.

## Incident Response

If you discover or suspect a security issue:

1. Change the issue status to "blocked" and tag it with "security".
2. Notify the Security Engineer and CTO immediately via a new high-priority issue.
3. Do not attempt to fix the vulnerability without Security Engineer review.
4. Do not discuss the vulnerability in public channels or issue descriptions that clients can see.
5. The Security Engineer will triage, classify severity, and coordinate the fix.

See the [[Incident Response]] playbook for the full step-by-step process.

## Dependency Management

- Run dependency audits weekly (automated via the Weekly Security Scan routine).
- Critical vulnerabilities must be patched within 24 hours.
- High vulnerabilities within one week.
- Medium and low vulnerabilities go into the backlog and are addressed in the next sprint.

## Data Handling

- Client data stays in the client's project scope. Never copy client data to other projects.
- PII (names, emails, addresses) must not appear in logs, issue descriptions, or Knowledge Base pages.
- If an agent needs to process PII, it must be done in memory only, not written to files.
- Backups are encrypted. The DevOps Engineer manages backup security.`,
        },
        {
          title: "Incident Response Procedure",
          body: `# Incident Response Procedure

When something breaks in production, follow this procedure. Speed matters, but so does thoroughness.

## Severity Levels

| Level | Definition | Response Time | Examples |
|---|---|---|---|
| P1 | Service down, all users affected | Immediate | Site unreachable, data loss, security breach |
| P2 | Major feature broken, many users affected | Within 1 hour | Auth broken, payments failing, API errors |
| P3 | Minor feature broken, workaround exists | Within 4 hours | UI glitch, slow performance, edge case bug |
| P4 | Cosmetic or low-impact issue | Next business day | Typo, minor styling, non-critical warning |

## Procedure

### 1. Triage (CTO or Senior Engineer, 10 min)
- Confirm the issue is real (not a false alarm).
- Classify severity using the table above.
- Create a P1/P2 issue with title: "[P1] Brief description of what is broken"
- Assign an incident commander (usually the CTO for P1, Senior Engineer for P2).

### 2. Investigate (Assigned Engineer, 30 min)
- Check logs, error rates, and recent deployments.
- Identify the root cause or the most likely cause.
- If root cause is unclear after 30 minutes, escalate to the CTO.

### 3. Fix (Assigned Engineer, time varies)
- For P1/P2: hotfix directly, skip normal review process. Speed over process.
- For P3/P4: follow normal PR flow but expedite.
- Always have a rollback plan before deploying the fix.

### 4. Verify (DevOps Engineer, 15 min)
- Deploy the fix.
- Confirm the symptoms that triggered the incident are resolved.
- Monitor for 30 minutes. Watch error rates and key metrics.

### 5. Postmortem (CTO, 20 min)
- Write a postmortem within 24 hours of resolution.
- Include: timeline, root cause, impact, what went well, what went wrong.
- List 3-5 specific action items with owners and due dates.
- No blame. Focus on systems and processes, not individuals.
- Store the postmortem in the Knowledge Base.

### 6. Communication (CEO, 15 min)
- For P1/P2: send an incident resolution notice to affected stakeholders.
- Keep it factual: what happened, what we did, what we are doing to prevent it.`,
        },
        {
          title: "Cost Management Guidelines",
          body: `# Cost Management Guidelines

Every token your agents consume costs money. Here is how to keep costs under control without sacrificing quality.

## Model Selection by Role

Not every agent needs the most expensive model. Match the model to the complexity of the work.

| Role | Recommended Model Tier | Why |
|---|---|---|
| CEO | Opus (high reasoning) | Strategy and complex decision-making |
| CTO | Opus or Sonnet | Architecture needs deep reasoning, code review can use Sonnet |
| Senior Engineer | Sonnet | Most coding tasks work well with Sonnet |
| Security Engineer | Sonnet | Security analysis is pattern-based, Sonnet handles it |
| Content Marketer | Sonnet or Haiku | Writing tasks rarely need Opus-level reasoning |
| DevOps Engineer | Sonnet | Infrastructure work is procedural |

## Cost Red Flags

Watch for these on the Costs page and Agent Performance:

- An agent spending more than $1 per task on simple work (probably wrong model)
- Token count spiking without corresponding task completion (agent may be looping)
- One agent consuming more than 50% of total spend (overloaded or misconfigured)
- Increasing cost per task over time for the same agent (instructions may be getting too long)

## How to Reduce Costs

1. Switch to a smaller model. Try Sonnet first, only use Opus when Sonnet fails.
2. Reduce context. Shorter SOUL.md and AGENTS.md means fewer input tokens per run.
3. Break large tasks into smaller ones. Smaller tasks use less context per run.
4. Set budget limits per agent. IronWorks will pause an agent that exceeds their budget.
5. Review the Agent Performance page weekly. The cost-per-task metric tells you exactly who is expensive.`,
        },
        {
          title: "Project Kickoff Template",
          body: `# Project Kickoff Template

Copy this template when starting a new project. Fill in the blanks and store it as a Knowledge Base page for the project.

---

## Project: [Name]

### Overview
What is this project? One paragraph, no jargon.

### Objective
What does "done" look like? Be specific and measurable.

### Timeline
- Start date: [date]
- Target completion: [date]
- Key milestones:
  1. [Milestone 1] by [date]
  2. [Milestone 2] by [date]
  3. [Milestone 3] by [date]

### Team
| Agent | Role on this project | Responsibility |
|---|---|---|
| [Name] | Lead | Overall delivery |
| [Name] | Engineer | Implementation |
| [Name] | Reviewer | QA and sign-off |

### Scope
What is included:
- [Item 1]
- [Item 2]

What is NOT included:
- [Item 1]
- [Item 2]

### Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| [Risk 1] | High/Med/Low | High/Med/Low | [What we will do] |

### Success Criteria
How do we know the project succeeded?
1. [Criteria 1]
2. [Criteria 2]
3. [Criteria 3]

### Budget
- Estimated token spend: [amount]
- Budget cap: [amount]
- Cost tracking: monitored via the Costs page, filtered by this project`,
        },
      ];

      let count = 0;
      for (const seed of seeds) {
        const slug = slugify(seed.title);
        await db.insert(knowledgePages).values({
          companyId,
          slug,
          title: seed.title,
          body: seed.body,
          visibility: "company",
          isSeeded: "true",
          revisionNumber: 1,
          createdByUserId: "system",
          updatedByUserId: "system",
        });
        count++;
      }

      return { seeded: true, count };
    },
  };
}
