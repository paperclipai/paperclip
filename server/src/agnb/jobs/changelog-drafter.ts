import { exec } from "node:child_process";
import { promisify } from "node:util";
import { sql } from "drizzle-orm";
import { rows } from "../helpers.js";
import { generate, hasGeminiKey } from "../lib/gemini.js";
import type { AgnbJobContext, AgnbJobResult } from "./types.js";

const execAsync = promisify(exec);

/**
 * changelog-drafter — reads git commits since the last published changelog
 * (or 7d ago), Gemini writes customer-friendly release notes, stored as a draft
 * in agnb.changelog_drafts. Ported from agnb api/internal/changelog-drafter.
 */

interface GitCommit { hash: string; date: string; subject: string; author: string; }

async function readGitLog(sinceIso: string): Promise<GitCommit[]> {
  try {
    const cmd = `git log --since="${sinceIso}" --pretty=format:'%H|%aI|%an|%s' --no-merges`;
    const { stdout } = await execAsync(cmd, { cwd: process.cwd(), maxBuffer: 5_000_000 });
    return stdout.split("\n").filter(Boolean).map((line) => {
      const [hash, date, author, ...rest] = line.split("|");
      return { hash, date, author, subject: rest.join("|") };
    });
  } catch {
    return [];
  }
}

async function geminiWriteChangelog(
  commits: GitCommit[],
  periodLabel: string,
  signal: AbortSignal,
): Promise<{ text: string; inTok: number; outTok: number }> {
  const commitText = commits.slice(0, 100).map((c) => `- ${c.subject} (${c.author})`).join("\n");
  const prompt = `Write a customer-facing changelog for Finn (B2B AI voice agent platform) covering ${periodLabel}.

GIT COMMITS (${commits.length} total):
${commitText}

Group into sections (only include sections with content):
- 🚀 New features
- 🐛 Fixes
- ⚡ Improvements
- 📚 Documentation
- 🔧 Internal (only the ones customers might notice)

For each entry:
- Plain English (no "refactor X into Y" — say what changed for the user)
- One line each, lead with verb
- Skip internal-only commits (CI, lint, comment fixes)
- If a commit is unclear, infer from subject + skip if still vague

Return markdown only. Start with H2 "${periodLabel}" then sections.`;
  try {
    const { text, inTok, outTok } = await generate(prompt, {
      temperature: 0.4,
      maxOutputTokens: 3000,
      timeoutMs: 30_000,
      signal,
    });
    return { text: text.trim(), inTok, outTok };
  } catch {
    return { text: "", inTok: 0, outTok: 0 };
  }
}

export async function changelogDrafter(ctx: AgnbJobContext): Promise<AgnbJobResult> {
  const { db } = ctx;
  if (!hasGeminiKey()) return { ok: true, summary: "skipped: no GEMINI_API_KEY" };

  const lastPub = rows<{ period_end: string | null }>(
    await db.execute(sql`
      SELECT period_end FROM agnb.changelog_drafts
      WHERE status = 'published'
      ORDER BY period_end DESC NULLS LAST
      LIMIT 1
    `),
  )[0];

  const start = lastPub?.period_end
    ? new Date(lastPub.period_end).toISOString()
    : new Date(Date.now() - 7 * 86_400_000).toISOString();
  const end = new Date().toISOString();

  const commits = await readGitLog(start);
  if (commits.length === 0) {
    return { ok: true, drafted: false, summary: "no commits in window", since: start };
  }

  const periodLabel = `${start.slice(0, 10)} → ${end.slice(0, 10)}`;
  const gen = await geminiWriteChangelog(commits, periodLabel, ctx.signal);
  if (!gen.text) return { ok: false, summary: "gemini empty" };

  const inserted = rows<{ id: string }>(
    await db.execute(sql`
      INSERT INTO agnb.changelog_drafts (period_start, period_end, commit_count, markdown, status)
      VALUES (${start.slice(0, 10)}, ${end.slice(0, 10)}, ${commits.length}, ${gen.text}, 'draft')
      RETURNING id
    `),
  )[0];

  ctx.log("changelog drafted", { draft_id: inserted?.id, commit_count: commits.length, period: periodLabel });
  return {
    ok: true,
    drafted: true,
    draft_id: inserted?.id,
    commit_count: commits.length,
    period: periodLabel,
    summary: `drafted ${commits.length} commits`,
  };
}
