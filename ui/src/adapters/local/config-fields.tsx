import type { AdapterConfigFieldsProps } from "../types";
import {
  DraftInput,
  DraftNumberInput,
  Field,
} from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";
import { DEFAULT_LOCAL_BASE_URL } from "@paperclipai/adapter-local";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";
const instructionsHint =
  "Absolute path to a markdown file (e.g. AGENTS.md) that defines this agent's behavior.";

type LocalFieldProps = AdapterConfigFieldsProps & {
  schemaValues: Record<string, unknown>;
};

function InstructionsField({ isCreate, values, set, config, eff, mark }: LocalFieldProps) {
  const value = isCreate
    ? values!.instructionsFilePath ?? ""
    : eff("adapterConfig", "instructionsFilePath", String(config.instructionsFilePath ?? ""));
  const commit = (v: string) =>
    isCreate ? set!({ instructionsFilePath: v }) : mark("adapterConfig", "instructionsFilePath", v || undefined);

  return (
    <Field label="Agent instructions file" hint={instructionsHint}>
      <div className="flex items-center gap-2">
        <DraftInput
          value={value}
          onCommit={commit}
          immediate
          className={inputClass}
          placeholder="/absolute/path/to/AGENTS.md"
        />
        <ChoosePathButton />
      </div>
    </Field>
  );
}

function BaseUrlField({ isCreate, values, set, config, eff, mark }: LocalFieldProps) {
  const value = isCreate
    ? values!.url || DEFAULT_LOCAL_BASE_URL
    : eff("adapterConfig", "baseUrl", String(config.baseUrl ?? DEFAULT_LOCAL_BASE_URL));
  const commit = (v: string) =>
    isCreate ? set!({ url: v }) : mark("adapterConfig", "baseUrl", v || undefined);

  return (
    <Field label="Base URL" hint="OpenAI-compatible local inference base URL.">
      <DraftInput value={value} onCommit={commit} immediate className={inputClass} placeholder={DEFAULT_LOCAL_BASE_URL} />
    </Field>
  );
}

function ApiKeyField({ isCreate, values, set, config, eff, mark, schemaValues }: LocalFieldProps) {
  const localApiKey = typeof schemaValues.apiKey === "string" ? schemaValues.apiKey : "";
  const value = isCreate ? localApiKey : eff("adapterConfig", "apiKey", String(config.apiKey ?? ""));
  const commit = (v: string) =>
    isCreate ? set!({ adapterSchemaValues: { ...schemaValues, apiKey: v } }) : mark("adapterConfig", "apiKey", v || undefined);

  return (
    <Field label="API key" hint="Optional bearer token for the local endpoint.">
      <DraftInput
        value={value}
        onCommit={commit}
        immediate
        className={inputClass}
        placeholder="Optional"
        type="password"
      />
    </Field>
  );
}

function FallbackTurnsField({ isCreate, values, set, config, eff, mark }: LocalFieldProps) {
  const value = isCreate
    ? values!.maxTurnsPerRun
    : eff("adapterConfig", "maxTurns", Number(config.maxTurns ?? 0));
  const commit = (v: number) =>
    isCreate ? set!({ maxTurnsPerRun: v }) : mark("adapterConfig", "maxTurns", v || undefined);

  return (
    <Field label="Fallback max turns" hint="Passed to claude_local when local inference is unavailable.">
      <DraftNumberInput value={value} onCommit={commit} className={inputClass} placeholder="0" />
    </Field>
  );
}

export function LocalConfigFields(props: AdapterConfigFieldsProps) {
  const schemaValues = props.values?.adapterSchemaValues ?? {};
  const fieldProps = { ...props, schemaValues };

  return (
    <>
      {!props.hideInstructionsFile && <InstructionsField {...fieldProps} />}
      <BaseUrlField {...fieldProps} />
      <ApiKeyField {...fieldProps} />
      <FallbackTurnsField {...fieldProps} />
    </>
  );
}
