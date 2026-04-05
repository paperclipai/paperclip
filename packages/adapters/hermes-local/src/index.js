
import { ADAPTER_LABEL, ADAPTER_TYPE, DEFAULT_AGENT_CONFIGURATION_DOC } from './shared/constants.js';
import { getStaticHermesModels } from './server/list-models.js';

export const type = ADAPTER_TYPE;
export const label = ADAPTER_LABEL;
export const models = getStaticHermesModels();
export const agentConfigurationDoc = DEFAULT_AGENT_CONFIGURATION_DOC;

export { createServerAdapter } from './server/index.js';
