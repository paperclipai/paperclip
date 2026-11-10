import { agents, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { badRequest, forbidden, notFound } from "../errors.js";
import { assertEnvironmentSelectionForCompany } from "./environment-selection.js";
import { environmentService } from "./environments.js";
import { instanceSettingsService } from "./instance-settings.js";

/** Validate a login's transport target without changing credential ownership. */
export async function assertLoginEnvironmentTarget(db: Db, input: {
  companyId: string; environmentId: string; agentId?: string; adapterType?: string;
}) {
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
    return environment;
  }
  if (input.adapterType && !["codex_local", "claude_local"].includes(input.adapterType)) throw badRequest("This provider login is not supported on agent computers.", { code: "login_adapter_unsupported" });
  if (!input.agentId) throw badRequest("Select an agent computer for sign-in.", { code: "login_agent_required" });
  const [agent] = await db.select().from(agents).where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId))).limit(1);
  if (!agent || agent.companyId !== input.companyId) throw notFound("Agent not found");
  const inherited = agent.defaultEnvironmentId ?? (await instanceSettingsService(db).get()).defaultEnvironmentId;
  if (inherited !== environment.id || agent.adapterType !== "paperclip_runner" || !["ready", "verifying"].includes(agent.lifecycleState)) {
    throw badRequest("The selected agent computer is not available for sign-in.", { code: "login_agent_unavailable" });
  }
  return environment;
}
