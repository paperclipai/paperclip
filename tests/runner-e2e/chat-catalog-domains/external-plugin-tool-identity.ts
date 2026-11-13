import type { PluginRecord } from "../../../packages/shared/src/types/plugin.js";
export interface PreviewToolDescriptor { name: string; pluginId: string }
export interface PreviewPluginSelection { id: string; key: string; count: 0 | 1 }
interface PublicToolReader { get<T>(route: string): Promise<T> }
export class PreviewToolRemovalPendingError extends Error {
  constructor() { super("Actual selected preview tool inventory is still registered during disable"); }
}
function requireSelectedPlugin(plugin: Pick<PluginRecord, "id" | "pluginKey" | "status">, selected: PreviewPluginSelection) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(selected.id)
    || !/^[a-z0-9][a-z0-9._-]+$/.test(selected.key) || plugin.id !== selected.id || plugin.pluginKey !== selected.key
    || plugin.status !== (selected.count === 1 ? "ready" : "disabled"))
    throw new Error("Selected preview plugin identity or lifecycle does not match its actual installed record");
}
/** Board discovery filters by manifest key; descriptors identify the database UUID.
 * Bind both instead of treating an empty query under the other identity as removal. */
export function requirePreviewToolInventory(plugin: Pick<PluginRecord, "id" | "pluginKey" | "status">, selected: PreviewPluginSelection, value: unknown): PreviewToolDescriptor[] {
  requireSelectedPlugin(plugin, selected);
  if (!Array.isArray(value) || value.some(row => !row || typeof row !== "object"
    || row.name !== `${selected.key}:preview` || row.pluginId !== selected.id))
    throw new Error("Actual selected preview tool inventory does not match its exact identity and count");
  if (selected.count === 0 && value.length === 1) throw new PreviewToolRemovalPendingError();
  if (value.length !== selected.count) throw new Error("Actual selected preview tool inventory does not match its exact identity and count");
  return value as PreviewToolDescriptor[];
}
export async function readPreviewToolInventory(api: PublicToolReader, plugin: Pick<PluginRecord, "id" | "pluginKey" | "status">, selected: PreviewPluginSelection): Promise<PreviewToolDescriptor[]> {
  requireSelectedPlugin(plugin, selected);
  const value = await api.get<unknown>(`/api/plugins/tools?pluginId=${encodeURIComponent(plugin.pluginKey)}`);
  return requirePreviewToolInventory(plugin, selected, value);
}
