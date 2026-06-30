import { z } from "zod";
import { AGENT_ADAPTER_TYPES } from "./constants.js";

/**
 * Agents Studio / AI Factory
 * --------------------------
 * A company composes "workflows" out of ordered "steps". Each step targets a
 * connector (an internal business system such as IT, HR, Finance, Procurement,
 * SAP, Workday, or Jira) and an action that connector exposes. Steps may be
 * assigned to an agent that performs / supervises the action.
 *
 * The connector + template catalogs below are static metadata shared between the
 * server (validation, template deployment) and the UI (builder palette, gallery).
 */

export const WORKFLOW_CONNECTORS = [
  "core",
  "it",
  "hr",
  "finance",
  "procurement",
  "sap",
  "workday",
  "jira",
] as const;

export type WorkflowConnector = (typeof WORKFLOW_CONNECTORS)[number];

export const WORKFLOW_STATUSES = ["draft", "active", "paused", "archived"] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const WORKFLOW_RUN_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

export const WORKFLOW_STEP_RUN_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
] as const;
export type WorkflowStepRunStatus = (typeof WORKFLOW_STEP_RUN_STATUSES)[number];

export interface ConnectorActionField {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "text";
  required?: boolean;
  placeholder?: string;
}

export interface ConnectorAction {
  key: string;
  label: string;
  description: string;
  /** Inputs the action expects; surfaced as a config form in the builder. */
  fields: ConnectorActionField[];
}

export type IntegratorAuthType = "none" | "api_key" | "oauth2";

export interface ConnectorDefinition {
  key: WorkflowConnector;
  label: string;
  /** Short, human description used in the studio palette + gallery. */
  description: string;
  /** Lucide-react icon name the UI maps to a component. */
  icon: string;
  /** Tailwind-ish accent token (UI maps to a class). */
  accent: string;
  actions: ConnectorAction[];
  /**
   * Whether this connector represents an external enterprise system (an
   * "Integrator" in Moveworks terms) that workflows stitch together. `core`
   * (the agent itself) is not an integrator.
   */
  isIntegrator?: boolean;
  /** Concrete enterprise system this integrator targets, e.g. "ServiceNow". */
  system?: string;
  /** How the integrator authenticates when connected to a company. */
  authType?: IntegratorAuthType;
  /** Credential/config fields collected on connect (e.g. base URL, API token). */
  authFields?: ConnectorActionField[];
}

const f = (
  key: string,
  label: string,
  type: ConnectorActionField["type"] = "string",
  required = false,
  placeholder?: string,
): ConnectorActionField => ({ key, label, type, required, placeholder });

export const CONNECTOR_CATALOG: ConnectorDefinition[] = [
  {
    key: "core",
    label: "Agent",
    description: "Have an internal AI agent reason, draft, review, or decide.",
    icon: "Bot",
    accent: "slate",
    actions: [
      {
        key: "agent.prompt",
        label: "Run agent",
        description: "Invoke an assigned agent with a prompt and capture its output.",
        fields: [f("prompt", "Prompt", "text", true, "Summarize the request and recommend next steps")],
      },
      {
        key: "agent.review",
        label: "Agent review / approval",
        description: "Ask an agent to review prior step output and approve or reject.",
        fields: [f("criteria", "Review criteria", "text", false, "Approve if budget < $5,000")],
      },
      {
        key: "core.notify",
        label: "Notify",
        description: "Send a notification to a person or channel.",
        fields: [f("recipient", "Recipient", "string", true, "#it-ops"), f("message", "Message", "text", true)],
      },
    ],
  },
  {
    key: "it",
    label: "IT / ServiceNow",
    description: "IT service management: tickets, access, provisioning.",
    icon: "Server",
    accent: "blue",
    isIntegrator: true,
    system: "ServiceNow",
    authType: "api_key",
    authFields: [f("baseUrl", "Instance URL", "string", true, "https://acme.service-now.com"), f("apiToken", "API token", "string", true)],
    actions: [
      {
        key: "it.ticket.create",
        label: "Create IT ticket",
        description: "Open an incident or service request in the ITSM tool.",
        fields: [
          f("shortDescription", "Short description", "string", true, "New laptop for new hire"),
          f("category", "Category", "string", false, "hardware"),
          f("priority", "Priority", "string", false, "medium"),
        ],
      },
      {
        key: "it.access.grant",
        label: "Grant system access",
        description: "Provision access to an application or group.",
        fields: [f("user", "User", "string", true), f("system", "System / group", "string", true)],
      },
      {
        key: "it.account.reset",
        label: "Reset account / password",
        description: "Trigger a credential reset for a user.",
        fields: [f("user", "User", "string", true)],
      },
    ],
  },
  {
    key: "hr",
    label: "HR",
    description: "People operations: onboarding, offboarding, records.",
    icon: "Users",
    accent: "rose",
    isIntegrator: true,
    system: "BambooHR",
    authType: "api_key",
    authFields: [f("subdomain", "Subdomain", "string", true, "acme"), f("apiKey", "API key", "string", true)],
    actions: [
      {
        key: "hr.employee.onboard",
        label: "Onboard employee",
        description: "Kick off the onboarding checklist for a new hire.",
        fields: [
          f("employeeName", "Employee name", "string", true),
          f("department", "Department", "string", true),
          f("startDate", "Start date", "string", false, "2026-07-15"),
        ],
      },
      {
        key: "hr.employee.offboard",
        label: "Offboard employee",
        description: "Begin offboarding and revoke access.",
        fields: [f("employeeName", "Employee name", "string", true), f("lastDay", "Last day", "string", false)],
      },
      {
        key: "hr.timeoff.review",
        label: "Review time-off request",
        description: "Route a PTO request for approval.",
        fields: [f("employeeName", "Employee name", "string", true), f("days", "Days", "number", false)],
      },
    ],
  },
  {
    key: "finance",
    label: "Finance",
    description: "Expenses, invoices, approvals, reporting.",
    icon: "DollarSign",
    accent: "emerald",
    isIntegrator: true,
    system: "NetSuite",
    authType: "oauth2",
    authFields: [f("accountId", "Account ID", "string", true), f("clientId", "Client ID", "string", true), f("clientSecret", "Client secret", "string", true)],
    actions: [
      {
        key: "finance.expense.submit",
        label: "Submit expense",
        description: "File an expense report for approval.",
        fields: [
          f("amount", "Amount", "number", true, "1250"),
          f("category", "Category", "string", false, "travel"),
          f("memo", "Memo", "text", false),
        ],
      },
      {
        key: "finance.invoice.approve",
        label: "Approve invoice",
        description: "Route a vendor invoice through approval thresholds.",
        fields: [f("invoiceId", "Invoice ID", "string", true), f("amount", "Amount", "number", false)],
      },
      {
        key: "finance.budget.check",
        label: "Check budget",
        description: "Verify a cost against remaining budget.",
        fields: [f("costCenter", "Cost center", "string", true), f("amount", "Amount", "number", true)],
      },
    ],
  },
  {
    key: "procurement",
    label: "Procurement",
    description: "Requisitions, purchase orders, vendor management.",
    icon: "ShoppingCart",
    accent: "amber",
    isIntegrator: true,
    system: "Coupa",
    authType: "api_key",
    authFields: [f("baseUrl", "Instance URL", "string", true, "https://acme.coupahost.com"), f("apiKey", "API key", "string", true)],
    actions: [
      {
        key: "procurement.requisition.create",
        label: "Create requisition",
        description: "Raise a purchase requisition for goods or services.",
        fields: [
          f("item", "Item / service", "string", true, "Standing desk"),
          f("quantity", "Quantity", "number", false, "1"),
          f("estimatedCost", "Estimated cost", "number", false),
        ],
      },
      {
        key: "procurement.vendor.evaluate",
        label: "Evaluate vendor",
        description: "Score a vendor against procurement criteria.",
        fields: [f("vendor", "Vendor", "string", true)],
      },
    ],
  },
  {
    key: "sap",
    label: "SAP",
    description: "ERP: purchase orders, invoices, materials, status.",
    icon: "Boxes",
    accent: "indigo",
    isIntegrator: true,
    system: "SAP S/4HANA",
    authType: "oauth2",
    authFields: [f("baseUrl", "API base URL", "string", true, "https://acme.s4hana.cloud.sap"), f("clientId", "Client ID", "string", true), f("clientSecret", "Client secret", "string", true)],
    actions: [
      {
        key: "sap.po.create",
        label: "Create purchase order",
        description: "Create a purchase order in SAP.",
        fields: [
          f("vendor", "Vendor", "string", true),
          f("material", "Material", "string", true),
          f("quantity", "Quantity", "number", false),
        ],
      },
      {
        key: "sap.invoice.status",
        label: "Get invoice status",
        description: "Look up the status of an SAP invoice.",
        fields: [f("invoiceId", "Invoice ID", "string", true)],
      },
      {
        key: "sap.goods.receipt",
        label: "Post goods receipt",
        description: "Confirm receipt of goods against a PO.",
        fields: [f("poNumber", "PO number", "string", true)],
      },
    ],
  },
  {
    key: "workday",
    label: "Workday",
    description: "HCM: workers, org, time-off, compensation.",
    icon: "CalendarClock",
    accent: "orange",
    isIntegrator: true,
    system: "Workday",
    authType: "oauth2",
    authFields: [f("tenant", "Tenant", "string", true, "acme"), f("clientId", "Client ID", "string", true), f("clientSecret", "Client secret", "string", true)],
    actions: [
      {
        key: "workday.worker.get",
        label: "Get worker",
        description: "Fetch a worker profile from Workday.",
        fields: [f("workerId", "Worker ID / email", "string", true)],
      },
      {
        key: "workday.timeoff.submit",
        label: "Submit time off",
        description: "Submit a time-off request in Workday.",
        fields: [f("workerId", "Worker ID", "string", true), f("days", "Days", "number", false)],
      },
      {
        key: "workday.position.create",
        label: "Create position",
        description: "Open a new position / requisition in Workday.",
        fields: [f("title", "Title", "string", true), f("department", "Department", "string", false)],
      },
    ],
  },
  {
    key: "jira",
    label: "Jira",
    description: "Issue tracking: create, transition, comment.",
    icon: "ClipboardList",
    accent: "sky",
    isIntegrator: true,
    system: "Atlassian Jira",
    authType: "api_key",
    authFields: [f("baseUrl", "Site URL", "string", true, "https://acme.atlassian.net"), f("email", "Account email", "string", true), f("apiToken", "API token", "string", true)],
    actions: [
      {
        key: "jira.issue.create",
        label: "Create Jira issue",
        description: "Create an issue in a Jira project.",
        fields: [
          f("project", "Project key", "string", true, "OPS"),
          f("summary", "Summary", "string", true),
          f("issueType", "Issue type", "string", false, "Task"),
        ],
      },
      {
        key: "jira.issue.transition",
        label: "Transition issue",
        description: "Move a Jira issue to a new status.",
        fields: [f("issueKey", "Issue key", "string", true, "OPS-123"), f("status", "Target status", "string", true)],
      },
      {
        key: "jira.issue.comment",
        label: "Comment on issue",
        description: "Add a comment to a Jira issue.",
        fields: [f("issueKey", "Issue key", "string", true), f("body", "Comment", "text", true)],
      },
    ],
  },
];

const CONNECTOR_BY_KEY = new Map(CONNECTOR_CATALOG.map((c) => [c.key, c]));

export function getConnector(key: string): ConnectorDefinition | undefined {
  return CONNECTOR_BY_KEY.get(key as WorkflowConnector);
}

export function getConnectorAction(connector: string, action: string): ConnectorAction | undefined {
  return getConnector(connector)?.actions.find((a) => a.key === action);
}

export function isValidConnectorAction(connector: string, action: string): boolean {
  return Boolean(getConnectorAction(connector, action));
}

/** The connectors that represent external enterprise systems (integrators). */
export const INTEGRATOR_CATALOG: ConnectorDefinition[] = CONNECTOR_CATALOG.filter((c) => c.isIntegrator);

export function getIntegrator(key: string): ConnectorDefinition | undefined {
  const c = getConnector(key);
  return c?.isIntegrator ? c : undefined;
}

export const INTEGRATOR_CONNECTION_STATUSES = ["available", "connected", "error"] as const;
export type IntegratorConnectionStatus = (typeof INTEGRATOR_CONNECTION_STATUSES)[number];

/** Per-company integrator state merged with its registry definition (for the UI). */
export interface CompanyIntegrator {
  key: string;
  name: string;
  category: string;
  description: string;
  icon: string;
  authScheme: string;
  /** Credential/config fields to collect on connect (labels only; no values). */
  authFields: Array<{ key: string; label: string; type?: string; required?: boolean; secret?: boolean; placeholder?: string }>;
  /** Actions this system exposes (key + label) for the test/run picker. */
  actions: Array<{ key: string; label: string; description: string; fields: Array<{ key: string; label: string; required?: boolean; placeholder?: string; type?: string }> }>;
  status: IntegratorConnectionStatus;
  /** Non-secret connection config echoed back (secrets redacted). */
  config: Record<string, unknown>;
  connectedAt: string | null;
}

export const integratorConnectInputSchema = z.object({
  config: z.record(z.unknown()).default({}),
});

export const integratorRunActionSchema = z.object({
  action: z.string().trim().min(1).max(120),
  inputs: z.record(z.unknown()).default({}),
});

/** Domains a studio-created agent can specialize in. */
export const AGENT_DOMAINS = ["it", "hr", "finance", "procurement", "general"] as const;
export type AgentDomain = (typeof AGENT_DOMAINS)[number];

export const factoryAgentCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  domain: z.enum(AGENT_DOMAINS).default("general"),
  instructions: z.string().trim().max(4000).default(""),
  allowedIntegrators: z.array(z.enum(WORKFLOW_CONNECTORS)).max(20).default([]),
  adapterType: z.enum(AGENT_ADAPTER_TYPES).default("claude_local"),
});

export type FactoryAgentCreateInput = z.infer<typeof factoryAgentCreateSchema>;

export interface FactoryAgentSummary {
  id: string;
  name: string;
  title: string | null;
  role: string;
  domain: string | null;
  allowedIntegrators: string[];
  isFactoryBuilt: boolean;
}

// ---------------------------------------------------------------------------
// Workflow step + workflow shapes
// ---------------------------------------------------------------------------

export interface WorkflowStep {
  id: string;
  name: string;
  connector: WorkflowConnector;
  action: string;
  /** Optional agent that performs / supervises this step. */
  assigneeAgentId?: string | null;
  /** Free-form config matching the action's fields. */
  config: Record<string, unknown>;
}

export interface AgentWorkflow {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  status: WorkflowStatus;
  steps: WorkflowStep[];
  templateKey: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowStepRunResult {
  stepId: string;
  name: string;
  connector: WorkflowConnector;
  action: string;
  status: WorkflowStepRunStatus;
  detail: string;
}

export interface AgentWorkflowRun {
  id: string;
  companyId: string;
  workflowId: string;
  status: WorkflowRunStatus;
  trigger: string;
  stepResults: WorkflowStepRunResult[];
  startedAt: string;
  finishedAt: string | null;
}

// ---------------------------------------------------------------------------
// Zod validators (used by server routes)
// ---------------------------------------------------------------------------

export const workflowConnectorSchema = z.enum(WORKFLOW_CONNECTORS);

export const workflowStepSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(200),
    connector: workflowConnectorSchema,
    action: z.string().trim().min(1).max(120),
    assigneeAgentId: z.string().uuid().nullish(),
    config: z.record(z.unknown()).default({}),
  })
  .refine((s) => isValidConnectorAction(s.connector, s.action), {
    message: "Unknown connector action",
    path: ["action"],
  });

export const workflowCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullish(),
  status: z.enum(WORKFLOW_STATUSES).optional(),
  steps: z.array(workflowStepSchema).max(50).default([]),
  templateKey: z.string().trim().max(120).nullish(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
});

export const workflowUpdateSchema = workflowCreateSchema.partial();

export const workflowDeployTemplateSchema = z.object({
  templateKey: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(200).optional(),
});

export const workflowRunCreateSchema = z.object({
  trigger: z.string().trim().min(1).max(60).default("manual"),
});

export type WorkflowCreateInput = z.infer<typeof workflowCreateSchema>;
export type WorkflowUpdateInput = z.infer<typeof workflowUpdateSchema>;

// ---------------------------------------------------------------------------
// Deployable templates — the "factory" starter workflows per domain
// ---------------------------------------------------------------------------

export interface WorkflowTemplate {
  key: string;
  name: string;
  description: string;
  category: WorkflowConnector;
  tags: string[];
  steps: Array<Omit<WorkflowStep, "assigneeAgentId">>;
}

let stepSeq = 0;
const step = (
  name: string,
  connector: WorkflowConnector,
  action: string,
  config: Record<string, unknown> = {},
): Omit<WorkflowStep, "assigneeAgentId"> => ({
  id: `s${++stepSeq}`,
  name,
  connector,
  action,
  config,
});

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    key: "it-access-request",
    name: "IT Access Request",
    description: "Employee requests system access; an agent triages, then access is granted and confirmed.",
    category: "it",
    tags: ["IT", "access", "onboarding"],
    steps: [
      step("Triage request", "core", "agent.prompt", {
        prompt: "Review the access request and determine the correct system + approval path.",
      }),
      step("Open IT ticket", "it", "it.ticket.create", { category: "access", priority: "medium" }),
      step("Grant access", "it", "it.access.grant", {}),
      step("Notify requester", "core", "core.notify", { message: "Your access request has been completed." }),
    ],
  },
  {
    key: "hr-employee-onboarding",
    name: "Employee Onboarding",
    description: "End-to-end onboarding: HR record, Workday position, IT provisioning, and a welcome ticket.",
    category: "hr",
    tags: ["HR", "onboarding", "Workday", "IT"],
    steps: [
      step("Create HR record", "hr", "hr.employee.onboard", {}),
      step("Create Workday position", "workday", "workday.position.create", {}),
      step("Provision IT access", "it", "it.access.grant", { system: "Core apps" }),
      step("Open onboarding ticket", "jira", "jira.issue.create", { project: "OPS", issueType: "Task" }),
    ],
  },
  {
    key: "finance-invoice-approval",
    name: "Invoice Approval",
    description: "Agent checks budget, routes invoice for approval, and posts the result back to SAP.",
    category: "finance",
    tags: ["Finance", "SAP", "approval"],
    steps: [
      step("Check budget", "finance", "finance.budget.check", {}),
      step("Agent approval", "core", "agent.review", { criteria: "Approve if within budget and PO matches." }),
      step("Approve invoice", "finance", "finance.invoice.approve", {}),
      step("Update SAP", "sap", "sap.invoice.status", {}),
    ],
  },
  {
    key: "procurement-purchase",
    name: "Procurement to Purchase Order",
    description: "Requisition is created, evaluated, then turned into an SAP purchase order.",
    category: "procurement",
    tags: ["Procurement", "SAP"],
    steps: [
      step("Create requisition", "procurement", "procurement.requisition.create", {}),
      step("Evaluate vendor", "procurement", "procurement.vendor.evaluate", {}),
      step("Budget check", "finance", "finance.budget.check", {}),
      step("Create SAP PO", "sap", "sap.po.create", {}),
    ],
  },
  {
    key: "hr-offboarding",
    name: "Employee Offboarding",
    description: "Offboard a worker: HR record, revoke access, and close out in Jira.",
    category: "hr",
    tags: ["HR", "offboarding", "IT"],
    steps: [
      step("Start offboarding", "hr", "hr.employee.offboard", {}),
      step("Revoke IT access", "it", "it.account.reset", {}),
      step("Close out tasks", "jira", "jira.issue.create", { project: "OPS", summary: "Offboarding checklist" }),
    ],
  },
  {
    key: "workday-timeoff",
    name: "Time-Off Request",
    description: "PTO request reviewed by an agent and submitted to Workday.",
    category: "workday",
    tags: ["Workday", "HR", "PTO"],
    steps: [
      step("Review request", "hr", "hr.timeoff.review", {}),
      step("Agent policy check", "core", "agent.review", { criteria: "Approve if balance available and no blackout." }),
      step("Submit to Workday", "workday", "workday.timeoff.submit", {}),
    ],
  },
];

const TEMPLATE_BY_KEY = new Map(WORKFLOW_TEMPLATES.map((t) => [t.key, t]));

export function getWorkflowTemplate(key: string): WorkflowTemplate | undefined {
  return TEMPLATE_BY_KEY.get(key);
}

// ---------------------------------------------------------------------------
// AI Factory org template — the agents that staff the factory and use the
// Agents Studio to build/run workflows across the connector domains.
// ---------------------------------------------------------------------------

export interface AiFactoryOrgMember {
  /** Stable key for idempotent provisioning + parent references. */
  key: string;
  name: string;
  /** One of AGENT_ROLES (closest fit; titles carry the real specialization). */
  role: string;
  title: string;
  /** Parent member key, or null for the factory root. */
  reportsToKey: string | null;
  /** Connector this agent specializes in (drives workflow assignment), if any. */
  connector: WorkflowConnector | null;
  capabilities: string;
}

/** AGENTS.md body for a factory member — derived from its role, no per-agent files. */
export function factoryAgentInstructions(member: AiFactoryOrgMember): string {
  const reports = member.reportsToKey ? "AI Factory Director" : "— (top of the AI Factory)";
  return `# ${member.name}

**Role:** ${member.title ?? member.name}
**Reports to:** ${reports}

## Mandate
${member.capabilities}

## How you work
- You are an agent in the Paperclip **AI Factory**. Work reaches you as **issues** assigned on the board — pick them up, do the work, update status, and attach results as work products.
- Author and run agent workflows in **Agents Studio** (use the \`agents-studio\` and \`paperclip\` skills).
- Call connected systems through **integrator tools** (\`GET /companies/:id/integrators/tools\`); credentials are injected server-side, so never handle secrets directly.
- Stay in your lane: do only what your mandate covers, and hand off to the right teammate (QA before release, Code Reviewer before merge) instead of expanding scope.
`;
}

export const AI_FACTORY_ORG_TEMPLATE: AiFactoryOrgMember[] = [
  {
    key: "director",
    name: "AI Factory Director",
    role: "ceo",
    title: "AI Factory Director",
    reportsToKey: null,
    connector: null,
    capabilities: "Owns the AI factory; sets priorities and oversees workflow delivery across all domains.",
  },
  {
    key: "workflow-architect",
    name: "Workflow Architect",
    role: "pm",
    title: "Agent Workflow Architect",
    reportsToKey: "director",
    connector: "core",
    capabilities: "Designs and maintains agent workflows in Agents Studio; turns requests into deployable blueprints.",
  },
  {
    key: "it-lead",
    name: "IT Operations Lead",
    role: "devops",
    title: "IT / ServiceNow Operations",
    reportsToKey: "director",
    connector: "it",
    capabilities: "Runs IT service workflows: tickets, access provisioning, account resets.",
  },
  {
    key: "hr-lead",
    name: "HR Operations Lead",
    role: "general",
    title: "HR / Workday Operations",
    reportsToKey: "director",
    connector: "hr",
    capabilities: "Runs HR workflows: onboarding, offboarding, time-off, Workday actions.",
  },
  {
    key: "finance-lead",
    name: "Finance Operations Lead",
    role: "cfo",
    title: "Finance / SAP Operations",
    reportsToKey: "director",
    connector: "finance",
    capabilities: "Runs finance workflows: expenses, invoice approvals, budget checks, SAP postings.",
  },
  {
    key: "procurement-lead",
    name: "Procurement Lead",
    role: "general",
    title: "Procurement / SAP Operations",
    reportsToKey: "director",
    connector: "procurement",
    capabilities: "Runs procurement workflows: requisitions, vendor evaluation, SAP purchase orders.",
  },
  {
    key: "integrations-engineer",
    name: "Integrations Engineer",
    role: "engineer",
    title: "SAP · Workday · Jira Integrations",
    reportsToKey: "director",
    connector: "jira",
    capabilities: "Builds and maintains the SAP, Workday, and Jira connector integrations the workflows call.",
  },
  {
    key: "qa-engineer",
    name: "QA Engineer",
    role: "qa",
    title: "Workflow QA / Test",
    reportsToKey: "director",
    connector: "core",
    capabilities: "Tests produced agents and workflows before release; runs dry-runs and validates outputs.",
  },
  {
    key: "release-manager",
    name: "Release Manager",
    role: "devops",
    title: "Release / Deploy",
    reportsToKey: "director",
    connector: "core",
    capabilities: "Promotes tested workflows to live and owns the deploy step of the factory pipeline.",
  },
  // ponytail: one build node makes this a generalist factory (apps + workflows);
  // QA + Release + Director already serve both lanes. Add a full SDLC team only
  // when this single engineer is a measured bottleneck.
  {
    key: "software-engineer",
    name: "Software Engineer",
    role: "engineer",
    title: "App Build / Refactor",
    reportsToKey: "director",
    connector: "core",
    capabilities: "Builds and refactors applications end to end; the SDLC build lane of the factory.",
  },
  // ponytail: code review + security is a quality/security trust boundary — the
  // one role you never skip. QA tests behavior; this reviews the diff for
  // correctness and security before Release ships it.
  {
    key: "code-reviewer",
    name: "Code Reviewer",
    role: "engineer",
    title: "Code Review / Security",
    reportsToKey: "director",
    connector: "core",
    capabilities: "Reviews produced code for correctness and security before release; the quality gate on the build lane.",
  },
];

