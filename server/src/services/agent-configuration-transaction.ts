import type { Db } from "@paperclipai/db";
import type { AgentConfigurationPatch, UpdateAgentOptions } from "../lib/agent-records.js";
import { conflict } from "../errors.js";
import { updateAgentConfiguration } from "../modules/agent-lifecycle/configuration.js";
import { createAgentLifecycleEffects } from "./agent-lifecycle.js";

export function updateAgentConfigurationInTransaction(tx: Db, id: string, data: Omit<AgentConfigurationPatch, "budgetMonthlyCents">, options?: UpdateAgentOptions) {
  if (Object.prototype.hasOwnProperty.call(data, "budgetMonthlyCents")) {
    throw conflict("Budget changes require a root lifecycle command");
  }
  return updateAgentConfiguration(tx, createAgentLifecycleEffects(), id, data, options);
}
