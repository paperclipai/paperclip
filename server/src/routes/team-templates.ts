import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { agentService, goalService, issueService, logActivity, projectService } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

const READABLE_DELIVERABLE_RULE = "If this task creates or reviews human-facing content, save the actual readable deliverable as a Paperclip issue document before asking for approval or marking done. A registry ref, run summary, or comment saying the work exists is not enough.";
const VICTORIA_REVIEW_RULE = "Before publishing, sending, or marking the pilot article flow complete, route the visible brief, draft, review notes, and media checklist through Victoria-style quality review: research-first, evidence-grounded, registry-aware, and focused on top 1% student usefulness.";
const TEMPLATE_SOURCE_REFS = [
  "agent:victoria@v1",
  "kb:hlt-app-paperclip@v1",
  "playbook:make-article@v1",
  "skill:hlt-product-article-creation-playbook@v1",
  "rubric:article-quality-v1@v1",
] as const;
const TEMPLATE_BEST_PRACTICES = [
  "Paperclip is the control plane: keep ownership, approvals, budgets, and visible artifacts here; durable execution stays in Hermes/Thomas.",
  "Hermes works best with specific goals, context files, reusable skills, and tool-using execution rather than vague chat prompts.",
  "Agent teams should coordinate through tasks and visible artifacts, not hidden agent-to-agent chatter or comments that say output exists elsewhere.",
  "Victoria provides the article-quality review lane: research-first, evidence-based, registry-aware, proactive, and top-1% useful for HLT students.",
] as const;
const DEFAULT_HTTP_AGENT_CONFIG = {
  url: "${env:PAPERCLIP_THOMAS_BRIDGE_URL}",
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Bridge-Token": "${env:PAPERCLIP_THOMAS_BRIDGE_TOKEN}",
  },
  timeoutMs: 5_400_000,
  payloadTemplate: {
    timeoutSec: 5_400,
    prompt: READABLE_DELIVERABLE_RULE,
  },
  env: {
    PAPERCLIP_THOMAS_BRIDGE_URL: "http://127.0.0.1:9119/v1/runs",
    PAPERCLIP_THOMAS_BRIDGE_TOKEN: "${env:PAPERCLIP_THOMAS_BRIDGE_TOKEN}",
  },
} as const;

type AgentTemplate = {
  name: string;
  role: string;
  title: string;
  icon: string;
  profile: string;
  capabilities: string;
  reportsTo?: string;
};

type IssueTemplate = {
  title: string;
  description: string;
  priority: "low" | "medium" | "high";
  assignee: string;
};

type TeamTemplate = {
  id: string;
  name: string;
  summary: string;
  goal: {
    title: string;
    description: string;
  };
  project: {
    name: string;
    description: string;
  };
  agents: AgentTemplate[];
  issues: IssueTemplate[];
  sourceRefs: readonly string[];
  bestPractices: readonly string[];
};

export const HLT_ARTICLE_FACTORY_TEMPLATE: TeamTemplate = {
  id: "hlt-article-factory",
  name: "HLT Article Factory",
  summary: "A clean team that researches, writes, reviews, prepares media for, and publishes helpful exam articles with readable drafts visible in Paperclip.",
  goal: {
    title: "Publish helpful exam articles people can actually read",
    description: "Create high-quality HLT exam articles that help students, attach every draft in Paperclip, and prepare approved work for MasteryPublishing.",
  },
  project: {
    name: "Article Factory Pilot",
    description: "Prove one complete article flow: choose a useful topic, show the topic brief, show the draft, review it, prepare media, and only then move toward publishing.",
  },
  sourceRefs: TEMPLATE_SOURCE_REFS,
  bestPractices: TEMPLATE_BEST_PRACTICES,
  agents: [
    {
      name: "Article Lead",
      role: "pm",
      title: "Article Lead",
      icon: "target",
      profile: "orchestrator",
      capabilities: "Turns an operator request into article tasks, assigns the right specialist, and checks that every deliverable is visible before asking for approval.",
    },
    {
      name: "Victoria Review",
      role: "qa",
      title: "Victoria Quality Reviewer",
      icon: "shield",
      profile: "victoria",
      reportsTo: "Article Lead",
      capabilities: "Reviews visible briefs, drafts, review notes, and media checklists with Victoria standards: research-first, evidence-grounded, registry-aware, and top 1% useful for students.",
    },
    {
      name: "Topic Researcher",
      role: "researcher",
      title: "Topic Researcher",
      icon: "search",
      profile: "researcher",
      reportsTo: "Article Lead",
      capabilities: "Finds useful exam topics, writes readable topic briefs, and attaches the brief where the operator can open it.",
    },
    {
      name: "Article Writer",
      role: "general",
      title: "Article Writer",
      icon: "file-code",
      profile: "writer",
      reportsTo: "Article Lead",
      capabilities: "Writes clear, student-helpful article drafts and attaches the full draft as a Paperclip document.",
    },
    {
      name: "Exam Reviewer",
      role: "qa",
      title: "Clinical / Exam Reviewer",
      icon: "shield",
      profile: "editor",
      reportsTo: "Article Lead",
      capabilities: "Checks factual accuracy, exam alignment, source quality, and student usefulness before publishing.",
    },
    {
      name: "Media Producer",
      role: "designer",
      title: "Media Producer",
      icon: "sparkles",
      profile: "media-producer",
      reportsTo: "Article Lead",
      capabilities: "Creates article image briefs, media checklists, and MMM2 requests that match the article and brand.",
    },
    {
      name: "Publisher",
      role: "pm",
      title: "Publishing Coordinator",
      icon: "rocket",
      profile: "publisher",
      reportsTo: "Article Lead",
      capabilities: "Prepares approved drafts for MasteryPublishing. Never publishes without explicit human approval.",
    },
    {
      name: "Traffic Analyst",
      role: "cmo",
      title: "Traffic Analyst",
      icon: "radar",
      profile: "analyst",
      reportsTo: "Article Lead",
      capabilities: "Reads traffic, search, CTA, and email-capture results and turns them into the next article priorities.",
    },
    {
      name: "Library Curator",
      role: "general",
      title: "Library Curator",
      icon: "telescope",
      profile: "curator",
      reportsTo: "Article Lead",
      capabilities: "Finds buried briefs, drafts, media, and reviews; renames ugly work items; and links artifacts so people can open them.",
    },
  ],
  issues: [
    {
      title: "Write and show one FNP article draft",
      priority: "high",
      assignee: "Article Lead",
      description: `Create one complete FNP article pilot. The operator must be able to open the topic brief and article draft from Paperclip before any approval request. ${READABLE_DELIVERABLE_RULE}`,
    },
    {
      title: "Find 5 useful FNP article topics",
      priority: "high",
      assignee: "Topic Researcher",
      description: `Research five student-useful FNP topics and attach a readable topic brief document. Use human titles; do not use registry slugs as task titles. ${READABLE_DELIVERABLE_RULE}`,
    },
    {
      title: "Prepare media checklist for the first article",
      priority: "medium",
      assignee: "Media Producer",
      description: `Create a simple media checklist for the pilot article: hero image idea, supporting visual idea, alt text direction, and MMM2 request notes. Attach it as a readable document. ${READABLE_DELIVERABLE_RULE}`,
    },
    {
      title: "Run Victoria quality review before publishing",
      priority: "high",
      assignee: "Victoria Review",
      description: `Review the pilot article package before any publishing step. Confirm the topic brief, article draft, exam review notes, and media checklist are visible in Paperclip; then attach a readable quality review with strengths, risks, and exact revision requests. ${VICTORIA_REVIEW_RULE} ${READABLE_DELIVERABLE_RULE}`,
    },
  ],
};

const TEAM_TEMPLATES = [HLT_ARTICLE_FACTORY_TEMPLATE] as const;
const importTeamTemplateSchema = z.object({
  templateId: z.string().min(1),
  createStarterWork: z.boolean().optional().default(true),
});

function withProfile(config: typeof DEFAULT_HTTP_AGENT_CONFIG, profile: string) {
  return {
    ...config,
    payloadTemplate: {
      ...config.payloadTemplate,
      profile,
    },
  };
}

function assertHumanTemplate(template: TeamTemplate) {
  const forbidden = [/operational_log/i, /schema:/i, /kb:/i, /\bHIG-\d+/i, /disposition/i, /liveness/i];
  const chunks = [
    template.name,
    template.summary,
    template.goal.title,
    template.goal.description,
    template.project.name,
    template.project.description,
    ...template.agents.flatMap((agent) => [agent.name, agent.title, agent.capabilities]),
    ...template.issues.flatMap((issue) => [issue.title, issue.description]),
  ];
  for (const chunk of chunks) {
    if (forbidden.some((pattern) => pattern.test(chunk))) {
      throw new Error(`Team template ${template.id} contains non-human wording: ${chunk}`);
    }
  }
}

for (const template of TEAM_TEMPLATES) assertHumanTemplate(template);

export function teamTemplateRoutes(db: Db) {
  const router = Router();
  const agents = agentService(db);
  const goals = goalService(db);
  const projects = projectService(db);
  const issues = issueService(db);

  router.get("/team-templates", (_req, res) => {
    res.json(TEAM_TEMPLATES.map((template) => ({
      id: template.id,
      name: template.name,
      summary: template.summary,
      agents: template.agents.map((agent) => ({
        name: agent.name,
        title: agent.title,
        role: agent.role,
        capabilities: agent.capabilities,
      })),
      starterIssues: template.issues.map((issue) => ({
        title: issue.title,
        assignee: issue.assignee,
        priority: issue.priority,
      })),
    })));
  });

  router.post("/companies/:companyId/team-templates/import", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const input = importTeamTemplateSchema.parse(req.body ?? {});
    const template = TEAM_TEMPLATES.find((candidate) => candidate.id === input.templateId);
    if (!template) {
      res.status(404).json({ error: "Team template not found" });
      return;
    }

    const createdAgents: Array<{ id: string; name: string; role: string }> = [];
    const agentIdsByName = new Map<string, string>();

    for (const agentTemplate of template.agents) {
      const reportsTo = agentTemplate.reportsTo ? agentIdsByName.get(agentTemplate.reportsTo) ?? null : null;
      const agent = await agents.create(companyId, {
        name: agentTemplate.name,
        role: agentTemplate.role,
        title: agentTemplate.title,
        icon: agentTemplate.icon,
        reportsTo,
        capabilities: agentTemplate.capabilities,
        adapterType: "http",
        adapterConfig: withProfile(DEFAULT_HTTP_AGENT_CONFIG, agentTemplate.profile),
        runtimeConfig: {},
        budgetMonthlyCents: 0,
        spentMonthlyCents: 0,
        status: "idle",
        metadata: {
          teamTemplateId: template.id,
          humanPurpose: agentTemplate.capabilities,
          sourceRefs: template.sourceRefs,
          bestPractices: template.bestPractices,
        },
      });
      createdAgents.push({ id: agent.id, name: agent.name, role: agent.role });
      agentIdsByName.set(agentTemplate.name, agent.id);
    }

    const leadAgentId = agentIdsByName.get("Article Lead") ?? createdAgents[0]?.id ?? null;
    const goal = await goals.create(companyId, {
      title: template.goal.title,
      description: template.goal.description,
      level: "company",
      status: "active",
      ownerAgentId: leadAgentId,
    });
    const project = await projects.create(companyId, {
      name: template.project.name,
      description: template.project.description,
      status: "in_progress",
      leadAgentId,
      goalIds: [goal.id],
    } as never);

    const createdIssues = [];
    if (input.createStarterWork) {
      for (const issueTemplate of template.issues) {
        const assigneeAgentId = agentIdsByName.get(issueTemplate.assignee) ?? leadAgentId;
        const issue = await issues.create(companyId, {
          projectId: project.id,
          goalId: goal.id,
          title: issueTemplate.title,
          description: issueTemplate.description,
          status: "todo",
          priority: issueTemplate.priority,
          assigneeAgentId,
          requestDepth: 0,
        } as never);
        createdIssues.push({ id: issue.id, identifier: issue.identifier, title: issue.title });
      }
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "team_template.imported",
      entityType: "project",
      entityId: project.id,
      details: {
        templateId: template.id,
        templateName: template.name,
        agentCount: createdAgents.length,
        issueCount: createdIssues.length,
        sourceRefs: template.sourceRefs,
      },
    });

    res.status(201).json({
      template: { id: template.id, name: template.name },
      goal: { id: goal.id, title: goal.title },
      project: { id: project.id, name: project.name },
      agents: createdAgents,
      issues: createdIssues,
    });
  });

  return router;
}
