import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
} from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";
const selectClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono";

const instructionsFileHint =
  "Absolute path to a markdown file (e.g. AGENTS.md) that defines this agent's behavior. Injected into the prompt at runtime.";
const runtimeHint =
  "Where this agent runs. \"local\" runs the SDK in-process against the workspace cwd. \"cloud\" runs in a Cursor-managed VM against the configured GitHub repo. \"self_hosted\" runs in your own VM pool. New agents default to \"local\"; switch here after creation.";
const repositoryHint =
  "GitHub repository URL the cloud agent should clone. Required for runtime=cloud or self_hosted. Falls back to the workspace's repo URL when blank.";
const refHint =
  "Branch or commit the cloud agent starts from. Defaults to \"main\".";
const enableCallbackHint =
  "Forward the Paperclip API key into the cloud VM environment so the agent can call Paperclip APIs (skill fetch, comments, etc.). Off by default — leaving it off keeps the auth token out of the cloud VM environment.";

type Runtime = "local" | "cloud" | "self_hosted";

function normalizeRuntime(value: unknown): Runtime {
  return value === "cloud" || value === "self_hosted" ? value : "local";
}

export function CursorSdkConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
  hideInstructionsFile,
}: AdapterConfigFieldsProps) {
  // Adapter-specific fields (runtime / repository / ref / enableCallback) only
  // surface in edit mode, where the existing adapterConfig is exposed via
  // eff()/mark(). New agents default to runtime="local" via buildAdapterConfig;
  // switch them to cloud or self_hosted by editing the agent after creation.
  const showAdapterFields = !isCreate;

  const runtime = showAdapterFields
    ? normalizeRuntime(eff("adapterConfig", "runtime", String(config.runtime ?? "local")))
    : "local";
  const isCloudLike = runtime === "cloud" || runtime === "self_hosted";

  return (
    <>
      {!hideInstructionsFile && (
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

      {showAdapterFields && (
        <>
          <Field label="Runtime" hint={runtimeHint}>
            <select
              className={selectClass}
              value={runtime}
              onChange={(e) => mark("adapterConfig", "runtime", e.target.value)}
            >
              <option value="local">local — in-process SDK against workspace cwd</option>
              <option value="cloud">cloud — Cursor-managed VM</option>
              <option value="self_hosted">self_hosted — your own VM pool</option>
            </select>
          </Field>

          {isCloudLike && (
            <>
              <Field label="Repository (cloud)" hint={repositoryHint}>
                <DraftInput
                  value={eff("adapterConfig", "repository", String(config.repository ?? ""))}
                  onCommit={(v) => mark("adapterConfig", "repository", v || undefined)}
                  immediate
                  className={inputClass}
                  placeholder="https://github.com/owner/repo"
                />
              </Field>

              <Field label="Starting ref (cloud)" hint={refHint}>
                <DraftInput
                  value={eff("adapterConfig", "ref", String(config.ref ?? "main"))}
                  onCommit={(v) => mark("adapterConfig", "ref", v || "main")}
                  immediate
                  className={inputClass}
                  placeholder="main"
                />
              </Field>
            </>
          )}

          <Field label="Enable Paperclip API callback (cloud)" hint={enableCallbackHint}>
            <select
              className={selectClass}
              value={config.enableCallback === true ? "on" : "off"}
              onChange={(e) =>
                mark("adapterConfig", "enableCallback", e.target.value === "on" ? true : false)
              }
            >
              <option value="off">off — do not forward PAPERCLIP_API_KEY (default)</option>
              <option value="on">on — forward PAPERCLIP_API_KEY into cloud VM</option>
            </select>
          </Field>
        </>
      )}
    </>
  );
}
