import { Router } from "express";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import type { Db } from "@paperclipai/db";
import { projectWorkspaces } from "@paperclipai/db";
import { eq, and } from "drizzle-orm";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export interface DigestEntry {
  topic: string;
  date: string;
  filename: string;
  size: number;
}

interface GroupedDigests {
  [topic: string]: DigestEntry[];
}

const podcastScriptSchema = z.object({
  content: z.string().min(1),
});

/** Look up the wiki workspace cwd for a company. */
async function getWikiCwd(db: Db, companyId: string): Promise<string | null> {
  const rows = await db
    .select({ cwd: projectWorkspaces.cwd })
    .from(projectWorkspaces)
    .where(
      and(
        eq(projectWorkspaces.companyId, companyId),
        eq(projectWorkspaces.name, "paperclip-wiki"),
      ),
    )
    .limit(1);
  return rows[0]?.cwd ?? null;
}

/** Parse a digest filename into topic + date. Returns null if unrecognised. */
function parseDigestFilename(filename: string): { topic: string; date: string } | null {
  const match = filename.match(/^(.+)-digest-(\d{4}-\d{2}-\d{2})/);
  if (!match) return null;
  return { topic: match[1]!, date: match[2]! };
}

export function digestRoutes(db: Db) {
  const router = Router();

  // ── List digest files grouped by topic ────────────────────────────────────
  router.get("/companies/:companyId/digests", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const wikiCwd = await getWikiCwd(db, companyId);
    if (!wikiCwd) {
      res.json({ digests: {} });
      return;
    }

    const reportsDir = join(wikiCwd, "outputs", "reports");
    let files: string[];
    try {
      files = await readdir(reportsDir);
    } catch {
      res.json({ digests: {} });
      return;
    }

    const grouped: GroupedDigests = {};
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const parsed = parseDigestFilename(file);
      if (!parsed) continue;

      const filePath = join(reportsDir, file);
      let size = 0;
      try {
        const s = await stat(filePath);
        size = s.size;
      } catch {
        /* skip */
      }

      const entry: DigestEntry = { topic: parsed.topic, date: parsed.date, filename: file, size };
      if (!grouped[parsed.topic]) grouped[parsed.topic] = [];
      grouped[parsed.topic]!.push(entry);
    }

    // Sort each topic's entries by date desc
    for (const topic of Object.keys(grouped)) {
      grouped[topic]!.sort((a, b) => b.date.localeCompare(a.date));
    }

    res.json({ digests: grouped });
  });

  // ── Return raw markdown content of a digest file ──────────────────────────
  router.get("/companies/:companyId/digests/content", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const file = req.query.file as string | undefined;
    if (!file) {
      res.status(400).json({ error: "file query parameter is required" });
      return;
    }
    // Path traversal guard: filename must be a plain basename
    if (basename(file) !== file || file.includes("/") || file.includes("\\")) {
      res.status(400).json({ error: "Invalid filename" });
      return;
    }

    const wikiCwd = await getWikiCwd(db, companyId);
    if (!wikiCwd) {
      res.status(404).json({ error: "Wiki workspace not found" });
      return;
    }

    const filePath = join(wikiCwd, "outputs", "reports", file);
    try {
      const content = await readFile(filePath, "utf8");
      res.json({ content });
    } catch {
      res.status(404).json({ error: "File not found" });
    }
  });

  // ── Convert markdown digest to podcast script via Claude ──────────────────
  router.post(
    "/companies/:companyId/digests/podcast-script",
    validate(podcastScriptSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);

      const { content } = req.body as { content: string };

      const client = new Anthropic();
      const message = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 4096,
        system:
          "You are a professional broadcast news anchor. Convert the following markdown digest into a natural, engaging spoken script. Remove all markdown syntax, hashtags, bullet points, bold markers, and links. Write as if speaking aloud. Use complete sentences. Keep all factual content. Target 150-200 words per topic section.",
        messages: [{ role: "user", content }],
      });

      const script = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");

      res.json({ script });
    },
  );

  return router;
}
