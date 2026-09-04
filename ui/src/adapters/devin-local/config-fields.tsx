import type { AdapterConfigFieldsProps } from '../types';
import {
  Field,
  ToggleField,
  DraftInput,
} from '../../components/agent-config-primitives';
import { ChoosePathButton } from '../../components/PathInstructionsModal';

// The board's native "Permissions & Configuration" section renders Model and
// Thinking effort for local adapters, so this component only contributes the
// devin-specific extras: 1M context, fast, priority, permission mode, and cwd.
// Instructions come from AGENTS.md in the working directory; there is no
// instructions-file field for this adapter.

const inputClass =
  'w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40';

const CONTEXT_SIZES = [
  { value: 'default', label: 'Default' },
  { value: '1m', label: '1M' },
];

// The vendor-documented mode set (essential-commands.mdx): normal (alias:
// auto, the CLI default), accept-edits, smart (rollout-gated; the CLI warns
// and falls back to normal when unavailable), dangerous (aliases: yolo,
// bypass), autonomous (requires --sandbox). The adapter forwards the value
// unchanged and the CLI validates it, so this list mirrors the tool.
const PERMISSION_MODES = [
  { value: 'auto', label: 'auto' },
  { value: 'normal', label: 'normal' },
  { value: 'accept-edits', label: 'accept-edits' },
  { value: 'smart', label: 'smart' },
  { value: 'dangerous', label: 'dangerous' },
  { value: 'autonomous', label: 'autonomous' },
];

function Segmented({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="inline-flex flex-wrap gap-1 rounded-md border border-border p-0.5">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={
              'rounded px-2.5 py-1 text-sm transition-colors ' +
              (active
                ? 'bg-accent text-accent-foreground'
                : 'bg-transparent text-muted-foreground hover:text-foreground')
            }
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function DevinLocalConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  const extra = (key: string, fallback: string): string =>
    isCreate
      ? String(values!.adapterSchemaValues?.[key] ?? fallback)
      : eff(
          'adapterConfig',
          key,
          String((config as Record<string, unknown>)[key] ?? fallback),
        );

  const setExtra = (key: string, value: unknown) => {
    if (isCreate) {
      set!({
        adapterSchemaValues: {
          ...(values!.adapterSchemaValues ?? {}),
          [key]: value,
        },
      });
    } else {
      mark('adapterConfig', key, value);
    }
  };

  const contextSize = extra('contextSize', 'default');
  // Normalize CLI aliases to their canonical modes so previously stored
  // configs (e.g. permissionMode: "bypass") highlight the right segment
  // instead of falling through to the `auto` fallback.
  const rawPermissionMode = extra('permissionMode', 'auto');
  const permissionMode =
    rawPermissionMode === 'yolo' || rawPermissionMode === 'bypass'
      ? 'dangerous'
      : rawPermissionMode;
  const fastMode = isCreate
    ? Boolean(values!.adapterSchemaValues?.fastMode)
    : Boolean(eff('adapterConfig', 'fastMode', Boolean(config.fastMode)));
  const priority = isCreate
    ? Boolean(values!.adapterSchemaValues?.priority)
    : Boolean(eff('adapterConfig', 'priority', Boolean(config.priority)));

  return (
    <>
      <Field
        label="Context size"
        hint="1M applies only to models that offer an extended-context variant."
      >
        <Segmented
          options={CONTEXT_SIZES}
          value={contextSize === '1m' ? '1m' : 'default'}
          onChange={(v) => setExtra('contextSize', v)}
        />
      </Field>

      <ToggleField
        label="Fast"
        hint="Use the faster (higher-cost) lane when the model offers one."
        checked={fastMode}
        onChange={(v) => setExtra('fastMode', v)}
      />

      <ToggleField
        label="Priority"
        hint="Use priority processing when the model offers a priority lane."
        checked={priority}
        onChange={(v) => setExtra('priority', v)}
      />

      <Field
        label="Permission mode"
        hint="Forwarded unchanged to the Devin CLI. auto inherits the CLI default; dangerous suits fully unattended runs; autonomous requires Sandbox enabled."
      >
        <Segmented
          options={PERMISSION_MODES}
          value={
            PERMISSION_MODES.some((p) => p.value === permissionMode)
              ? permissionMode
              : 'auto'
          }
          onChange={(v) => setExtra('permissionMode', v)}
        />
      </Field>

      <ToggleField
        label="Sandbox"
        hint="Run the Devin OS sandbox; implies the autonomous permission mode."
        checked={isCreate ? Boolean(values!.adapterSchemaValues?.sandbox) : Boolean(eff('adapterConfig', 'sandbox', Boolean(config.sandbox)))}
        onChange={(v) => setExtra('sandbox', v)}
      />

      <ToggleField
        label="Respect workspace trust"
        hint="Off by default so Devin runs unattended in fresh directories without a trust prompt."
        checked={isCreate ? Boolean(values!.adapterSchemaValues?.respectWorkspaceTrust) : Boolean(eff('adapterConfig', 'respectWorkspaceTrust', Boolean(config.respectWorkspaceTrust)))}
        onChange={(v) => setExtra('respectWorkspaceTrust', v)}
      />

      <Field label="Working directory" hint="Absolute path. Defaults to $HOME.">
        <div className="flex items-center gap-2">
          <DraftInput
            value={
              isCreate
                ? (values!.cwd ?? '')
                : eff('adapterConfig', 'cwd', String(config.cwd ?? ''))
            }
            onCommit={(v) =>
              isCreate
                ? set!({ cwd: v })
                : mark('adapterConfig', 'cwd', v || undefined)
            }
            immediate
            className={inputClass}
            placeholder="/Users/you/project"
          />
          <ChoosePathButton />
        </div>
      </Field>

      <Field label="ATIF export path" hint="Optional absolute path; each run writes <name>-<runId>.atif alongside it.">
        <DraftInput
          value={isCreate ? String(values!.adapterSchemaValues?.exportPath ?? '') : eff('adapterConfig', 'exportPath', String(config.exportPath ?? ''))}
          onCommit={(v) => isCreate ? set!({ adapterSchemaValues: { ...(values!.adapterSchemaValues ?? {}), exportPath: v } }) : mark('adapterConfig', 'exportPath', v || undefined)}
          immediate
          className={inputClass}
          placeholder="/Users/you/runs/devin.atif"
        />
      </Field>

      <Field label="Extra Devin args" hint="Additional CLI args (comma or space separated), appended before --prompt-file.">
        <DraftInput
          value={isCreate ? String(values!.adapterSchemaValues?.extraArgs ?? '') : eff('adapterConfig', 'extraArgs', Array.isArray(config.extraArgs) ? (config.extraArgs as string[]).join(', ') : String(config.extraArgs ?? ''))}
          onCommit={(v) => isCreate ? set!({ adapterSchemaValues: { ...(values!.adapterSchemaValues ?? {}), extraArgs: v } }) : mark('adapterConfig', 'extraArgs', v || undefined)}
          immediate
          className={inputClass}
          placeholder="--verbose, --some-flag value"
        />
      </Field>
    </>
  );
}
