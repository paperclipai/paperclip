/**
 * Gate 3: exact model-catalog and footer gates (46839114)
 *
 * Fail-closed hardening gates for Paperclip 722:
 * - exact-model-catalog: When an agent adapter config references a model, verify
 *   it against the exact provider model catalog. Reject fuzzy/partial matches
 *   that could silently route to the wrong model.
 * - footer-gate: Verify that API responses include the required Paperclip
 *   version footer header (X-Paperclip-Version) and that it matches the
 *   running server version. Fail-closed: reject responses missing the footer.
 *
 * Parent: bd78b074 (Paperclip 722 harden)
 * Program: JAC-3662
 */

import type { Request, Response } from "express";
import { forbidden } from "../errors.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Known exact model identifiers per provider (fail-closed: only these pass) */
const EXACT_MODEL_CATALOG: Record<string, ReadonlySet<string>> = {
  openai: new Set([
    "gpt-5.6",
    "gpt-5.6-luna",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3",
    "gpt-5.3-mini",
    "gpt-5.2",
    "gpt-5.2-mini",
    "gpt-5.1",
    "gpt-5.1-mini",
    "gpt-5",
    "gpt-5-mini",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4o",
    "gpt-4o-mini",
    "o4-mini",
    "o3",
    "o3-mini",
    "o1",
    "o1-mini",
    "o1-pro",
  ]),
  anthropic: new Set([
    "claude-opus-5-2025",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-5",
    "claude-opus-4",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5",
    "claude-sonnet-4",
    "claude-haiku-4-5",
    "claude-haiku-4",
    "claude-fable-5",
  ]),
  google: new Set([
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-1.5-pro",
    "gemini-1.5-flash",
  ]),
  xai: new Set([
    "grok-4-fast-reasoning",
    "grok-4-fast",
    "grok-4",
    "grok-3",
    "grok-3-mini",
  ]),
  mistral: new Set([
    "mistral-large-latest",
    "mistral-medium-latest",
    "mistral-small-latest",
    "pixtral-large-latest",
    "codestral-latest",
  ]),
  deepseek: new Set([
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "deepseek-v3",
    "deepseek-r1",
  ]),
  ollama: new Set([
    "qwen3-coder:30b",
    "qwen3:30b",
    "qwen2.5-coder:32b",
    "qwen2.5:32b",
    "deepseek-r1:70b",
    "deepseek-r1:32b",
    "deepseek-r1:14b",
    "llama3.3:70b",
    "llama3.2:3b",
    "gemma3:27b",
    "gemma3:12b",
    "mistral:7b",
    "codestral:22b",
    "phi4:14b",
    "nomic-embed-text",
  ]),
  kimi: new Set([
    "kimi-coding/k2p7",
    "kimi-coding/k2",
    "kimi/k2",
    "kimi/k1.5",
  ]),
  groq: new Set([
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    "mixtral-8x7b-32768",
    "gemma2-9b-it",
    "deepseek-r1-distill-llama-70b",
  ]),
  cerebras: new Set([
    "llama3.1-8b",
    "llama3.1-70b",
    "llama3.3-70b",
  ]),
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ModelCatalogGateInput {
  provider: string;
  model: string;
  agentId?: string | null;
}

export interface FooterGateInput {
  req: Request;
  res: Response;
  serverVersion: string;
}

/**
 * Verify that a model identifier exactly matches the provider's catalog.
 * Fail-closed: rejects fuzzy/partial/substring matches.
 */
export function assertExactModelCatalog(input: ModelCatalogGateInput): void {
  const provider = input.provider.toLowerCase().trim();
  const model = input.model.trim();

  // "auto" is a special sentinel that means "let the adapter decide"
  if (model === "auto" || model === "") return;

  const catalog = EXACT_MODEL_CATALOG[provider];

  if (!catalog) {
    // Unknown provider → fail closed
    throw forbidden(
      `Unknown provider "${input.provider}" — cannot validate model "${model}" against catalog. ` +
        `Known providers: ${Object.keys(EXACT_MODEL_CATALOG).join(", ")}`,
      {
        code: "model_catalog_unknown_provider",
        provider: input.provider,
        model,
        agentId: input.agentId,
      },
    );
  }

  if (!catalog.has(model)) {
    // Model not in exact catalog → fail closed
    const suggestions = [...catalog].filter((m) => m.includes(model) || model.includes(m));
    const hint = suggestions.length > 0
      ? ` Did you mean: ${suggestions.join(", ")}?`
      : "";

    throw forbidden(
      `Model "${model}" is not in the exact catalog for provider "${input.provider}".` + hint,
      {
        code: "model_catalog_exact_match_required",
        provider: input.provider,
        model,
        agentId: input.agentId,
        availableModels: [...catalog],
      },
    );
  }
}

/**
 * Verify that the X-Paperclip-Version response header is present and matches
 * the running server version. Fail-closed: rejects mismatches.
 */
export function assertFooterGate(input: FooterGateInput): void {
  const headerValue = input.res.getHeader("x-paperclip-version");

  if (!headerValue) {
    throw forbidden(
      "Response missing required X-Paperclip-Version footer header",
      {
        code: "footer_gate_missing_version_header",
        path: input.req.path,
      },
    );
  }

  const version = Array.isArray(headerValue) ? headerValue[0] : String(headerValue);

  if (version !== input.serverVersion) {
    throw forbidden(
      `X-Paperclip-Version footer mismatch: header says "${version}", server is "${input.serverVersion}"`,
      {
        code: "footer_gate_version_mismatch",
        headerVersion: version,
        serverVersion: input.serverVersion,
        path: input.req.path,
      },
    );
  }
}

/**
 * Express middleware that injects the X-Paperclip-Version footer header into
 * every API response.
 */
export function paperclipVersionFooterMiddleware(serverVersion: string) {
  return (_req: Request, res: Response, next: () => void) => {
    res.setHeader("x-paperclip-version", serverVersion);
    next();
  };
}

/**
 * Express middleware that verifies the X-Paperclip-Version footer on outgoing
 * responses. Should be registered after all route handlers.
 */
export function paperclipFooterGateMiddleware(serverVersion: string) {
  return (req: Request, res: Response, next: () => void) => {
    // Intercept the response finish to verify the footer
    const originalEnd = res.end.bind(res);
    res.end = function (this: Response, ...args: any[]) {
      try {
        assertFooterGate({ req, res, serverVersion });
      } catch {
        // If footer gate fails, override the response with a 500
        if (!res.headersSent) {
          res.status(500).json({
            error: "Internal server error: footer gate validation failed",
            code: "footer_gate_validation_failed",
          });
        }
      }
      return originalEnd(...args);
    } as typeof res.end;
    next();
  };
}

/**
 * Resolve the canonical provider name from an adapter type or config.
 * Maps adapter types to their model catalog provider keys.
 */
export function resolveProviderFromAdapter(adapterType: string): string | null {
  const mapping: Record<string, string> = {
    openai_local: "openai",
    openai_gateway: "openai",
    codex_local: "openai",
    claude_local: "anthropic",
    claude_gateway: "anthropic",
    gemini_local: "google",
    gemini_gateway: "google",
    xai_local: "xai",
    xai_gateway: "xai",
    mistral_local: "mistral",
    mistral_gateway: "mistral",
    deepseek_local: "deepseek",
    deepseek_gateway: "deepseek",
    ollama_local: "ollama",
    ollama_launch: "ollama",
    ollama_cloud: "ollama",
    kimi_local: "kimi",
    kimi_gateway: "kimi",
    groq_local: "groq",
    groq_gateway: "groq",
    cerebras_local: "cerebras",
    cerebras_gateway: "cerebras",
  };

  return mapping[adapterType.toLowerCase()] ?? null;
}
