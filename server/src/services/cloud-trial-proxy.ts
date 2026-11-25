import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { Db } from "@paperclipai/db";
import { CLOUD_TRIAL_EXHAUSTED_ERROR_CODE } from "@paperclipai/shared";
import { OPENROUTER_ATTRIBUTION_HEADERS } from "@paperclipai/shared/openrouter-attribution";
import { unprocessable } from "../errors.js";
import { instanceSettingsService } from "./instance-settings.js";
import {
  CloudTrialExhaustedError,
  readJsonRecord,
  stripOpenRouterPrefix,
  type CloudTrialKeyStore,
} from "./cloud-trial-key-store.js";

const PROXY_REQUEST_TIMEOUT_MS = 180_000;
const MAX_PROXY_REQUEST_BYTES = 16 * 1024 * 1024;
const RUN_TOKEN_PREFIX = "pctrial_";

interface RunProxyTokenRecord {
  token: string;
  companyId: string;
  agentId: string;
  runId: string;
  allowedModel: string;
}

export interface PreparedCloudTrialRuntime {
  env: Record<string, string>;
  secretValues: string[];
  defaultModel: string;
  cleanup: () => Promise<void>;
}

function looksLikeOpenRouterLimitExhausted(status: number, bodyText: string): boolean {
  if (status === 402) return true;
  if (status === 403 || status === 429) {
    return /key\s+limit\s+exceeded|insufficient\s+credits|credit\s+limit|budget\s+exhausted|cloud_trial_exhausted/i.test(
      bodyText,
    );
  }
  return false;
}

/**
 * Per-run OpenRouter reverse proxy for starter-trial runs.
 *
 * Ephemeral tokens live in this single-replica stack process for the lifetime
 * of the active run (sliding idle TTL refreshed on every proxied request, and
 * revoked immediately on run exit or budget exhaustion).
 */
export function createCloudTrialProxy(keyStore: CloudTrialKeyStore) {
  const { env, fetchImpl } = keyStore;
  const activeRunTokens = new Map<string, RunProxyTokenRecord>();

  keyStore.setOnExhausted(() => {
    activeRunTokens.clear();
  });

  function findActiveRunToken(presented: string): RunProxyTokenRecord | null {
    const presentedBuf = Buffer.from(presented, "utf8");
    for (const [stored, record] of activeRunTokens) {
      const storedBuf = Buffer.from(stored, "utf8");
      if (storedBuf.length === presentedBuf.length && timingSafeEqual(storedBuf, presentedBuf)) {
        return record;
      }
    }
    return null;
  }

  /**
   * Prepares an isolated, proxy-backed runtime environment for a single run of a
   * Cloud-trial agent. The raw `sk-or-v1-...` key NEVER leaves this server process,
   * and the allowed model is strictly bound to the Cloud-approved starter model.
   */
  async function prepareCloudTrialRuntime(
    db: Db,
    input: {
      companyId: string;
      agentId: string;
      runId: string;
      model?: string;
    },
  ): Promise<PreparedCloudTrialRuntime> {
    const experimental = await instanceSettingsService(db).getExperimental();
    if (!experimental.enableCloudTrialInference) {
      throw unprocessable("Cloud starter inference is not enabled on this instance.", {
        code: "cloud_trial_disabled",
      });
    }

    const state = await keyStore.fetchKeyFromCloudOrLocal(false);
    if (state.status === "exhausted" || (state.status === "active" && state.remainingUsdCents <= 0)) {
      await keyStore.markExhausted({
        companyId: input.companyId,
        agentId: input.agentId,
        runId: input.runId,
        spentUsdCents: state.spentUsdCents || state.limitUsdCents,
        reason: "budget_exhausted",
      });
      throw new CloudTrialExhaustedError(undefined, {
        companyId: input.companyId,
        agentId: input.agentId,
        runId: input.runId,
      });
    }
    if (state.status !== "active" || !state.apiKey) {
      throw unprocessable("You need to connect a model provider to continue.", {
        code: state.status === "disabled" ? "cloud_trial_disabled" : CLOUD_TRIAL_EXHAUSTED_ERROR_CODE,
        trialStatus: state.status,
        reason: state.reason,
      });
    }

    const allowedModel = stripOpenRouterPrefix(state.defaultModel);
    if (input.model?.trim() && stripOpenRouterPrefix(input.model) !== allowedModel) {
      throw unprocessable(
        `Starter inference is limited to ${state.defaultModel}. Connect a model provider to use other models.`,
        {
          code: "cloud_trial_model_not_allowed",
          allowedModel: state.defaultModel,
          requestedModel: input.model.trim(),
        },
      );
    }

    const serverOrigin = (env.PAPERCLIP_API_URL?.trim() || "http://127.0.0.1:3100").replace(/\/+$/, "");
    const proxyUrl = `${serverOrigin}/api/internal/cloud-inference/v1`;
    const token = `${RUN_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    keyStore.recordRunPrepared();

    activeRunTokens.set(token, {
      token,
      companyId: input.companyId,
      agentId: input.agentId,
      runId: input.runId,
      allowedModel,
    });

    return {
      env: {
        OPENROUTER_API_KEY: "",
        PAPERCLIP_OPENROUTER_PROXY_URL: proxyUrl,
        PAPERCLIP_OPENROUTER_PROXY_TOKEN: token,
      },
      secretValues: [token, state.apiKey],
      defaultModel: state.defaultModel,
      cleanup: async () => {
        activeRunTokens.delete(token);
        await keyStore.probeOpenRouterUsage(input.companyId, true);
      },
    };
  }

  /**
   * Transparent OpenRouter reverse proxy for trial runs.
   * Authenticates strictly via the active per-run token and injects the
   * server-held OpenRouter key upstream. Never exposes the raw key to the caller.
   */
  async function proxyOpenRouterRequest(
    req: IncomingMessage & { originalUrl?: string; url?: string; body?: unknown },
    res: ServerResponse,
    subpath: string,
  ): Promise<void> {
    const authHeader = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
    const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
    const tokenRecord = bearer ? findActiveRunToken(bearer) : null;
    if (!tokenRecord) {
      const code = bearer.startsWith(RUN_TOKEN_PREFIX)
        ? "proxy_token_not_found_on_instance"
        : "unauthorized";
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          error: {
            code,
            message:
              code === "proxy_token_not_found_on_instance"
                ? "Trial proxy token is no longer active on this server instance"
                : "Invalid or expired trial proxy token",
          },
        }),
      );
      return;
    }

    const state = keyStore.getCached() ?? (await keyStore.fetchKeyFromCloudOrLocal(false));
    if (state.status === "exhausted" || !state.apiKey || state.remainingUsdCents <= 0) {
      await keyStore.markExhausted({
        companyId: tokenRecord.companyId,
        agentId: tokenRecord.agentId,
        runId: tokenRecord.runId,
        reason: "budget_exhausted",
      });
      res.statusCode = 402;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          error: {
            code: CLOUD_TRIAL_EXHAUSTED_ERROR_CODE,
            message: "You need to connect a model provider to continue.",
          },
        }),
      );
      return;
    }

    const normalizedSubpath = subpath.replace(/^\/+/, "");
    if (!["chat/completions", "responses", "models"].includes(normalizedSubpath)) {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { code: "unsupported_endpoint", message: "Unsupported proxy endpoint" } }));
      return;
    }

    const method = (req.method ?? "POST").toUpperCase();
    let forwardBody: Buffer | undefined;
    if (method !== "GET" && method !== "HEAD") {
      if (req.body !== undefined && req.body !== null) {
        const serialized = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
        forwardBody = Buffer.from(serialized, "utf8");
      } else {
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of req) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buf.length;
          if (total > MAX_PROXY_REQUEST_BYTES) {
            res.statusCode = 413;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: { code: "payload_too_large", message: "Request body too large" } }));
            return;
          }
          chunks.push(buf);
        }
        forwardBody = Buffer.concat(chunks);
      }

      if (normalizedSubpath === "chat/completions" || normalizedSubpath === "responses") {
        if (forwardBody.length === 0) {
          res.statusCode = 400;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: { code: "invalid_json", message: "Request body is required" } }));
          return;
        }
        try {
          const parsed = readJsonRecord(JSON.parse(forwardBody.toString("utf8")));
          const requestedModel =
            typeof parsed.model === "string" && parsed.model.trim()
              ? stripOpenRouterPrefix(parsed.model)
              : "";
          const disallowedFallbackRoute = parsed.route !== undefined;
          let disallowedModelsList = false;
          if (parsed.models !== undefined) {
            if (
              !Array.isArray(parsed.models) ||
              parsed.models.length === 0 ||
              parsed.models.some(
                (entry) =>
                  typeof entry !== "string" ||
                  !entry.trim() ||
                  stripOpenRouterPrefix(entry) !== tokenRecord.allowedModel,
              )
            ) {
              disallowedModelsList = true;
            }
          }
          if (
            requestedModel !== tokenRecord.allowedModel ||
            disallowedFallbackRoute ||
            disallowedModelsList
          ) {
            res.statusCode = 403;
            res.setHeader("content-type", "application/json");
            res.end(
              JSON.stringify({
                error: {
                  code: "model_not_allowed",
                  message: `Trial inference is restricted to ${tokenRecord.allowedModel}`,
                },
              }),
            );
            return;
          }
        } catch {
          res.statusCode = 400;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: { code: "invalid_json", message: "Invalid JSON payload" } }));
          return;
        }
      }
    }

    const upstreamAbort = new AbortController();
    const onClientClose = () => {
      if (!res.writableEnded) {
        upstreamAbort.abort();
      }
    };
    res.on("close", onClientClose);

    try {
      const upstreamUrl = `${keyStore.upstreamBaseUrl()}/${normalizedSubpath}`;
      let upstream: Response;
      try {
        upstream = await fetchImpl(upstreamUrl, {
          method,
          headers: {
            ...OPENROUTER_ATTRIBUTION_HEADERS,
            accept: typeof req.headers.accept === "string" ? req.headers.accept : "application/json",
            authorization: `Bearer ${state.apiKey}`,
            ...(forwardBody ? { "content-type": "application/json" } : {}),
          },
          ...(forwardBody ? { body: new Uint8Array(forwardBody) } : {}),
          signal: AbortSignal.any([upstreamAbort.signal, AbortSignal.timeout(PROXY_REQUEST_TIMEOUT_MS)]),
        });
      } catch (err) {
        if (upstreamAbort.signal.aborted || res.writableEnded) return;
        res.statusCode = 502;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            error: {
              code: "upstream_unavailable",
              message: err instanceof Error ? err.message : "Failed to reach inference upstream",
            },
          }),
        );
        return;
      }

      if (upstream.status === 402 || upstream.status === 403 || upstream.status === 429) {
        const text = await upstream.text().catch(() => "");
        if (looksLikeOpenRouterLimitExhausted(upstream.status, text)) {
          await keyStore.markExhausted({
            companyId: tokenRecord.companyId,
            agentId: tokenRecord.agentId,
            runId: tokenRecord.runId,
            reason: `openrouter_http_${upstream.status}`,
          });
          res.statusCode = 402;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              error: {
                code: CLOUD_TRIAL_EXHAUSTED_ERROR_CODE,
                message: "You need to connect a model provider to continue.",
              },
            }),
          );
          return;
        }
        res.statusCode = upstream.status;
        res.setHeader("content-type", upstream.headers.get("content-type") ?? "application/json");
        res.end(text);
        return;
      }

      res.statusCode = upstream.status;
      const contentType = upstream.headers.get("content-type");
      if (contentType) res.setHeader("content-type", contentType);
      res.setHeader("cache-control", "no-store");

      if (upstream.body) {
        try {
          const nodeStream = Readable.fromWeb(upstream.body as unknown as NodeReadableStream);
          await pipeline(nodeStream, res);
        } catch (err) {
          if (!upstreamAbort.signal.aborted && !res.writableEnded) {
            throw err;
          }
        }
      } else {
        res.end(await upstream.text());
      }

      // Background usage probe (throttled) so UI stays current without blocking stream completion.
      void keyStore.probeOpenRouterUsage(tokenRecord.companyId, false);
    } finally {
      res.off("close", onClientClose);
    }
  }

  return {
    prepareCloudTrialRuntime,
    proxyOpenRouterRequest,
    clearTokens: () => activeRunTokens.clear(),
  };
}
