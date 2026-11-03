import { buildAdapterEnvConfig } from "@paperclipai/adapter-utils";
import type { AdapterConfigFieldsProps, AdapterConfigSection } from "../types";
import { DraftInput, Field } from "../../components/agent-config-primitives";

const inputClass = "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm";

export function ClaudeRuntimePolicyFields({
  isCreate, values, set, config, eff, mark, displayDefaults,
}: AdapterConfigFieldsProps & { configSection?: AdapterConfigSection }) {
  const env = isCreate ? buildAdapterEnvConfig(values!.envBindings, values!.envVars) : eff("adapterConfig", "env", config.env ?? {}) as Record<string, unknown>;
  const plain = (key: string) => {
    const binding = env[key];
    return typeof binding === "string" ? binding : binding && typeof binding === "object" && "type" in binding &&
      binding.type === "plain" && "value" in binding && typeof binding.value === "string" ? binding.value : undefined;
  };
  const inherited = !isCreate && env === config.env ? displayDefaults : undefined;
  const envMode = plain("PAPERCLIP_CLAUDE_PLUGIN_IMPORT_MODE")?.trim().toLowerCase();
  const legacyMode = envMode && ["off", "copy", "cache"].includes(envMode) ? envMode : inherited?.profileImportMode;
  const envRetention = plain("PAPERCLIP_MANAGED_CLAUDE_TRANSCRIPT_RETENTION_ENABLED");
  const legacyRetention = envRetention === "true" || envRetention === "false" ? envRetention : inherited?.transcriptRetentionEnabled;
  const envDays = Number(plain("PAPERCLIP_MANAGED_CLAUDE_TRANSCRIPT_RETENTION_DAYS"));
  const legacyDays = Number.isInteger(envDays) && envDays >= 1 ? envDays : inherited?.transcriptRetentionDays;
  const mode = isCreate ? values!.claudeProfileImportMode : eff("adapterConfig", "profileImportMode", config.profileImportMode as string | undefined);
  const source = isCreate ? values!.claudeProfileSourceDir : eff("adapterConfig", "profileSourceDir", config.profileSourceDir as string | undefined);
  const retention = isCreate ? values!.claudeTranscriptRetentionEnabled : eff("adapterConfig", "transcriptRetentionEnabled", config.transcriptRetentionEnabled as boolean | undefined);
  const days = isCreate ? values!.claudeTranscriptRetentionDays : eff("adapterConfig", "transcriptRetentionDays", config.transcriptRetentionDays as number | undefined);
  return <>
    <Field label="Local Claude skills and plugins" hint="Import enabled plugins and skills from a trusted local Claude profile. Plugin hooks run with this agent's permissions. Authentication stays separate. Applies to local managed CLI and ACP runs.">
      <select aria-label="Local Claude skills and plugins" className={inputClass}
        value={mode ?? "inherit"}
        onChange={(event) => {
          const value = event.target.value === "inherit" ? undefined : event.target.value as "off" | "copy" | "cache";
          isCreate ? set!({ claudeProfileImportMode: value }) : mark("adapterConfig", "profileImportMode", value);
        }}>
        <option value="inherit">Use environment/default{typeof legacyMode === "string" && ["off", "copy", "cache"].includes(legacyMode) ? ` (currently ${legacyMode})` : " (off if unset)"}</option>
        <option value="off">Off</option><option value="copy">Copy for each run</option><option value="cache">Cache per agent</option>
      </select>
    </Field>
    <Field label="Claude profile source directory" hint="Optional local source for the import. Unset uses the existing environment setting or automatic discovery. Clear an explicitly set path to use automatic discovery. The source is never modified or deleted.">
      <DraftInput value={source ?? ""} immediate className={inputClass} placeholder="Automatic / existing environment setting"
        onCommit={(value) => isCreate ? set!({ claudeProfileSourceDir: value }) : mark("adapterConfig", "profileSourceDir", value)} />
    </Field>
    <Field label="Keep Claude session transcripts" hint="Keep transcripts per agent, task and account so a later run can resume. Credentials remain temporary. Local processes running as the same OS user can access each other's files. Requires a generated managed HOME and config directory.">
      <select aria-label="Keep Claude session transcripts" className={inputClass} value={retention === undefined ? "inherit" : retention ? "on" : "off"}
        onChange={(event) => { const value = event.target.value === "inherit" ? undefined : event.target.value === "on";
          isCreate ? set!({ claudeTranscriptRetentionEnabled: value }) : mark("adapterConfig", "transcriptRetentionEnabled", value);
        }}>
        <option value="inherit">Use environment/instance default{legacyRetention === true || legacyRetention === "true" ? " (currently on)" : legacyRetention === false || legacyRetention === "false" ? " (currently off)" : ""}</option><option value="off">Off</option><option value="on">On</option>
      </select>
    </Field>
    <Field label="Claude transcript retention days" hint="Delete retained transcripts after a task has been closed and unused for this many days. Unset uses the environment/instance default. A change takes effect when the task next runs.">
      <input aria-label="Claude transcript retention days" type="number" min={1} step={1} className={inputClass} value={days ?? ""} placeholder={legacyDays === undefined ? "Environment / instance default" : `Environment / instance default (${legacyDays} days)`}
        onChange={(event) => { const value = event.target.value === "" ? undefined : Number(event.target.value);
          isCreate ? set!({ claudeTranscriptRetentionDays: value }) : mark("adapterConfig", "transcriptRetentionDays", value);
        }} />
    </Field>
  </>;
}
