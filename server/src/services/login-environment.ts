import { agents, environmentLeases, type Db } from "@paperclipai/db";
import { and, asc, eq, isNull, notExists, notInArray, or, sql } from "drizzle-orm";
import { badRequest, forbidden, notFound } from "../errors.js";
import { assertEnvironmentSelectionForCompany } from "./environment-selection.js";
import { environmentService } from "./environments.js";
import { instanceSettingsService } from "./instance-settings.js";

type LoginEnvironmentTarget = { companyId: string; environmentId: string; agentId?: string; adapterType?: string };

export async function assertLoginEnvironmentTarget(db: Db, input: LoginEnvironmentTarget) {
  return (await resolveLoginEnvironmentTarget(db, input)).environment;
}

/** Resolve the transport target once at start. Subsequent lease checks use its exact agent ID. */
export async function resolveLoginEnvironmentTarget(
  db: Db,
  input: LoginEnvironmentTarget & { selectComputer?: boolean },
) {
  const environments = environmentService(db);
  await assertEnvironmentSelectionForCompany(environments, input.companyId, input.environmentId, {
    allowedDrivers: ["sandbox", "plugin"],
  });
  const environment = await environments.getById(input.environmentId);
  if (!environment) throw notFound("Environment not found");
  const companies = await environments.listBoundCompanyIds(environment.id);
  if (companies.length && !companies.includes(input.companyId)) throw forbidden("The selected environment belongs to another company.", { code: "environment_company_mismatch" });
  if (environment.driver !== "plugin") {
    if (input.agentId) throw badRequest("A temporary sandbox login does not take an agent computer target.");
    return { environment, agentId: undefined };
  }
  if (input.adapterType && !["codex_local", "claude_local"].includes(input.adapterType)) throw badRequest("This provider login is not supported on agent computers.", { code: "login_adapter_unsupported" });
  if (!input.agentId) {
    if (!input.selectComputer) throw badRequest("Select an agent computer for sign-in.", { code: "login_agent_required" });
    const settings = await instanceSettingsService(db).get();
    const matchesEnvironment = eq(agents.defaultEnvironmentId, environment.id);
    const activeLogin = db.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
      eq(environmentLeases.companyId, input.companyId),
      eq(environmentLeases.environmentId, environment.id),
      eq(environmentLeases.status, "active"),
      sql`${environmentLeases.metadata}->>'purpose' = 'login'`,
      sql`${environmentLeases.metadata}->>'agentId' = ${agents.id}::text`,
    ));
    const [agent] = await db.select({ id: agents.id }).from(agents).where(and(
      eq(agents.companyId, input.companyId),
      eq(agents.adapterType, "paperclip_runner"),
      notExists(activeLogin),
      settings.defaultEnvironmentId === environment.id
        ? or(matchesEnvironment, isNull(agents.defaultEnvironmentId))
        : matchesEnvironment,
      or(
        and(eq(agents.lifecycleState, "ready"), notInArray(agents.status, ["paused", "terminated", "pending_approval"])),
        and(eq(agents.lifecycleState, "verifying"), notInArray(agents.status, ["terminated", "pending_approval"])),
      ),
    )).orderBy(asc(agents.lifecycleState), asc(agents.id)).limit(1);
    if (!agent) throw badRequest("No agent computer is available for sign-in.", { code: "login_agent_unavailable" });
    return { environment, agentId: agent.id };
  }
  const [agent] = await db.select().from(agents).where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId))).limit(1);
  if (!agent || agent.companyId !== input.companyId) throw notFound("Agent not found");
  const inherited = agent.defaultEnvironmentId ?? (await instanceSettingsService(db).get()).defaultEnvironmentId;
  if (inherited !== environment.id || agent.adapterType !== "paperclip_runner" || !["ready", "verifying"].includes(agent.lifecycleState)) {
    throw badRequest("The selected agent computer is not available for sign-in.", { code: "login_agent_unavailable" });
  }
  return { environment, agentId: agent.id };
}
