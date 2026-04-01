import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
  DraftNumberInput,
} from "../../components/agent-config-primitives";
import { ClaudeLocalConfigFields } from "../claude-local/config-fields";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function ClaudeContainerConfigFields(props: AdapterConfigFieldsProps) {
  const { isCreate, config, eff, mark } = props;
  return (
    <>
      <ClaudeLocalConfigFields {...props} />
      <Field label="Docker image" hint="Container image for agent execution">
        {isCreate ? (
          <DraftInput
            value=""
            onCommit={() => {}}
            immediate
            className={inputClass}
            placeholder="nanoclaw-agent:latest"
          />
        ) : (
          <DraftInput
            value={eff("adapterConfig", "image", String(config.image ?? "nanoclaw-agent:latest"))}
            onCommit={(v) => mark("adapterConfig", "image", v || "nanoclaw-agent:latest")}
            immediate
            className={inputClass}
            placeholder="nanoclaw-agent:latest"
          />
        )}
      </Field>
      <Field label="Memory limit (MB)" hint="Container memory limit in megabytes">
        {isCreate ? (
          <input
            type="number"
            className={inputClass}
            defaultValue={2048}
            placeholder="2048"
          />
        ) : (
          <DraftNumberInput
            value={eff("adapterConfig", "memoryMb", Number(config.memoryMb ?? 2048))}
            onCommit={(v) => mark("adapterConfig", "memoryMb", v || 2048)}
            immediate
            className={inputClass}
          />
        )}
      </Field>
      <Field label="CPU limit" hint="Container CPU limit (e.g. 1.5)">
        {isCreate ? (
          <input
            type="number"
            step="0.5"
            className={inputClass}
            defaultValue={1.5}
            placeholder="1.5"
          />
        ) : (
          <DraftNumberInput
            value={eff("adapterConfig", "cpus", Number(config.cpus ?? 1.5))}
            onCommit={(v) => mark("adapterConfig", "cpus", v || 1.5)}
            immediate
            className={inputClass}
          />
        )}
      </Field>
      <Field label="Docker network" hint="Docker network for container communication">
        {isCreate ? (
          <DraftInput
            value=""
            onCommit={() => {}}
            immediate
            className={inputClass}
            placeholder="pkb-net"
          />
        ) : (
          <DraftInput
            value={eff("adapterConfig", "network", String(config.network ?? "pkb-net"))}
            onCommit={(v) => mark("adapterConfig", "network", v || "pkb-net")}
            immediate
            className={inputClass}
            placeholder="pkb-net"
          />
        )}
      </Field>
    </>
  );
}
