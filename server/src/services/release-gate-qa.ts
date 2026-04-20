import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies } from "@paperclipai/db";
import { resolveReleaseGateQaAgent } from "@paperclipai/shared";

type CompanyReleaseGateQaResolution = ReturnType<typeof resolveReleaseGateQaAgent> & {
  configuredAgentId: string | null;
};

type ResolvableDb = Pick<Db, "select">;

type QaAgentRow = {
  id: string;
  companyId: string;
  role: string | null;
  status: string | null;
  name: string | null;
  title: string | null;
};

function releaseGateQaBlockingReason(
  resolution: CompanyReleaseGateQaResolution["resolution"],
) {
  switch (resolution) {
    case "configured_unavailable":
      return "Configured release-gate QA owner is unavailable.";
    case "none":
      return "No eligible QA agent is available for the release gate.";
    case "ambiguous":
      return "Release-gate QA ownership is ambiguous and must be configured explicitly.";
    default:
      return null;
  }
}

export async function resolveCompanyReleaseGateQaAgent(
  db: ResolvableDb,
  companyId: string,
) {
  const [companyRow, qaAgents] = await Promise.all([
    db
      .select({
        id: companies.id,
        releaseGateQaAgentId: companies.releaseGateQaAgentId,
      })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null),
    db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        role: agents.role,
        status: agents.status,
        name: agents.name,
        title: agents.title,
      })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.role, "qa"))),
  ]);

  const resolution = resolveReleaseGateQaAgent(qaAgents, {
    configuredAgentId: companyRow?.releaseGateQaAgentId ?? null,
  });
  return {
    ...resolution,
    configuredAgentId: companyRow?.releaseGateQaAgentId ?? null,
    blockingReason: releaseGateQaBlockingReason(resolution.resolution),
  };
}

export async function listCompanyReleaseGateQaResolutionMap(
  db: ResolvableDb,
  companyIds: string[],
) {
  const uniqueCompanyIds = Array.from(new Set(companyIds.filter(Boolean)));
  if (uniqueCompanyIds.length === 0) {
    return new Map<string, CompanyReleaseGateQaResolution & { blockingReason: string | null }>();
  }

  const [companyRows, qaAgentRows] = await Promise.all([
    db
      .select({
        id: companies.id,
        releaseGateQaAgentId: companies.releaseGateQaAgentId,
      })
      .from(companies)
      .where(inArray(companies.id, uniqueCompanyIds)),
    db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        role: agents.role,
        status: agents.status,
        name: agents.name,
        title: agents.title,
      })
      .from(agents)
      .where(and(inArray(agents.companyId, uniqueCompanyIds), eq(agents.role, "qa"))),
  ]);

  const qaAgentsByCompanyId = new Map<string, QaAgentRow[]>();
  for (const agent of qaAgentRows) {
    const existing = qaAgentsByCompanyId.get(agent.companyId) ?? [];
    existing.push(agent);
    qaAgentsByCompanyId.set(agent.companyId, existing);
  }

  const resolutionMap = new Map<string, CompanyReleaseGateQaResolution & { blockingReason: string | null }>();
  for (const company of companyRows) {
    const resolution = resolveReleaseGateQaAgent(qaAgentsByCompanyId.get(company.id) ?? [], {
      configuredAgentId: company.releaseGateQaAgentId ?? null,
    });
    resolutionMap.set(company.id, {
      ...resolution,
      configuredAgentId: company.releaseGateQaAgentId ?? null,
      blockingReason: releaseGateQaBlockingReason(resolution.resolution),
    });
  }

  return resolutionMap;
}
