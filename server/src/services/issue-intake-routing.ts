import { HttpError } from "../errors.js";
import { companies, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";

export type IntakeRoutingActorType = "user" | "agent";

export interface IntakeRoutingInput {
  companyId: string;
  actorType: IntakeRoutingActorType;
  status: string | null | undefined;
  assigneeAgentId: string | null | undefined;
  assigneeUserId: string | null | undefined;
  parentId: string | null | undefined;
}

export interface IntakeRoutingDeps {
  getCompanyIntakeAgentId: (companyId: string) => Promise<string | null>;
  assertAssignableAgent: (companyId: string, agentId: string) => Promise<void>;
  hasAncestorPassedIntake: (companyId: string, parentIssueId: string, intakeAgentId: string) => Promise<boolean>;
}

export interface IntakeRoutingDecision {
  intakeAgentId: string;
  requestedAssigneeAgentId: string | null;
}

const CLOSED_CREATE_STATUSES = new Set(["done", "cancelled"]);

export async function getCompanyIntakeAgentId(db: Db, companyId: string): Promise<string | null> {
  const [row] = await db.select({ intakeAgentId: companies.intakeAgentId })
    .from(companies).where(eq(companies.id, companyId));
  return row?.intakeAgentId ?? null;
}

export async function resolveIssueIntakeRouting(
  deps: IntakeRoutingDeps,
  input: IntakeRoutingInput,
): Promise<IntakeRoutingDecision | null> {
  if (input.actorType !== "user" || input.assigneeUserId) return null;
  if (input.status && CLOSED_CREATE_STATUSES.has(input.status)) return null;
  const intakeAgentId = await deps.getCompanyIntakeAgentId(input.companyId);
  if (!intakeAgentId || input.assigneeAgentId === intakeAgentId) return null;
  try {
    await deps.assertAssignableAgent(input.companyId, intakeAgentId);
  } catch (error) {
    if (error instanceof HttpError && [404, 409, 422].includes(error.status)) return null;
    throw error;
  }
  const requestedAssigneeAgentId = input.assigneeAgentId ?? null;
  if (requestedAssigneeAgentId && input.parentId && await deps.hasAncestorPassedIntake(input.companyId, input.parentId, intakeAgentId)) return null;
  return { intakeAgentId, requestedAssigneeAgentId };
}

export function intakeRoutingActivityDetails(decision: IntakeRoutingDecision | null): Record<string, unknown> {
  return decision ? { intakeRouted: true, intakeAgentId: decision.intakeAgentId, requestedAssigneeAgentId: decision.requestedAssigneeAgentId } : {};
}
