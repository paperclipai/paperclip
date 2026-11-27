import { agents, companies, companyMemberships, type Db } from "@paperclipai/db";
import { reportingLinePolicySchema } from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import { conflict, forbidden } from "../errors.js";
import type { AgentConfigurationRecord, CreateAgentData } from "../lib/agent-records.js";
import type { AuthorizationActor } from "./authorization.js";

type Report = Pick<AgentConfigurationRecord, "id" | "reportsTo" | "lifecycleState">;
type ReportingGraph = Map<string, Report>;

export async function assertReportingLinePolicyOwner(db: Db, companyId: string, actor: AuthorizationActor) {
  if (actor.type === "board") {
    if (actor.source === "local_implicit" || (actor.isInstanceAdmin && !actor.ignoreInstanceAdmin)) return;
    if (actor.userId) {
      const [owner] = await db.select({ id: companyMemberships.id }).from(companyMemberships).where(and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, actor.userId),
        eq(companyMemberships.membershipRole, "owner"),
        eq(companyMemberships.status, "active"),
      ));
      if (owner) return;
    }
  }
  throw forbidden("Company owner access is required");
}

async function enabledPolicy(db: Db, companyId: string) {
  const [company] = await db.select({ policy: companies.reportingLinePolicy })
    .from(companies).where(eq(companies.id, companyId));
  const policy = reportingLinePolicySchema.safeParse(company?.policy);
  return policy.success && policy.data.enabled ? policy.data : null;
}

async function reportingGraph(db: Db, companyId: string): Promise<ReportingGraph> {
  const records = await db.select({ id: agents.id, reportsTo: agents.reportsTo, lifecycleState: agents.lifecycleState })
    .from(agents).where(eq(agents.companyId, companyId));
  return new Map(records.map(record => [record.id, record]));
}

function ancestors(graph: ReportingGraph, id: string | null) {
  const chain = new Set<string>();
  while (id !== null) {
    const report = graph.get(id);
    if (!report || chain.has(id)) throw conflict("Invalid reporting line");
    chain.add(id);
    id = report.reportsTo;
  }
  return chain;
}

function countsTowardLimit(report: Report) {
  return report.lifecycleState !== "terminated" && report.lifecycleState !== "rejected";
}

function assertAllowedManager(graph: ReportingGraph, actorId: string, managerId: string | null) {
  const manager = managerId === null ? undefined : graph.get(managerId);
  if (!manager || !countsTowardLimit(manager)) {
    throw forbidden("Choose a manager within your reporting line");
  }
  const chain = ancestors(graph, manager.id);
  if (!chain.has(actorId)) throw forbidden("Choose a manager within your reporting line");
  return { id: manager.id, depth: chain.size - 1 };
}

function assertDirectReportLimit(graph: ReportingGraph, managerId: string, maximum: number, excludeId?: string) {
  const reports = Array.from(graph.values()).filter(report =>
    report.reportsTo === managerId && report.id !== excludeId && countsTowardLimit(report));
  if (reports.length >= maximum) throw conflict("Maximum direct reports exceeded");
}

export async function reportingLineForHire(db: Db, companyId: string, hire: CreateAgentData, actorId: string | null | undefined) {
  if (!actorId) return hire.reportsTo;
  const policy = await enabledPolicy(db, companyId);
  if (!policy) return hire.reportsTo;

  const graph = await reportingGraph(db, companyId);
  const manager = assertAllowedManager(graph, actorId, hire.reportsTo === undefined ? actorId : hire.reportsTo);
  if (manager.depth + 1 > policy.maxDepth) throw conflict("Maximum reporting depth exceeded");
  assertDirectReportLimit(graph, manager.id, policy.maxDirectReports, hire.id);
  return manager.id;
}

export async function assertReportingLineMove(
  db: Db, current: AgentConfigurationRecord, managerId: string | null | undefined, actorId: string | null | undefined,
) {
  if (!actorId || managerId === undefined || managerId === current.reportsTo) return;
  const policy = await enabledPolicy(db, current.companyId);
  if (!policy) return;

  const graph = await reportingGraph(db, current.companyId);
  if (actorId === current.id || !ancestors(graph, current.id).has(actorId)) {
    throw forbidden("You can only move agents in your reporting line");
  }
  const manager = assertAllowedManager(graph, actorId, managerId);
  if (countsTowardLimit(current)) assertDirectReportLimit(graph, manager.id, policy.maxDirectReports);
  graph.set(current.id, { id: current.id, reportsTo: manager.id, lifecycleState: current.lifecycleState });
  for (const report of graph.values()) {
    if (!countsTowardLimit(report)) continue;
    const chain = ancestors(graph, report.id);
    if (chain.has(current.id) && chain.size - 1 > policy.maxDepth) {
      throw conflict("Maximum reporting depth exceeded");
    }
  }
}
