import { useMemo, useState, type ReactNode } from "react";
import { getUIAdapter } from "../adapters";
import type { AdapterConfigFieldsProps, AdapterConfigSection } from "../adapters/types";
import { ClaudeRuntimePolicyFields } from "../adapters/claude-local/runtime-policy-fields";
import { ClaudeLocalAdvancedFields } from "../adapters/claude-local/config-fields";
import { CollapsibleSection, DraftNumberInput, Field, help } from "./agent-config-primitives";

const inputClass = "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

type Props = {
  fieldProps: AdapterConfigFieldsProps;
  section?: AdapterConfigSection;
  advancedFields?: ReactNode;
  showAdvanced?: boolean;
  showSectionTitles?: boolean;
  includeTimeouts?: boolean;
  schemaKeys?: readonly string[];
  bordered?: boolean;
  children?: ReactNode;
};

function RuntimeFields({ fieldProps, section }: Pick<Props, "fieldProps"> & { section: AdapterConfigSection }) {
  const adapter = useMemo(() => getUIAdapter(fieldProps.adapterType), [fieldProps.adapterType]);
  return <>
    {fieldProps.adapterType === "claude_local" && <ClaudeLocalAdvancedFields {...fieldProps} section={section} />}
    {fieldProps.adapterType === "claude_local" && section === "advanced" && fieldProps.allowedConfigKeys?.has("profileImportMode") && <ClaudeRuntimePolicyFields {...fieldProps} />}
    <adapter.ConfigFields {...fieldProps} section={section} />
  </>;
}

/** Shared provider fields and disclosure chrome for agent and pool settings. */
export function AgentRuntimeConfigSections({ fieldProps, section, advancedFields, showAdvanced = false, showSectionTitles = true, includeTimeouts = false, schemaKeys, bordered, children }: Props) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [policyOpen, setPolicyOpen] = useState(false);
  if (!section) {
    const policyKeys = new Set(["lifecycleMode", "idleTimeoutMs", "mode", "warmHandleIdleMs", "timeoutSec", "graceSec", "codexPermissionMode"]);
    const hasConfiguration = !fieldProps.allowedConfigKeys || [...fieldProps.allowedConfigKeys].some(key => !policyKeys.has(key));
    return <div className="space-y-3">
      {hasConfiguration && <section className="space-y-3">{showSectionTitles && <h3 className="text-sm font-medium">Configuration</h3>}<AgentRuntimeConfigSections fieldProps={fieldProps} section="configuration" showAdvanced={showAdvanced} advancedFields={advancedFields} /></section>}
      <section className="space-y-3">{showSectionTitles && <h3 className="text-sm font-medium">Run Policy</h3>}<AgentRuntimeConfigSections fieldProps={fieldProps} section="runPolicy" includeTimeouts /></section>
    </div>;
  }
  if (section === "configuration") return <>
    <RuntimeFields fieldProps={fieldProps} section="configuration" />
    {showAdvanced && <CollapsibleSection title="Advanced" open={advancedOpen} onToggle={() => setAdvancedOpen(!advancedOpen)}><div className="space-y-3">{advancedFields}<RuntimeFields fieldProps={fieldProps} section="advanced" /></div></CollapsibleSection>}
  </>;
  if (section === "runPolicy") return <CollapsibleSection title="Advanced Run Policy" bordered={bordered} open={policyOpen} onToggle={() => setPolicyOpen(!policyOpen)}><div className="space-y-3">
    <RuntimeFields fieldProps={fieldProps} section="runPolicy" />
    {includeTimeouts && !fieldProps.isCreate && (["timeoutSec", "graceSec"] as const).map(key => (!fieldProps.allowedConfigKeys || fieldProps.allowedConfigKeys.has(key)) && !schemaKeys?.includes(key) && <Field key={key} configKey={key} label={key === "timeoutSec" ? "Timeout (sec)" : "Interrupt grace period (sec)"} hint={help[key]}><DraftNumberInput aria-label={key === "timeoutSec" ? "Timeout (sec)" : "Interrupt grace period (sec)"} value={fieldProps.eff("adapterConfig", key, Number(fieldProps.config[key] ?? (key === "timeoutSec" ? 0 : 15)))} onCommit={value => fieldProps.mark("adapterConfig", key, value)} immediate className={inputClass} /></Field>)}
    {children}
  </div></CollapsibleSection>;
  return <RuntimeFields fieldProps={fieldProps} section={section} />;
}
