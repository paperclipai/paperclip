import type { AdapterConfigSchema } from '@paperclipai/adapter-utils';
import { listDevinBaseModels, type DevinBaseModel } from './models.js';

export async function getConfigSchema(): Promise<AdapterConfigSchema> {
  let discoveryFailed = false;
  const baseModels = await listDevinBaseModels().catch(() => {
    discoveryFailed = true;
    return [] as DevinBaseModel[];
  });
  // On discovery failure, keep the fields VISIBLE (annotated as
  // unavailability-verified) so a stored value never loses its only UI.
  const availabilityHint = discoveryFailed
    ? ' Model catalog is currently unreachable, so availability of this axis is unverified.'
    : '';

  const any1m = discoveryFailed || baseModels.some((b) => b.has1m);
  const anyFast = discoveryFailed || baseModels.some((b) => b.hasFast);
  const anyPriority = discoveryFailed || baseModels.some((b) => b.hasPriority);

  const fields: AdapterConfigSchema['fields'] = [];

  fields.push(
    {
      key: 'command',
      label: 'Devin CLI command',
      type: 'text',
      default: 'devin',
      hint: 'Command or absolute path to the Devin CLI.',
    },
    {
      key: 'cwd',
      label: 'Working directory',
      type: 'text',
      hint: 'Absolute path to the working directory. Devin loads AGENTS.md from this directory.',
    },
    {
      key: 'instructionsFilePath',
      label: 'Instructions file',
      type: 'text',
      hint: 'Devin auto-loads AGENTS.md from the working directory. Any other path is delivered in the prompt: the file content is prepended and its directory named as authoritative for sibling instruction files.',
    },
  );

  if (any1m) {
    fields.push({
      key: 'contextSize',
      label: 'Context size',
      type: 'select',
      default: 'default',
      options: [
        { value: 'default', label: 'Default' },
        { value: '1m', label: '1M' },
      ],
      hint: '1M applies only to models that offer an extended-context variant.' + availabilityHint,
      meta: { renderer: 'segmented' },
    });
  }

  if (anyFast) {
    fields.push({
      key: 'fastMode',
      label: 'Fast',
      type: 'toggle',
      default: false,
      hint: 'Use the faster (higher-cost) lane when the model offers one.' + availabilityHint,
    });
  }

  if (anyPriority) {
    fields.push({
      key: 'priority',
      label: 'Priority',
      type: 'toggle',
      default: false,
      hint: 'Use priority processing when the model offers a priority lane.' + availabilityHint,
    });
  }

  fields.push(
    {
      key: 'permissionMode',
      label: 'Permission mode',
      type: 'select',
      default: 'auto',
      options: [
        { value: 'auto', label: 'auto (CLI default; alias for normal)' },
        { value: 'normal', label: 'normal (interactive approvals)' },
        { value: 'accept-edits', label: 'accept-edits (auto-approve workspace edits)' },
        { value: 'smart', label: 'smart (model-judged approvals; rollout-gated, falls back to normal)' },
        { value: 'dangerous', label: 'dangerous (auto-approve all; alias for bypass)' },
        { value: 'autonomous', label: 'autonomous (requires sandbox; --sandbox implies it)' },
      ],
      hint: 'Forwarded unchanged to the Devin CLI, which validates it. Leave at auto to inherit the CLI default; choose dangerous for fully unattended runs.',
    },
    {
      key: 'respectWorkspaceTrust',
      label: 'Respect workspace trust',
      type: 'toggle',
      default: false,
      hint: 'When false, passes --respect-workspace-trust false so Devin can run in a fresh directory without prompting.',
    },
    {
      key: 'sandbox',
      label: 'Sandbox',
      type: 'toggle',
      default: false,
      hint: 'Enable the Devin OS sandbox. Required for autonomous permission mode.',
    },
    {
      key: 'timeoutSec',
      label: 'Timeout (seconds)',
      type: 'number',
      default: 1800,
      hint: 'Maximum run time before the process is killed.',
    },
    {
      key: 'graceSec',
      label: 'Grace period (seconds)',
      type: 'number',
      default: 15,
      hint: 'Seconds between SIGTERM and SIGKILL.',
    },
    {
      key: 'exportPath',
      label: 'ATIF export path',
      type: 'text',
      hint: 'Optional absolute path for the Devin ATIF transcript. Defaults to a temp file.',
    },
    {
      key: 'extraArgs',
      label: 'Extra Devin args',
      type: 'text',
      hint: 'Additional CLI arguments appended after the managed args (comma or space separated).',
    },
  );

  return { fields };
}
