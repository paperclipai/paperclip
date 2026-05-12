/**
 * content-capture.ts -- silent URL/content capture to vault inbox
 *
 * When a user shares a bare URL or content snippet, the bridge captures it
 * directly — no Paperclip issue needed. The workflow:
 *
 *   1. React 👀 on the original message
 *   2. Fetch the URL content (fxtwitter for tweets/articles, Jina for web)
 *   3. Classify topic + generate so_what via local LM Studio
 *   4. Write templated note with extracted content to vault inbox
 *   5. React 👍 on the original message (replaces 👀) ONLY after successful save
 *   6. Send brief confirmation reply
 *
 * If capture fails (empty content, LLM error, write error), react 😢 and
 * send a short error. Never react 👍 on a failed or empty capture.
 */

import type { Bot } from "grammy";

const VAULT_ROOT = process.env.VAULT_ROOT ?? `${process.env.HOME}/second-brain`;
const INBOX_DIR = "01-ops/inbox";
const LM_STUDIO_URL = process.env.LM_STUDIO_URL ?? "http://localhost:1234";
const LM_STUDIO_MODEL = process.env.LM_STUDIO_MODEL ?? "phi-4";

// Topic → vault subdirectory mapping
const TOPIC_DIRS: Array<{ keywords: string[]; dir: string }> = [
  { keywords: ["ai", "agent", "llm", "ml", "model", "gpt", "claude", "prompt", "embedding", "rag", "mcp"], dir: "07-reference/ai" },
  { keywords: ["fintech", "payment", "banking", "stripe", "crypto", "defi", "chargeback"], dir: "07-reference/fintech" },
  { keywords: ["business", "strategy", "startup", "vc", "fundraising", "saas", "growth"], dir: "07-reference/business" },
  { keywords: ["trading", "investing", "stock", "option", "portfolio", "hedge"], dir: "06-finance/trading/research" },
  { keywords: ["article", "essay", "opinion", "long-read"], dir: "07-reference/articles" },
];

type CaptureResult = {
  ok: true;
  vaultPath: string;
  title: string;
  soWhat: string;
} | {
  ok: false;
  error: string;
};

/**
 * Extract the URL from a message (first URL found).
 */
function extractUrl(text: string): string | null {
  const match = text.match(/https?:\/\/\S+/);
  return match ? match[0] : null;
}

/**
 * Fetch tweet content via fxtwitter API.
 * Handles both regular tweets and Twitter Articles (long-form).
 */
async function fetchTweet(url: string): Promise<{ author: string; text: string; articleTitle?: string } | null> {
  const match = url.match(/(?:x\.com|twitter\.com)\/(\w+)\/status\/(\d+)/);
  if (!match) return null;
  const [, handle, id] = match;
  try {
    const res = await fetch(`https://api.fxtwitter.com/${handle}/status/${id}`, {
      signal: AbortSignal.timeout(10_000),
      headers: { "User-Agent": "mattclaw-bridge/1.0" },
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    const tweet = data?.tweet;
    if (!tweet) return null;

    const author = `${tweet.author?.name ?? handle} (@${tweet.author?.screen_name ?? handle})`;

    // Regular tweet text
    let text = tweet.text ?? "";

    // Twitter Article (long-form): extract from article.content.blocks
    const article = tweet.article;
    let articleTitle: string | undefined;
    if (article) {
      articleTitle = article.title ?? undefined;
      const blocks: Array<{ text?: string; type?: string }> = article.content?.blocks ?? [];
      const articleText = blocks
        .filter(b => b.text && b.type !== "atomic") // skip image/embed placeholders
        .map(b => b.text!.trim())
        .filter(Boolean)
        .join("\n\n");
      if (articleText) {
        text = articleText;
      }
    }

    // Media alt text
    const mediaDesc = tweet.media?.all?.map((m: any) => m.alt_text ?? "").filter(Boolean).join(", ");
    if (mediaDesc) text += `\n\n[Media: ${mediaDesc}]`;

    return { author, text, articleTitle };
  } catch {
    return null;
  }
}

/**
 * Fetch article/web content via Jina reader API (free, no key needed).
 */
async function fetchArticle(url: string): Promise<string | null> {
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      signal: AbortSignal.timeout(15_000),
      headers: {
        "Accept": "text/plain",
        "User-Agent": "mattclaw-bridge/1.0",
      },
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text.slice(0, 6000);
  } catch {
    return null;
  }
}

/**
 * Classify topic and generate so_what via local LM Studio.
 */
async function classifyAndSoWhat(
  content: string,
  sourceUrl: string,
): Promise<{ title: string; topic: string; so_what: string; tags: string[] } | null> {
  const prompt = `You are a content classifier for a personal knowledge management system. Given the following content, produce a JSON object with:
- "title": a short descriptive title (not the URL)
- "topic": one of: ai, fintech, business, trading, article, personal, general
- "so_what": 2-3 sentences explaining why this matters to Matt Healey — what action it suggests, what insight it connects to, or what trend it signals. Matt works in fintech/payments at Juspay/HyperSwitch, trades options, builds AI agent infrastructure (mattclaw/paperclip), and is developing a notes app called Noted.
- "tags": array of 3-5 lowercase tags

Content source: ${sourceUrl}

Content:
${content.slice(0, 4000)}

Respond with ONLY the JSON object, no markdown.`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    const res = await fetch(`${LM_STUDIO_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: LM_STUDIO_MODEL,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 400,
        temperature: 0.3,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json() as any;
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) return null;
    // Extract JSON from the response — the model may wrap it in markdown code blocks
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

/**
 * Determine vault subdirectory based on topic.
 */
function classifyDir(topic: string): string {
  const lower = topic.toLowerCase();
  for (const { keywords, dir } of TOPIC_DIRS) {
    if (keywords.some(k => lower.includes(k))) return dir;
  }
  return INBOX_DIR;
}

/**
 * Build the templated note content with full extraction.
 */
function buildNoteContent(args: {
  title: string;
  sourceUrl: string;
  content: string;
  soWhat: string;
  tags: string[];
  topic: string;
  isTweet?: boolean;
  author?: string;
}): string {
  const date = new Date().toISOString().slice(0, 10);
  const type = args.isTweet ? "tweet" : "clipping";
  const tagsStr = args.tags.map(t => t.toLowerCase()).join(", ");

  let body = "";

  if (args.isTweet && args.author) {
    body += `**${args.author}**\n\n`;
  }

  body += args.content;

  return [
    "---",
    `title: "${args.title.replace(/"/g, '\\"')}"`,
    `type: ${type}`,
    `tags: [${tagsStr}]`,
    `topic: ${args.topic}`,
    `date_created: ${date}`,
    `source: ${args.sourceUrl}`,
    `so_what: "${args.soWhat.replace(/"/g, '\\"')}"`,
    "---",
    "",
    `# ${args.title}`,
    "",
    body,
    "",
    "## So what",
    args.soWhat,
    "",
    "## Source",
    args.sourceUrl,
    "",
  ].join("\n");
}

/**
 * Generate a filename-safe slug from a title.
 */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

/**
 * Main capture function. Called from the bridge's onMessage handler.
 * Returns the result so the bridge can react/reply appropriately.
 */
export async function captureContent(
  text: string,
  bot: Bot,
  chatId: number,
  messageId: number,
  threadId?: number,
): Promise<CaptureResult> {
  // 1. React 👀 (acknowledge — "seen, working on it")
  await bot.api.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji: "👀" }]).catch(() => {});

  const url = extractUrl(text);
  const date = new Date().toISOString().slice(0, 10);

  try {
    // 2. Fetch content
    let content = "";
    let isTweet = false;
    let author: string | undefined;
    let articleTitle: string | undefined;

    if (url) {
      // Try fxtwitter first for tweet URLs
      const isTweetUrl = /(?:x\.com|twitter\.com)/.test(url);
      if (isTweetUrl) {
        const tweet = await fetchTweet(url);
        if (tweet && tweet.text.trim()) {
          content = tweet.text;
          isTweet = true;
          author = tweet.author;
          articleTitle = tweet.articleTitle;
        } else {
          // fxtwitter returned empty (rate-limited, deleted, etc.) — fall back to Jina
          const article = await fetchArticle(url);
          if (article && article.trim()) {
            content = article;
          }
        }
      } else {
        // Non-tweet URL — try Jina reader
        const article = await fetchArticle(url);
        if (article && article.trim()) {
          content = article;
        }
      }
    } else {
      // Bare text capture
      content = text;
    }

    // Reject empty captures — do NOT save a note with no content
    if (!content.trim()) {
      throw new Error("Could not extract any content from the URL");
    }

    // 3. Classify + generate so_what
    const classified = await classifyAndSoWhat(content, url ?? "pasted text");

    let title = classified?.title ?? articleTitle ?? (url ? new URL(url).hostname : "Captured note");
    let topic = classified?.topic ?? "general";
    let tags = classified?.tags ?? ["captured"];
    let soWhat = classified?.so_what ?? "";

    // If LLM returned a generic so_what, generate a basic one from the content
    if (!soWhat.trim() || /^(saved|stored|kept|archived|captured) (for|as) (reference|later|future)/i.test(soWhat)) {
      // Best-effort: use the first sentence of content as context
      const firstSentence = content.split(/[.!?\n]/)[0]?.trim() ?? "";
      soWhat = firstSentence
        ? `Captured for review: ${firstSentence.slice(0, 150)}${firstSentence.length > 150 ? "..." : ""}`
        : "Captured for review — content extracted and saved to inbox.";
    }

    // 4. Save to inbox — filing to topic dirs is a separate process
    const dir = INBOX_DIR;
    const slug = slugify(title);
    const vaultPath = `${dir}/${date}-${slug}.md`;
    const absPath = `${VAULT_ROOT}/${vaultPath}`;

    // Truncate content for the note body but keep enough for value
    const noteContentBody = content.slice(0, 5000);

    const noteContent = buildNoteContent({
      title,
      sourceUrl: url ?? "pasted text",
      content: noteContentBody,
      soWhat,
      tags,
      topic,
      isTweet,
      author,
    });

    const { writeFileSync, mkdirSync } = await import("fs");
    const { dirname } = await import("path");
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, noteContent, "utf-8");

    // 5. React 👍 ONLY after successful content extraction + vault write
    await bot.api.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji: "👍" }]).catch(() => {});

    // 6. Send brief confirmation
    const { sendMarkdownMessage } = await import("./telegram-bot.js");
    const confirmDir = dir === INBOX_DIR ? "inbox" : dir.split("/").pop() ?? dir;
    await sendMarkdownMessage(
      bot,
      String(chatId),
      `Captured: *${title}* → ${confirmDir}/`,
      threadId,
      messageId,
    );

    return { ok: true, vaultPath, title, soWhat };
  } catch (err: any) {
    // React 😢 on failure
    await bot.api.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji: "😢" }]).catch(() => {});

    const { sendMarkdownMessage } = await import("./telegram-bot.js");
    await sendMarkdownMessage(
      bot,
      String(chatId),
      `Capture failed: ${err?.message ?? "unknown error"}`,
      threadId,
      messageId,
    );

    return { ok: false, error: err?.message ?? "unknown" };
  }
}
