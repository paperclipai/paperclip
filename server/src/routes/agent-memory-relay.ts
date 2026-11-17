import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { resolveAgentMemoryConfig } from "../services/default-mcp-agent-memory.js";
import { tailnetAwareFetch } from "../services/remote-http-fetch.js";
import { secretService } from "../services/secrets.js";

/**
 * TECH-8908: relay for a sandboxed Hermes agent's native mem0 requests (stage 3).
 *
 * A pod cannot reach the tailnet, so Hermes's mem0 client points `MEM0_HOST` at the sandbox bridge, which forwards here
 * with the run JWT. Fixed surface, no wildcard: `POST /search`, `POST /memories`, `PUT /memories/:id`,
 * `DELETE /memories/:id`. The target is ONLY the server's configured `PAPERCLIP_AGENT_MEMORY_URL`; nothing in the
 * request (path, query, header, body, the agent's adapter config) can choose the host or the path. The owner is the
 * calling agent: its own `agent_memory.<agentId>` secret is the token (rh-memory-mcp takes the owner from the token
 * subject and ignores any `user_id`/`agent_id`/`filters` in the body), and the body is forwarded byte for byte.
 */

/**
 * Hermes's mem0 client stops waiting at 30 s. The bridge route policy gives the route 35 s in the pod and aborts the
 * host handler at 33 s, so the relay gives up at 32 s and always answers before either.
 */
export const AGENT_MEMORY_RELAY_DEADLINE_MS = 32_000;
/** Same cap as rh-memory-mcp's own request limit. */
export const AGENT_MEMORY_RELAY_MAX_BODY_BYTES = 1_000_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JSON_CONTENT_TYPE_RE = /^application\/json\s*(;|$)/i;

export interface AgentMemoryRelayDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** The agent's own memory token, or null when it has none. Replaceable in tests. */
  resolveToken?: (companyId: string, agentId: string) => Promise<string | null>;
}

function fail(res: Response, status: number, detail: string) {
  res.status(status).json({ detail });
}

export function agentMemoryRelayRoutes(db: Db, deps: AgentMemoryRelayDeps = {}) {
  const router = Router();
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? tailnetAwareFetch;
  const resolveToken = deps.resolveToken ?? (async (companyId: string, agentId: string) => {
    const secrets = secretService(db);
    const secret = await secrets.getByKey(companyId, `agent_memory.${agentId}`);
    if (!secret || secret.status !== "active") return null;
    return secrets.resolveSecretValue(companyId, secret.id, "latest");
  });

  async function relay(req: Request, res: Response, method: "POST" | "PUT" | "DELETE", route: string) {
    // The run JWT only: an agent API key has no run, and a board user has no agent memory.
    const actor = req.actor;
    if (actor.type !== "agent" || actor.source !== "agent_jwt" || !actor.agentId || !actor.companyId || !actor.runId) {
      return fail(res, 403, "forbidden");
    }
    const resolved = resolveAgentMemoryConfig(env);
    if (!resolved.ok) return fail(res, 503, "memory_unavailable");

    const headers: Record<string, string> = {};
    let body: Buffer | undefined;
    if (method !== "DELETE") {
      const contentType = req.header("content-type") ?? "";
      const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
      if (!JSON_CONTENT_TYPE_RE.test(contentType) || !raw) return fail(res, 415, "json_required");
      if (raw.length > AGENT_MEMORY_RELAY_MAX_BODY_BYTES) return fail(res, 413, "too_large");
      headers["content-type"] = contentType;
      body = raw;
    }

    let token: string | null;
    try {
      token = await resolveToken(actor.companyId, actor.agentId);
    } catch (err) {
      // An outage of the secret store or database is not a denial: answer 503 and log the class only (never a message or value).
      logger.warn({ agentId: actor.agentId, errorClass: err instanceof Error ? err.constructor.name : typeof err }, "agent memory relay token lookup failed");
      return fail(res, 503, "memory_unavailable");
    }
    if (!token) return fail(res, 403, "forbidden");
    headers["x-api-key"] = token;

    let upstream: globalThis.Response;
    try {
      upstream = await fetchImpl(`${resolved.config.url}${route}`, {
        method,
        headers,
        ...(body ? { body: new Uint8Array(body) } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(AGENT_MEMORY_RELAY_DEADLINE_MS),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      logger.warn({ agentId: actor.agentId, errorClass: err instanceof Error ? err.name : typeof err, timedOut }, "agent memory relay upstream call failed");
      return fail(res, timedOut ? 504 : 502, timedOut ? "memory_timeout" : "memory_unavailable");
    }

    // Status and JSON body only. A redirect or a non-JSON answer is never passed through.
    const upstreamType = upstream.headers.get("content-type") ?? "";
    if (upstream.status >= 300 && upstream.status < 400) return fail(res, 502, "memory_unavailable");
    if (!JSON_CONTENT_TYPE_RE.test(upstreamType)) {
      const empty = upstream.ok && upstream.headers.get("content-length") === "0";
      await upstream.body?.cancel().catch(() => undefined);
      // A bodiless success (for example 204) is a success; any other non-JSON answer is an upstream fault.
      if (empty || upstream.status === 204) return void res.status(upstream.status === 204 ? 200 : upstream.status).json({});
      return fail(res, 502, "memory_unavailable");
    }
    let text: string;
    try {
      text = await upstream.text();
    } catch {
      return fail(res, 502, "memory_unavailable");
    }
    if (Buffer.byteLength(text) > AGENT_MEMORY_RELAY_MAX_BODY_BYTES) return fail(res, 502, "memory_unavailable");
    res.status(upstream.status).type("application/json").send(text);
  }

  router.post("/agent-memory-relay/search", (req, res, next) => {
    relay(req, res, "POST", "/search").catch(next);
  });
  router.post("/agent-memory-relay/memories", (req, res, next) => {
    relay(req, res, "POST", "/memories").catch(next);
  });
  router.put("/agent-memory-relay/memories/:id", (req, res, next) => {
    const id = req.params.id as string;
    if (!UUID_RE.test(id)) return fail(res, 404, "not_found");
    relay(req, res, "PUT", `/memories/${id.toLowerCase()}`).catch(next);
  });
  router.delete("/agent-memory-relay/memories/:id", (req, res, next) => {
    const id = req.params.id as string;
    if (!UUID_RE.test(id)) return fail(res, 404, "not_found");
    relay(req, res, "DELETE", `/memories/${id.toLowerCase()}`).catch(next);
  });

  return router;
}
