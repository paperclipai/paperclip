
import { VALID_PROVIDERS } from '../shared/constants.js';
import { listHermesModels } from './list-models.js';

/**
 * Declarative config schema for Paperclip's schema-driven adapter UI.
 *
 * The goal is not to mirror every raw field one-for-one.
 * The goal is to cover the operational fields an operator actually needs,
 * while still allowing escape hatches through extraArgs and env.
 */
export async function getHermesConfigSchema() {
  const models = await listHermesModels();
  return {
    fields: [
      {
        key: 'model',
        label: 'Model',
        type: 'combobox',
        required: false,
        hint: 'Leave blank to use ~/.hermes/config.yaml default model.',
        options: models.filter((entry) => entry.id).map((entry) => ({ label: entry.label, value: entry.id })),
      },
      {
        key: 'provider',
        label: 'Provider override',
        type: 'select',
        required: false,
        hint: 'Usually leave blank or auto unless you need forced routing. Custom endpoints work best through a dedicated Hermes home/profile.',
        options: VALID_PROVIDERS.map((value) => ({ label: value, value })),
        default: 'auto',
      },
      {
        key: 'hermesHome',
        label: 'Hermes home',
        type: 'text',
        required: false,
        hint: 'Optional alternate Hermes home/profile root. Useful for per-agent setups such as LiteLLM-backed custom endpoints.',
      },
      {
        key: 'hermesCommand',
        label: 'Hermes command',
        type: 'text',
        required: false,
        hint: 'Path or wrapper script. Also accepts command for compatibility with edit flows.',
        default: 'hermes',
      },
      {
        key: 'cwd',
        label: 'Default working directory',
        type: 'text',
        required: false,
      },
      {
        key: 'toolsets',
        label: 'Toolsets',
        type: 'text',
        required: false,
        hint: 'Comma-separated Hermes toolsets such as web,terminal,skills.',
      },
      {
        key: 'instructionsFilePath',
        label: 'Instructions file path',
        type: 'text',
        required: false,
      },
      {
        key: 'promptTemplate',
        label: 'Prompt template',
        type: 'textarea',
        required: false,
      },
      {
        key: 'bootstrapPromptTemplate',
        label: 'Bootstrap prompt template',
        type: 'textarea',
        required: false,
      },
      {
        key: 'timeoutSec',
        label: 'Timeout (seconds)',
        type: 'number',
        required: false,
        default: 1800,
      },
      {
        key: 'graceSec',
        label: 'Grace period (seconds)',
        type: 'number',
        required: false,
        default: 20,
      },
      {
        key: 'maxTurnsPerRun',
        label: 'Max turns per run',
        type: 'number',
        required: false,
      },
      {
        key: 'persistSession',
        label: 'Persist session',
        type: 'toggle',
        required: false,
        default: true,
      },
      {
        key: 'worktreeMode',
        label: 'Use --worktree',
        type: 'toggle',
        required: false,
        default: false,
      },
      {
        key: 'checkpoints',
        label: 'Use --checkpoints',
        type: 'toggle',
        required: false,
        default: false,
      },
      {
        key: 'dangerouslySkipPermissions',
        label: 'Bypass Hermes command approvals',
        type: 'toggle',
        required: false,
        default: true,
        hint: 'Recommended for non-interactive Paperclip child runs. This passes --yolo.',
      },
      {
        key: 'verbose',
        label: 'Verbose stderr',
        type: 'toggle',
        required: false,
        default: false,
      },
      {
        key: 'quiet',
        label: 'Quiet mode',
        type: 'toggle',
        required: false,
        default: false,
        hint: 'Only enable this if you explicitly prefer cleaner output over richer tool transcript lines.',
      },
      {
        key: 'extraArgs',
        label: 'Extra CLI args',
        type: 'text',
        required: false,
        hint: 'Whitespace-delimited extra args appended after the adapter-managed args.',
      },
      {
        key: 'env',
        label: 'Environment variables',
        type: 'textarea',
        required: false,
        hint: 'KEY=value per line when the host UI does not provide envBindings.',
      },
    ],
  };
}
