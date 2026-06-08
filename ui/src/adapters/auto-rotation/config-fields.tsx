import type { AdapterConfigFieldsProps } from "../types";
import { Field } from "../../components/agent-config-primitives";

const selectClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm placeholder:text-muted-foreground/40";

/**
 * Config UI for the `auto_rotation` adapter.
 *
 * Auto rotation runs whichever provider (Claude or Codex) the account-pool
 * balancer picks each heartbeat. The only per-agent knob is the PREFERRED
 * provider, used as a fallback when neither pool has an active account yet.
 * Per-provider model selection is intentionally omitted for now — each
 * sub-adapter uses its own default model.
 */
export function AutoRotationConfigFields({ isCreate, config, eff, mark }: AdapterConfigFieldsProps) {
  const preferred = isCreate
    ? "claude"
    : eff("adapterConfig", "preferredProvider", String(config.preferredProvider ?? "claude"));

  return (
    <>
      <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
        This agent rotates across the <strong>Claude</strong> and <strong>Codex</strong> account pools
        plus the local default, running the best-available account each heartbeat. Manage the pools in{" "}
        <strong>Company → Account Pool</strong>.
      </div>
      {!isCreate ? (
        <Field label="Preferred provider" hint="Used when neither pool has an active account yet.">
          <select
            className={selectClass}
            value={preferred}
            onChange={(e) => mark("adapterConfig", "preferredProvider", e.target.value)}
          >
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </select>
        </Field>
      ) : null}
    </>
  );
}
