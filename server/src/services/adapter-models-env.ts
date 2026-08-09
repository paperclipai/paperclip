export interface AdapterModelEntry {
  id: string;
  label?: string;
}

/**
 * Per-adapter model list supplied by the operator via env, so the agent model
 * picker can offer models the server cannot CLI-discover (e.g. gateway models).
 * JSON object: adapterType -> [{ id, label? }]. Returns null when unset; throws
 * loudly on malformed input.
 */
export function parseAdapterModelsEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, AdapterModelEntry[]> | null {
  const raw = env.PAPERCLIP_ADAPTER_MODELS?.trim();
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`PAPERCLIP_ADAPTER_MODELS must be valid JSON: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("PAPERCLIP_ADAPTER_MODELS must be a JSON object mapping adapterType to an array of {id,label}");
  }
  const out: Record<string, AdapterModelEntry[]> = {};
  for (const [type, list] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(list)) {
      throw new Error(`PAPERCLIP_ADAPTER_MODELS[${type}] must be an array`);
    }
    out[type] = list.map((m) => {
      const o = m as Record<string, unknown>;
      if (typeof o.id !== "string" || !o.id) {
        throw new Error(`PAPERCLIP_ADAPTER_MODELS[${type}] entries require a non-empty string id`);
      }
      return { id: o.id, label: typeof o.label === "string" ? o.label : o.id };
    });
  }
  return out;
}
