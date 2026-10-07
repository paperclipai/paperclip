import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JsonRpcCallError, JSONRPC_ERROR_CODES, PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import { createPluginWorkerHandle } from "../services/plugin-worker-manager.js";

describe("host error data through the production worker bridge", () => {
  for (const method of ["performAction", "getData"] as const) {
    for (const data of [{ reason: "version_conflict", version: 3 }, null, false, 0]) {
      it(`preserves explicit typed data through ${method}: ${JSON.stringify(data)}`, async () => {
        const error = new JsonRpcCallError({ code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR, message: "Host refusal", data });
        await expect(invoke(method, error)).rejects.toMatchObject({ code: error.code, message: error.message, data });
      });
    }

    it(`does not expose incidental exception data through ${method}`, async () => {
      const error = Object.assign(new Error("Host failed"), { data: { secret: "private-value" } });
      await expect(invoke(method, error)).rejects.toMatchObject({
        code: JSONRPC_ERROR_CODES.INTERNAL_ERROR, message: "Host failed", data: undefined,
      });
    });
  }
});

async function invoke(method: "performAction" | "getData", error: Error) {
  const handle = createPluginWorkerHandle("paperclip.error-test", {
    entrypointPath: fileURLToPath(new URL("./fixtures/plugin-worker-rpc-errors.mjs", import.meta.url)),
    execArgv: ["--import", import.meta.resolve("tsx")], // Resolve the server's loader before forking from the workspace root.
    manifest: {
      id: "paperclip.error-test", apiVersion: 1, version: "1.0.0", displayName: "Error test",
      description: "RPC error test", author: "Paperclip", categories: ["automation"],
      capabilities: [], entrypoints: { worker: "dist/worker.js" },
    },
    config: {}, instanceInfo: { instanceId: "fixture", hostVersion: "1.0.0" }, apiVersion: 1,
    hostHandlers: { "config.get": async () => { throw error; } },
  });
  try {
    await handle.start();
    return await handle.call(method, { key: "host-config", params: {} });
  } finally {
    await handle.stop();
  }
}
