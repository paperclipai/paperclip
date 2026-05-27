import { Buffer } from "node:buffer";
import { asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentMemberships,
  agents,
  coachDecisions,
  goals,
  issues,
  opcBlueprints,
  proposalArtifacts,
  routines,
} from "@paperclipai/db";
import type {
  CoachDecision,
  CreateOPCCompany,
  CreateOPCProposal,
  OPCAgentPlanItem,
  OPCBlueprint,
  OPCBudgetTimeGuesses,
  OPCCoachResponse,
  OPCCreateCompanyResponse,
  OPCIssuePlanItem,
  OPCRoutinePlanItem,
  ProposalArtifact,
} from "@paperclipai/shared";
import { AGENT_ROLES, type AgentRole, type IssuePriority } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { accessService } from "./access.js";
import { callCoachAI, isCoachAvailable } from "./opc-coach.js";
import { logActivity } from "./activity-log.js";
import { companyService } from "./companies.js";
import { goalService } from "./goals.js";
import { agentService } from "./agents.js";
import { issueService } from "./issues.js";
import { projectService } from "./projects.js";
import { routineService } from "./routines.js";

const MAX_PROPOSAL_TEXT_CHARS = 120_000;

type BoardActor = {
  userId: string | null;
};

type ProjectContext = {
  path: string | null;
  link: string | null;
  mode: "advise" | "take_charge";
};

type BlueprintInsert = typeof opcBlueprints.$inferInsert;
type BlueprintSelect = typeof opcBlueprints.$inferSelect;
type ProposalSelect = typeof proposalArtifacts.$inferSelect;
type DecisionSelect = typeof coachDecisions.$inferSelect;
type BlueprintDraft = Omit<
  BlueprintInsert,
  "proposalId" | "agentPlan" | "issuePlan" | "routinePlan" | "budgetTimeGuesses"
> & {
  budgetTimeGuesses: OPCBudgetTimeGuesses;
  agentPlan: OPCAgentPlanItem[];
  issuePlan: OPCIssuePlanItem[];
  routinePlan: OPCRoutinePlanItem[];
};

const DEFAULT_AGENT_PLAN = [
  {
    name: "Founder Chief of Staff",
    role: "ceo",
    title: "Founder Chief of Staff",
    capabilities: "Runs the founder operating cadence, challenges priorities, and turns strategy into visible work.",
  },
  {
    name: "Product Strategist",
    role: "pm",
    title: "Product Strategist",
    capabilities: "Sharpens the customer wedge, success metric, launch scope, and roadmap tradeoffs.",
  },
  {
    name: "Designer",
    role: "designer",
    title: "Product Designer",
    capabilities: "Owns the first user journey, interface critique, and usability risks.",
  },
  {
    name: "Engineer",
    role: "engineer",
    title: "Engineering Lead",
    capabilities: "Owns architecture, implementation sequencing, test strategy, and technical debt control.",
  },
  {
    name: "QA",
    role: "qa",
    title: "QA Lead",
    capabilities: "Owns acceptance criteria, smoke tests, regressions, and release readiness.",
  },
  {
    name: "Security",
    role: "security",
    title: "Security Lead",
    capabilities: "Reviews data handling, auth boundaries, secrets, abuse cases, and launch risk.",
  },
  {
    name: "Growth Ops",
    role: "cmo",
    title: "Growth and Ops Lead",
    capabilities: "Owns customer feedback loops, launch distribution, operating metrics, and budget checks.",
  },
] as const;

const ROLE_TO_AGENT_NAME: Record<string, string> = {
  ceo: "Founder Chief of Staff",
  pm: "Product Strategist",
  designer: "Designer",
  engineer: "Engineer",
  qa: "QA",
  security: "Security",
  cmo: "Growth Ops",
};

function normalizeText(value: string) {
  return value.replace(/\r\n/g, "\n").replace(/\t/g, " ").replace(/[ \f\v]+/g, " ").trim();
}

function sentenceCandidates(text: string) {
  return normalizeText(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 24);
}

function truncate(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${Array.from(value).slice(0, maxChars - 1).join("")}...`;
}

function normalizeProjectMode(value: unknown): ProjectContext["mode"] {
  return value === "take_charge" ? "take_charge" : "advise";
}

function projectContextFromInput(input: Pick<CreateOPCProposal | CreateOPCCompany, "projectPath" | "projectLink" | "projectMode">): ProjectContext {
  return {
    path: input.projectPath?.trim() || null,
    link: input.projectLink?.trim() || null,
    mode: normalizeProjectMode(input.projectMode),
  };
}

function projectContextFromText(text: string): ProjectContext {
  const block = text.match(/^\[OPC current project context\]\n([\s\S]*?)(?:\n\n|$)/i)?.[1] ?? "";
  const path = block.match(/^Project path:\s*(.+)$/im)?.[1]?.trim() || null;
  const link = block.match(/^Project link:\s*(.+)$/im)?.[1]?.trim() || null;
  const mode = normalizeProjectMode(block.match(/^Mode:\s*(.+)$/im)?.[1]?.trim());
  return { path, link, mode };
}

function mergeProjectContext(primary: ProjectContext, fallback: ProjectContext): ProjectContext {
  return {
    path: primary.path ?? fallback.path,
    link: primary.link ?? fallback.link,
    mode: primary.mode !== "advise" ? primary.mode : fallback.mode,
  };
}

function hasProjectContext(context: ProjectContext) {
  return Boolean(context.path || context.link);
}

function buildProjectContextBlock(context: ProjectContext) {
  if (!hasProjectContext(context)) return "";
  return [
    "[OPC current project context]",
    context.path ? `Project path: ${context.path}` : null,
    context.link ? `Project link: ${context.link}` : null,
    `Mode: ${context.mode}`,
    context.mode === "take_charge"
      ? "Intent: create an operating company that can own the current project backlog, QA, release, and routines."
      : "Intent: advise on the current project before taking over execution.",
  ].filter(Boolean).join("\n");
}

function composeProposalText(text: string, context: ProjectContext) {
  const block = buildProjectContextBlock(context);
  if (!block) return text;
  const body = text.trim() || "No standalone proposal was provided; analyze the existing project context and ask the founder for missing product direction.";
  return truncate(normalizeText(`${block}\n\n${body}`), MAX_PROPOSAL_TEXT_CHARS);
}

function projectNameFromContext(context: ProjectContext) {
  const source = context.path ?? context.link ?? "";
  const clean = source.replace(/[?#].*$/, "").replace(/\/+$/, "");
  const last = clean.split(/[\\/]/).filter(Boolean).at(-1);
  return titleCase((last || "Current Project").replace(/[-_]+/g, " ")) || "Current Project";
}

function sourceTypeForProjectWorkspace(context: ProjectContext) {
  if (context.path) return "local_path";
  if (context.link) return "git_repo";
  return "remote_managed";
}

function adapterConfigForProject(input: CreateOPCCompany, context: ProjectContext) {
  const config = { ...input.adapterConfig };
  if (input.adapterType === "process" && context.mode === "take_charge" && context.path && typeof config.cwd !== "string") {
    config.cwd = context.path;
  }
  return config;
}

function titleCase(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function inferName(text: string) {
  const firstHeading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (firstHeading) return truncate(firstHeading.replace(/[:.]+$/, ""), 80);
  const nameLike = text.match(/(?:project|product|company|app|platform|proposal)\s*(?:name|called|:)\s*([A-Za-z0-9][A-Za-z0-9 '&-]{2,80})/i)?.[1]?.trim();
  if (nameLike) return truncate(nameLike.replace(/[.。].*$/, ""), 80);
  return titleCase(text.replace(/[#*_`>]/g, " ")) || "OPC Venture";
}

function extractLines(text: string, patterns: RegExp[], fallback: string[]) {
  const lines = text
    .split(/\n|[.;]\s+/)
    .map((line) => line.replace(/^[-*#\d.\s]+/, "").trim())
    .filter((line) => line.length > 8);
  const matches = lines.filter((line) => patterns.some((pattern) => pattern.test(line)));
  return (matches.length > 0 ? matches : fallback).slice(0, 6).map((item) => truncate(item, 220));
}

function buildIssuePlan(text: string): OPCIssuePlanItem[] {
  const proposalName = inferName(text);
  const context = projectContextFromText(text);
  const currentProjectIssues = hasProjectContext(context)
    ? [
        {
          title: "Audit current project state and repo risks",
          description: "Review the current project path or link, summarize what exists, identify blockers, and propose the smallest next operational step.",
          priority: "critical" as const,
          role: "engineer",
        },
        {
          title: "Convert current project gaps into the first operating backlog",
          description: "Turn observed product, design, QA, security, and launch gaps into founder-readable issues with clear acceptance criteria.",
          priority: "high" as const,
          role: "ceo",
        },
      ]
    : [];
  return [
    ...currentProjectIssues,
    {
      title: "Validate the wedge MVP with 5 target users",
      description: "Interview likely first users, test the promised pain point, and decide which use case is narrow enough to ship first.",
      priority: "critical",
      role: "pm",
    },
    {
      title: `Design the first ${proposalName} user journey`,
      description: "Map the happy path, main empty states, and approval points for a founder-operated MVP.",
      priority: "high",
      role: "designer",
    },
    {
      title: "Draft the technical architecture and test plan",
      description: "Define data model, integration points, deployment assumptions, test coverage, and risks before implementation starts.",
      priority: "high",
      role: "engineer",
    },
    {
      title: "Create launch smoke tests and QA checklist",
      description: "Turn the blueprint into acceptance criteria, release checks, and regression coverage for the initial launch.",
      priority: "medium",
      role: "qa",
    },
    {
      title: "Review security, privacy, and abuse risks",
      description: "Check data exposure, authentication boundaries, secret handling, logging, and founder approval gates.",
      priority: "medium",
      role: "security",
    },
    {
      title: "Plan the first distribution and feedback loop",
      description: "Define the first channel, feedback capture, weekly review metric, and cost guardrail.",
      priority: "medium",
      role: "cmo",
    },
  ];
}

function buildRoutinePlan(): OPCRoutinePlanItem[] {
  return [
    {
      title: "Daily OPC progress review",
      description: "Summarize completed work, blocked items, next decisions, and budget risk for the founder.",
      cadence: "daily",
      role: "ceo",
    },
    {
      title: "Weekly founder retro",
      description: "Review traction evidence, scope creep, customer signal, and next-week priorities.",
      cadence: "weekly",
      role: "ceo",
    },
    {
      title: "Bug triage and release readiness",
      description: "Review new defects, failed checks, risky changes, and release blockers.",
      cadence: "daily",
      role: "qa",
    },
    {
      title: "Customer feedback review",
      description: "Cluster customer feedback, extract product decisions, and update the launch plan.",
      cadence: "weekly",
      role: "cmo",
    },
    {
      title: "Cost and budget check",
      description: "Check model spend, hosting spend, manual workarounds, and whether automation is still worth it.",
      cadence: "weekly",
      role: "cfo",
    },
  ];
}

export function buildBlueprintDraft(text: string): BlueprintDraft {
  const normalized = normalizeText(text);
  const context = projectContextFromText(normalized);
  const sentences = sentenceCandidates(normalized);
  const firstSentence = sentences[0] ?? truncate(normalized, 220);
  const proposalName = inferName(normalized);
  const assumptions = extractLines(
    normalized,
    [/assum/i, /belie(?:f|ve)/i, /expect/i, /should/i, /need/i],
    [
      "The founder can personally reach the first target users.",
      "The first version should prove a narrow workflow before broad automation.",
      "A human approval gate is acceptable before agents create ongoing work.",
    ],
  );
  const risks = extractLines(
    normalized,
    [/risk/i, /concern/i, /hard/i, /uncertain/i, /compliance/i, /security/i, /privacy/i],
    [
      "The proposal may be too broad for a one-person company launch.",
      "The target customer and willingness to pay need sharper evidence.",
      "Automation may hide cost or quality risk unless routines surface it early.",
    ],
  );
  const deliverables = extractLines(
    normalized,
    [/deliver/i, /build/i, /ship/i, /mvp/i, /launch/i, /feature/i],
    [
      "Approved OPC blueprint",
      "Wedge MVP project plan",
      "Agent org chart",
      "Initial issues and operating routines",
    ],
  );
  const isComplex = normalized.length > 8_000 || /enterprise|compliance|payment|marketplace|mobile|ai|agent|workflow/i.test(normalized);

  const projectLabel = hasProjectContext(context)
    ? ` Existing project: ${[context.path, context.link].filter(Boolean).join(" | ")}.`
    : "";
  const modeLabel = context.mode === "take_charge"
    ? "Take-charge mode: create scoped project work, operating routines, and repo-aware agents after approval."
    : "Advise mode: critique the current project first and wait for founder approval before operational takeover.";

  return {
    status: "draft",
    summary: truncate(`${firstSentence}${projectLabel}`, 420),
    targetCustomer: extractLines(
      normalized,
      [/customer/i, /user/i, /founder/i, /team/i, /buyer/i, /persona/i],
      ["A narrowly defined first user segment still needs founder confirmation."],
    )[0],
    mvpWedge: `Ship the smallest ${proposalName} workflow that proves one painful job for one reachable user segment.`,
    uxNotes: hasProjectContext(context)
      ? "Start with current-project diagnosis: show what the project is, what is unclear, and which founder decision is blocking execution. Then convert approved decisions into visible goals, issues, and operating loops."
      : "Use a chat-first coaching flow for ambiguity, then convert decisions into visible goals, issues, and operating loops. Keep the first screen operational, not a marketing page.",
    architectureNotes: [
      "Start with Paperclip-native companies, projects, workspaces, agents, goals, issues, and routines.",
      hasProjectContext(context) ? modeLabel : null,
      "Keep model provider configuration external and make automation auditable through comments, approvals, and recurring review issues.",
    ].filter(Boolean).join(" "),
    risks,
    assumptions,
    deliverables,
    budgetTimeGuesses: {
      timelineWeeks: isComplex ? 6 : 3,
      monthlyBudgetCents: isComplex ? 50000 : 15000,
      confidence: normalized.length > 2_000 ? "medium" : "low",
      rationale: "Estimated from proposal breadth and integration risk; founder should revise after first validation interviews.",
    },
    launchPlan: [
      "Interview 5 target users and cut any non-critical workflow.",
      "Prototype the highest-frequency user journey.",
      "Run QA/security review before public launch.",
      "Ship to a small founder-controlled cohort.",
      "Review feedback, spend, and retention weekly.",
    ],
    agentPlan: DEFAULT_AGENT_PLAN.map((item) => ({ ...item })),
    issuePlan: buildIssuePlan(normalized),
    routinePlan: buildRoutinePlan(),
  };
}

function normalizeBlueprint(row: BlueprintSelect): OPCBlueprint {
  return {
    ...row,
    status: row.status as OPCBlueprint["status"],
    budgetTimeGuesses: row.budgetTimeGuesses as unknown as OPCBlueprint["budgetTimeGuesses"],
    agentPlan: row.agentPlan as unknown as OPCBlueprint["agentPlan"],
    issuePlan: row.issuePlan as unknown as OPCBlueprint["issuePlan"],
    routinePlan: row.routinePlan as unknown as OPCBlueprint["routinePlan"],
  };
}

function normalizeProposal(row: ProposalSelect): ProposalArtifact {
  return {
    ...row,
    sourceType: row.sourceType as ProposalArtifact["sourceType"],
  };
}

function normalizeDecision(row: DecisionSelect): CoachDecision {
  return row;
}

function decodeProposalFile(input: CreateOPCProposal) {
  const sourceType = input.sourceType ?? "paste";
  const explicitText = input.text?.trim();
  if (explicitText) {
    return {
      text: truncate(normalizeText(explicitText), MAX_PROPOSAL_TEXT_CHARS),
      notes: null,
    };
  }
  if (!input.fileContentBase64?.trim()) {
    return {
      text: "",
      notes: null,
    };
  }
  const buffer = Buffer.from(input.fileContentBase64 ?? "", "base64");
  if (sourceType === "txt" || sourceType === "md") {
    return {
      text: truncate(normalizeText(buffer.toString("utf8")), MAX_PROPOSAL_TEXT_CHARS),
      notes: null,
    };
  }
  return {
    text: "",
    notes: `${sourceType.toUpperCase()} binary extraction requires a document parser; resend with extracted text or fileContentBase64 for .txt/.md.`,
  };
}

function roleForAgentPlan(role: string): AgentRole {
  return (AGENT_ROLES as readonly string[]).includes(role) ? role as AgentRole : "general";
}

function cronForCadence(cadence: string) {
  return cadence === "daily" ? "0 9 * * *" : "0 9 * * 1";
}

function companyNameFromBlueprint(blueprint: OPCBlueprint, override?: string) {
  if (override?.trim()) return override.trim();
  const name = inferName(`${blueprint.summary}\n${blueprint.mvpWedge}`);
  return name.endsWith("OPC") ? name : `${name} OPC`;
}

export function opcService(db: Db) {
  const companiesSvc = companyService(db);
  const access = accessService(db);
  const goalsSvc = goalService(db);
  const agentsSvc = agentService(db);
  const issuesSvc = issueService(db);
  const projectsSvc = projectService(db);
  const routinesSvc = routineService(db);

  async function getLatestBlueprint(proposalId: string) {
    const row = await db
      .select()
      .from(opcBlueprints)
      .where(eq(opcBlueprints.proposalId, proposalId))
      .orderBy(asc(opcBlueprints.createdAt))
      .then((rows) => rows.at(-1) ?? null);
    return row ? normalizeBlueprint(row) : null;
  }

  async function getProposalOrThrow(proposalId: string) {
    const proposal = await db
      .select()
      .from(proposalArtifacts)
      .where(eq(proposalArtifacts.id, proposalId))
      .then((rows) => rows[0] ?? null);
    if (!proposal) throw notFound("Proposal not found");
    return normalizeProposal(proposal);
  }

  return {
    createProposal: async (input: CreateOPCProposal, actor: BoardActor) => {
      const decoded = decodeProposalFile(input);
      const projectContext = projectContextFromInput(input);
      const extractedText = composeProposalText(decoded.text, projectContext);
      if (!extractedText) {
        throw unprocessable(decoded.notes ?? "No proposal text could be extracted");
      }
      const [proposal] = await db
        .insert(proposalArtifacts)
        .values({
          sourceType: input.sourceType ?? "paste",
          filename: input.filename ?? null,
          mimeType: input.mimeType ?? null,
          extractedText,
          extractionNotes: decoded.notes,
          createdByUserId: actor.userId ?? "board",
        })
        .returning();

      const draft = buildBlueprintDraft(extractedText);
      const [blueprint] = await db
        .insert(opcBlueprints)
        .values({
          ...draft,
          proposalId: proposal.id,
        })
        .returning();

      return {
        proposal: normalizeProposal(proposal),
        blueprint: normalizeBlueprint(blueprint),
        decisions: [],
      };
    },

    getProposal: async (proposalId: string) => {
      const proposal = await getProposalOrThrow(proposalId);
      const blueprint = await getLatestBlueprint(proposalId);
      const decisions = await db
        .select()
        .from(coachDecisions)
        .where(eq(coachDecisions.proposalId, proposalId))
        .orderBy(asc(coachDecisions.createdAt));
      return {
        proposal,
        blueprint,
        decisions: decisions.map(normalizeDecision),
      };
    },

    chat: async (
      proposalId: string,
      input: { message: string; decision?: { question: string; selectedAnswer: string; rationale?: string | null } },
      actor: BoardActor,
    ): Promise<OPCCoachResponse> => {
      const proposal = await getProposalOrThrow(proposalId);
      let blueprint = await getLatestBlueprint(proposalId);
      if (!blueprint) {
        const [created] = await db
          .insert(opcBlueprints)
          .values({ ...buildBlueprintDraft(proposal.extractedText), proposalId })
          .returning();
        blueprint = normalizeBlueprint(created);
      }

      let decision: CoachDecision | undefined;
      if (input.decision) {
        const [row] = await db
          .insert(coachDecisions)
          .values({
            proposalId,
            blueprintId: blueprint.id,
            question: input.decision.question,
            selectedAnswer: input.decision.selectedAnswer,
            rationale: input.decision.rationale ?? null,
            createdByUserId: actor.userId ?? "board",
          })
          .onConflictDoUpdate({
            target: [coachDecisions.proposalId, coachDecisions.question],
            set: {
              selectedAnswer: input.decision.selectedAnswer,
              rationale: input.decision.rationale ?? null,
              blueprintId: blueprint.id,
              createdByUserId: actor.userId ?? "board",
            },
          })
          .returning();
        decision = normalizeDecision(row);
      }

      // Try real AI coach first, fall back to heuristic
      const aiResult = await callCoachAI({
        proposalText: proposal.extractedText,
        blueprint,
        decisions: await db
          .select()
          .from(coachDecisions)
          .where(eq(coachDecisions.proposalId, proposalId))
          .orderBy(asc(coachDecisions.createdAt)),
        userMessage: input.message,
      });

      let response: string;
      let proposedDecisions: OPCCoachResponse["proposedDecisions"];

      if (aiResult) {
        response = aiResult.response;
        proposedDecisions = aiResult.proposedDecisions;
      } else {
        // Fallback heuristic when no ANTHROPIC_API_KEY is set
        const lower = input.message.toLowerCase();
        const projectContext = projectContextFromText(proposal.extractedText);
        proposedDecisions = [
          {
            question: "Who is the first painfully specific customer?",
            options: ["Founder/operator doing this manually today", "Small team with repeated workflow pain", "Broad consumer audience"],
            recommendation: "Founder/operator doing this manually today",
            rationale: "An OPC should start where the founder can directly reach users and judge quality without a sales team.",
          },
          {
            question: "What should be cut from the first launch?",
            options: ["Admin/config surfaces", "Multi-user permissions", "All non-critical integrations"],
            recommendation: "All non-critical integrations",
            rationale: "The first launch needs proof of one workflow, not complete platform coverage.",
          },
          {
            question: "What is the approval gate before execution?",
            options: ["Founder approves blueprint", "Founder approves every issue", "Agents execute immediately"],
            recommendation: "Founder approves blueprint",
            rationale: "Blueprint approval preserves speed while avoiding direct automation from an unchallenged proposal.",
          },
        ];

        const aiAvailable = isCoachAvailable();
        const emphasis = !aiAvailable
          ? "⚠️ No AI coach configured (set ANTHROPIC_API_KEY). Showing generic heuristic responses. Configure the API key for real coaching."
          : lower.includes("risk") || lower.includes("security")
            ? "The riskiest assumption is not technical execution; it is whether the first user segment is narrow enough to validate quickly."
            : lower.includes("design") || lower.includes("ux")
              ? "The UX should make founder decisions explicit, then turn approved decisions into work objects the company can run."
              : hasProjectContext(projectContext)
                ? projectContext.mode === "take_charge"
                  ? "I would first audit the current project state, then let the company own a narrow backlog instead of generating generic startup tasks."
                  : "I would advise from the current project evidence first, then ask for explicit approval before turning that advice into operational ownership."
              : "I would shrink this to one high-frequency job, one reachable customer segment, and one weekly success metric before creating more work.";

        response = [
          emphasis,
          `Current wedge: ${blueprint.mvpWedge}`,
          "Before execution, answer the customer and scope-cut decisions so the company is not created around vague ambition.",
        ].join("\n\n");
      }

      return {
        response,
        proposedDecisions,
        blueprint,
        ...(decision ? { decision } : {}),
      };
    },

    approveBlueprint: async (proposalId: string, actor: BoardActor) => {
      await getProposalOrThrow(proposalId);
      const blueprint = await getLatestBlueprint(proposalId);
      if (!blueprint) throw notFound("Blueprint not found");
      if (blueprint.status === "company_created") return blueprint;
      const [updated] = await db
        .update(opcBlueprints)
        .set({
          status: "approved",
          approvedAt: new Date(),
          approvedByUserId: actor.userId ?? "board",
          updatedAt: new Date(),
        })
        .where(eq(opcBlueprints.id, blueprint.id))
        .returning();
      return normalizeBlueprint(updated);
    },

    createCompany: async (
      proposalId: string,
      input: CreateOPCCompany,
      actor: BoardActor,
    ): Promise<OPCCreateCompanyResponse> => {
      const proposal = await getProposalOrThrow(proposalId);
      const blueprint = await getLatestBlueprint(proposalId);
      if (!blueprint) throw notFound("Blueprint not found");
      if (blueprint.status !== "approved" && blueprint.status !== "company_created") {
        throw conflict("Approve the OPC blueprint before creating a company");
      }
      if (blueprint.createdCompanyId) {
        const existing = await companiesSvc.getById(blueprint.createdCompanyId);
        if (existing) {
          const [agentRows, goalRows, issueRows, routineRows] = await Promise.all([
            db.select().from(agents).where(eq(agents.companyId, existing.id)),
            db.select().from(goals).where(eq(goals.companyId, existing.id)),
            db.select().from(issues).where(eq(issues.companyId, existing.id)),
            db.select().from(routines).where(eq(routines.companyId, existing.id)),
          ]);
          return {
            company: { id: existing.id, name: existing.name, issuePrefix: existing.issuePrefix },
            agents: agentRows.map((agent) => ({ id: agent.id, name: agent.name, role: agent.role, title: agent.title })),
            goals: goalRows.map((goal) => ({ id: goal.id, title: goal.title })),
            issues: issueRows.map((issue) => ({ id: issue.id, identifier: issue.identifier, title: issue.title })),
            routines: routineRows.map((routine) => ({ id: routine.id, title: routine.title })),
          };
        }
      }

      const company = await companiesSvc.create({
        name: companyNameFromBlueprint(blueprint, input.name),
        description: blueprint.summary,
        budgetMonthlyCents: blueprint.budgetTimeGuesses.monthlyBudgetCents,
      });
      const ownerPrincipalId = actor.userId ?? "local-board";
      await access.ensureMembership(company.id, "user", ownerPrincipalId, "owner", "active");
      await access.ensureRoleDefaultGrants(company.id, ownerPrincipalId, "owner", actor.userId ?? null);

      const companyGoal = await goalsSvc.create(company.id, {
        title: blueprint.mvpWedge,
        description: blueprint.summary,
        level: "company",
        status: "active",
      });
      const projectContext = mergeProjectContext(projectContextFromInput(input), projectContextFromText(proposal.extractedText));
      const agentAdapterConfig = adapterConfigForProject(input, projectContext);

      const createdAgents = [];
      const agentByRole = new Map<string, string>();
      let ceoId: string | null = null;
      for (const item of blueprint.agentPlan) {
        const role = roleForAgentPlan(item.role);
        const agent = await agentsSvc.create(company.id, {
          name: item.name,
          role,
          title: item.title,
          reportsTo: role === "ceo" ? null : ceoId,
          capabilities: item.capabilities,
          adapterType: input.adapterType,
          adapterConfig: agentAdapterConfig,
          metadata: { opcProposalId: proposalId, opcBlueprintId: blueprint.id },
        });
        if (role === "ceo") ceoId = agent.id;
        agentByRole.set(item.role, agent.id);
        agentByRole.set(role, agent.id);
        agentByRole.set(item.name, agent.id);
        createdAgents.push(agent);
        await db
          .insert(agentMemberships)
          .values({
            companyId: company.id,
            agentId: agent.id,
            userId: ownerPrincipalId,
            state: "joined",
          })
          .onConflictDoNothing({
            target: [agentMemberships.companyId, agentMemberships.userId, agentMemberships.agentId],
          });
      }

      const project = hasProjectContext(projectContext)
        ? await projectsSvc.create(company.id, {
            name: projectNameFromContext(projectContext),
            description: [
              "Current project supplied through OPC Intake.",
              projectContext.path ? `Local path: ${projectContext.path}` : null,
              projectContext.link ? `Link: ${projectContext.link}` : null,
              `Mode: ${projectContext.mode}`,
            ].filter(Boolean).join("\n"),
            status: "in_progress",
            goalId: companyGoal.id,
            goalIds: [companyGoal.id],
            leadAgentId: ceoId,
          })
        : null;
      const projectWorkspace = project && (projectContext.path || projectContext.link)
        ? await projectsSvc.createWorkspace(project.id, {
            name: projectContext.path ? "Local workspace" : "Repository workspace",
            sourceType: sourceTypeForProjectWorkspace(projectContext),
            cwd: projectContext.path ?? undefined,
            repoUrl: projectContext.link ?? undefined,
            isPrimary: true,
            metadata: {
              opcProposalId: proposalId,
              opcBlueprintId: blueprint.id,
              opcProjectMode: projectContext.mode,
            },
          })
        : null;

      const createdIssues = [];
      for (const item of blueprint.issuePlan) {
        const assigneeAgentId = agentByRole.get(item.role) ?? agentByRole.get(ROLE_TO_AGENT_NAME[item.role] ?? "") ?? ceoId;
        const issue = await issuesSvc.create(company.id, {
          title: item.title,
          description: item.description,
          status: "todo",
          priority: item.priority as IssuePriority,
          goalId: companyGoal.id,
          projectId: project?.id ?? null,
          projectWorkspaceId: projectWorkspace?.id ?? null,
          assigneeAgentId: assigneeAgentId ?? null,
          createdByUserId: ownerPrincipalId,
          originKind: "manual" as const,
          originId: blueprint.id,
          originFingerprint: `opc:${blueprint.id}:${item.title}`,
        });
        createdIssues.push(issue);
      }

      const createdRoutines = [];
      for (const item of blueprint.routinePlan) {
        const assigneeAgentId = agentByRole.get(item.role) ?? ceoId;
        const routine = await routinesSvc.create(company.id, {
          title: item.title,
          description: item.description,
          projectId: project?.id ?? null,
          goalId: companyGoal.id,
          assigneeAgentId: assigneeAgentId ?? null,
          priority: "medium",
          status: "active",
          concurrencyPolicy: "coalesce_if_active",
          catchUpPolicy: "skip_missed",
          variables: [],
        }, {
          userId: ownerPrincipalId,
          agentId: null,
          runId: null,
        });
        await routinesSvc.createTrigger(routine.id, {
          kind: "schedule",
          label: item.cadence,
          enabled: true,
          cronExpression: cronForCadence(item.cadence),
          timezone: "UTC",
        }, {
          userId: ownerPrincipalId,
          agentId: null,
          runId: null,
        });
        createdRoutines.push(routine);
      }

      await db
        .update(opcBlueprints)
        .set({
          status: "company_created",
          createdCompanyId: company.id,
          updatedAt: new Date(),
        })
        .where(eq(opcBlueprints.id, blueprint.id));
      await db
        .update(proposalArtifacts)
        .set({ createdCompanyId: company.id, updatedAt: new Date() })
        .where(eq(proposalArtifacts.id, proposalId));

      await logActivity(db, {
        companyId: company.id,
        actorType: "user",
        actorId: ownerPrincipalId,
        action: "opc.company_created",
        entityType: "company",
        entityId: company.id,
        details: {
          proposalId,
          blueprintId: blueprint.id,
          agentCount: createdAgents.length,
          issueCount: createdIssues.length,
          routineCount: createdRoutines.length,
        },
      });

      return {
        company: { id: company.id, name: company.name, issuePrefix: company.issuePrefix },
        agents: createdAgents.map((agent) => ({ id: agent.id, name: agent.name, role: agent.role, title: agent.title })),
        goals: [{ id: companyGoal.id, title: companyGoal.title }],
        issues: createdIssues.map((issue) => ({ id: issue.id, identifier: issue.identifier, title: issue.title })),
        routines: createdRoutines.map((routine) => ({ id: routine.id, title: routine.title })),
      };
    },
  };
}
