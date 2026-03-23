// social-collector.ts
// Flow: Fetch RapidAPI → Parse/Filter → summarize → Telegram

import "dotenv/config";

import { sendTelegram } from "./lib/telegram.js";
import { moneySmart } from "./lib/formatters.js";

// --- Config from env ---
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
if (!RAPIDAPI_KEY) throw new Error("Missing RAPIDAPI_KEY");

const ACCOUNTS = JSON.parse(process.env.SOCIAL_ACCOUNTS ?? "[]") as Array<{ id: string; name: string }>;
if (ACCOUNTS.length === 0) throw new Error("Missing SOCIAL_ACCOUNTS env (JSON array)");

const THRESHOLDS = {
  strong: Number(process.env.THRESHOLD_STRONG ?? "50"),
  good: Number(process.env.THRESHOLD_GOOD ?? "20"),
  moderate: Number(process.env.THRESHOLD_MODERATE ?? "5"),
};

// --- Step 1: Fetch tweets via RapidAPI (port from n8n HTTP Request) ---
async function fetchTweets(userId: string): Promise<any> {
  const url = `https://twitter241.p.rapidapi.com/user-tweets?user=${userId}&count=6`;
  const res = await fetch(url, {
    headers: {
      "x-rapidapi-host": "twitter241.p.rapidapi.com",
      "x-rapidapi-key": RAPIDAPI_KEY!,
    },
  });
  if (!res.ok) throw new Error(`RapidAPI ${res.status}: ${await res.text()}`);
  return res.json();
}

// --- Step 2: Parse tweets (port from n8n Code node) ---
interface ParsedTweet {
  link_tweet: string;
  views: number;
  like: number;
  retweet: number;
  reply: number;
  date: string;
  content: string;
}

function parseTweets(data: any): ParsedTweet[] {
  const output: ParsedTweet[] = [];
  const now = new Date();
  const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));

  function isFromYesterday(dateStr: string): boolean {
    const d = new Date(dateStr);
    return d.getUTCFullYear() === yesterday.getUTCFullYear() &&
      d.getUTCMonth() === yesterday.getUTCMonth() &&
      d.getUTCDate() === yesterday.getUTCDate();
  }

  function cleanText(text: string): string {
    return text.replace(/https:\/\/t\.co\/\w+/g, "").trim();
  }

  function formatDate(dateStr: string): string {
    const d = new Date(dateStr);
    return `${d.getDate().toString().padStart(2, "0")}/${(d.getMonth() + 1).toString().padStart(2, "0")}`;
  }

  function normalizeTweet(result: any): any {
    return result?.tweet ?? result;
  }

  function processTweet(tweet: any): ParsedTweet | null {
    if (!tweet) return null;
    const legacy = tweet.legacy;
    if (!legacy) return null;
    if (legacy.full_text?.startsWith("RT @")) return null;
    if (!isFromYesterday(legacy.created_at)) return null;
    if (legacy.in_reply_to_status_id_str) return null;

    const userName = tweet.core?.user_results?.result?.core?.screen_name ??
                     tweet.core?.user_results?.result?.legacy?.screen_name;
    const tweetId = legacy.id_str;
    if (!userName || !tweetId) return null;

    return {
      link_tweet: `https://x.com/${userName}/status/${tweetId}`,
      views: parseInt(tweet.views?.count || "0"),
      like: legacy.favorite_count,
      retweet: legacy.retweet_count,
      reply: legacy.reply_count,
      date: formatDate(legacy.created_at),
      content: cleanText(legacy.full_text || ""),
    };
  }

  const instructions = data?.result?.timeline?.instructions ?? [];
  for (const instr of instructions) {
    if (instr.type === "TimelinePinEntry") {
      const raw = instr.entry?.content?.itemContent?.tweet_results?.result;
      const result = processTweet(normalizeTweet(raw));
      if (result) output.push(result);
    }
    if (instr.type === "TimelineAddEntries") {
      for (const entry of instr.entries ?? []) {
        const raw = entry?.content?.itemContent?.tweet_results?.result;
        const result = processTweet(normalizeTweet(raw));
        if (result) output.push(result);
      }
    }
    if (instr.type === "TimelineTimelineModule") {
      for (const it of instr.items ?? []) {
        const raw = it?.item?.itemContent?.tweet_results?.result;
        const result = processTweet(normalizeTweet(raw));
        if (result) { output.push(result); break; }
      }
    }
  }
  return output;
}

// --- Step 3: Summarize via Claude API (port from n8n AI Agent) ---
async function batchSummarize(tweets: ParsedTweet[]): Promise<string[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || tweets.length === 0) return tweets.map((t) => t.content.slice(0, 50));

  const prompt = tweets.map((t, i) => `${i + 1}. "${t.content}"`).join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      messages: [{
        role: "user",
        content: `Summarize each tweet in no more than 5 words. Return ONLY a JSON array of strings, one summary per tweet.\n\n${prompt}`,
      }],
    }),
  });

  if (!res.ok) {
    console.error(`Claude API error: ${res.status}`);
    return tweets.map((t) => t.content.slice(0, 50));
  }

  const data = await res.json() as any;
  const text = data.content?.[0]?.text ?? "[]";
  try {
    const match = text.match(/\[[\s\S]*\]/);
    return match ? JSON.parse(match[0]) : tweets.map((t) => t.content.slice(0, 50));
  } catch {
    return tweets.map((t) => t.content.slice(0, 50));
  }
}

// --- Step 4: Calculate engagement (port from n8n Telegram node logic) ---
function getEngagement(likes: number): string {
  if (likes > THRESHOLDS.strong) return "Strong";
  if (likes > THRESHOLDS.good) return "Good";
  if (likes > THRESHOLDS.moderate) return "Moderate";
  return "Weak";
}

// --- Main ---
async function main() {
  const allAccounts: any[] = [];

  for (const account of ACCOUNTS) {
    console.log(`Social Collector: fetching @${account.name} (${account.id})...`);
    try {
      const raw = await fetchTweets(account.id);
      const tweets = parseTweets(raw);

      if (tweets.length === 0) {
        console.log(`  → No tweets from yesterday for @${account.name}`);
        allAccounts.push({
          name: account.name,
          total_posts: 0,
          avg_views: 0,
          best_post: null,
          engagement: {},
          posts: [],
        });
        continue;
      }

      // Summarize
      const summaries = await batchSummarize(tweets);

      // Build per-account data
      const posts = tweets.map((t, i) => ({
        summary: summaries[i] ?? t.content.slice(0, 50),
        likes: t.like,
        retweets: t.retweet,
        replies: t.reply,
        views: t.views,
        link: t.link_tweet,
        date: t.date,
        engagement: getEngagement(t.like),
      }));

      const totalViews = posts.reduce((s, p) => s + p.views, 0);
      const bestPost = posts.reduce((best, p) => (p.likes > (best?.likes ?? 0) ? p : best), posts[0]);

      const engCounts: Record<string, number> = {};
      for (const p of posts) {
        engCounts[p.engagement] = (engCounts[p.engagement] ?? 0) + 1;
      }

      allAccounts.push({
        name: account.name,
        total_posts: posts.length,
        avg_views: Math.round(totalViews / posts.length),
        best_post: bestPost ? {
          summary: bestPost.summary,
          likes: bestPost.likes,
          retweets: bestPost.retweets,
          replies: bestPost.replies,
          views: bestPost.views,
        } : null,
        engagement: engCounts,
        posts,
      });

      console.log(`  → ${posts.length} tweets, best: ${bestPost?.likes} likes`);
    } catch (err) {
      console.error(`  → Error fetching @${account.name}:`, err);
      allAccounts.push({
        name: account.name,
        total_posts: 0,
        avg_views: 0,
        best_post: null,
        engagement: {},
        posts: [],
        error: String(err),
      });
    }
  }

  // Format and send Telegram (same as n8n flow)
  const todayFormatted = new Date().toLocaleDateString("en-GB", {
    timeZone: "Asia/Bangkok",
    day: "2-digit", month: "2-digit",
  });

  let report = `<b>Whales Market Social Report ${todayFormatted}:</b>\n\n`;
  for (const account of allAccounts) {
    if (account.total_posts === 0) continue;
    report += `<b>@${account.name}</b>\n`;
    for (const post of account.posts) {
      const contentWithLink = `<a href="${post.link}">${post.summary}</a>`;
      report += `<b>${post.date}</b> - ${contentWithLink}\n`;
      report += `Likes: ${post.likes} | Retweet: ${post.retweets} | Reply: ${post.replies} | Views: ${moneySmart(post.views, "")}\n`;
      report += `Engagement: ${post.engagement}\n\n`;
    }
  }

  if (report.includes("@")) {
    console.log("Social Collector: sending Telegram...");
    await sendTelegram(report);
  } else {
    console.log("Social Collector: no tweets to report, skipping Telegram");
  }

  console.log("Social Collector: done ✓");
}

main().catch((err) => {
  console.error("Social Collector failed:", err);
  process.exit(1);
});
