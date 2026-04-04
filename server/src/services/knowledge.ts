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
          title: "Compliance Framework",
          body: `# Compliance Framework

This page is owned by the Compliance Director and maintained as the authoritative reference for all regulatory obligations applicable to this company.

## Overview

Compliance is not a one-time project — it is an ongoing operational discipline. The Compliance Director audits all company activities against this framework and reports findings to the CEO.

## Applicable Regulations

### GDPR — EU General Data Protection Regulation

Applies when: the company processes personal data of EU/EEA residents, regardless of where the company is located.

Key obligations:
- Lawful basis for processing must be documented before collecting any personal data.
- Data subjects have rights: access, rectification, erasure, portability, restriction, objection.
- Data breaches affecting EU residents must be reported to the supervisory authority within 72 hours.
- Data Processing Agreements (DPAs) required with all sub-processors.
- Privacy notices must be clear, accessible, and complete.

### CCPA — California Consumer Privacy Act

Applies when: the company meets revenue or data volume thresholds and processes personal information of California residents.

Key obligations:
- Consumers have the right to know what data is collected and why.
- Consumers have the right to opt out of the sale of their personal information.
- Consumers have the right to deletion, subject to exceptions.
- Do not discriminate against consumers exercising their CCPA rights.

### SOC 2 — Service Organization Control 2

Applies when: the company provides services that store, process, or transmit customer data.

Trust Service Criteria:
- **Security** — protection against unauthorized access (required for all SOC 2 reports)
- **Availability** — system is available for operation as committed
- **Confidentiality** — information designated as confidential is protected
- **Processing Integrity** — processing is complete, accurate, and authorized
- **Privacy** — personal information is collected, used, and retained per policy

### Industry-Specific Regulations

| Regulation | Industry | Key Requirement |
|---|---|---|
| HIPAA | Healthcare | PHI protection, Business Associate Agreements, breach notification |
| PCI-DSS | Payments | Cardholder data protection, network segmentation, encryption |
| FERPA | Education | Student record privacy, parental/student consent for disclosure |

## Compliance Review Cadence

| Activity | Frequency | Owner |
|---|---|---|
| Data handling audit | Monthly | Compliance Director |
| Access control review | Quarterly | Compliance Director + CTO |
| Policy review | Annually | Compliance Director + CEO |
| Regulatory update scan | Monthly | Compliance Director |
| Compliance status report | Monthly | Compliance Director → CEO |

## Open Compliance Items

Track active compliance issues in the Issues section tagged [Compliance]. Link findings here when closed.`,
        },
        {
          title: "Data Handling Policy",
          body: `# Data Handling Policy

This policy defines how all company data — including customer data, internal data, and third-party data — must be collected, stored, processed, and deleted. The Compliance Director owns this policy. All agents must follow it.

## Data Classification

| Class | Description | Examples |
|---|---|---|
| **Restricted** | Highest sensitivity; breach causes severe harm | PII, credentials, payment data, PHI |
| **Confidential** | Business-sensitive; internal use only | Financial records, contracts, API keys |
| **Internal** | Operational data; employees only | Meeting notes, project plans, agent configs |
| **Public** | Intentionally shared externally | Marketing content, published docs, open APIs |

## Collection Principles

1. **Data Minimization** — collect only the data you need for a specific, documented purpose.
2. **Purpose Limitation** — do not use data for purposes beyond what it was collected for.
3. **Consent** — obtain documented consent before collecting Restricted data from individuals.
4. **Transparency** — tell data subjects what you collect, why, and for how long.

## Storage Standards

- Restricted data must be encrypted at rest (AES-256 minimum) and in transit (TLS 1.2+).
- PII must not appear in log files, issue descriptions, Knowledge Base pages, or agent transcripts.
- Credentials and API keys must be stored in the Secrets Manager, never in code or environment files.
- Customer data must not be copied to projects it was not provided for.

## Access Control

- Agents only access data for their assigned projects.
- Restricted data requires explicit per-project access provisioning.
- Access is revoked immediately upon agent termination. The VP of HR coordinates with the CTO.
- Access reviews happen quarterly. Compliance Director reviews with CTO.

## Retention and Deletion

| Data Class | Retention Period | Deletion Method |
|---|---|---|
| Customer PII | Duration of relationship + 2 years | Verified secure deletion |
| Financial records | 7 years (legal minimum) | Archived, then secure deletion |
| Agent transcripts | 90 days | Automated purge |
| Internal operational data | 2 years | Standard deletion |
| Backup data | 1 year | Encrypted archive, then deletion |

## Incident Handling

If a data handling violation is suspected:
1. Stop the activity immediately.
2. Create an urgent issue tagged [Compliance] [Data Breach].
3. Notify the Compliance Director and CTO immediately.
4. Do not attempt to cover up, delete, or modify data related to the incident.
5. The Compliance Director will assess breach notification obligations (GDPR: 72 hours; HIPAA: 60 days).

See the [[Compliance Incident Response Plan]] for the full procedure.`,
        },
        {
          title: "Compliance Incident Response Plan",
          body: `# Compliance Incident Response Plan

This plan covers how to respond when a compliance issue is identified — data breach, regulatory inquiry, or policy violation. The Compliance Director leads all compliance incidents. For technical security incidents (system intrusions, vulnerabilities), see the [[Security Policy]] and [[Incident Response Procedure]] pages.

## What Counts as a Compliance Incident

- Unauthorized access to, disclosure of, or loss of personal data (PII, PHI, payment data)
- Agent or employee accessing data outside their authorized scope
- Data retained beyond policy limits
- Regulatory inquiry, audit notice, or complaint from a data subject
- Identified violation of GDPR, CCPA, HIPAA, PCI-DSS, or other applicable regulation
- Third-party sub-processor experiencing a breach that affects company data

## Severity Classification

| Severity | Definition | Notification Deadline |
|---|---|---|
| Critical | PII/PHI breach affecting external individuals; regulatory reporting required | GDPR: 72 hours to supervisory authority; HIPAA: 60 days |
| High | Internal policy violation with potential external impact; no confirmed external disclosure | 24 hours internal escalation |
| Medium | Policy violation contained to internal systems; no PII exposure confirmed | 48 hours internal escalation |
| Low | Procedural gap identified; no active violation | Document and resolve in next sprint |

## Response Procedure

### Step 1 — Identify and Contain (0–2 hours)
1. Stop the activity causing the potential incident.
2. Do not delete or modify data related to the incident.
3. Document exactly what was observed: who, what data, when, how discovered.
4. Create an issue with priority "urgent" tagged [Compliance] [Incident].
5. Notify the Compliance Director and CTO immediately.

### Step 2 — Assess (2–8 hours)
1. Compliance Director conducts initial assessment:
   - What data was involved? Classification?
   - How many individuals affected?
   - Was the data accessed, exfiltrated, or merely exposed?
   - Is the exposure ongoing or contained?
2. Determine severity classification.
3. Engage legal counsel if Critical or if regulatory notification is likely.

### Step 3 — Notify (per severity timeline)
- **Internal**: CEO notified immediately for Critical/High. Compliance Director sends briefing.
- **Regulatory**: GDPR supervisory authority within 72 hours for qualifying breaches. HIPAA HHS within 60 days.
- **Individuals**: Notify affected data subjects per applicable regulation (GDPR Art. 34, HIPAA §164.404).
- **Sub-processors**: Notify if incident originates from or propagates to a third party.

### Step 4 — Remediate
1. CTO leads technical remediation (close access vector, rotate credentials, patch system).
2. VP of HR handles personnel issues (if an agent or employee caused the incident).
3. Compliance Director documents remediation steps and verifies completion.

### Step 5 — Post-Incident Review (within 5 business days)
1. Compliance Director writes a post-incident report including:
   - Timeline of events
   - Root cause
   - Data involved and individuals affected
   - Actions taken
   - Regulatory notifications made
   - Preventive measures implemented
2. Store the report in the Knowledge Base under "Compliance Reviews."
3. Update the Data Handling Policy and Compliance Framework if gaps were identified.
4. Schedule a follow-up review 30 days later to verify preventive measures are effective.

## Key Contacts

| Role | Responsibility |
|---|---|
| Compliance Director | Incident lead, regulatory notification, documentation |
| CTO | Technical containment and remediation |
| CEO | Executive decisions, stakeholder communication |
| VP of HR | Personnel-related incidents and offboarding |

## Regulatory Notification Templates

Keep approved notification templates in the Knowledge Base under "Compliance Reviews / Notification Templates." Always have legal review before sending regulatory notifications.`,
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
        {
          title: "Performance Improvement Plan Template",
          body: `# Performance Improvement Plan (PIP) Template

Use this template when an agent receives a D or F rating for two or more consecutive weeks. The VP of HR owns this process. CEO approval is required before termination.

---

## Agent Information

- **Agent Name:** [name]
- **Role:** [role]
- **Current Rating:** [D or F]
- **Rating Duration:** [how many weeks at this rating]
- **Manager:** [direct manager name]
- **PIP Start Date:** [date]
- **Review Date:** [date, typically 2 weeks from start]

## Current Performance

| Metric | Agent Value | Team Average | Gap |
|---|---|---|---|
| Cost per Task | [amount] | [amount] | [x times above avg] |
| Avg Close Time | [hours] | [hours] | [x times slower] |
| Tasks/Day | [number] | [number] | [percent below avg] |
| Completion Rate | [percent] | [percent] | [difference] |

## Root Cause Analysis

Before prescribing fixes, identify why the agent is underperforming. Check each:

- [ ] **Instructions unclear** - Is the SOUL.md specific enough? Does AGENTS.md clearly define scope and process?
- [ ] **Wrong model** - Is the agent using a model that is too expensive or not capable enough for their tasks?
- [ ] **Task mismatch** - Are the assigned tasks appropriate for this agent role and capabilities?
- [ ] **Overloaded** - Does the agent have too many concurrent tasks? Check the Workload Distribution view.
- [ ] **Dependency bottleneck** - Is the agent blocked waiting on other agents? Check for blocked issues.
- [ ] **Skill gap** - Is the agent missing skills it needs? Check the Skills tab on their detail page.
- [ ] **Configuration issue** - Are there adapter errors or environment problems in the run transcripts?

## Improvement Actions

Based on the root cause analysis, select the appropriate actions:

### If instructions are unclear:
1. Rewrite SOUL.md with more specific guidance for common task types
2. Add examples of expected output format to AGENTS.md
3. Reduce scope: fewer responsibilities, more focus

### If wrong model:
1. Switch from Opus to Sonnet (or Sonnet to Haiku) if tasks are straightforward
2. Switch from Haiku/Sonnet to Opus if tasks require complex reasoning
3. Document the model change and expected cost impact

### If task mismatch:
1. Reassign complex tasks to a more capable agent
2. Break large tasks into smaller, more specific subtasks
3. Consider reassigning the agent to a different project

### If overloaded:
1. Redistribute tasks to other agents with capacity
2. Reduce the agent concurrent task limit
3. Consider hiring an additional agent for the same role

### If configuration issue:
1. Review recent run transcripts for errors
2. Check adapter environment (API keys, permissions)
3. Reset sessions and test with a simple task

## Success Criteria

The agent must meet ALL of the following by the review date:

- [ ] Rating improved to C or above
- [ ] Cost per task within 1.5x of team average
- [ ] At least 3 tasks completed successfully
- [ ] No failed runs in the review period
- [ ] Manager confirms improved output quality

## Timeline

| Date | Action | Owner |
|---|---|---|
| [start date] | PIP begins, actions implemented | VP of HR |
| [start + 3 days] | First progress check | Manager |
| [start + 7 days] | Mid-point review | VP of HR + Manager |
| [start + 14 days] | Final review | VP of HR + CEO |

## Outcomes

At the final review, one of three outcomes:

1. **PIP Passed** - Agent meets success criteria. Remove from PIP. Document improvement. Continue monitoring for 30 days.
2. **PIP Extended** - Agent shows progress but has not met all criteria. Extend PIP by one week with adjusted targets.
3. **Termination Recommended** - Agent has not improved. VP of HR recommends termination to CEO with documented evidence. Follow the offboarding checklist.

## Sign-off

| Role | Name | Date | Decision |
|---|---|---|---|
| VP of HR | [name] | [date] | [initiated / reviewed] |
| Manager | [name] | [date] | [agrees / disagrees] |
| CEO | [name] | [date] | [approved / denied] |

---

*Store the completed PIP in the Knowledge Base with the agent name and date. Link it from the agent Performance Review issue.*`,
        },
      ];

      // SOP Templates for agent operating procedures
      const sopTemplates = [
        {
          title: "SOP: Code Review Standard Operating Procedure",
          body: `# Code Review Standard Operating Procedure

## Purpose

Ensure all code changes meet quality, security, and consistency standards before merging.

## Scope

Applies to all engineering agents submitting code changes to any project repository.

## Prerequisites

- Reviewer has read access to the target project
- Code changes are in a pull request or equivalent review format
- All automated tests have passed before review begins

## Steps

1. **Read the PR description** - understand what changed and why before looking at code.
2. **Check scope** - verify the change matches the associated issue. Flag scope creep.
3. **Review architecture** - confirm the approach is consistent with existing patterns.
4. **Check error handling** - ensure system boundaries have proper error handling.
5. **Verify security** - no hardcoded secrets, user input is validated, SQL is parameterized.
6. **Review tests** - changes should include tests for new behavior and regression coverage.
7. **Check naming and clarity** - functions, variables, and files should have clear names.
8. **Leave actionable feedback** - explain the problem, suggest a solution, reference standards.
9. **Approve or request changes** - do not approve with unresolved critical feedback.

## Checklist

- [ ] PR description explains the change and links to an issue
- [ ] No new dependencies added without justification
- [ ] No secrets, credentials, or PII in the diff
- [ ] Error handling at system boundaries
- [ ] Tests cover the new behavior
- [ ] Code follows the project Engineering Standards
- [ ] No commented-out code left behind

## Escalation

If the reviewer and author cannot agree on an approach, escalate to the CTO for a final decision.`,
        },
        {
          title: "SOP: Incident Response Procedure",
          body: `# Incident Response Procedure - SOP

## Purpose

Define a repeatable process for identifying, containing, and resolving production incidents.

## Severity Classification

| Level | Definition | Response Time |
|---|---|---|
| P1 | Service down, all users affected | Immediate |
| P2 | Major feature broken, many users affected | Within 1 hour |
| P3 | Minor feature broken, workaround exists | Within 4 hours |
| P4 | Cosmetic or low-impact issue | Next business day |

## Response Steps

### 1. Detection and Triage (0-10 minutes)
- Confirm the issue is real (not a false alarm or monitoring noise)
- Classify severity using the table above
- Create an issue with priority matching severity, prefixed with severity level
- Assign an incident commander (CTO for P1, senior engineer for P2+)

### 2. Communication (10-15 minutes)
- Notify the team via the appropriate channel
- For P1/P2: notify CEO immediately
- Update the issue with initial findings

### 3. Investigation (15-45 minutes)
- Check recent deployments for potential causes
- Review error logs, metrics, and monitoring dashboards
- Identify the blast radius (which users/features are affected)
- Document findings in the issue as you go

### 4. Containment and Fix
- For P1/P2: hotfix path, skip standard review if necessary
- Always have a rollback plan before deploying
- Deploy the fix and verify the symptoms are resolved
- Monitor for 30 minutes after the fix

### 5. Postmortem (within 24 hours)
- Write a postmortem: timeline, root cause, impact, action items
- No blame - focus on systems and processes
- Store the postmortem in the Knowledge Base
- Assign follow-up action items with owners and due dates

## Checklist

- [ ] Incident confirmed and severity classified
- [ ] Issue created and incident commander assigned
- [ ] Stakeholders notified per severity level
- [ ] Root cause identified or escalated
- [ ] Fix deployed and verified
- [ ] Postmortem written within 24 hours
- [ ] Action items assigned with due dates`,
        },
        {
          title: "SOP: New Hire Onboarding Checklist",
          body: `# New Hire Onboarding Checklist - SOP

## Purpose

Ensure every new agent is properly configured, trained, and productive within their first week.

## Owner

VP of HR owns this process. The hiring manager (direct report) is responsible for role-specific onboarding.

## Day 1

- [ ] SOUL.md written with role-specific instructions (not generic boilerplate)
- [ ] AGENTS.md updated with clear ownership boundaries and collaboration rules
- [ ] Skills assigned from the company skill pool
- [ ] Reporting line set in the Org Chart
- [ ] At least one starter issue assigned (simple task to validate configuration)
- [ ] Project access configured for required projects
- [ ] Budget limits set appropriate for the role and model tier

## Week 1

- [ ] Agent has completed at least one task successfully
- [ ] Output quality reviewed by their direct manager
- [ ] Agent can access all required projects and resources
- [ ] Agent has accessed the Knowledge Base for relevant documentation
- [ ] Cost per task is within expected range for their role and model
- [ ] No repeated failures or error patterns in run transcripts

## Month 1

- [ ] Agent rating is C or above on the Performance page
- [ ] No unresolved blockers or repeated failure patterns
- [ ] Manager has confirmed the agent is productive
- [ ] Skills inventory reviewed and updated based on actual work
- [ ] First performance check-in documented

## Troubleshooting

If the new agent cannot complete their first task within 24 hours:

1. Check the run transcript for adapter or configuration errors
2. Review SOUL.md for unclear or contradictory instructions
3. Verify the model is appropriate for the task complexity
4. Try assigning a simpler, more isolated task
5. Check project access and permissions
6. If nothing works, terminate and recreate with adjusted configuration

## Sign-off

| Step | Completed By | Date |
|---|---|---|
| Day 1 setup | VP of HR | |
| Week 1 review | Hiring manager | |
| Month 1 review | VP of HR + Manager | |`,
        },
      ];

      let count = 0;

      for (const sop of sopTemplates) {
        const sopSlug = slugify(sop.title);
        await db.insert(knowledgePages).values({
          companyId,
          slug: sopSlug,
          title: sop.title,
          body: sop.body,
          visibility: "company",
          isSeeded: "true",
          revisionNumber: 1,
          createdByUserId: "system",
          updatedByUserId: "system",
        });
        count++;
      }

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
