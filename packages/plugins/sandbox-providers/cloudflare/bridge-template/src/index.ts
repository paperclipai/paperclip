import { Sandbox } from "@cloudflare/sandbox";
import { handleBridgeRequest, } from "./routes.js";
import type { BridgeEnv } from "./sandboxes.js";

export { Sandbox };

export default {
  async fetch(request: Request, env: BridgeEnv): Promise<Response> {
    try {
      return await handleBridgeRequest(request, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(
        JSON.stringify({
          error: "internal_error",
          message,
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  },
};
