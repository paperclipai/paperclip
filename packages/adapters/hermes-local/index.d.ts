import type { AdapterModel, ServerAdapterModule } from "@paperclipai/adapter-utils";

export const type: "hermes_local";
export const label: string;
export const models: AdapterModel[];
export const agentConfigurationDoc: string;
export function createServerAdapter(): ServerAdapterModule;
