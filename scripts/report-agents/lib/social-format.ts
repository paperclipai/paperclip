import { moneySmart } from "./formatters.js";
import Database from "better-sqlite3";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOCIAL_DB_PATH = join(__dirname, "..", "social.db");

interface ParsedTweet {
  account: string;
  tweet_id: string;
  link_tweet: string;
  views: number;
  like: number;
  retweet: number;
  reply: number;
  bookmark: number;
  created_at: string; // ISO
  content: string;
}

// ── DB setup ──

function getDb(): Database.Database {
  const db = new Database(SOCIAL_DB_PATH);
  db.exec(`CREATE TABLE IF NOT EXISTS tweets (
    tweet_id TEXT PRIMARY KEY,
    account TEXT,
    link_tweet TEXT,
    views INTEGER,
    likes INTEGER,
    retweets INTEGER,
    replies INTEGER,
    bookmarks INTEGER DEFAULT 0,
    created_at TEXT,
    content TEXT,
    fetched_at TEXT DEFAULT (datetime('now'))
  )`);
  // Add bookmarks column if missing (migration)
  try { db.exec(`ALTER TABLE tweets ADD COLUMN bookmarks INTEGER DEFAULT 0`); } catch {}
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tweets_account_date ON tweets(account, created_at)`);
  return db;
}

// ── Fetch & parse ──

async function fetchTweets(userId: string, apiKey: string): Promise<any> {
  const url = `https://twitter241.p.rapidapi.com/user-tweets?user=${userId}&count=20`;
  const res = await fetch(url, {
    headers: {
      "x-rapidapi-host": "twitter241.p.rapidapi.com",
      "x-rapidapi-key": apiKey,
    },
  });
  if (!res.ok) throw new Error(`RapidAPI ${res.status}`);
  return res.json();
}

function parseAllTweets(data: any, accountName: string): ParsedTweet[] {
  const output: ParsedTweet[] = [];

  function normalize(r: any) { return r?.tweet ?? r; }

  function process(tweet: any): ParsedTweet | null {
    if (!tweet?.legacy) return null;
    const l = tweet.legacy;
    // Skip retweets and replies
    if (l.full_text?.startsWith("RT @") || l.in_reply_to_status_id_str) return null;
    const user = tweet.core?.user_results?.result?.core?.screen_name ?? tweet.core?.user_results?.result?.legacy?.screen_name;
    const id = l.id_str;
    if (!user || !id) return null;
    return {
      account: accountName,
      tweet_id: id,
      link_tweet: `https://x.com/${user}/status/${id}`,
      views: parseInt(tweet.views?.count || "0"),
      like: l.favorite_count || 0,
      retweet: l.retweet_count || 0,
      reply: l.reply_count || 0,
      bookmark: l.bookmark_count || 0,
      created_at: new Date(l.created_at).toISOString(),
      content: l.full_text?.replace(/https:\/\/t\.co\/\w+/g, "").trim() ?? "",
    };
  }

  for (const instr of data?.result?.timeline?.instructions ?? []) {
    if (instr.type === "TimelinePinEntry") {
      const r = process(normalize(instr.entry?.content?.itemContent?.tweet_results?.result));
      if (r) output.push(r);
    }
    if (instr.type === "TimelineAddEntries") {
      for (const e of instr.entries ?? []) {
        const r = process(normalize(e?.content?.itemContent?.tweet_results?.result));
        if (r) output.push(r);
      }
    }
    if (instr.type === "TimelineTimelineModule") {
      for (const it of instr.items ?? []) {
        const r = process(normalize(it?.item?.itemContent?.tweet_results?.result));
        if (r) output.push(r);
      }
    }
  }
  return output;
}

// ── Sync: fetch + save to local DB ──

export async function syncSocialData(apiKey: string, accounts: Array<{ id: string; name: string }>): Promise<number> {
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO tweets (tweet_id, account, link_tweet, views, likes, retweets, replies, bookmarks, created_at, content)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let totalSaved = 0;
  for (const account of accounts) {
    try {
      const raw = await fetchTweets(account.id, apiKey);
      const tweets = parseAllTweets(raw, account.name);
      const tx = db.transaction((tweets: ParsedTweet[]) => {
        for (const t of tweets) {
          insert.run(t.tweet_id, t.account, t.link_tweet, t.views, t.like, t.retweet, t.reply, t.bookmark, t.created_at, t.content);
        }
      });
      tx(tweets);
      totalSaved += tweets.length;
      console.log(`  Social: @${account.name} — ${tweets.length} tweets saved`);
    } catch (e: any) {
      console.error(`  Social: @${account.name} — Error: ${e.message}`);
    }
  }
  db.close();
  return totalSaved;
}

// ── Query local DB for report ──

function getEngagement(likes: number): string {
  if (likes > 50) return "Strong";
  if (likes > 20) return "Good";
  if (likes > 5) return "Moderate";
  return "Weak";
}

export function getSocialReport(period: "daily" | "weekly" | "monthly"): string | null {
  const db = getDb();
  try {
    const rangeMap = { daily: "-1 day", weekly: "-7 days", monthly: "-30 days" };
    const range = rangeMap[period];

    const tweets = db.prepare(`
      SELECT * FROM tweets
      WHERE created_at >= datetime('now', ?)
      ORDER BY created_at DESC
    `).all(range) as any[];

    if (tweets.length === 0) return null;

    const totalViews = tweets.reduce((s, t) => s + (t.views || 0), 0);
    const totalLikes = tweets.reduce((s, t) => s + (t.likes || 0), 0);
    const totalRT = tweets.reduce((s, t) => s + (t.retweets || 0), 0);
    const totalBookmarks = tweets.reduce((s, t) => s + (t.bookmarks || 0), 0);
    const engRate = totalViews > 0 ? ((totalLikes + totalRT + totalBookmarks) / totalViews * 100) : 0;

    const L: string[] = [];
    L.push(`${tweets.length} posts  ·  ${moneySmart(totalViews, "")} views  ·  ER ${engRate.toFixed(2)}%`);
    L.push(``);

    // Top 3 posts across all accounts
    tweets
      .sort((a, b) => (b.likes + b.retweets + b.bookmarks) - (a.likes + a.retweets + a.bookmarks))
      .slice(0, 3)
      .forEach(t => {
        const preview = t.content.slice(0, 50) + (t.content.length > 50 ? "..." : "");
        const date = t.created_at.slice(5, 10);
        L.push(`🔥 ${date}  <a href="${t.link_tweet}">${preview}</a>`);
        L.push(`   ${moneySmart(t.views, "")} views · ❤️ ${t.likes} · 🔁 ${t.retweets} · 🔖 ${t.bookmarks || 0}`);
      });

    return L.join("\n");
  } finally {
    db.close();
  }
}

// ── Structured data for HTML visual report ──

export function getSocialStructuredData(period: "daily" | "weekly" | "monthly") {
  const db = getDb();
  try {
    const rangeMap = { daily: "-1 day", weekly: "-7 days", monthly: "-30 days" };
    const tweets = db.prepare(`SELECT * FROM tweets WHERE created_at >= datetime('now', ?) ORDER BY created_at DESC`).all(rangeMap[period]) as any[];
    if (tweets.length === 0) return null;

    const totalViews = tweets.reduce((s, t) => s + (t.views || 0), 0);
    const totalLikes = tweets.reduce((s, t) => s + (t.likes || 0), 0);
    const totalRT = tweets.reduce((s, t) => s + (t.retweets || 0), 0);
    const totalReplies = tweets.reduce((s, t) => s + (t.replies || 0), 0);
    const totalBookmarks = tweets.reduce((s, t) => s + (t.bookmarks || 0), 0);
    const engRate = totalViews > 0 ? ((totalLikes + totalRT + totalReplies + totalBookmarks) / totalViews * 100) : 0;

    const topPosts = tweets
      .sort((a, b) => (b.likes + b.retweets + b.bookmarks) - (a.likes + a.retweets + a.bookmarks))
      .slice(0, 5)
      .map(t => ({
        date: t.created_at.slice(0, 10),
        content: t.content?.slice(0, 60) || "",
        views: t.views || 0,
        likes: t.likes || 0,
        retweets: t.retweets || 0,
        bookmarks: t.bookmarks || 0,
        link: t.link_tweet || "",
      }));

    return { totalPosts: tweets.length, totalViews, totalLikes, totalRT, totalReplies, totalBookmarks, engRate, topPosts };
  } finally {
    db.close();
  }
}

// ── Legacy: keep old API for backwards compat ──
export async function runSocialCollector(apiKey: string, accounts: Array<{ id: string; name: string }>): Promise<string | null> {
  // Sync first, then query
  await syncSocialData(apiKey, accounts);
  return getSocialReport("daily");
}
