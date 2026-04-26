import { Client } from "pg";
import { YamlRegistryReader, type TopicDefinition } from "./yaml-registry.js";

export interface RssWatcherOptions {
  yamlSourcesDir?: string;
  checkIntervalMs: number;
  userAgent: string;
  rateLimitMs: number;
  githubApiToken?: string;
}

export interface RssFeedItem {
  title?: string;
  link?: string;
  pubDate?: string;
  guid?: string;
  contentHash?: string;
}

export interface FeedChange {
  topicSlug: string;
  sourceUrl: string;
  newItems: RssFeedItem[];
  source: "rss" | "changelog" | "github_release";
}

export interface WatchState {
  sourceUrl: string;
  lastEtag?: string;
  lastModified?: string;
  lastItemHashes: string[];
  lastCheckedAt: Date;
}

export class RssWatcher {
  private options: RssWatcherOptions;
  private registryReader: YamlRegistryReader;
  private client: Client | null = null;
  private watchStates = new Map<string, WatchState>();
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private onChangeCallback?: (change: FeedChange) => Promise<void>;

  constructor(options: RssWatcherOptions) {
    this.options = {
      yamlSourcesDir: "/home/jakejames/biz-ops/knowledge/sources",
      checkIntervalMs: 6 * 60 * 60 * 1000,
      userAgent: "Paperclip-KitVentures-Knowledge-Bot/1.0",
      rateLimitMs: 2000,
      ...options,
    };
    this.registryReader = new YamlRegistryReader(this.options.yamlSourcesDir);
  }

  async initialize(): Promise<void> {
    this.client = new Client({
      connectionString: process.env.DATABASE_URL,
    });
    await this.client.connect();
    await this.loadWatchStates();
  }

  async close(): Promise<void> {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.client) {
      await this.client.end();
      this.client = null;
    }
  }

  onChange(callback: (change: FeedChange) => Promise<void>): void {
    this.onChangeCallback = callback;
  }

  private async loadWatchStates(): Promise<void> {
    if (!this.client) return;

    try {
      const result = await this.client.query<{
        source_url: string;
        last_etag: string | null;
        last_modified: string | null;
        last_item_hashes: string[] | null;
        last_checked_at: Date;
      }>(
        `SELECT source_url, last_etag, last_modified, last_item_hashes, last_checked_at
         FROM knowledge_rss_watch_state`
      );

      for (const row of result.rows) {
        this.watchStates.set(row.source_url, {
          sourceUrl: row.source_url,
          lastEtag: row.last_etag || undefined,
          lastModified: row.last_modified || undefined,
          lastItemHashes: row.last_item_hashes || [],
          lastCheckedAt: row.last_checked_at,
        });
      }
    } catch (err) {
      console.warn("Could not load RSS watch states (table may not exist yet):", err);
    }
  }

  private async saveWatchState(state: WatchState): Promise<void> {
    if (!this.client) return;

    try {
      await this.client.query(
        `INSERT INTO knowledge_rss_watch_state (source_url, last_etag, last_modified, last_item_hashes, last_checked_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (source_url) DO UPDATE SET
           last_etag = EXCLUDED.last_etag,
           last_modified = EXCLUDED.last_modified,
           last_item_hashes = EXCLUDED.last_item_hashes,
           last_checked_at = EXCLUDED.last_checked_at`,
        [
          state.sourceUrl,
          state.lastEtag || null,
          state.lastModified || null,
          JSON.stringify(state.lastItemHashes),
          state.lastCheckedAt.toISOString(),
        ]
      );
    } catch (err) {
      console.error("Failed to save RSS watch state:", err);
    }
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async fetchWithRateLimit(url: string, options: RequestInit = {}): Promise<Response> {
    await this.sleep(this.options.rateLimitMs);
    const response = await fetch(url, {
      ...options,
      headers: {
        "User-Agent": this.options.userAgent,
        Accept: "application/rss+xml, application/xml, text/xml, application/atom+xml, */*",
        ...options.headers,
      },
    });
    return response;
  }

  private computeItemHash(item: RssFeedItem): string {
    const content = `${item.title || ""}|${item.link || ""}|${item.pubDate || ""}|${item.guid || ""}`;
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
  }

  private async parseRssFeed(xml: string): Promise<RssFeedItem[]> {
    const items: RssFeedItem[] = [];
    const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
    let match;

    while ((match = itemRegex.exec(xml)) !== null) {
      const itemXml = match[1];
      const item: RssFeedItem = {};

      const titleMatch = /<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i.exec(itemXml);
      if (titleMatch) item.title = titleMatch[1].trim();

      const linkMatch = /<link[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i.exec(itemXml);
      if (linkMatch) item.link = linkMatch[1].trim();

      const pubDateMatch = /<pubDate[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/pubDate>/i.exec(itemXml);
      if (pubDateMatch) item.pubDate = pubDateMatch[1].trim();

      const guidMatch = /<guid[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/guid>/i.exec(itemXml);
      if (guidMatch) item.guid = guidMatch[1].trim();

      item.contentHash = this.computeItemHash(item);
      items.push(item);
    }

    return items;
  }

  private async parseAtomFeed(xml: string): Promise<RssFeedItem[]> {
    const items: RssFeedItem[] = [];
    const entryRegex = /<entry[^>]*>([\s\S]*?)<\/entry>/gi;
    let match;

    while ((match = entryRegex.exec(xml)) !== null) {
      const entryXml = match[1];
      const item: RssFeedItem = {};

      const titleMatch = /<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i.exec(entryXml);
      if (titleMatch) item.title = titleMatch[1].trim();

      const linkMatch = /<link[^>]*href=["']([^"']+)["'][^>]*>/i.exec(entryXml);
      if (linkMatch) item.link = linkMatch[1];

      const updatedMatch = /<updated[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/updated>/i.exec(entryXml);
      if (updatedMatch) item.pubDate = updatedMatch[1].trim();

      const idMatch = /<id[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/id>/i.exec(entryXml);
      if (idMatch) item.guid = idMatch[1].trim();

      item.contentHash = this.computeItemHash(item);
      items.push(item);
    }

    return items;
  }

  private async parseFeed(xml: string): Promise<RssFeedItem[]> {
    if (xml.includes("<feed")) {
      return this.parseAtomFeed(xml);
    }
    return this.parseRssFeed(xml);
  }

  private async checkRssFeed(
    url: string,
    topicSlug: string,
    source: "rss" | "changelog"
  ): Promise<FeedChange | null> {
    const state = this.watchStates.get(url);

    const headers: Record<string, string> = {};
    if (state?.lastEtag) headers["If-None-Match"] = state.lastEtag;
    if (state?.lastModified) headers["If-Modified-Since"] = state.lastModified;

    try {
      const response = await this.fetchWithRateLimit(url, { headers });

      if (response.status === 304) {
        return null;
      }

      const newEtag = response.headers.get("ETag") || undefined;
      const newModified = response.headers.get("Last-Modified") || undefined;
      const xml = await response.text();
      const items = await this.parseFeed(xml);

      const currentHashes = items.map((item) => item.contentHash || "");
      const knownHashes = new Set(state?.lastItemHashes || []);
      const newItems = items.filter(
        (item) => item.contentHash && !knownHashes.has(item.contentHash!)
      );

      const newState: WatchState = {
        sourceUrl: url,
        lastEtag: newEtag,
        lastModified: newModified,
        lastItemHashes: currentHashes,
        lastCheckedAt: new Date(),
      };

      this.watchStates.set(url, newState);
      await this.saveWatchState(newState);

      if (newItems.length > 0) {
        return {
          topicSlug,
          sourceUrl: url,
          newItems,
          source,
        };
      }

      return null;
    } catch (err) {
      console.error(`Error checking RSS feed ${url}:`, err);
      return null;
    }
  }

  async checkAllFeeds(): Promise<FeedChange[]> {
    const topics = await this.registryReader.getTopicDefinitions();
    const changes: FeedChange[] = [];

    for (const topic of topics) {
      if (topic.tier !== 1) continue;

      for (const source of topic.sources) {
        if (!source.robots_allowed && source.rate_limit_respect) {
          continue;
        }

        const change = await this.checkRssFeed(source.url, topic.topic, "rss");
        if (change) {
          changes.push(change);
        }
      }
    }

    return changes;
  }

  async start(): Promise<void> {
    await this.checkAllFeeds();

    this.intervalHandle = setInterval(async () => {
      try {
        const changes = await this.checkAllFeeds();
        if (changes.length > 0 && this.onChangeCallback) {
          for (const change of changes) {
            await this.onChangeCallback(change);
          }
        }
      } catch (err) {
        console.error("Error in RSS watcher interval:", err);
      }
    }, this.options.checkIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  async checkGitHubReleases(repoSlug: string, topicSlug: string): Promise<FeedChange | null> {
    const url = `https://api.github.com/repos/${repoSlug}/releases`;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": this.options.userAgent,
    };
    if (this.options.githubApiToken) {
      headers["Authorization"] = `Bearer ${this.options.githubApiToken}`;
    }

    try {
      const response = await this.fetchWithRateLimit(url, { headers });
      if (!response.ok) {
        console.warn(`GitHub API error for ${repoSlug}: ${response.status}`);
        return null;
      }

      const releases = await response.json() as Array<{
        id: number;
        tag_name: string;
        name?: string;
        published_at: string;
        html_url: string;
      }>;

      const state = this.watchStates.get(url);
      const knownIds = new Set(state?.lastItemHashes || []);
      const newReleases = releases.filter((r) => !knownIds.has(String(r.id)));

      const items: RssFeedItem[] = releases.map((r) => ({
        title: r.name || r.tag_name,
        link: r.html_url,
        pubDate: r.published_at,
        guid: String(r.id),
        contentHash: String(r.id),
      }));

      const newState: WatchState = {
        sourceUrl: url,
        lastItemHashes: items.map((i) => i.contentHash || ""),
        lastCheckedAt: new Date(),
      };

      this.watchStates.set(url, newState);
      await this.saveWatchState(newState);

      if (newReleases.length > 0) {
        return {
          topicSlug,
          sourceUrl: url,
          newItems: newReleases.map((r) => ({
            title: r.name || r.tag_name,
            link: r.html_url,
            pubDate: r.published_at,
            guid: String(r.id),
            contentHash: String(r.id),
          })),
          source: "github_release",
        };
      }

      return null;
    } catch (err) {
      console.error(`Error checking GitHub releases for ${repoSlug}:`, err);
      return null;
    }
  }
}