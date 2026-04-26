import { KnowledgeService } from "./index.js";
import { RssWatcher, type FeedChange } from "./rss-watcher.js";

export interface ChangeDetectionWatcherOptions {
  yamlSourcesDir?: string;
  checkIntervalMs?: number;
  userAgent?: string;
  rateLimitMs?: number;
  githubApiToken?: string;
}

export class ChangeDetectionWatcher {
  private rssWatcher: RssWatcher;
  private knowledgeService: KnowledgeService;
  private initialized = false;

  constructor(
    knowledgeService: KnowledgeService,
    options: ChangeDetectionWatcherOptions = {}
  ) {
    this.knowledgeService = knowledgeService;
    this.rssWatcher = new RssWatcher({
      yamlSourcesDir: options.yamlSourcesDir,
      checkIntervalMs: options.checkIntervalMs ?? 6 * 60 * 60 * 1000,
      userAgent: options.userAgent ?? "Paperclip-KitVentures-Knowledge-Bot/1.0",
      rateLimitMs: options.rateLimitMs ?? 2000,
      githubApiToken: options.githubApiToken,
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.rssWatcher.initialize();
    this.rssWatcher.onChange(async (change: FeedChange) => {
      await this.handleFeedChange(change);
    });
    this.initialized = true;
  }

  async close(): Promise<void> {
    await this.rssWatcher.stop();
    await this.rssWatcher.close();
  }

  private async handleFeedChange(change: FeedChange): Promise<void> {
    console.log(
      `[ChangeDetection] Detected ${change.newItems.length} new items from ${change.source} for topic ${change.topicSlug}`
    );

    try {
      const result = await this.knowledgeService.triggerStaleRefresh({
        topicSlug: change.topicSlug,
        agentId: "00000000-0000-0000-0000-000000000000",
        agentName: "Change Detection Watcher",
        issueLink: `change-detection/${change.source}`,
        companyId: "00000000-0000-0000-0000-000000000001",
        priority: "medium",
      });

      if (result.success) {
        console.log(
          `[ChangeDetection] Successfully triggered refresh for topic ${change.topicSlug}`
        );
      } else {
        console.warn(
          `[ChangeDetection] Failed to trigger refresh for topic ${change.topicSlug}: ${result.error}`
        );
      }
    } catch (err) {
      console.error(
        `[ChangeDetection] Error triggering refresh for topic ${change.topicSlug}:`,
        err
      );
    }
  }

  async start(): Promise<void> {
    await this.initialize();
    await this.rssWatcher.start();
  }

  async stop(): Promise<void> {
    await this.rssWatcher.stop();
  }

  async checkNow(): Promise<void> {
    await this.initialize();
    const changes = await this.rssWatcher.checkAllFeeds();
    for (const change of changes) {
      await this.handleFeedChange(change);
    }
  }

  async checkGitHubReleasesNow(
    repoSlug: string,
    topicSlug: string
  ): Promise<void> {
    await this.initialize();
    const change = await this.rssWatcher.checkGitHubReleases(repoSlug, topicSlug);
    if (change) {
      await this.handleFeedChange(change);
    }
  }
}