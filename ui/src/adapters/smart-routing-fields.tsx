import type { AdapterConfigFieldsProps } from "./types";
import {
  Field,
  ToggleField,
  DraftInput,
} from "../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

interface SmartRoutingConfig {
  enabled?: boolean;
  cheapModel?: string;
  cheapThinkingEffort?: string;
  maxPreflightTurns?: number;
  allowInitialProgressComment?: boolean;
}

function readRouting(raw: unknown): SmartRoutingConfig {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    return raw as SmartRoutingConfig;
  }
  return {};
}

/**
 * Shared smart-model-routing config fields for local adapters.
 *
 * Create mode: values flow through `adapterSchemaValues.smartModelRouting`.
 * Edit mode:   values flow through `adapterConfig.smartModelRouting`.
 *
 * Both codex-local and claude-local build-config.ts files already parse the
 * resulting nested object, so no server-side changes are needed.
 */
export function SmartModelRoutingFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  /* ---- read current config ---- */
  const routing: SmartRoutingConfig = isCreate
    ? readRouting(values?.adapterSchemaValues?.smartModelRouting)
    : readRouting(
        eff(
          "adapterConfig",
          "smartModelRouting",
          (config.smartModelRouting ?? {}) as Record<string, unknown>,
        ),
      );

  const enabled = routing.enabled === true;

  /* ---- write helper (replaces whole nested object) ---- */
  const update = (patch: Partial<SmartRoutingConfig>) => {
    const next: SmartRoutingConfig = { ...routing, ...patch };
    if (isCreate && set && values) {
      set({
        adapterSchemaValues: {
          ...values.adapterSchemaValues,
          smartModelRouting: next,
        },
      });
    } else {
      mark("adapterConfig", "smartModelRouting", next);
    }
  };

  return (
    <>
      <ToggleField
        label="Smart model routing"
        hint="Run a cheap preflight phase (orientation, triage, optional progress comment) before the primary model. Reduces cost on fresh issue runs."
        checked={enabled}
        onChange={(v) => update({ enabled: v })}
      />
      {enabled && (
        <>
          <Field
            label="Cheap model"
            hint="Model ID for the preflight phase (e.g. o4-mini, claude-sonnet-4-20250514)."
          >
            <DraftInput
              value={routing.cheapModel ?? ""}
              onCommit={(v) => update({ cheapModel: v || undefined })}
              immediate
              className={inputClass}
              placeholder="e.g. o4-mini"
            />
          </Field>
          <Field
            label="Cheap thinking effort"
            hint="Optional reasoning effort for the cheap model (e.g. low, medium). Leave blank to use the model default."
          >
            <DraftInput
              value={routing.cheapThinkingEffort ?? ""}
              onCommit={(v) =>
                update({ cheapThinkingEffort: v || undefined })
              }
              immediate
              className={inputClass}
              placeholder="e.g. low"
            />
          </Field>
          <ToggleField
            label="Allow initial progress comment"
            hint="Let the preflight phase post an early progress comment on the issue before the primary model starts."
            checked={routing.allowInitialProgressComment ?? false}
            onChange={(v) => update({ allowInitialProgressComment: v })}
          />
        </>
      )}
    </>
  );
}