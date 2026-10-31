import { Router } from "express";
import { RUNNER_TOOL_SCOPE_TOKEN_HEADER } from "../vendor/paperclip-runner/index.js";
import { forwardRemoteMcpRequest } from "../services/native-runtime/remote-mcp-relay.js";

export function nativeRunMcpRoutes() {
  const router = Router();
  router.all("/mcp/native-runs/:runId", async (req, res, next) => {
    try {
      if (req.method !== "POST") { res.setHeader("Allow", "POST"); res.sendStatus(405); return; }
      const result = await forwardRemoteMcpRequest({ runId: String(req.params.runId), authorization: req.headers.authorization, scopeAuthorization: typeof req.headers[RUNNER_TOOL_SCOPE_TOKEN_HEADER] === "string" ? req.headers[RUNNER_TOOL_SCOPE_TOKEN_HEADER] : undefined, body: req.body, mcpSessionId: typeof req.headers["mcp-session-id"] === "string" ? req.headers["mcp-session-id"] : undefined });
      res.setHeader("Cache-Control", "no-store");
      if (result.mcpSessionId) res.setHeader("Mcp-Session-Id", result.mcpSessionId);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.status(result.status).type("application/json").send(result.body);
    } catch (error) { next(error); }
  });
  return router;
}
