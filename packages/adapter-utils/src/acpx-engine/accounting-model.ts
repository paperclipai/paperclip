import type { AcpRuntimeStatus } from "acpx/runtime";

/** Use provider-selected IDs, including its default. A mid-turn model change
 * cannot be priced as a single-model receipt; never guess from a display name. */
export function acpxAccountingModel(requested: string, before: AcpRuntimeStatus | null, after: AcpRuntimeStatus | null): string | null {
  const pre = before?.models?.currentModelId?.trim();
  const post = after?.models?.currentModelId?.trim();
  if (pre && post && pre !== post) return null;
  return post || pre || requested.trim() || null;
}
