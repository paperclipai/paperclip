import { models as claudeModels } from "@paperclipai/adapter-claude-local";
import { models as codexModels } from "@paperclipai/adapter-codex-local";
import { models as cursorModels } from "@paperclipai/adapter-cursor-local";

export const type = "sandbox";
export const label = "Sandboxed Agent";

export const models = [
  ...claudeModels.map((model) => ({ ...model, label: `Claude: ${model.label}` })),
  ...codexModels.map((model) => ({ ...model, label: `Codex: ${model.label}` })),
  ...cursorModels.map((model) => ({ ...model, label: `Cursor: ${model.label}` })),
];

export const agentConfigurationDoc = `# sandbox agent configuration

Adapter: sandbox

Core fields:
- sandboxAgentType (string, required): claude_local | codex_local | opencode_local | pi_local | cursor
- providerType (string, required): cloudflare | e2b | opensandbox
- providerConfig.baseUrl (string, Cloudflare only): URL of the sandbox gateway
- providerConfig.namespace (string, Cloudflare only, optional): sandbox namespace, default "paperclip"
- providerConfig.instanceType (string, Cloudflare only, optional): container size like lite | standard | heavy
- providerConfig.template (string, E2B only): template or snapshot with the target CLI installed
- providerConfig.domain (string, E2B/OpenSandbox optional): provider API domain override
- providerConfig.image (string, Cloudflare/OpenSandbox): container image with the target CLI installed
- keepAlive (boolean, optional): keep sandbox/session alive across heartbeats

Inner agent fields mirror the matching local adapter where practical:
- cwd
- instructionsFilePath
- promptTemplate
- bootstrapPromptTemplate
- command
- model
- effort | modelReasoningEffort | variant | mode
- extraArgs
- env
- timeoutSec
- graceSec
`;
