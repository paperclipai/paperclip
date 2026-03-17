import type { AdapterConfigFieldsProps } from "../types";
import { LocalWorkspaceRuntimeFields } from "../local-workspace-runtime-fields";

export function AmpLocalConfigFields({
  mode,
  isCreate,
  adapterType,
  values,
  set,
  config,
  mark,
  eff,
  models,
}: AdapterConfigFieldsProps) {
  return (
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
  );
}
