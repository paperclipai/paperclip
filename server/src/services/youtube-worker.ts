import { execFile } from "node:child_process";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import type { Db } from "@paperclipai/db";
import { youtubeExtractionService } from "./youtube-extractions.js";

const exec = promisify(execFile);

interface YtDlpMeta {
  title: string;
  channel?: string;
  uploader?: string;
  description?: string;
  thumbnail?: string;
  duration?: number;
  view_count?: number;
  like_count?: number;
  tags?: string[];
  id?: string;
}

async function extractMetadata(url: string): Promise<YtDlpMeta> {
  const { stdout } = await exec("yt-dlp", ["--dump-json", url], {
    maxBuffer: 50 * 1024 * 1024,
  });
  return JSON.parse(stdout) as YtDlpMeta;
}

async function extractTranscript(url: string, outDir: string): Promise<{ text: string; source: string }> {
  try {
    await exec(
      "yt-dlp",
      [
        "--write-subs",
        "--write-auto-subs",
        "--sub-langs", "en.*",
        "--skip-download",
        "-o", join(outDir, "transcript.%(ext)s"),
        url,
      ],
      { maxBuffer: 10 * 1024 * 1024 },
    );

    const files = await readdir(outDir);
    const subFile = files.find((f) => f.endsWith(".vtt") || f.endsWith(".srt"));
    if (subFile) {
      const raw = await readFile(join(outDir, subFile), "utf8");
      const source = subFile.includes(".en.") ? "auto_subs" : "manual_subs";
      return { text: cleanSubtitles(raw), source };
    }
  } catch {
    // no subtitles available — fall through
  }

  return { text: "(no transcript available)", source: "none" };
}

function cleanSubtitles(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (trimmed === "WEBVTT") return false;
      if (/^\d{2}:\d{2}/.test(trimmed)) return false;
      if (/^\d+$/.test(trimmed)) return false;
      if (trimmed.startsWith("NOTE")) return false;
      return true;
    })
    .map((line) => line.replace(/<[^>]+>/g, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\b(\w+) \1\b/gi, "$1")
    .trim();
}

async function analyzeWithClaude(meta: YtDlpMeta, transcript: string): Promise<string> {
  const duration = meta.duration
    ? `${Math.floor(meta.duration / 60)}m ${Math.round(meta.duration % 60)}s`
    : "unknown";

  const prompt = [
    "You are a technical research analyst for Darwin, a company building Paperclip — an AI agent orchestration and project management platform.",
    "",
    "Analyze the following YouTube video and produce a structured research report. Your goal is to determine whether the content is worth implementing or adapting for the Paperclip system.",
    "",
    "## Video Info",
    `Title: ${meta.title}`,
    `Channel: ${meta.channel ?? meta.uploader ?? "unknown"}`,
    `Duration: ${duration}`,
    `Views: ${meta.view_count?.toLocaleString() ?? "unknown"}`,
    "",
    "## Description",
    (meta.description ?? "(none)").slice(0, 2000),
    "",
    "## Transcript",
    transcript.slice(0, 8000) || "(no transcript available)",
    "",
    "## Your Task",
    "",
    "Produce a markdown report with these exact sections:",
    "",
    "### Summary",
    "2-4 sentences describing what this video is actually about.",
    "",
    "### Key Items Extracted",
    "Numbered list of every distinct tool, technique, tip, feature, or concept mentioned. One-sentence description for each.",
    "",
    "### Relevance Assessment",
    "For each key item above, rate relevance to Paperclip (AI agent orchestration, project management, developer productivity tools) as HIGH / MEDIUM / LOW. One sentence explanation.",
    "",
    "### Top Recommendations",
    "The 3-5 items most worth exploring for Paperclip. For each: what specifically we would implement and why.",
    "",
    "### Verdict",
    "One of: HIGHLY RECOMMENDED / WORTH EXPLORING / NOT RELEVANT",
    "One sentence justification.",
  ].join("\n");

  try {
    const { stdout } = await exec(
      "claude",
      ["-p", prompt, "--dangerously-skip-permissions", "--output-format", "text"],
      { maxBuffer: 10 * 1024 * 1024, timeout: 180_000 },
    );
    return stdout.trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Analysis failed: ${message}`;
  }
}

export async function processYoutubeExtraction(db: Db, extractionId: string, url: string): Promise<void> {
  const svc = youtubeExtractionService(db);
  const outDir = await mkdtemp(join(tmpdir(), "yt-extract-"));

  try {
    let meta: YtDlpMeta;
    try {
      meta = await extractMetadata(url);
    } catch (err) {
      await svc.update(extractionId, {
        status: "failed",
        errorMessage: `yt-dlp metadata failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    await svc.update(extractionId, {
      videoId: meta.id,
      title: meta.title,
      channel: meta.channel ?? meta.uploader,
      description: meta.description?.slice(0, 5000),
      thumbnailUrl: meta.thumbnail,
      durationSec: meta.duration ? Math.round(meta.duration) : undefined,
      viewCount: meta.view_count,
      likeCount: meta.like_count,
      tags: meta.tags ?? [],
    });

    const { text: transcript, source: transcriptSource } = await extractTranscript(url, outDir);

    await svc.update(extractionId, { transcript, transcriptSource });

    const report = await analyzeWithClaude(meta, transcript);

    await svc.update(extractionId, { report, status: "completed" });
  } catch (err) {
    await svc.update(extractionId, {
      status: "failed",
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}
