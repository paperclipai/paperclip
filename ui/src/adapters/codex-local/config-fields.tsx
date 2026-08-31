import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  ToggleField,
  DraftInput,
  DraftNumberInput,
  help,
} from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";
import { LocalWorkspaceRuntimeFields } from "../local-workspace-runtime-fields";
import {
  CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS,
  isCodexLocalFastModeSupported,
  isCodexLocalManualModel,
} from "@paperclipai/adapter-codex-local";
import {
  PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES,
  type PaperclipRunnerPermissionMode,
  type PaperclipRunnerProvider,
} from "@paperclipai/adapter-utils";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";
const instructionsFileHint =
  "Absolute path to a markdown file (e.g. AGENTS.md) that defines this agent's behavior. Injected into the system prompt at runtime. Note: Codex may still auto-apply repo-scoped AGENTS.md files from the workspace.";

const acpxModelByAgent = {
  pi: "openrouter/deepseek/deepseek-v4-flash-0731",
  claude: "claude-sonnet-5",
} as const;

type QualifiedRunnerProvider = Extract<
  PaperclipRunnerProvider,
  "codex" | "opencode" | "acpx"
>;

function isQualifiedRunnerProvider(
  value: unknown,
): value is QualifiedRunnerProvider {
  return value === "codex" || value === "opencode" || value === "acpx";
}

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
  managedSandboxOnly,
}: AdapterConfigFieldsProps) {
  const runnerManaged = adapterType === "paperclip_runner";
  // The execution engine picks which binary runs on the execution host, and the
  // ACP sub-fields below name host paths. The platform-managed environment owns
  // both, so the managed-sandbox-only policy hides them the same way
  // `runnerManaged` already does for the Paperclip Runner.
  const hideEngineChoice = runnerManaged || managedSandboxOnly === true;
  const runnerProvider = runnerManaged
    ? isCreate
      ? values!.paperclipRunnerProvider ?? "codex"
      : eff("adapterConfig", "provider", String(config.provider ?? "codex"))
    : "codex";
  const qualifiedRunnerProvider = isQualifiedRunnerProvider(runnerProvider)
    ? runnerProvider
    : null;
  const normalizedRunnerProvider: QualifiedRunnerProvider =
    qualifiedRunnerProvider ?? "codex";
  const codexRunner = runnerManaged && qualifiedRunnerProvider === "codex";
  const openCodeRunner = runnerManaged && runnerProvider === "opencode";
  const acpxRunner = runnerManaged && runnerProvider === "acpx";
  const rawAcpxAgent = acpxRunner
    ? isCreate
      ? values!.paperclipRunnerAcpxAgent ?? "pi"
      : eff("adapterConfig", "acpxAgent", String(config.acpxAgent ?? "pi"))
    : "pi";
  const acpxAgent = rawAcpxAgent === "pi" || rawAcpxAgent === "claude"
    ? rawAcpxAgent
    : null;
  const permissionCapability =
    PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES[normalizedRunnerProvider];
  const permissionMode = permissionCapability.configurable
    ? isCreate
      ? String(
          (values as unknown as Record<string, unknown>)[
            permissionCapability.configKey
          ] ?? permissionCapability.defaultMode,
        )
      : eff(
          "adapterConfig",
          permissionCapability.configKey,
          String(
            config[permissionCapability.configKey] ??
              permissionCapability.defaultMode,
          ),
        )
    : permissionCapability.defaultMode;
  const runnerLifecycleMode = runnerManaged
    ? isCreate
      ? values!.paperclipRunnerLifecycleMode ?? "per_turn"
      : eff(
          "adapterConfig",
          "lifecycleMode",
          String(config.lifecycleMode ?? "per_turn"),
        )
    : "per_turn";
  const rawEngine = runnerManaged ? "cli" : isCreate
    ? values!.codexEngine ?? "auto"
    : eff("adapterConfig", "engine", String(config.engine ?? "auto"));
  const engine = rawEngine === "acp" || rawEngine === "cli" ? rawEngine : "auto";
  const acpSelected = engine === "acp";
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
    ? "Fast mode will be passed through for this manual model. If Codex rejects it, turn the toggle off."
    : fastModeSupported
      ? "Fast mode consumes credits/tokens much faster than standard Codex runs."
      : `Fast mode currently only works on ${supportedModelsLabel} or manual model IDs. Paperclip will ignore this toggle until the model is switched.`;

  return (
    <>
      {!hideEngineChoice && <Field label="Execution engine" hint="Auto uses ACP when prerequisites pass and falls back to Codex CLI with diagnostics.">
        <select
          className={inputClass}
          value={engine}
          onChange={(e) => {
            const value = e.target.value === "acp" ? "acp" : e.target.value === "cli" ? "cli" : "auto";
            isCreate
              ? set!({ codexEngine: value })
              : mark("adapterConfig", "engine", value === "auto" ? undefined : value);
          }}
        >
          <option value="auto">Auto (ACP preferred)</option>
          <option value="cli">Codex CLI</option>
          <option value="acp">ACP</option>
        </select>
      </Field>}
      {runnerManaged && (
        <Field label="Provider" hint="The runner persists this provider with each run so recovery cannot drift after configuration changes.">
          <select
            className={inputClass}
            value={qualifiedRunnerProvider ?? "unavailable"}
            onChange={(event) => {
              const provider = isQualifiedRunnerProvider(event.target.value)
                ? event.target.value
                : "codex";
              if (isCreate) {
                set!({
                  paperclipRunnerProvider: provider,
                  ...(provider === "opencode" && !values!.model
                    ? { model: "openrouter/deepseek/deepseek-v4-flash-0731" }
                    : {}),
                  ...(provider === "acpx" && !values!.model
                    ? { paperclipRunnerAcpxAgent: "pi", model: acpxModelByAgent.pi }
                    : {}),
                });
              } else {
                mark("adapterConfig", "provider", provider);
                if (provider === "opencode" && !String(config.model ?? "")) {
                  mark("adapterConfig", "model", "openrouter/deepseek/deepseek-v4-flash-0731");
                }
                if (provider === "acpx" && !String(config.model ?? "")) {
                  mark("adapterConfig", "acpxAgent", "pi");
                  mark("adapterConfig", "model", acpxModelByAgent.pi);
                }
              }
            }}
          >
            {!qualifiedRunnerProvider && (
              <option value="unavailable" disabled>
                Saved provider unavailable in this release
              </option>
            )}
            <option value="codex">Codex</option>
            <option value="opencode">OpenCode 1.18.17</option>
            <option value="acpx">ACPX</option>
          </select>
        </Field>
      )}
      {acpxRunner && (
        <Field label="ACP agent" hint="Qualified ACP server profile. Changing the profile starts a fresh provider session.">
          <select
            className={inputClass}
            value={acpxAgent ?? "unavailable"}
            onChange={(event) => {
              const agent = event.target.value === "claude"
                ? "claude"
                : "pi";
              if (isCreate) {
                set!({ paperclipRunnerAcpxAgent: agent, model: acpxModelByAgent[agent] });
              } else {
                mark("adapterConfig", "acpxAgent", agent);
                mark("adapterConfig", "model", acpxModelByAgent[agent]);
              }
            }}
          >
            {!acpxAgent && (
              <option value="unavailable" disabled>
                Saved ACP agent unavailable in this release
              </option>
            )}
            <option value="pi">Pi via ACPX</option>
            <option value="claude">Claude via ACPX</option>
          </select>
        </Field>
      )}
      {runnerManaged && qualifiedRunnerProvider && permissionCapability.configurable && (
        <Field
          label="Permission mode"
          hint={`${permissionCapability.description} Full auto does not widen Paperclip's workspace, network, credential, or planning boundaries.`}
        >
          <select
            className={inputClass}
            value={permissionMode}
            onChange={(event) => {
              const value = permissionCapability.options.some((option) => option.value === event.target.value)
                ? event.target.value as PaperclipRunnerPermissionMode
                : permissionCapability.defaultMode;
              isCreate
                ? set!({ [permissionCapability.configKey]: value })
                : mark("adapterConfig", permissionCapability.configKey, value);
            }}
          >
            {permissionCapability.options.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </Field>
      )}
      {runnerManaged && qualifiedRunnerProvider && !permissionCapability.configurable && (
        <Field label="Permission mode" hint={permissionCapability.description}>
          <div className="text-sm text-muted-foreground">Provider-managed full auto</div>
        </Field>
      )}
      {runnerManaged && (
        <Field label="Runner lifecycle" hint="Turn by turn suspends after each run. Warm keeps the same provider process available between governed runs.">
          <select
            className={inputClass}
            value={runnerLifecycleMode}
            onChange={(event) => {
              const value = event.target.value === "warm" ? "warm" : "per_turn";
              isCreate
                ? set!({ paperclipRunnerLifecycleMode: value })
                : mark("adapterConfig", "lifecycleMode", value);
            }}
          >
            <option value="per_turn">Turn by turn</option>
            <option value="warm">Warm session</option>
          </select>
        </Field>
      )}
      {runnerManaged && runnerLifecycleMode === "warm" && (
        <Field label="Warm idle timeout (ms)" hint="After this much inactivity, runnerd checkpoints and suspends the provider session.">
          {isCreate ? (
            <input
              type="number"
              min={1}
              className={inputClass}
              value={values!.paperclipRunnerIdleTimeoutMs ?? 300_000}
              onChange={(event) => set!({ paperclipRunnerIdleTimeoutMs: Math.max(1, Number(event.target.value)) })}
            />
          ) : (
            <DraftNumberInput
              value={eff("adapterConfig", "idleTimeoutMs", Number(config.idleTimeoutMs ?? 300_000))}
              onCommit={(value) => mark("adapterConfig", "idleTimeoutMs", Math.max(1, value || 300_000))}
              immediate
              className={inputClass}
            />
          )}
        </Field>
      )}
      {openCodeRunner && (
        <Field label="OpenCode command" hint="The OpenCode executable. Version 1.18.17 is qualified for this runner.">
          <DraftInput
            value={
              isCreate
                ? values!.command ?? ""
                : eff("adapterConfig", "command", String(config.command ?? ""))
            }
            onCommit={(value) =>
              isCreate
                ? set!({ command: value })
                : mark("adapterConfig", "command", value || undefined)
            }
            immediate
            className={inputClass}
            placeholder="opencode"
          />
        </Field>
      )}
      {acpSelected && (
        <>
          {!managedSandboxOnly && (
            <Field
              label="ACP server command"
              hint="Optional override for the Codex ACP server command. Defaults to the package-local codex-acp binary."
            >
              <DraftInput
                value={
                  isCreate
                    ? values!.codexAcpAgentCommand ?? ""
                    : eff("adapterConfig", "agentCommand", String(config.agentCommand ?? ""))
                }
                onCommit={(v) =>
                  isCreate
                    ? set!({ codexAcpAgentCommand: v })
                    : mark("adapterConfig", "agentCommand", v || undefined)
                }
                immediate
                className={inputClass}
                placeholder="codex-acp"
              />
            </Field>
          )}
          <Field label="ACP session mode" hint="Persistent keeps ACP session state between runs. One-shot starts fresh each run.">
            <select
              className={inputClass}
              value={
                isCreate
                  ? values!.codexAcpMode ?? "persistent"
                  : eff("adapterConfig", "mode", String(config.mode ?? "persistent"))
              }
              onChange={(e) => {
                const value = e.target.value === "oneshot" ? "oneshot" : "persistent";
                isCreate
                  ? set!({ codexAcpMode: value })
                  : mark("adapterConfig", "mode", value);
              }}
            >
              <option value="persistent">Persistent</option>
              <option value="oneshot">One-shot</option>
            </select>
          </Field>
          <Field
            label="ACP non-interactive permissions"
            hint="Fallback if the ACP agent asks for input outside an interactive session."
          >
            <select
              className={inputClass}
              value={
                isCreate
                  ? values!.codexAcpNonInteractivePermissions ?? "deny"
                  : eff("adapterConfig", "nonInteractivePermissions", String(config.nonInteractivePermissions ?? "deny"))
              }
              onChange={(e) => {
                const value = e.target.value === "fail" ? "fail" : "deny";
                isCreate
                  ? set!({ codexAcpNonInteractivePermissions: value })
                  : mark("adapterConfig", "nonInteractivePermissions", value);
              }}
            >
              <option value="deny">Deny</option>
              <option value="fail">Fail</option>
            </select>
          </Field>
          {!managedSandboxOnly && (
            <Field
              label="ACP state directory"
              hint="Optional ACP session state directory. Defaults to Paperclip-managed organization/agent scoped storage."
            >
              <div className="flex items-center gap-2">
                <DraftInput
                  value={
                    isCreate
                      ? values!.codexAcpStateDir ?? ""
                      : eff("adapterConfig", "stateDir", String(config.stateDir ?? ""))
                  }
                  onCommit={(v) =>
                    isCreate
                      ? set!({ codexAcpStateDir: v })
                      : mark("adapterConfig", "stateDir", v || undefined)
                  }
                  immediate
                  className={inputClass}
                  placeholder="/path/to/acp-state"
                />
                <ChoosePathButton />
              </div>
            </Field>
          )}
          <Field
            label="ACP warm process idle ms"
            hint="Defaults to 0, which closes the ACP process after each run while retaining persistent session state."
          >
            {isCreate ? (
              <input
                type="number"
                className={inputClass}
                value={values!.codexAcpWarmHandleIdleMs ?? 0}
                onChange={(e) => set!({ codexAcpWarmHandleIdleMs: Number(e.target.value) })}
              />
            ) : (
              <DraftNumberInput
                value={eff(
                  "adapterConfig",
                  "warmHandleIdleMs",
                  Number(config.warmHandleIdleMs ?? 0),
                )}
                onCommit={(v) => mark("adapterConfig", "warmHandleIdleMs", v || 0)}
                immediate
                className={inputClass}
              />
            )}
          </Field>
        </>
      )}
      {!runnerManaged && !hideInstructionsFile && (
        <Field label="Agent instructions file" hint={instructionsFileHint}>
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
              placeholder="/absolute/path/to/AGENTS.md"
            />
            <ChoosePathButton />
          </div>
        </Field>
      )}
      {!runnerManaged && !openCodeRunner && <ToggleField
          label="Bypass sandbox"
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
        />}
      {(!runnerManaged || codexRunner) && <ToggleField
          label="Enable search"
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
        />}
      {(!runnerManaged || codexRunner) && <ToggleField
          label="Fast mode"
          hint={help.fastMode}
          checked={fastModeEnabled}
          onChange={(v) =>
            isCreate
              ? set!({ fastMode: v })
              : mark("adapterConfig", "fastMode", v)
          }
        />}
      {(!runnerManaged || codexRunner) && fastModeEnabled && (
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
