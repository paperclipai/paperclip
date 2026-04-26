import { Router } from "express";
import { assertAuthenticated } from "./authz.js";

const DIMENSION = 384;

const API_KEY_RE = /\b(pk_live_[a-zA-Z0-9]{20,}|sk_live_[a-zA-Z0-9]{20,}|sk_test_[a-zA-Z0-9]{20,}|whsec_[a-zA-Z0-9]{20,}|gho_[a-zA-Z0-9]{20,})\b/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const EMAIL_RE = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;
const AWS_ARN_RE = /\barn:aws:[a-zA-Z0-9:./-]+(?<![\/.-])(?=\s|,|;|\.\s|$)/g;
const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g;
const IPV6_RE = /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g;
const IPV6_COMPRESSED_RE = /\b(?:[0-9a-fA-F]{1,4}:)*:[0-9a-fA-F]{1,4}\b/g;

export function redactForIndex(text: string): string {
  return text
    .replace(API_KEY_RE, "[REDACTED]")
    .replace(JWT_RE, "[REDACTED]")
    .replace(EMAIL_RE, "[REDACTED]")
    .replace(AWS_ARN_RE, "[REDACTED]")
    .replace(IPV4_RE, "[REDACTED]")
    .replace(IPV6_RE, "[REDACTED]")
    .replace(IPV6_COMPRESSED_RE, "[REDACTED]");
}

function hashWord(word: string): number {
  let hash = 5381;
  for (let i = 0; i < word.length; i++) {
    hash = ((hash << 5) + hash) ^ word.charCodeAt(i);
  }
  return Math.abs(hash);
}

function computeEmbedding(text: string): number[] {
  const words = text.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
  const embedding = new Array(DIMENSION).fill(0);

  for (let wordIdx = 0; wordIdx < words.length; wordIdx++) {
    const word = words[wordIdx];
    const wordHash = hashWord(word);

    for (let charIdx = 0; charIdx < Math.min(word.length, 32); charIdx++) {
      const charCode = word.charCodeAt(charIdx);
      const idx = (wordHash + charIdx * 127) % DIMENSION;
      const decay = 1.0 / (wordIdx + 1);
      const positionBoost = charIdx < 3 ? 1.5 : 1.0;
      embedding[idx] += (charCode / 255.0) * decay * positionBoost;
    }

    const subwordHash = hashWord(word.slice(0, 4) + word.slice(-4));
    for (let j = 0; j < 8; j++) {
      const idx = (subwordHash + j * 31) % DIMENSION;
      embedding[idx] += (1.0 / (wordIdx + 1)) * 0.3;
    }
  }

  const magnitude = Math.sqrt(
    embedding.reduce((sum, val) => sum + val * val, 0)
  );
  if (magnitude > 0) {
    for (let i = 0; i < embedding.length; i++) {
      embedding[i] /= magnitude;
    }
  }

  return embedding;
}

function createRateLimiter(maxRequests: number, windowMs: number) {
  const requests = new Map<string, number[]>();

  return {
    check(key: string): boolean {
      const now = Date.now();
      const windowStart = now - windowMs;
      const existing = (requests.get(key) ?? []).filter((ts) => ts > windowStart);
      if (existing.length >= maxRequests) return false;
      existing.push(now);
      requests.set(key, existing);
      return true;
    },
  };
}

export function embedRoutes() {
  const router = Router();
  const embedRateLimiter = createRateLimiter(100, 60_000);

  router.get("/health", (_req, res) => {
    res.json({
      status: "ready",
      dimension: DIMENSION,
      model: "all-MiniLM-L6-v2 (hash-based)",
    });
  });

  router.post("/", (req, res) => {
    assertAuthenticated(req);
    const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
    if (!embedRateLimiter.check(ip)) {
      res.status(429).json({ error: "Rate limit exceeded. Try again in a minute." });
      return;
    }

    try {
      const { text } = req.body;

      if (!text || typeof text !== "string") {
        res.status(400).json({ error: "Field 'text' is required and must be a string" });
        return;
      }

      if (text.length > 10000) {
        res.status(400).json({ error: "Text exceeds maximum length of 10000 characters" });
        return;
      }

      const start = Date.now();
      const redactedText = redactForIndex(text);
      const embedding = computeEmbedding(redactedText);
      const latencyMs = Date.now() - start;

      res.json({
        embedding,
        dimension: DIMENSION,
        latencyMs,
        model: "all-MiniLM-L6-v2 (hash-based)",
      });
    } catch (error) {
      console.error("[embed] Error:", error);
      res.status(500).json({
        error: "Embedding generation failed",
      });
    }
  });

  router.post("/batch", (req, res) => {
    assertAuthenticated(req);
    const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
    if (!embedRateLimiter.check(ip)) {
      res.status(429).json({ error: "Rate limit exceeded. Try again in a minute." });
      return;
    }

    try {
      const { texts } = req.body;

      if (!Array.isArray(texts)) {
        res.status(400).json({ error: "Field 'texts' must be an array" });
        return;
      }

      if (texts.length === 0) {
        res.status(400).json({ error: "texts array cannot be empty" });
        return;
      }

      if (texts.length > 100) {
        res.status(400).json({ error: "Maximum batch size is 100" });
        return;
      }

      for (const text of texts) {
        if (typeof text !== "string") {
          res.status(400).json({ error: "All items in texts must be strings" });
          return;
        }
        if (text.length > 10000) {
          res.status(400).json({ error: "Each text item exceeds maximum length of 10000 characters" });
          return;
        }
      }

      const start = Date.now();
      const embeddings = texts.map((text) => computeEmbedding(redactForIndex(text)));
      const latencyMs = Date.now() - start;

      res.json({
        embeddings,
        count: embeddings.length,
        latencyMs,
        model: "all-MiniLM-L6-v2 (hash-based)",
      });
    } catch (error) {
      console.error("[embed/batch] Error:", error);
      res.status(500).json({
        error: "Batch embedding generation failed",
      });
    }
  });

  return router;
}
