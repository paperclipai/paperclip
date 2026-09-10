import { pipeline } from "node:stream/promises";
import { Router } from "express";
import { z } from "zod";
import { AGENT_PALETTE_IDS, AGENT_AVATAR_SIZES, CHARACTER_STATES, appearanceForPalette, type AgentAvatarSize } from "@paperclipai/shared";
import { AvatarAdmissionError, createAgentAvatarService } from "../services/agent-avatars.js";
import { createStorageProviderFromConfig } from "../storage/provider-registry.js";
import { loadConfig } from "../config.js";
import { logger } from "../middleware/logger.js";

const requestSchema = z.object({
  version: z.literal("cap-v1"),
  palette: z.enum([...AGENT_PALETTE_IDS, "muted-dream"]),
  pose: z.enum(CHARACTER_STATES),
  size: z.string().regex(/^\d+$/).default("512").transform(Number).refine(n => (AGENT_AVATAR_SIZES as readonly number[]).includes(n)),
  scale: z.enum(["1", "2"]).default("1"),
}).strict();

/** Public preset artwork only. No agent lookup or tenant data is exposed. */
export function agentAvatarRoutes(injected?: ReturnType<typeof createAgentAvatarService>) {
  const router = Router();
  let service = injected;
  router.get("/agent-avatars/:version/:palette/:file", async (req, res) => {
    const file = String(req.params.file);
    const parsed = requestSchema.safeParse({ ...req.query, version: req.params.version, palette: req.params.palette, pose: file.endsWith(".png") ? file.slice(0, -4) : file });
    if (!file.endsWith(".png") || !parsed.success || Object.keys(req.query).some(key => key !== "size" && key !== "scale")) {
      res.setHeader("Cache-Control", "no-store");
      res.status(400).json({ error: "Unsupported avatar version, palette, pose, size, or scale" }); return;
    }
    const { palette, pose, size, scale } = parsed.data;
    try {
      service ??= createAgentAvatarService(createStorageProviderFromConfig(loadConfig()));
      const { stream, byteSize, etag } = await service.get({ appearance: appearanceForPalette(palette === "muted-dream" ? AGENT_PALETTE_IDS[0] : palette), muted: palette === "muted-dream", pose, size: size as AgentAvatarSize, scale: Number(scale) as 1 | 2 }, req.ip || req.socket.remoteAddress || "unknown");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader("ETag", etag);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.type("png");
      const validators = req.get("if-none-match")?.split(",").map(value => value.trim().replace(/^W\//, ""));
      if (validators?.some(value => value === "*" || value === etag)) { stream.destroy(); res.status(304).end(); return; }
      res.setHeader("Content-Length", byteSize);
      await pipeline(stream, res);
    } catch (error) {
      if (!(error instanceof AvatarAdmissionError)) logger.warn({ err: error }, "Could not render agent avatar");
      if (res.headersSent || res.destroyed) { res.destroy(); return; }
      res.removeHeader("Content-Length");
      res.removeHeader("ETag");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Retry-After", String(error instanceof AvatarAdmissionError ? error.retryAfterSeconds : 5));
      res.status(error instanceof AvatarAdmissionError ? 429 : 503).json({ error: "Avatar temporarily unavailable" });
    }
  });
  return router;
}
