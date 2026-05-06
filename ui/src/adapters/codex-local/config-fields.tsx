import { useTranslation } from "react-i18next";
import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  ToggleField,
  DraftInput,
  help,
} from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";
import { LocalWorkspaceRuntimeFields } from "../local-workspace-runtime-fields";
import {
  CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS,
  isCodexLocalFastModeSupported,
  isCodexLocalManualModel,
} from "@paperclipai/adapter-codex-local";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function CodexLocalConfigFields({
  mode,
  isCreate,
  adapterType,
  values,
  set,
  config,
  eff,
  mark,
  models,
  hideInstructionsFile,
}: AdapterConfigFieldsProps) {
  const { t } = useTranslation("adapters");
  const bypassEnabled =
    config.dangerouslyBypassApprovalsAndSandbox === true || config.dangerouslyBypassSandbox === true;
  const fastModeEnabled = isCreate
    ? Boolean(values!.fastMode)
    : eff("adapterConfig", "fastMode", Boolean(config.fastMode));
  const currentModel = isCreate
    ? String(values!.model ?? "")
    : eff("adapterConfig", "model", String(config.model ?? ""));
  const fastModeManualModel = isCodexLocalManualModel(currentModel);
  const fastModeSupported = isCodexLocalFastModeSupported(currentModel);
  const supportedModelsLabel = CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS.join(", ");
  const fastModeMessage = fastModeManualModel
    ? t("codex_local.fast_mode_manual")
    : fastModeSupported
      ? t("codex_local.fast_mode_supported")
      : t("codex_local.fast_mode_unsupported", { models: supportedModelsLabel });

  return (
    <>
      {!hideInstructionsFile && (
        <Field
          label={t("codex_local.instructions_file")}
          hint={t("codex_local.instructions_file_hint")}
        >
          <div className="flex items-center gap-2">
            <DraftInput
              value={
                isCreate
                  ? values!.instructionsFilePath ?? ""
                  : eff(
                      "adapterConfig",
                      "instructionsFilePath",
                      String(config.instructionsFilePath ?? ""),
                    )
              }
              onCommit={(v) =>
                isCreate
                  ? set!({ instructionsFilePath: v })
                  : mark("adapterConfig", "instructionsFilePath", v || undefined)
              }
              immediate
              className={inputClass}
              placeholder={t("codex_local.instructions_placeholder")}
            />
            <ChoosePathButton />
          </div>
        </Field>
      )}
      <ToggleField
        label={t("codex_local.bypass_sandbox")}
        hint={help.dangerouslyBypassSandbox}
        checked={
          isCreate
            ? values!.dangerouslyBypassSandbox
            : eff(
                "adapterConfig",
                "dangerouslyBypassApprovalsAndSandbox",
                bypassEnabled,
              )
        }
        onChange={(v) =>
          isCreate
            ? set!({ dangerouslyBypassSandbox: v })
            : mark("adapterConfig", "dangerouslyBypassApprovalsAndSandbox", v)
        }
      />
      <ToggleField
        label={t("codex_local.enable_search")}
        hint={help.search}
        checked={
          isCreate
            ? values!.search
            : eff("adapterConfig", "search", !!config.search)
        }
        onChange={(v) =>
          isCreate
            ? set!({ search: v })
            : mark("adapterConfig", "search", v)
        }
      />
      <ToggleField
        label={t("codex_local.fast_mode")}
        hint={help.fastMode}
        checked={fastModeEnabled}
        onChange={(v) =>
          isCreate
            ? set!({ fastMode: v })
            : mark("adapterConfig", "fastMode", v)
        }
      />
      {fastModeEnabled && (
        <div className="rounded-md border border-amber-300/70 bg-amber-50/80 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
          {fastModeMessage}
        </div>
      )}
      <LocalWorkspaceRuntimeFields
        isCreate={isCreate}
        values={values}
        set={set}
        config={config}
        mark={mark}
        eff={eff}
        mode={mode}
        adapterType={adapterType}
        models={models}
      />
    </>
  );
}
