import { expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { enableTaskWorkspaceView } from "./runtime-workspaces.js";
import { runtimeWorkspaceClosureCases } from "./runtime-workspace-closure.js";
import { runtimePreviewCases } from "./runtime-preview.js";

function context(enabled: unknown) {
  const api = { patch: vi.fn(async () => ({})), get: vi.fn(async () => ({ enableIsolatedWorkspaces: enabled })) };
  return { api, ctx: { input: { api, execution: { environment: { id: "local" } } } } as unknown as ChatCatalogContext };
}
it("enables and independently reads back the supported public workspace view", async () => {
  const { ctx, api } = context(true);
  await enableTaskWorkspaceView(ctx);
  expect(api.patch).toHaveBeenCalledExactlyOnceWith("/api/instance/settings/experimental", { enableIsolatedWorkspaces: true });
  expect(api.get).toHaveBeenCalledExactlyOnceWith("/api/instance/settings/experimental");
  expect(api.patch.mock.invocationCallOrder[0]).toBeLessThan(api.get.mock.invocationCallOrder[0]!);
});
it.each([false, undefined, "true"])("both actual setup callbacks reject unenabled %s before any native prerequisite", async enabled => {
  for (const definition of [runtimeWorkspaceClosureCases[0]!, runtimePreviewCases[0]!]) {
    const { ctx, api } = context(enabled);
    await expect(definition.setup(ctx)).rejects.toThrow("supported workspace view is not enabled");
    expect(api.patch).toHaveBeenCalledTimes(1); expect(api.get).toHaveBeenCalledTimes(1);
  }
});
it("does not rescue a denied public feature-setting operation", async () => {
  const { ctx, api } = context(true); api.patch.mockRejectedValueOnce(new Error("403 Forbidden"));
  await expect(runtimePreviewCases[0]!.setup(ctx)).rejects.toThrow("403 Forbidden");
  expect(api.get).not.toHaveBeenCalled();
});
