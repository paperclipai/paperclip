import { expect, it, vi } from "vitest";
import type { PluginRecord } from "../../../packages/shared/src/types/plugin.js";
import { readPreviewToolInventory, requirePreviewToolInventory, PreviewToolRemovalPendingError } from "./external-plugin-tool-identity.js";
const mocks = vi.hoisted(() => ({ databaseFactory: vi.fn(() => { throw new Error("No database allowed in tool inventory calibration"); }) }));
vi.mock("../../../server/src/services/plugin-registry.js", () => ({ pluginRegistryService: mocks.databaseFactory }));
vi.mock("../../../server/src/middleware/logger.js", () => { const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger }; return { logger }; });
import { createPluginToolDispatcher } from "../../../server/src/services/plugin-tool-dispatcher.js";
const id = "11111111-1111-4111-8111-111111111111", otherId = "22222222-2222-4222-8222-222222222222", key = "paperclip.eval-preview-calibration";
const selection = { id, key, count: 1 as const };
const record = (status: "ready" | "disabled" = "ready") => ({ id, pluginKey: key, status });
function fixture(pluginKey = key, pluginId = id) {
  const dispatcher = createPluginToolDispatcher();
  dispatcher.registerPluginTools(pluginKey, { id: pluginKey, tools: [{ name: "preview", displayName: "Preview", description: "Synthetic preview", parametersSchema: { type: "object", properties: {} } }] } as never, pluginId);
  const routes: string[] = [];
  const api = { async get<T>(route: string): Promise<T> { routes.push(route); const query = new URL(route, "http://synthetic.invalid").searchParams.get("pluginId"); return dispatcher.listToolsForAgent(query ? { pluginId: query } : undefined) as T; } };
  return { dispatcher, api, routes };
}
it("reads the supported board stable-key filter and binds the actual UUID and exact preview namespace", async () => {
  const { dispatcher, api, routes } = fixture();
  expect(dispatcher.listToolsForAgent({ pluginId: id })).toEqual([]); // The original vacuous UUID lookup.
  expect(await readPreviewToolInventory(api, record(), selection)).toEqual([expect.objectContaining({ pluginId: id, name: `${key}:preview` })]);
  expect(routes).toEqual([`/api/plugins/tools?pluginId=${key}`]); expect(mocks.databaseFactory).not.toHaveBeenCalled();
});
it("proves actual dispatcher removal, after an enabled positive, before accepting disabled zero", async () => {
  const { dispatcher, api } = fixture();
  expect(await readPreviewToolInventory(api, record(), selection)).toHaveLength(1);
  dispatcher.unregisterPluginTools(key);
  expect(await readPreviewToolInventory(api, record("disabled"), { ...selection, count: 0 })).toEqual([]);
  expect(mocks.databaseFactory).not.toHaveBeenCalled();
});
it("rejects a disabled label while the real tool remains registered", async () => {
  const { api } = fixture();
  await expect(readPreviewToolInventory(api, record("disabled"), { ...selection, count: 0 })).rejects.toThrow("inventory");
});
it("only the same exact still-registered tool can be pending within the original disable deadline", () => {
  const same = [{ name: `${key}:preview`, pluginId: id }];
  expect(() => requirePreviewToolInventory(record("disabled"), { ...selection, count: 0 }, same)).toThrow(PreviewToolRemovalPendingError);
  for (const rows of [[{ name: `${key}:preview`, pluginId: otherId }], [{ name: "foreign:preview", pluginId: id }], [...same, ...same]]) {
    let observed: unknown;
    try { requirePreviewToolInventory(record("disabled"), { ...selection, count: 0 }, rows); } catch (error) { observed = error; }
    expect(observed).toBeInstanceOf(Error); expect(observed).not.toBeInstanceOf(PreviewToolRemovalPendingError); expect(String(observed)).toContain("inventory");
  }
});
it("rejects absent registration for an enabled plugin", async () => {
  const { dispatcher, api } = fixture(); dispatcher.unregisterPluginTools(key);
  await expect(readPreviewToolInventory(api, record(), selection)).rejects.toThrow("inventory");
});
it("rejects the correct key namespace with a foreign returned database UUID", async () => {
  const { api } = fixture(key, otherId);
  await expect(readPreviewToolInventory(api, record(), selection)).rejects.toThrow("inventory");
});
it.each([
  { selected: { ...selection, id: otherId }, plugin: record() },
  { selected: { ...selection, key: "paperclip.foreign" }, plugin: record() },
  { selected: { ...selection, key: id }, plugin: record() },
  { selected: selection, plugin: { ...record(), id: otherId } },
  { selected: selection, plugin: { ...record(), pluginKey: "paperclip.foreign" } },
  { selected: selection, plugin: record("disabled") },
  { selected: { ...selection, count: 0 as const }, plugin: record() },
])("rejects wrong selected identity/lifecycle before an empty query could hide it: %j", async ({ selected, plugin }) => {
  const { api, routes } = fixture(); await expect(readPreviewToolInventory(api, plugin, selected)).rejects.toThrow("identity or lifecycle"); expect(routes).toEqual([]);
});
it.each([
  undefined,
  { tools: [{ pluginId: id, name: `${key}:preview` }] },
  [],
  [{ pluginId: id, name: `${key}:other` }],
  [{ pluginId: otherId, name: `${key}:preview` }],
  [{ name: `${key}:preview` }],
  [{ pluginId: id, name: `${key}:preview` }, { pluginId: id, name: `${key}:preview` }],
  [{ pluginId: id, name: `${key}:preview` }, { pluginId: otherId, name: "paperclip.foreign:preview" }],
])("does not accept a wrong shape, count or foreign contribution: %j", value => {
  expect(() => requirePreviewToolInventory(record(), selection, value)).toThrow("inventory");
});
it("permits zero only for the same installed disabled identity", () => {
  expect(requirePreviewToolInventory(record("disabled"), { ...selection, count: 0 }, [])).toEqual([]);
  expect(() => requirePreviewToolInventory({ ...record("disabled"), pluginKey: "paperclip.foreign" }, { ...selection, count: 0 }, [])).toThrow("identity or lifecycle");
});
