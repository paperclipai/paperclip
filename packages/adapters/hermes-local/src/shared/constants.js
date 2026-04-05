
/**
 * Shared constants for the Hermes ↔ Paperclip adapter.
 *
 * The adapter is intentionally conservative:
 * - it prefers explicit configuration over inference,
 * - it exports helpers that are easy to unit-test,
 * - and it keeps runtime side effects isolated to a few server modules.
 */

export const ADAPTER_TYPE = 'hermes_local';
export const ADAPTER_LABEL = 'Hermes Agent';

export const HERMES_DEFAULT_COMMAND = 'hermes';
export const DEFAULT_TIMEOUT_SEC = 1800;
export const DEFAULT_GRACE_SEC = 20;
export const DEFAULT_REASONING_EFFORT = 'medium';
export const DEFAULT_PROVIDER = 'auto';
export const DEFAULT_MODEL = 'anthropic/claude-sonnet-4';
export const MODELS_CACHE_TTL_MS = 60_000;
export const MODEL_DISCOVERY_TIMEOUT_SEC = 20;

export const VALID_PROVIDERS = [
  'auto',
  'openrouter',
  'nous',
  'openai-codex',
  'copilot-acp',
  'copilot',
  'anthropic',
  'huggingface',
  'zai',
  'kimi-coding',
  'minimax',
  'minimax-cn',
  'kilocode',
  'alibaba',
  'deepseek',
  'opencode-zen',
  'opencode-go',
  'ai-gateway',
  'main',
  'custom',
];

/**
 * Providers accepted by the installed Hermes CLI's `hermes chat --provider`.
 *
 * Hermes also supports additional provider ids through config.yaml and runtime
 * resolution, but those values hard-fail if passed as a CLI flag on v0.7.0.
 * The adapter must avoid forwarding unsupported ids via `--provider`.
 */
export const CLI_PROVIDER_FLAG_VALUES = new Set([
  'auto',
  'openrouter',
  'nous',
  'openai-codex',
  'copilot-acp',
  'copilot',
  'anthropic',
  'huggingface',
  'zai',
  'kimi-coding',
  'minimax',
  'minimax-cn',
  'kilocode',
]);

/**
 * Prefix hints are a last resort only.
 * They are intentionally opinionated and can be overridden by:
 * 1. adapterConfig.provider
 * 2. ~/.hermes/config.yaml model.provider when the model matches
 */
export const MODEL_PREFIX_PROVIDER_HINTS = [
  ['anthropic/', 'anthropic'],
  ['openai/', 'openai-codex'],
  ['gpt-5', 'copilot'],
  ['gpt-4', 'openai-codex'],
  ['o1-', 'openai-codex'],
  ['o3-', 'openai-codex'],
  ['o4-', 'openai-codex'],
  ['claude', 'anthropic'],
  ['glm-', 'zai'],
  ['kimi', 'kimi-coding'],
  ['moonshot', 'kimi-coding'],
  ['minimax', 'minimax'],
  ['qwen', 'alibaba'],
  ['deepseek', 'deepseek'],
  ['huggingface/', 'huggingface'],
  ['hermes-', 'nous'],
];

export const KNOWN_PROVIDER_ENV_KEYS = {
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
  openrouter: ['OPENROUTER_API_KEY'],
  'openai-codex': ['OPENAI_API_KEY'],
  copilot: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
  'copilot-acp': ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
  nous: ['HERMES_INFERENCE_PROVIDER'],
  huggingface: ['HF_TOKEN'],
  zai: ['GLM_API_KEY', 'ZAI_API_KEY', 'Z_AI_API_KEY'],
  'kimi-coding': ['KIMI_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  'minimax-cn': ['MINIMAX_CN_API_KEY'],
  kilocode: ['KILOCODE_API_KEY'],
  alibaba: ['DASHSCOPE_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  'opencode-zen': ['OPENCODE_ZEN_API_KEY'],
  'opencode-go': ['OPENCODE_GO_API_KEY'],
  'ai-gateway': ['AI_GATEWAY_API_KEY'],
  main: ['OPENAI_BASE_URL', 'OPENAI_API_KEY'],
  custom: ['OPENAI_BASE_URL', 'OPENAI_API_KEY'],
};

export const TOOL_NAME_MAP = {
  '$': 'shell',
  exec: 'shell',
  terminal: 'shell',
  read: 'read',
  write: 'write',
  patch: 'patch',
  search: 'search',
  fetch: 'fetch',
  crawl: 'crawl',
  navigate: 'browser',
  snapshot: 'browser',
  click: 'browser',
  type: 'browser',
  scroll: 'browser',
  press: 'browser',
  back: 'browser',
  close: 'browser',
  vision: 'browser',
  browser_navigate: 'browser',
  browser_click: 'browser',
  browser_type: 'browser',
  browser_scroll: 'browser',
  browser_snapshot: 'browser',
  browser_press: 'browser',
  browser_back: 'browser',
  browser_close: 'browser',
  browser_vision: 'browser',
  web_search: 'search',
  web_extract: 'fetch',
  session_search: 'recall',
  memory: 'memory',
  recall: 'recall',
  plan: 'plan',
  delegate: 'delegate',
};

export const DEFAULT_AGENT_CONFIGURATION_DOC = `# Hermes Agent configuration

This adapter runs Hermes Agent as a local Paperclip employee runtime.

## Core fields

- model: explicit provider/model value. If empty, the adapter reads ~/.hermes/config.yaml.
- provider: optional explicit provider override. Usually leave blank.
- hermesCommand: binary or wrapper script to execute. Also accepts command for edit-path compatibility.
- cwd: default working directory if Paperclip does not provide one.
- timeoutSec / graceSec: child process runtime limits.
- persistSession: reuse Hermes sessions across Paperclip heartbeats.
- worktreeMode: pass --worktree to Hermes.
- checkpoints: pass --checkpoints to Hermes.
- toolsets: comma-separated Hermes toolsets.
- extraArgs: raw extra Hermes CLI args.
- env: extra environment variables merged into the child process.
- instructionsFilePath: optional agent instructions file injected ahead of the wake prompt.
- bootstrapPromptTemplate: prepended only when starting a fresh session.
- promptTemplate: main wake prompt template.
- dangerouslySkipPermissions: when true, the adapter passes --yolo because Paperclip runs the child non-interactively.

## Approval handling

This adapter is approval-aware:
- approval wake payloads become environment variables and prompt sections,
- /agent-hires is treated as the correct board-gated hiring path,
- revision / rejection / approval wakes are supported in the prompt template,
- and the adapter can create a local notification file for newly approved hires.

## Skills

The adapter can copy bundled Paperclip companion skills into ~/.hermes/skills/paperclip/
and can also enumerate existing Hermes user skills from ~/.hermes/skills/.
`;
