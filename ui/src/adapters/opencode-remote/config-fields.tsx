import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
} from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function OpenCodeRemoteConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  return (
    <>
      <Field label="OpenCode server URL" hint="Base URL of the OpenCode HTTP server (e.g. http://codev:5400)">
        <DraftInput
          value={
            isCreate
              ? values!.url ?? ""
              : eff("adapterConfig", "url", String(config.url ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ url: v })
              : mark("adapterConfig", "url", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="http://codev:5400"
        />
      </Field>
      <Field label="Project directory" hint="Directory on the OpenCode server filesystem (e.g. /home/coder/src)">
        <DraftInput
          value={
            isCreate
              ? values!.directory ?? ""
              : eff("adapterConfig", "directory", String(config.directory ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ directory: v })
              : mark("adapterConfig", "directory", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="/home/coder/src"
        />
      </Field>
      <Field label="Provider ID" hint="AI provider ID (e.g. anthropic). Default: anthropic">
        <DraftInput
          value={
            isCreate
              ? values!.providerID ?? ""
              : eff("adapterConfig", "providerID", String(config.providerID ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ providerID: v })
              : mark("adapterConfig", "providerID", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="anthropic"
        />
      </Field>
      <Field label="Agent instructions file" hint="Path to markdown instructions file, resolved relative to Paperclip agent cwd">
        <DraftInput
          value={
            isCreate
              ? values!.instructionsFilePath ?? ""
              : eff("adapterConfig", "instructionsFilePath", String(config.instructionsFilePath ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ instructionsFilePath: v })
              : mark("adapterConfig", "instructionsFilePath", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="/workspace/agents/my-agent/AGENTS.md"
        />
      </Field>
    </>
  );
}
