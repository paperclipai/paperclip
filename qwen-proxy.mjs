#!/usr/bin/env node
/**
 * Qwen ↔ Anthropic API proxy
 *
 * Sits between Claude Code and DashScope's Anthropic-compatible endpoint.
 * Rewrites Claude model names → Qwen model names in the request body.
 *
 * Env vars:
 *   QWEN_PROXY_PORT       (default: 3199)
 *   QWEN_UPSTREAM_URL     (default: https://coding-intl.dashscope.aliyuncs.com/apps/anthropic)
 *   QWEN_API_KEY          (required — DashScope API key)
 *
 * Model mapping (Claude → Qwen):
 *   claude-opus-4-6, opus     → qwen3-coder-plus
 *   claude-sonnet-4-6, sonnet → qwen3-coder-next
 *   claude-haiku-*, haiku     → qwen3-coder-next (qwen3.5-plus was too slow/unreliable)
 *   (anything else)           → qwen3-coder-next
 */

import { createServer } from "node:http";

const PORT = parseInt(process.env.QWEN_PROXY_PORT || "3199", 10);
const UPSTREAM = (process.env.QWEN_UPSTREAM_URL || "https://coding-intl.dashscope.aliyuncs.com/apps/anthropic").replace(/\/$/, "");
const API_KEY = process.env.QWEN_API_KEY || "";

const MODEL_MAP = {
  // Opus tier → best quality
  "claude-opus-4-6": "qwen3-coder-plus",
  "claude-opus-4-5-20250918": "qwen3-coder-plus",
  opus: "qwen3-coder-plus",

  // Sonnet tier → balanced
  "claude-sonnet-4-6": "qwen3-coder-next",
  "claude-sonnet-4-5-20250929": "qwen3-coder-next",
  "claude-sonnet-4-5-20241022": "qwen3-coder-next",
  sonnet: "qwen3-coder-next",

  // Haiku tier → use qwen3-coder-next (qwen3.5-plus is too slow and unreliable)
  "claude-haiku-4-6": "qwen3-coder-next",
  "claude-haiku-4-5-20251001": "qwen3-coder-next",
  "claude-haiku-3-5-20241022": "qwen3-coder-next",
  haiku: "qwen3-coder-next",
};

const DEFAULT_MODEL = "qwen3-coder-next";

function mapModel(claudeModel) {
  if (!claudeModel) return DEFAULT_MODEL;
  const lower = claudeModel.toLowerCase().trim();
  if (MODEL_MAP[lower]) return MODEL_MAP[lower];
  if (lower.includes("opus")) return MODEL_MAP.opus;
  if (lower.includes("haiku")) return MODEL_MAP.haiku;
  if (lower.includes("sonnet")) return MODEL_MAP.sonnet;
  return DEFAULT_MODEL;
}

const server = createServer(async (req, res) => {
  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", upstream: UPSTREAM }));
    return;
  }

  // Read request body
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString();

  let body;
  let originalModel = "unknown";
  let mappedModel = DEFAULT_MODEL;

  try {
    body = JSON.parse(rawBody);
    originalModel = body.model || "unknown";
    mappedModel = mapModel(body.model);
    body.model = mappedModel;
  } catch {
    // Not JSON — forward as-is
    body = null;
  }

  const upstreamUrl = `${UPSTREAM}${req.url}`;
  const headers = {
    "content-type": "application/json",
    "anthropic-version": req.headers["anthropic-version"] || "2023-06-01",
    "x-api-key": API_KEY,
  };

  // Copy accept header for streaming
  if (req.headers.accept) headers.accept = req.headers.accept;

  console.log(`[qwen-proxy] ${originalModel} → ${mappedModel} | ${req.method} ${req.url}`);

  try {
    const upstream = await fetch(upstreamUrl, {
      method: req.method || "POST",
      headers,
      body: body ? JSON.stringify(body) : rawBody,
    });

    // Forward status and headers
    const responseHeaders = {};
    for (const [key, value] of upstream.headers.entries()) {
      responseHeaders[key] = value;
    }
    res.writeHead(upstream.status, responseHeaders);

    // Stream the response
    if (upstream.body) {
      const reader = upstream.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        res.end();
      };
      await pump();
    } else {
      const text = await upstream.text();
      res.end(text);
    }
  } catch (err) {
    console.error(`[qwen-proxy] upstream error: ${err.message}`);
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "proxy_error", message: err.message } }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[qwen-proxy] listening on http://127.0.0.1:${PORT}`);
  console.log(`[qwen-proxy] upstream: ${UPSTREAM}`);
  console.log(`[qwen-proxy] model map: opus→qwen3-coder-plus, sonnet→qwen3-coder-next, haiku→qwen3.5-plus`);
});
